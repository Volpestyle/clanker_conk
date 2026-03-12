import {
  BARGE_IN_BOT_AUDIO_ECHO_GUARD_MS,
  BARGE_IN_BOT_SPEAKING_ACTIVE_RATIO_MIN,
  BARGE_IN_BOT_SPEAKING_PEAK_MIN,
  BARGE_IN_MIN_SPEECH_MS,
  BARGE_IN_STT_MIN_CAPTURE_AGE_MS,
  STT_REPLY_MAX_CHARS,
  VOICE_SILENCE_GATE_ACTIVE_RATIO_MAX,
  VOICE_SILENCE_GATE_PEAK_MAX
} from "./voiceSessionManager.constants.ts";
import { isRealtimeMode, normalizeVoiceText } from "./voiceSessionHelpers.ts";
import type { ReplyManager } from "./replyManager.ts";
import type { OutputChannelState, VoiceSession } from "./voiceSessionTypes.ts";

type BargeInStoreLike = {
  logAction: (entry: {
    kind: string;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    content: string;
    metadata?: Record<string, unknown>;
  }) => void;
};

type CaptureStateLike = {
  userId?: string | null;
  startedAt?: number;
  promotedAt?: number;
  bytesSent?: number;
  speakingEndFinalizeTimer?: ReturnType<typeof setTimeout> | NodeJS.Timeout | null;
  signalSampleCount?: number;
  signalActiveSampleCount?: number;
  signalPeakAbs?: number;
  signalSumSquares?: number;
};

type PendingResponseLike = {
  requestId?: number;
  utteranceText?: string | null;
  interruptionPolicy?: ReplyInterruptionPolicy | null;
  audioReceivedAt?: number;
};

export interface ReplyInterruptionPolicy {
  assertive: boolean;
  scope: "none" | "speaker" | "anyone";
  allowedUserId: string | null;
  talkingTo?: string | null;
  source?: string | null;
  reason?: string | null;
}

export type BargeInDecisionReason =
  | "allowed"
  | "session_ending"
  | "barge_in_suppressed"
  | "output_unlocked"
  | "music_only_playback"
  | "pending_response_pre_audio"
  | "echo_guard_active"
  | "no_active_bot_speech"
  | "missing_user_id"
  | "speaking_end_finalize_pending"
  | "interruption_policy_denied"
  | "capture_too_young_for_buffered_playback"
  | "insufficient_capture_bytes"
  | "capture_signal_not_assertive"
  | "capture_signal_not_assertive_during_bot_speech";

type BargeInDecision =
  | { allowed: false }
  | {
    allowed: true;
    minCaptureBytes: number;
    interruptionPolicy: ReplyInterruptionPolicy | null;
  };

export interface BargeInDecisionEvaluation {
  allowed: boolean;
  reason: BargeInDecisionReason;
  minCaptureBytes: number | null;
  interruptionPolicy: ReplyInterruptionPolicy | null;
  pendingRequestId: number | null;
  userId: string | null;
  captureAgeMs: number | null;
  captureBytesSent: number;
  signal: CaptureSignalMetrics;
  outputState: Pick<
    OutputChannelState,
    | "locked"
    | "lockReason"
    | "musicActive"
    | "bargeInSuppressed"
    | "botTurnOpen"
    | "bufferedBotSpeech"
    | "pendingResponse"
    | "openAiActiveResponse"
  >;
  liveAudioStreaming: boolean;
  pendingEverProducedAudio: boolean | null;
}

interface CaptureSignalMetrics {
  sampleCount: number;
  activeSampleRatio: number;
  peak: number;
  rms: number;
}

interface BargeInInterruptCommand {
  now: number;
  userId: string | null;
  source: string;
  pendingRequestId: number | null;
  minCaptureBytes: number;
  interruptionPolicy: ReplyInterruptionPolicy | null;
  interruptedUtteranceText: string | null;
  captureBytesSent: number | null;
  captureSignalPeak: number | null;
  captureSignalActiveSampleRatio: number | null;
  botTurnWasOpen: boolean;
  botTurnAgeMs: number | null;
}

interface BargeInControllerHost {
  client: {
    user?: {
      id?: string | null;
    } | null;
  };
  store: BargeInStoreLike;
  replyManager: Pick<ReplyManager, "hasRecentAssistantAudioDelta" | "hasBufferedTtsPlayback">;
  getOutputChannelState: (session: VoiceSession) => OutputChannelState;
  normalizeReplyInterruptionPolicy: (
    rawPolicy?: ReplyInterruptionPolicy | Record<string, unknown> | null
  ) => ReplyInterruptionPolicy | null;
  isUserAllowedToInterruptReply: (args?: {
    policy?: ReplyInterruptionPolicy | null;
    userId?: string | null;
  }) => boolean;
}

export class BargeInController {
  constructor(private readonly host: BargeInControllerHost) {}

  isBargeInOutputSuppressed(session: VoiceSession, now = Date.now()) {
    if (!session) return false;
    const suppressedUntil = Number(session.bargeInSuppressionUntil || 0);
    if (suppressedUntil <= 0) return false;
    if (now < suppressedUntil) return true;
    this.clearBargeInOutputSuppression(session, "timeout");
    return false;
  }

  clearBargeInOutputSuppression(session: VoiceSession, reason = "cleared") {
    if (!session) return;
    const suppressedUntil = Number(session.bargeInSuppressionUntil || 0);
    if (suppressedUntil <= 0) return;
    const droppedChunks = Math.max(0, Number(session.bargeInSuppressedAudioChunks || 0));
    const droppedBytes = Math.max(0, Number(session.bargeInSuppressedAudioBytes || 0));

    session.bargeInSuppressionUntil = 0;
    session.bargeInSuppressedAudioChunks = 0;
    session.bargeInSuppressedAudioBytes = 0;

    if (reason === "timeout" && droppedChunks <= 0 && droppedBytes <= 0) return;
    this.host.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.host.client.user?.id || null,
      content: "voice_barge_in_suppression_cleared",
      metadata: {
        sessionId: session.id,
        reason: String(reason || "cleared"),
        droppedAudioChunks: droppedChunks,
        droppedAudioBytes: droppedBytes
      }
    });
  }

  evaluateBargeInDecision({
    session,
    userId,
    captureState
  }: {
    session: VoiceSession;
    userId?: string | null;
    captureState?: CaptureStateLike | null;
  }): BargeInDecisionEvaluation {
    const normalizedUserId = String(userId || "").trim() || null;
    const captureAgeMs = captureState
      ? Math.max(0, Date.now() - Number(captureState.startedAt || Date.now()))
      : null;
    const captureBytesSent = Math.max(0, Number(captureState?.bytesSent || 0));
    const signal = this.getCaptureSignalMetrics(captureState);
    const buildEvaluation = ({
      allowed,
      reason,
      minCaptureBytes = null,
      interruptionPolicy = null,
      pendingRequestId = null,
      liveAudioStreaming = false,
      pendingEverProducedAudio = null,
      outputState = {
        locked: false,
        lockReason: null,
        musicActive: false,
        bargeInSuppressed: false,
        botTurnOpen: false,
        bufferedBotSpeech: false,
        pendingResponse: false,
        openAiActiveResponse: false
      }
    }: {
      allowed: boolean;
      reason: BargeInDecisionReason;
      minCaptureBytes?: number | null;
      interruptionPolicy?: ReplyInterruptionPolicy | null;
      pendingRequestId?: number | null;
      liveAudioStreaming?: boolean;
      pendingEverProducedAudio?: boolean | null;
      outputState?: BargeInDecisionEvaluation["outputState"];
    }): BargeInDecisionEvaluation => ({
      allowed,
      reason,
      minCaptureBytes,
      interruptionPolicy,
      pendingRequestId,
      userId: normalizedUserId,
      captureAgeMs,
      captureBytesSent,
      signal,
      outputState,
      liveAudioStreaming,
      pendingEverProducedAudio
    });

    if (!session || session.ending) {
      return buildEvaluation({
        allowed: false,
        reason: "session_ending"
      });
    }

    const outputChannelState = this.host.getOutputChannelState(session);
    const outputState: BargeInDecisionEvaluation["outputState"] = {
      locked: Boolean(outputChannelState.locked),
      lockReason: outputChannelState.lockReason || null,
      musicActive: Boolean(outputChannelState.musicActive),
      bargeInSuppressed: Boolean(outputChannelState.bargeInSuppressed),
      botTurnOpen: Boolean(outputChannelState.botTurnOpen),
      bufferedBotSpeech: Boolean(outputChannelState.bufferedBotSpeech),
      pendingResponse: Boolean(outputChannelState.pendingResponse),
      openAiActiveResponse: Boolean(outputChannelState.openAiActiveResponse)
    };
    if (outputState.bargeInSuppressed) {
      return buildEvaluation({
        allowed: false,
        reason: "barge_in_suppressed",
        outputState
      });
    }
    if (!outputState.locked) {
      return buildEvaluation({
        allowed: false,
        reason: "output_unlocked",
        outputState
      });
    }
    if (
      outputState.musicActive &&
      !outputState.botTurnOpen &&
      !outputState.pendingResponse &&
      !outputState.openAiActiveResponse
    ) {
      return buildEvaluation({
        allowed: false,
        reason: "music_only_playback",
        outputState
      });
    }

    const botTurnOpenAt = Math.max(0, Number(session.botTurnOpenAt || 0));
    const liveAudioStreaming = this.host.replyManager.hasRecentAssistantAudioDelta(session);
    const bufferedBotSpeech = this.host.replyManager.hasBufferedTtsPlayback(session);
    const pendingResponse = this.getPendingResponse(session);
    const pendingRequestId = Math.max(0, Number(pendingResponse?.requestId || 0)) || null;

    if (!session.botTurnOpen && botTurnOpenAt <= 0 && !liveAudioStreaming && !bufferedBotSpeech) {
      const pendingEverProducedAudio = Math.max(0, Number(pendingResponse?.audioReceivedAt || 0)) > 0;
      if (!pendingEverProducedAudio) {
        return buildEvaluation({
          allowed: false,
          reason: "pending_response_pre_audio",
          pendingRequestId,
          liveAudioStreaming,
          pendingEverProducedAudio,
          outputState
        });
      }
    } else if (botTurnOpenAt > 0 && Date.now() - botTurnOpenAt < BARGE_IN_BOT_AUDIO_ECHO_GUARD_MS) {
      return buildEvaluation({
        allowed: false,
        reason: "echo_guard_active",
        pendingRequestId,
        liveAudioStreaming,
        outputState
      });
    }

    if (!liveAudioStreaming && !session.botTurnOpen && !bufferedBotSpeech) {
      return buildEvaluation({
        allowed: false,
        reason: "no_active_bot_speech",
        pendingRequestId,
        liveAudioStreaming,
        outputState
      });
    }

    if (!normalizedUserId) {
      return buildEvaluation({
        allowed: false,
        reason: "missing_user_id",
        pendingRequestId,
        liveAudioStreaming,
        outputState
      });
    }
    if (captureState?.speakingEndFinalizeTimer) {
      return buildEvaluation({
        allowed: false,
        reason: "speaking_end_finalize_pending",
        pendingRequestId,
        liveAudioStreaming,
        outputState
      });
    }

    const interruptionPolicy = this.host.normalizeReplyInterruptionPolicy(
      pendingResponse?.interruptionPolicy || session.activeReplyInterruptionPolicy
    );
    if (
      !this.host.isUserAllowedToInterruptReply({
        policy: interruptionPolicy,
        userId: normalizedUserId
      })
    ) {
      return buildEvaluation({
        allowed: false,
        reason: "interruption_policy_denied",
        pendingRequestId,
        liveAudioStreaming,
        interruptionPolicy,
        outputState
      });
    }

    const sampleRateHz = isRealtimeMode(session.mode)
      ? Number(session.realtimeInputSampleRateHz) || 24000
      : 24000;
    const minCaptureBytes = Math.max(2, Math.ceil((sampleRateHz * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000));
    if (!isRealtimeMode(session.mode) && (captureAgeMs || 0) < BARGE_IN_STT_MIN_CAPTURE_AGE_MS) {
      return buildEvaluation({
        allowed: false,
        reason: "capture_too_young_for_buffered_playback",
        minCaptureBytes,
        pendingRequestId,
        liveAudioStreaming,
        interruptionPolicy,
        outputState
      });
    }
    if (captureBytesSent < minCaptureBytes) {
      return buildEvaluation({
        allowed: false,
        reason: "insufficient_capture_bytes",
        minCaptureBytes,
        pendingRequestId,
        liveAudioStreaming,
        interruptionPolicy,
        outputState
      });
    }
    if (!this.isCaptureSignalAssertive(captureState)) {
      return buildEvaluation({
        allowed: false,
        reason: "capture_signal_not_assertive",
        minCaptureBytes,
        pendingRequestId,
        liveAudioStreaming,
        interruptionPolicy,
        outputState
      });
    }

    const botRecentlySpeaking = session.botTurnOpen || liveAudioStreaming || bufferedBotSpeech;
    if (botRecentlySpeaking && !this.isCaptureSignalAssertiveDuringBotSpeech(captureState)) {
      return buildEvaluation({
        allowed: false,
        reason: "capture_signal_not_assertive_during_bot_speech",
        minCaptureBytes,
        pendingRequestId,
        liveAudioStreaming,
        interruptionPolicy,
        outputState
      });
    }

    return buildEvaluation({
      allowed: true,
      reason: "allowed",
      minCaptureBytes,
      pendingRequestId,
      liveAudioStreaming,
      interruptionPolicy,
      outputState
    });
  }

  shouldBargeIn({
    session,
    userId,
    captureState
  }: {
    session: VoiceSession;
    userId?: string | null;
    captureState?: CaptureStateLike | null;
  }): BargeInDecision {
    const evaluation = this.evaluateBargeInDecision({
      session,
      userId,
      captureState
    });
    if (!evaluation.allowed || !evaluation.minCaptureBytes) return { allowed: false };
    return {
      allowed: true,
      minCaptureBytes: evaluation.minCaptureBytes,
      interruptionPolicy: evaluation.interruptionPolicy
    };
  }

  isCaptureSignalAssertive(capture: CaptureStateLike | null | undefined) {
    const signal = this.getCaptureSignalMetrics(capture);
    if (signal.sampleCount <= 0) return false;
    const nearSilentSignal =
      signal.activeSampleRatio <= VOICE_SILENCE_GATE_ACTIVE_RATIO_MAX &&
      signal.peak <= VOICE_SILENCE_GATE_PEAK_MAX;
    return !nearSilentSignal;
  }

  isCaptureSignalAssertiveDuringBotSpeech(capture: CaptureStateLike | null | undefined) {
    const signal = this.getCaptureSignalMetrics(capture);
    if (signal.sampleCount <= 0) return false;
    return signal.activeSampleRatio >= BARGE_IN_BOT_SPEAKING_ACTIVE_RATIO_MIN &&
      signal.peak >= BARGE_IN_BOT_SPEAKING_PEAK_MIN;
  }

  getCaptureSignalMetrics(capture: CaptureStateLike | null | undefined): CaptureSignalMetrics {
    if (!capture || typeof capture !== "object") {
      return {
        sampleCount: 0,
        activeSampleRatio: 0,
        peak: 0,
        rms: 0
      };
    }
    const sampleCount = Math.max(0, Number(capture.signalSampleCount || 0));
    if (sampleCount <= 0) {
      return {
        sampleCount,
        activeSampleRatio: 0,
        peak: 0,
        rms: 0
      };
    }
    const activeSampleCount = Math.max(0, Number(capture.signalActiveSampleCount || 0));
    const peakAbs = Math.max(0, Number(capture.signalPeakAbs || 0));
    const sumSquares = Math.max(0, Number(capture.signalSumSquares || 0));
    return {
      sampleCount,
      activeSampleRatio: activeSampleCount / sampleCount,
      peak: peakAbs / 32768,
      rms: Math.sqrt(sumSquares / sampleCount) / 32768
    };
  }

  buildInterruptBotSpeechForBargeInCommand({
    session,
    userId = null,
    source = "speaking_start",
    minCaptureBytes = 0,
    captureState = null
  }: {
    session: VoiceSession;
    userId?: string | null;
    source?: string;
    minCaptureBytes?: number;
    captureState?: CaptureStateLike | null;
  }): BargeInInterruptCommand | null {
    if (!session || session.ending) return null;

    const now = Date.now();
    const pendingResponse = this.getPendingResponse(session);
    const interruptionPolicy = this.host.normalizeReplyInterruptionPolicy(
      pendingResponse?.interruptionPolicy || session.activeReplyInterruptionPolicy
    );
    const interruptedUtteranceText =
      normalizeVoiceText(
        pendingResponse?.utteranceText || session.lastRequestedRealtimeUtterance?.utteranceText || "",
        STT_REPLY_MAX_CHARS
      ) || null;
    const signal = this.getCaptureSignalMetrics(captureState);
    const botTurnOpenAt = Math.max(0, Number(session.botTurnOpenAt || 0));

    return {
      now,
      userId: String(userId || "").trim() || null,
      source: String(source || "speaking_start"),
      pendingRequestId: Math.max(0, Number(pendingResponse?.requestId || 0)) || null,
      minCaptureBytes: Math.max(0, Number(minCaptureBytes || 0)),
      interruptionPolicy,
      interruptedUtteranceText,
      captureBytesSent: captureState ? Math.max(0, Number(captureState.bytesSent || 0)) : null,
      captureSignalPeak: captureState ? signal.peak : null,
      captureSignalActiveSampleRatio: captureState ? signal.activeSampleRatio : null,
      botTurnWasOpen: Boolean(session.botTurnOpen),
      botTurnAgeMs: botTurnOpenAt > 0 ? Math.max(0, now - botTurnOpenAt) : null
    };
  }

  private getPendingResponse(session: VoiceSession): PendingResponseLike | null {
    const pendingResponse = session.pendingResponse;
    if (!pendingResponse || typeof pendingResponse !== "object") return null;
    return pendingResponse;
  }
}
