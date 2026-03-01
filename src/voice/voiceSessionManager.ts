import {
  AudioPlayerStatus,
  EndBehaviorType,
  getVoiceConnection,
  VoiceConnectionStatus
} from "@discordjs/voice";
import { PermissionFlagsBits } from "discord.js";
import prism from "prism-media";
import {
  buildVoiceToneGuardrails,
  buildHardLimitsSection,
  getPromptBotName,
  getPromptCapabilityHonestyLine,
  getPromptImpossibleActionLine,
  getPromptMemoryDisabledLine,
  getPromptMemoryEnabledLine,
  getPromptStyle,
  getPromptVoiceGuidance,
  VOICE_REPLY_DECIDER_SYSTEM_PROMPT_COMPACT_DEFAULT,
  VOICE_REPLY_DECIDER_SYSTEM_PROMPT_FULL_DEFAULT,
  VOICE_REPLY_DECIDER_SYSTEM_PROMPT_STRICT_DEFAULT,
  VOICE_REPLY_DECIDER_WAKE_VARIANT_HINT_DEFAULT
} from "../promptCore.ts";
import { estimateUsdCost } from "../pricing.ts";
import { clamp } from "../utils.ts";
import {
  DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD,
  hasBotNameCue,
  scoreDirectAddressConfidence
} from "../directAddressConfidence.ts";
import { convertDiscordPcmToXaiInput, convertXaiOutputToDiscordPcm } from "./pcmAudio.ts";
import { SoundboardDirector } from "./soundboardDirector.ts";
import {
  defaultVoiceReplyDecisionModel,
  isLikelyWakeWordPing,
  isLowSignalVoiceFragment,
  normalizeVoiceReplyDecisionProvider,
  parseVoiceDecisionContract,
  parseVoiceThoughtDecisionContract,
  resolveVoiceReplyDecisionMaxOutputTokens,
  shouldUseLlmForLowSignalTurn,
  resolveRealtimeTurnTranscriptionPlan
} from "./voiceDecisionRuntime.ts";
import { defaultModelForLlmProvider, normalizeLlmProvider } from "../llm/llmHelpers.ts";
import {
  enableWatchStreamForUser,
  getStreamWatchBrainContextForPrompt,
  generateVisionFallbackStreamWatchCommentary,
  ingestStreamFrame,
  initializeStreamWatchState,
  isUserInSessionVoiceChannel,
  maybeTriggerStreamWatchCommentary,
  requestStopWatchingStream,
  requestStreamWatchStatus,
  requestWatchStream,
  resolveStreamWatchVisionProviderSettings,
  supportsStreamWatchCommentary,
  supportsStreamWatchBrainContext,
  supportsVisionFallbackStreamWatchCommentary
} from "./voiceStreamWatch.ts";
import {
  resolveOperationalChannel,
  sendOperationalMessage,
  sendToChannel
} from "./voiceOperationalMessaging.ts";
import {
  REALTIME_MEMORY_FACT_LIMIT,
  SOUNDBOARD_MAX_CANDIDATES,
  dedupeSoundboardCandidates,
  buildRealtimeTextUtterancePrompt,
  encodePcm16MonoAsWav,
  ensureBotAudioPlaybackReady,
  extractSoundboardDirective,
  findMentionedSoundboardReference,
  getRealtimeCommitMinimumBytes,
  formatRealtimeMemoryFacts,
  formatSoundboardCandidateLine,
  getRealtimeRuntimeLabel,
  isLikelyVocativeAddressToOtherParticipant,
  isFinalRealtimeTranscriptEventType,
  isRecoverableRealtimeError,
  isRealtimeMode,
  isVoiceTurnAddressedToBot,
  matchSoundboardReference,
  normalizeVoiceText,
  parseSoundboardDirectiveSequence,
  parsePreferredSoundboardReferences,
  parseRealtimeErrorPayload,
  parseResponseDoneId,
  parseResponseDoneModel,
  parseResponseDoneStatus,
  parseResponseDoneUsage,
  resolveVoiceAsrLanguageGuidance,
  resolveRealtimeProvider,
  shortError,
  shouldAllowVoiceNsfwHumor,
  transcriptSourceFromEventType
} from "./voiceSessionHelpers.ts";
import { requestJoin } from "./voiceJoinFlow.ts";
import {
  ACTIVITY_TOUCH_MIN_SPEECH_MS,
  ACTIVITY_TOUCH_THROTTLE_MS,
  AUDIO_PLAYBACK_PUMP_CHUNK_BYTES,
  AUDIO_PLAYBACK_QUEUE_HARD_MAX_BYTES,
  AUDIO_PLAYBACK_QUEUE_WARN_BYTES,
  AUDIO_PLAYBACK_QUEUE_WARN_COOLDOWN_MS,
  BARGE_IN_ASSERTION_MS,
  BARGE_IN_FULL_OVERRIDE_MIN_MS,
  BARGE_IN_MIN_SPEECH_MS,
  BARGE_IN_RETRY_MAX_AGE_MS,
  BARGE_IN_SUPPRESSION_MAX_MS,
  BOT_DISCONNECT_GRACE_MS,
  DIRECT_ADDRESS_CROSS_SPEAKER_WAKE_MS,
  BOT_TURN_DEFERRED_COALESCE_MAX,
  BOT_TURN_DEFERRED_FLUSH_DELAY_MS,
  BOT_TURN_DEFERRED_QUEUE_MAX,
  BOT_TURN_SILENCE_RESET_MS,
  CAPTURE_IDLE_FLUSH_MS,
  CAPTURE_NEAR_SILENCE_ABORT_ACTIVE_RATIO_MAX,
  CAPTURE_NEAR_SILENCE_ABORT_MIN_AGE_MS,
  CAPTURE_NEAR_SILENCE_ABORT_PEAK_MAX,
  CAPTURE_MAX_DURATION_MS,
  DISCORD_PCM_FRAME_BYTES,
  FOCUSED_SPEAKER_CONTINUATION_MS,
  INPUT_SPEECH_END_SILENCE_MS,
  LEAVE_DIRECTIVE_PLAYBACK_MAX_WAIT_MS,
  LEAVE_DIRECTIVE_PLAYBACK_NO_SIGNAL_GRACE_MS,
  LEAVE_DIRECTIVE_PLAYBACK_POLL_MS,
  LEAVE_DIRECTIVE_REALTIME_AUDIO_START_WAIT_MS,
  MAX_INACTIVITY_SECONDS,
  MAX_MAX_SESSION_MINUTES,
  MAX_RESPONSE_SILENCE_RETRIES,
  MIN_INACTIVITY_SECONDS,
  MIN_MAX_SESSION_MINUTES,
  MIN_RESPONSE_REQUEST_GAP_MS,
  OPENAI_ACTIVE_RESPONSE_RETRY_MS,
  JOIN_GREETING_LLM_WINDOW_MS,
  NON_DIRECT_REPLY_MIN_SILENCE_MS,
  REALTIME_CONTEXT_MEMBER_LIMIT,
  REALTIME_CONTEXT_TRANSCRIPT_MAX_CHARS,
  REALTIME_INSTRUCTION_REFRESH_DEBOUNCE_MS,
  REALTIME_TURN_PENDING_MERGE_MAX_BYTES,
  REALTIME_TURN_QUEUE_MAX,
  REALTIME_TURN_STALE_SKIP_MS,
  RESPONSE_DONE_SILENCE_GRACE_MS,
  RESPONSE_FLUSH_DEBOUNCE_MS,
  RESPONSE_SILENCE_RETRY_DELAY_MS,
  SOUNDBOARD_CATALOG_REFRESH_MS,
  SOUNDBOARD_DECISION_TRANSCRIPT_MAX_CHARS,
  SPEAKING_END_ADAPTIVE_BUSY_BACKLOG,
  SPEAKING_END_ADAPTIVE_BUSY_CAPTURE_COUNT,
  SPEAKING_END_ADAPTIVE_BUSY_SCALE,
  SPEAKING_END_ADAPTIVE_HEAVY_BACKLOG,
  SPEAKING_END_ADAPTIVE_HEAVY_CAPTURE_COUNT,
  SPEAKING_END_ADAPTIVE_HEAVY_SCALE,
  SPEAKING_END_FINALIZE_MICRO_MS,
  SPEAKING_END_FINALIZE_MIN_MS,
  SPEAKING_END_FINALIZE_QUICK_MS,
  SPEAKING_END_FINALIZE_SHORT_MS,
  SPEAKING_END_MICRO_CAPTURE_MS,
  SPEAKING_END_SHORT_CAPTURE_MS,
  STT_CONTEXT_MAX_MESSAGES,
  STT_REPLY_MAX_CHARS,
  STT_TRANSCRIPT_MAX_CHARS,
  STT_TURN_COALESCE_MAX_BYTES,
  STT_TURN_COALESCE_WINDOW_MS,
  STT_TURN_QUEUE_MAX,
  STT_TURN_STALE_SKIP_MS,
  STT_TTS_CONVERSION_CHUNK_MS,
  STT_TTS_CONVERSION_YIELD_EVERY_CHUNKS,
  VOICE_DECIDER_HISTORY_MAX_CHARS,
  VOICE_MEMBERSHIP_EVENT_FRESH_MS,
  VOICE_MEMBERSHIP_EVENT_MAX_TRACKED,
  VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT,
  VOICE_THOUGHT_LOOP_BUSY_RETRY_MS,
  VOICE_THOUGHT_LOOP_MAX_INTERVAL_SECONDS,
  VOICE_THOUGHT_LOOP_MAX_SILENCE_SECONDS,
  VOICE_THOUGHT_LOOP_MIN_INTERVAL_SECONDS,
  VOICE_THOUGHT_LOOP_MIN_SILENCE_SECONDS,
  VOICE_THOUGHT_MAX_CHARS,
  VOICE_THOUGHT_MEMORY_SEARCH_LIMIT,
  VOICE_THOUGHT_DECISION_MAX_OUTPUT_TOKENS,
  VOICE_DECIDER_PROMPT_HISTORY_MAX_CHARS,
  VOICE_EMPTY_TRANSCRIPT_ERROR_STREAK,
  VOICE_FALLBACK_NOISE_GATE_ACTIVE_RATIO_MAX,
  VOICE_FALLBACK_NOISE_GATE_MAX_CLIP_MS,
  VOICE_FALLBACK_NOISE_GATE_PEAK_MAX,
  VOICE_FALLBACK_NOISE_GATE_RMS_MAX,
  VOICE_INACTIVITY_WARNING_SECONDS,
  VOICE_DECIDER_HISTORY_MAX_TURNS,
  VOICE_MAX_DURATION_WARNING_SECONDS,
  VOICE_TRANSCRIPT_TIMELINE_MAX_TURNS,
  VOICE_LOOKUP_BUSY_ANNOUNCE_DELAY_MS,
  VOICE_LOOKUP_BUSY_LOG_COOLDOWN_MS,
  VOICE_LOW_SIGNAL_POST_REPLY_MAX_CLIP_MS,
  VOICE_SILENCE_GATE_ACTIVE_RATIO_MAX,
  VOICE_SILENCE_GATE_ACTIVE_SAMPLE_MIN_ABS,
  VOICE_SILENCE_GATE_MIN_CLIP_MS,
  VOICE_SILENCE_GATE_PEAK_MAX,
  VOICE_SILENCE_GATE_RMS_MAX,
  VOICE_LOOKUP_BUSY_MAX_CHARS,
  VOICE_TURN_MIN_ASR_CLIP_MS,
  VOICE_TURN_ADDRESSING_TRANSCRIPT_MAX_CHARS
} from "./voiceSessionManager.constants.ts";
import { loadPromptMemorySliceFromMemory } from "../memory/promptMemorySlice.ts";

export function resolveVoiceThoughtTopicalityBias({
  silenceMs = 0,
  minSilenceSeconds = 20,
  minSecondsBetweenThoughts = 20
} = {}) {
  const normalizedSilenceMs = Math.max(0, Number(silenceMs) || 0);
  const normalizedMinSilenceSeconds = clamp(
    Number(minSilenceSeconds) || 20,
    VOICE_THOUGHT_LOOP_MIN_SILENCE_SECONDS,
    VOICE_THOUGHT_LOOP_MAX_SILENCE_SECONDS
  );
  const normalizedMinBetweenSeconds = clamp(
    Number(minSecondsBetweenThoughts) || normalizedMinSilenceSeconds,
    VOICE_THOUGHT_LOOP_MIN_INTERVAL_SECONDS,
    VOICE_THOUGHT_LOOP_MAX_INTERVAL_SECONDS
  );
  const silenceSeconds = normalizedSilenceMs / 1000;
  const topicalStartSeconds = normalizedMinSilenceSeconds;
  const fullDriftSeconds = Math.max(
    topicalStartSeconds + 18,
    Math.round(normalizedMinBetweenSeconds * 3),
    60
  );
  const driftProgress = clamp(
    (silenceSeconds - topicalStartSeconds) / Math.max(1, fullDriftSeconds - topicalStartSeconds),
    0,
    1
  );
  const topicTetherStrength = Math.round((1 - driftProgress) * 100);
  const randomInspirationStrength = Math.round(driftProgress * 100);
  let phase = "anchored";
  let promptHint = "Keep it clearly tied to the current conversation topic.";

  if (topicTetherStrength < 35) {
    phase = "ambient";
    promptHint =
      "Treat old topic context as stale. Prefer standalone, fresh, lightly inspired lines over callbacks.";
  } else if (topicTetherStrength < 70) {
    phase = "blended";
    promptHint =
      "Mix in novelty. Keep only loose thematic links to recent dialogue, avoid direct callbacks that require context.";
  }

  return {
    silenceSeconds: Number(silenceSeconds.toFixed(2)),
    topicTetherStrength,
    randomInspirationStrength,
    phase,
    topicalStartSeconds,
    fullDriftSeconds,
    promptHint
  };
}

const VOICE_ADDRESSING_ALL_TOKENS = new Set([
  "ALL",
  "EVERYONE",
  "EVERYBODY",
  "WHOLE_ROOM",
  "WHOLE_CHAT",
  "VC"
]);

function normalizeVoiceAddressingTargetToken(value = "") {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (!normalized) return "";
  const upper = normalized.toUpperCase();
  if (VOICE_ADDRESSING_ALL_TOKENS.has(upper)) return "ALL";
  return normalized;
}

export class VoiceSessionManager {
  client;
  store;
  appConfig;
  llm;
  memory;
  composeOperationalMessage;
  generateVoiceTurn;
  sessions;
  pendingSessionGuildIds;
  joinLocks;
  boundBotAudioStreams;
  soundboardDirector;
  onVoiceStateUpdate;

  constructor({
    client,
    store,
    appConfig,
    llm = null,
    memory = null,
    composeOperationalMessage = null,
    generateVoiceTurn = null
  }) {
    this.client = client;
    this.store = store;
    this.appConfig = appConfig;
    this.llm = llm || null;
    this.memory = memory || null;
    this.composeOperationalMessage =
      typeof composeOperationalMessage === "function" ? composeOperationalMessage : null;
    this.generateVoiceTurn = typeof generateVoiceTurn === "function" ? generateVoiceTurn : null;
    this.sessions = new Map();
    this.pendingSessionGuildIds = new Set();
    this.joinLocks = new Map();
    this.boundBotAudioStreams = new WeakSet();
    this.soundboardDirector = new SoundboardDirector({
      client,
      store,
      appConfig
    });
    this.onVoiceStateUpdate = (oldState, newState) => {
      this.handleVoiceStateUpdate(oldState, newState).catch((error) => {
        this.store.logAction({
          kind: "voice_error",
          guildId: newState?.guild?.id || oldState?.guild?.id || null,
          channelId: newState?.channelId || oldState?.channelId || null,
          userId: this.client.user?.id || null,
          content: `voice_state_update: ${String(error?.message || error)}`
        });
      });
    };

    this.client.on("voiceStateUpdate", this.onVoiceStateUpdate);
  }

  getSession(guildId) {
    const id = String(guildId || "");
    if (!id) return null;
    return this.sessions.get(id) || null;
  }

  hasActiveSession(guildId) {
    return Boolean(this.getSession(guildId));
  }

  getRuntimeState() {
    const sessions = [...this.sessions.values()].map((session) => {
      const now = Date.now();
      const participants = this.getVoiceChannelParticipants(session);
      const participantDisplayByUserId = new Map(
        participants.map((entry) => [String(entry?.userId || ""), String(entry?.displayName || "")])
      );
      const membershipEvents = this.getRecentVoiceMembershipEvents(session, {
        maxItems: VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT
      });
      const activeCaptureEntries = session.userCaptures instanceof Map
        ? [...session.userCaptures.entries()]
        : [];
      const activeCaptures = activeCaptureEntries
        .map(([rawUserId, rawCapture]) => {
          const userId = String(rawUserId || "").trim();
          if (!userId) return null;
          const capture = rawCapture && typeof rawCapture === "object" ? rawCapture : {};
          const startedAtMs = Number(capture?.startedAt || 0);
          const startedAt = Number.isFinite(startedAtMs) && startedAtMs > 0
            ? new Date(startedAtMs).toISOString()
            : null;
          const ageMs = Number.isFinite(startedAtMs) && startedAtMs > 0
            ? Math.max(0, Math.round(now - startedAtMs))
            : null;
          const participantDisplayName = String(participantDisplayByUserId.get(userId) || "").trim();
          const membershipDisplayName = String(
            membershipEvents
              .slice()
              .reverse()
              .find((entry) => String(entry?.userId || "") === userId)
              ?.displayName || ""
          ).trim();
          const cachedUser = this.client?.users?.cache?.get?.(userId) || null;
          const cachedDisplayName = String(
            cachedUser?.displayName ||
              cachedUser?.globalName ||
              cachedUser?.username ||
              ""
          ).trim();
          const displayName = participantDisplayName || membershipDisplayName || cachedDisplayName || null;
          return {
            userId,
            displayName,
            startedAt,
            ageMs
          };
        })
        .filter(Boolean);
      const wakeContext = this.buildVoiceConversationContext({
        session,
        now
      });
      const addressingState = this.buildVoiceAddressingState({
        session,
        now
      });
      const joinWindowAgeMs = Math.max(0, now - Number(session?.startedAt || 0));
      const joinWindowActive = Boolean(session?.startedAt) && joinWindowAgeMs <= JOIN_GREETING_LLM_WINDOW_MS;
      const modelTurns = Array.isArray(session.recentVoiceTurns) ? session.recentVoiceTurns : [];
      const transcriptTurns = Array.isArray(session.transcriptTurns) ? session.transcriptTurns : [];
      const deferredQueue = Array.isArray(session.pendingDeferredTurns) ? session.pendingDeferredTurns : [];
      const generationSummary =
        session.modelContextSummary && typeof session.modelContextSummary === "object"
          ? session.modelContextSummary.generation || null
          : null;
      const deciderSummary =
        session.modelContextSummary && typeof session.modelContextSummary === "object"
          ? session.modelContextSummary.decider || null
          : null;
      const streamWatchRawEntries = Array.isArray(session.streamWatch?.brainContextEntries)
        ? session.streamWatch.brainContextEntries
        : [];
      const streamWatchVisualFeed = streamWatchRawEntries
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const text = String(entry.text || "").trim();
          if (!text) return null;
          const atMs = Number(entry.at || 0);
          return {
            text: text.slice(0, 220),
            at: Number.isFinite(atMs) && atMs > 0 ? new Date(atMs).toISOString() : null,
            provider: String(entry.provider || "").trim() || null,
            model: String(entry.model || "").trim() || null,
            speakerName: String(entry.speakerName || "").trim() || null
          };
        })
        .filter(Boolean);
      const streamWatchBrainContext = this.getStreamWatchBrainContextForPrompt(
        session,
        session.settingsSnapshot || null
      );
      const streamWatchLatestFrameDataBase64 = String(session.streamWatch?.latestFrameDataBase64 || "").trim();
      const streamWatchLatestFrameApproxBytes = streamWatchLatestFrameDataBase64
        ? Math.max(0, Math.floor((streamWatchLatestFrameDataBase64.length * 3) / 4))
        : 0;

      return {
        sessionId: session.id,
        guildId: session.guildId,
        voiceChannelId: session.voiceChannelId,
        textChannelId: session.textChannelId,
        startedAt: new Date(session.startedAt).toISOString(),
        lastActivityAt: new Date(session.lastActivityAt).toISOString(),
        maxEndsAt: session.maxEndsAt ? new Date(session.maxEndsAt).toISOString() : null,
        inactivityEndsAt: session.inactivityEndsAt ? new Date(session.inactivityEndsAt).toISOString() : null,
        activeInputStreams: session.userCaptures.size,
        activeCaptures,
        soundboard: {
          playCount: session.soundboard?.playCount || 0,
          lastPlayedAt: session.soundboard?.lastPlayedAt
            ? new Date(session.soundboard.lastPlayedAt).toISOString()
            : null
        },
        mode: session.mode || "voice_agent",
        botTurnOpen: Boolean(session.botTurnOpen),
        focusedSpeaker: session.focusedSpeakerUserId
          ? {
              userId: session.focusedSpeakerUserId,
              displayName: participants.find((p) => p.userId === session.focusedSpeakerUserId)?.displayName || null,
              since: session.focusedSpeakerAt ? new Date(session.focusedSpeakerAt).toISOString() : null
            }
          : null,
        conversation: {
          lastAssistantReplyAt: session.lastAssistantReplyAt
            ? new Date(session.lastAssistantReplyAt).toISOString()
            : null,
          lastDirectAddressAt: session.lastDirectAddressAt
            ? new Date(session.lastDirectAddressAt).toISOString()
            : null,
          lastDirectAddressUserId: session.lastDirectAddressUserId || null,
          wake: {
            state: wakeContext?.engaged ? "awake" : "listening",
            active: Boolean(wakeContext?.engaged),
            engagementState: wakeContext?.engagementState || "wake_word_biased",
            engagedWithCurrentSpeaker: Boolean(wakeContext?.engagedWithCurrentSpeaker),
            recentAssistantReply: Boolean(wakeContext?.recentAssistantReply),
            recentDirectAddress: Boolean(wakeContext?.recentDirectAddress),
            msSinceAssistantReply: Number.isFinite(wakeContext?.msSinceAssistantReply)
              ? Math.round(wakeContext.msSinceAssistantReply)
              : null,
            msSinceDirectAddress: Number.isFinite(wakeContext?.msSinceDirectAddress)
              ? Math.round(wakeContext.msSinceDirectAddress)
              : null,
            windowMs: FOCUSED_SPEAKER_CONTINUATION_MS
          },
          joinWindow: {
            active: joinWindowActive,
            ageMs: Math.round(joinWindowAgeMs),
            windowMs: JOIN_GREETING_LLM_WINDOW_MS
          },
          thoughtEngine: {
            busy: Boolean(session.thoughtLoopBusy),
            nextAttemptAt: session.nextThoughtAt ? new Date(session.nextThoughtAt).toISOString() : null,
            lastAttemptAt: session.lastThoughtAttemptAt
              ? new Date(session.lastThoughtAttemptAt).toISOString()
              : null,
            lastSpokenAt: session.lastThoughtSpokenAt
              ? new Date(session.lastThoughtSpokenAt).toISOString()
              : null
          },
          addressing: addressingState,
          modelContext: {
            generation: generationSummary,
            decider: deciderSummary,
            trackedTurns: modelTurns.length,
            trackedTurnLimit: VOICE_DECIDER_HISTORY_MAX_TURNS,
            trackedTranscriptTurns: transcriptTurns.length
          }
        },
        participants: participants.map((p) => ({ userId: p.userId, displayName: p.displayName })),
        participantCount: participants.length,
        membershipEvents: membershipEvents.map((entry) => ({
          userId: entry.userId,
          displayName: entry.displayName,
          eventType: entry.eventType,
          at: new Date(entry.at).toISOString(),
          ageMs: Math.max(0, Math.round(entry.ageMs))
        })),
        voiceLookupBusyCount: Number(session.voiceLookupBusyCount || 0),
        pendingDeferredTurns: deferredQueue.length,
        recentTurns: transcriptTurns.slice(-VOICE_TRANSCRIPT_TIMELINE_MAX_TURNS).map((t) => ({
          role: t.role,
          speakerName: t.speakerName || "",
          text: String(t.text || ""),
          at: t.at ? new Date(t.at).toISOString() : null,
          addressing:
            t?.addressing && typeof t.addressing === "object"
              ? {
                  talkingTo: t.addressing.talkingTo || null,
                  directedConfidence: Number.isFinite(Number(t.addressing.directedConfidence))
                    ? Number(clamp(Number(t.addressing.directedConfidence), 0, 1).toFixed(3))
                    : 0,
                  source: t.addressing.source || null,
                  reason: t.addressing.reason || null
                }
              : null
        })),
        streamWatch: {
          active: Boolean(session.streamWatch?.active),
          targetUserId: session.streamWatch?.targetUserId || null,
          requestedByUserId: session.streamWatch?.requestedByUserId || null,
          lastFrameAt: session.streamWatch?.lastFrameAt
            ? new Date(session.streamWatch.lastFrameAt).toISOString()
            : null,
          lastCommentaryAt: session.streamWatch?.lastCommentaryAt
            ? new Date(session.streamWatch.lastCommentaryAt).toISOString()
            : null,
          latestFrameAt: session.streamWatch?.latestFrameAt
            ? new Date(session.streamWatch.latestFrameAt).toISOString()
            : null,
          latestFrameMimeType: session.streamWatch?.latestFrameMimeType || null,
          latestFrameApproxBytes: streamWatchLatestFrameApproxBytes,
          acceptedFrameCountInWindow: Number(session.streamWatch?.acceptedFrameCountInWindow || 0),
          frameWindowStartedAt: session.streamWatch?.frameWindowStartedAt
            ? new Date(session.streamWatch.frameWindowStartedAt).toISOString()
            : null,
          lastBrainContextAt: session.streamWatch?.lastBrainContextAt
            ? new Date(session.streamWatch.lastBrainContextAt).toISOString()
            : null,
          lastBrainContextProvider: session.streamWatch?.lastBrainContextProvider || null,
          lastBrainContextModel: session.streamWatch?.lastBrainContextModel || null,
          brainContextCount: Array.isArray(session.streamWatch?.brainContextEntries)
            ? session.streamWatch.brainContextEntries.length
            : 0,
          ingestedFrameCount: Number(session.streamWatch?.ingestedFrameCount || 0),
          visualFeed: streamWatchVisualFeed,
          brainContextPayload: streamWatchBrainContext
            ? {
                prompt: String(streamWatchBrainContext.prompt || "").trim(),
                notes: Array.isArray(streamWatchBrainContext.notes)
                  ? streamWatchBrainContext.notes
                      .map((note) => String(note || "").trim())
                      .filter(Boolean)
                      .slice(-24)
                  : [],
                lastAt: Number(streamWatchBrainContext.lastAt || 0)
                  ? new Date(Number(streamWatchBrainContext.lastAt)).toISOString()
                  : null,
                provider: streamWatchBrainContext.provider || null,
                model: streamWatchBrainContext.model || null
              }
            : null
        },
        stt: session.mode === "stt_pipeline"
          ? {
              pendingTurns: Number(session.pendingSttTurns || 0),
              contextMessages: modelTurns.length
            }
          : null,
        realtime: isRealtimeMode(session.mode)
          ? {
              provider: session.realtimeProvider || resolveRealtimeProvider(session.mode),
              inputSampleRateHz: Number(session.realtimeInputSampleRateHz) || 24000,
              outputSampleRateHz: Number(session.realtimeOutputSampleRateHz) || 24000,
              recentVoiceTurns: modelTurns.length,
              replySuperseded: Math.max(0, Number(session.realtimeReplySupersededCount || 0)),
              pendingTurns:
                (session.realtimeTurnDrainActive ? 1 : 0) +
                (Array.isArray(session.pendingRealtimeTurns) ? session.pendingRealtimeTurns.length : 0),
              drainActive: Boolean(session.realtimeTurnDrainActive),
              state: session.realtimeClient?.getState?.() || null
            }
          : null,
        latency: (() => {
          const stages = Array.isArray(session.latencyStages) ? session.latencyStages : [];
          if (stages.length === 0) return null;
          const recentTurns = stages.slice(-8).reverse().map((e) => ({
            at: new Date(e.at).toISOString(),
            finalizedToAsrStartMs: e.finalizedToAsrStartMs ?? null,
            asrToGenerationStartMs: e.asrToGenerationStartMs ?? null,
            generationToReplyRequestMs: e.generationToReplyRequestMs ?? null,
            replyRequestToAudioStartMs: e.replyRequestToAudioStartMs ?? null,
            totalMs: e.totalMs ?? null,
            queueWaitMs: e.queueWaitMs ?? null,
            pendingQueueDepth: e.pendingQueueDepth ?? null
          }));
          const avg = (field) => {
            const vals = stages.map((e) => e[field]).filter((v) => Number.isFinite(v) && v >= 0);
            return vals.length > 0 ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
          };
          return {
            recentTurns,
            averages: {
              finalizedToAsrStartMs: avg("finalizedToAsrStartMs"),
              asrToGenerationStartMs: avg("asrToGenerationStartMs"),
              generationToReplyRequestMs: avg("generationToReplyRequestMs"),
              replyRequestToAudioStartMs: avg("replyRequestToAudioStartMs"),
              totalMs: avg("totalMs")
            },
            turnCount: stages.length
          };
        })()
      };
    });

    return {
      activeCount: sessions.length,
      sessions
    };
  }

  async requestJoin({ message, settings, intentConfidence = null }) {
    return await requestJoin(this, { message, settings, intentConfidence });
  }

  async requestLeave({ message, settings, reason = "nl_leave" }) {
    if (!message?.guild || !message?.channel) return false;

    const guildId = String(message.guild.id);
    if (!this.sessions.has(guildId)) {
      await this.sendOperationalMessage({
        channel: message.channel,
        settings,
        guildId,
        channelId: message.channelId,
        userId: message.author?.id || null,
        messageId: message.id,
        event: "voice_leave_request",
        reason: "not_in_voice",
        details: {}
      });
      return true;
    }

    await this.endSession({
      guildId,
      reason,
      requestedByUserId: message.author?.id || null,
      announceChannel: message.channel,
      announcement: "aight i'm leaving vc.",
      settings,
      messageId: message.id
    });

    return true;
  }

  async requestStatus({ message, settings }) {
    if (!message?.guild || !message?.channel) return false;

    const guildId = String(message.guild.id);
    const session = this.sessions.get(guildId);
    const requestText = String(message?.content || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220);

    if (!session) {
      await this.sendOperationalMessage({
        channel: message.channel,
        settings,
        guildId,
        channelId: message.channelId,
        userId: message.author?.id || null,
        messageId: message.id,
        event: "voice_status_request",
        reason: "offline",
        details: {}
      });
      return true;
    }

    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - session.startedAt) / 1000));
    const remainingSeconds = session.maxEndsAt
      ? Math.max(0, Math.ceil((session.maxEndsAt - Date.now()) / 1000))
      : null;
    const inactivitySeconds = session.inactivityEndsAt
      ? Math.max(0, Math.ceil((session.inactivityEndsAt - Date.now()) / 1000))
      : null;

    await this.sendOperationalMessage({
      channel: message.channel,
      settings: settings || session.settingsSnapshot,
      guildId,
      channelId: message.channelId,
      userId: message.author?.id || null,
      messageId: message.id,
      event: "voice_status_request",
      reason: "online",
      details: {
        voiceChannelId: session.voiceChannelId,
        elapsedSeconds,
        remainingSeconds: remainingSeconds ?? null,
        inactivitySeconds: inactivitySeconds ?? null,
        activeCaptures: session.userCaptures.size,
        streamWatchActive: Boolean(session.streamWatch?.active),
        streamWatchTargetUserId: session.streamWatch?.targetUserId || null,
        requestText: requestText || null
      }
    });

    return true;
  }

  async requestWatchStream({ message, settings, targetUserId = null }) {
    return await requestWatchStream(this, { message, settings, targetUserId });
  }

  initializeStreamWatchState({ session, requesterUserId, targetUserId = null }) {
    return initializeStreamWatchState(this, { session, requesterUserId, targetUserId });
  }

  supportsStreamWatchCommentary(session, settings = null) {
    return supportsStreamWatchCommentary(this, session, settings);
  }

  supportsVisionFallbackStreamWatchCommentary({ session = null, settings = null } = {}) {
    return supportsVisionFallbackStreamWatchCommentary(this, { session, settings });
  }

  supportsStreamWatchBrainContext({ session = null, settings = null } = {}) {
    return supportsStreamWatchBrainContext(this, { session, settings });
  }

  resolveStreamWatchVisionProviderSettings(settings = null) {
    return resolveStreamWatchVisionProviderSettings(this, settings);
  }

  getStreamWatchBrainContextForPrompt(session, settings = null) {
    return getStreamWatchBrainContextForPrompt(session, settings);
  }

  async generateVisionFallbackStreamWatchCommentary({
    session,
    settings,
    streamerUserId = null,
    frameMimeType = "image/jpeg",
    frameDataBase64 = ""
  }) {
    return await generateVisionFallbackStreamWatchCommentary(this, {
      session,
      settings,
      streamerUserId,
      frameMimeType,
      frameDataBase64
    });
  }

  isUserInSessionVoiceChannel({ session, userId }) {
    return isUserInSessionVoiceChannel(this, { session, userId });
  }

  async enableWatchStreamForUser({
    guildId,
    requesterUserId,
    targetUserId = null,
    settings = null,
    source = "screen_share_link"
  }) {
    return await enableWatchStreamForUser(this, {
      guildId,
      requesterUserId,
      targetUserId,
      settings,
      source
    });
  }

  async requestStopWatchingStream({ message, settings }) {
    return await requestStopWatchingStream(this, { message, settings });
  }

  async requestStreamWatchStatus({ message, settings }) {
    return await requestStreamWatchStatus(this, { message, settings });
  }

  async ingestStreamFrame({
    guildId,
    streamerUserId = null,
    mimeType = "image/jpeg",
    dataBase64 = "",
    source = "api_stream_ingest",
    settings = null
  }) {
    return await ingestStreamFrame(this, {
      guildId,
      streamerUserId,
      mimeType,
      dataBase64,
      source,
      settings
    });
  }

  async maybeTriggerStreamWatchCommentary({
    session,
    settings,
    streamerUserId = null,
    source = "api_stream_ingest"
  }) {
    return await maybeTriggerStreamWatchCommentary(this, {
      session,
      settings,
      streamerUserId,
      source
    });
  }

  async maybeTriggerAssistantDirectedSoundboard({
    session,
    settings,
    userId = null,
    transcript = "",
    requestedRef = "",
    source = "voice_transcript"
  }) {
    if (!session || session.ending) return;

    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    if (!resolvedSettings?.voice?.soundboard?.enabled) return;
    const normalizedRef = String(requestedRef || "").trim().slice(0, 180);
    if (!normalizedRef) return;

    const normalizedTranscript = normalizeVoiceText(transcript, SOUNDBOARD_DECISION_TRANSCRIPT_MAX_CHARS);
    session.soundboard = session.soundboard || {
      playCount: 0,
      lastPlayedAt: 0,
      catalogCandidates: [],
      catalogFetchedAt: 0,
      lastDirectiveKey: "",
      lastDirectiveAt: 0
    };

    const directiveKey = [
      String(source || "voice_transcript").trim().toLowerCase(),
      normalizedRef.toLowerCase(),
      String(normalizedTranscript || "").trim().toLowerCase()
    ].join("|");
    const now = Date.now();
    if (
      directiveKey &&
      directiveKey === String(session.soundboard.lastDirectiveKey || "") &&
      now - Number(session.soundboard.lastDirectiveAt || 0) < 6_000
    ) {
      return;
    }
    session.soundboard.lastDirectiveKey = directiveKey;
    session.soundboard.lastDirectiveAt = now;

    const candidateInfo = await this.resolveSoundboardCandidates({
      session,
      settings: resolvedSettings
    });
    const candidates = Array.isArray(candidateInfo?.candidates) ? candidateInfo.candidates : [];
    const candidateSource = String(candidateInfo?.source || "none");
    const byReference = matchSoundboardReference(candidates, normalizedRef);
    const byMention = byReference ? null : findMentionedSoundboardReference(candidates, normalizedRef);
    const byName =
      byReference || byMention
        ? null
        : candidates.find((entry) => String(entry?.name || "").trim().toLowerCase() === normalizedRef.toLowerCase()) ||
          candidates.find((entry) =>
            String(entry?.name || "")
              .trim()
              .toLowerCase()
              .includes(normalizedRef.toLowerCase())
          );
    const matched = byReference || byMention || byName || null;

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: userId || this.client.user?.id || null,
      content: "voice_soundboard_directive_decision",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source: String(source || "voice_transcript"),
        transcript: normalizedTranscript || null,
        requestedRef: normalizedRef,
        candidateCount: candidates.length,
        candidateSource,
        matchedReference: matched?.reference || null
      }
    });

    if (!matched) return;

    const result = await this.soundboardDirector.play({
      session,
      settings: resolvedSettings,
      soundId: matched.soundId,
      sourceGuildId: matched.sourceGuildId,
      reason: `assistant_directive_${String(source || "voice_transcript").slice(0, 50)}`
    });

    this.store.logAction({
      kind: result.ok ? "voice_runtime" : "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: userId || this.client.user?.id || null,
      content: result.ok ? "voice_soundboard_directive_played" : "voice_soundboard_directive_failed",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source: String(source || "voice_transcript"),
        transcript: normalizedTranscript || null,
        requestedRef: normalizedRef,
        soundId: matched.soundId,
        sourceGuildId: matched.sourceGuildId,
        reason: result.reason || null,
        error: result.ok ? null : shortError(result.message || "")
      }
    });
  }

  async resolveSoundboardCandidates({ session = null, settings, guild = null }) {
    const preferred = parsePreferredSoundboardReferences(settings?.voice?.soundboard?.preferredSoundIds);
    if (preferred.length) {
      return {
        source: "preferred",
        candidates: preferred.slice(0, SOUNDBOARD_MAX_CANDIDATES)
      };
    }

    const guildCandidates = await this.fetchGuildSoundboardCandidates({
      session,
      guild
    });
    if (guildCandidates.length) {
      return {
        source: "guild_catalog",
        candidates: guildCandidates.slice(0, SOUNDBOARD_MAX_CANDIDATES)
      };
    }

    return {
      source: "none",
      candidates: []
    };
  }

  async fetchGuildSoundboardCandidates({ session = null, guild = null }) {
    if (session && session.ending) return [];
    const now = Date.now();

    let cached = [];
    if (session) {
      session.soundboard = session.soundboard || {
        playCount: 0,
        lastPlayedAt: 0,
        catalogCandidates: [],
        catalogFetchedAt: 0,
        lastDirectiveKey: "",
        lastDirectiveAt: 0
      };
      cached = Array.isArray(session.soundboard.catalogCandidates)
        ? session.soundboard.catalogCandidates.filter(Boolean)
        : [];
      const lastFetchedAt = Number(session.soundboard.catalogFetchedAt || 0);
      if (lastFetchedAt > 0 && now - lastFetchedAt < SOUNDBOARD_CATALOG_REFRESH_MS) {
        return cached;
      }
    }

    const resolvedGuild = guild || this.client.guilds.cache.get(String(session?.guildId || ""));
    if (!resolvedGuild?.soundboardSounds?.fetch) {
      return cached || [];
    }

    try {
      const fetched = await resolvedGuild.soundboardSounds.fetch();
      const candidates = [];
      fetched.forEach((sound) => {
        if (!sound || sound.available === false) return;
        const soundId = String(sound.soundId || "").trim();
        if (!soundId) return;
        const name = String(sound.name || "").trim();
        candidates.push({
          soundId,
          sourceGuildId: null,
          reference: soundId,
          name: name || null,
          origin: "guild_catalog"
        });
      });

      const deduped = dedupeSoundboardCandidates(candidates).slice(0, SOUNDBOARD_MAX_CANDIDATES);
      if (session?.soundboard) {
        session.soundboard.catalogCandidates = deduped;
        session.soundboard.catalogFetchedAt = now;
      }
      return deduped;
    } catch (error) {
      if (session) {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          content: `voice_soundboard_catalog_fetch_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id
          }
        });
        session.soundboard.catalogFetchedAt = now;
      }
      return cached || [];
    }
  }

  async stopAll(reason = "shutdown") {
    const guildIds = [...this.sessions.keys()];
    for (const guildId of guildIds) {
      await this.endSession({ guildId, reason, announcement: null });
    }
  }

  async dispose(reason = "shutdown") {
    if (this.onVoiceStateUpdate) {
      this.client.off("voiceStateUpdate", this.onVoiceStateUpdate);
      this.onVoiceStateUpdate = null;
    }

    await this.stopAll(reason);
    this.pendingSessionGuildIds.clear();
    this.joinLocks.clear();
  }

  async withJoinLock(guildId, fn) {
    const key = String(guildId || "");
    if (!key) return await fn();

    const previous = this.joinLocks.get(key) || Promise.resolve();
    let release = null;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.joinLocks.set(key, current);

    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      if (typeof release === "function") {
        release();
      }
      if (this.joinLocks.get(key) === current) {
        this.joinLocks.delete(key);
      }
    }
  }

  async reconcileSettings(settings) {
    const voiceEnabled = Boolean(settings?.voice?.enabled);
    const allowlist = new Set(settings?.voice?.allowedVoiceChannelIds || []);
    const blocklist = new Set(settings?.voice?.blockedVoiceChannelIds || []);

    for (const session of [...this.sessions.values()]) {
      session.settingsSnapshot = settings || session.settingsSnapshot;

      if (!voiceEnabled) {
        await this.endSession({
          guildId: session.guildId,
          reason: "settings_disabled",
          announcement: "voice mode was disabled, leaving vc.",
          settings
        });
        continue;
      }

      if (blocklist.has(session.voiceChannelId)) {
        await this.endSession({
          guildId: session.guildId,
          reason: "settings_channel_blocked",
          announcement: "this vc is now blocked for me, leaving.",
          settings
        });
        continue;
      }

      if (allowlist.size > 0 && !allowlist.has(session.voiceChannelId)) {
        await this.endSession({
          guildId: session.guildId,
          reason: "settings_channel_not_allowlisted",
          announcement: "this vc is no longer allowlisted, leaving.",
          settings
        });
        continue;
      }

      this.touchActivity(session.guildId, settings);
    }
  }

  startSessionTimers(session, settings) {
    const maxSessionMinutes = clamp(
      Number(settings.voice?.maxSessionMinutes) || 30,
      MIN_MAX_SESSION_MINUTES,
      MAX_MAX_SESSION_MINUTES
    );
    const maxDurationMs = maxSessionMinutes * 60_000;

    session.maxEndsAt = Date.now() + maxDurationMs;
    session.maxTimer = setTimeout(() => {
      this.endSession({
        guildId: session.guildId,
        reason: "max_duration",
        announcement: `max session time (${maxSessionMinutes}m) reached, leaving vc.`,
        settings
      }).catch(() => undefined);
    }, maxDurationMs);

    this.touchActivity(session.guildId, settings);
  }

  touchActivity(guildId, settings) {
    const session = this.sessions.get(String(guildId));
    if (!session) return;

    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();

    const inactivitySeconds = clamp(
      Number(resolvedSettings?.voice?.inactivityLeaveSeconds) || 300,
      MIN_INACTIVITY_SECONDS,
      MAX_INACTIVITY_SECONDS
    );

    session.lastActivityAt = Date.now();
    if (session.inactivityTimer) clearTimeout(session.inactivityTimer);

    session.inactivityEndsAt = Date.now() + inactivitySeconds * 1000;
    session.inactivityTimer = setTimeout(() => {
      this.endSession({
        guildId: session.guildId,
        reason: "inactivity_timeout",
        announcement: `no one talked for ${inactivitySeconds}s, leaving vc.`,
        settings: resolvedSettings
      }).catch(() => undefined);
    }, inactivitySeconds * 1000);

    this.scheduleVoiceThoughtLoop({
      session,
      settings: resolvedSettings
    });
  }

  buildVoiceSessionTimingContext(session) {
    if (!session || typeof session !== "object") return null;

    const now = Date.now();
    const maxEndsAt = Number(session.maxEndsAt);
    const inactivityEndsAt = Number(session.inactivityEndsAt);
    const maxSecondsRemaining = Number.isFinite(maxEndsAt)
      ? Math.max(0, Math.ceil((maxEndsAt - now) / 1000))
      : null;
    const inactivitySecondsRemaining = Number.isFinite(inactivityEndsAt)
      ? Math.max(0, Math.ceil((inactivityEndsAt - now) / 1000))
      : null;

    const maxDurationWarningActive =
      Number.isFinite(maxSecondsRemaining) && maxSecondsRemaining <= VOICE_MAX_DURATION_WARNING_SECONDS;
    const inactivityWarningActive =
      Number.isFinite(inactivitySecondsRemaining) && inactivitySecondsRemaining <= VOICE_INACTIVITY_WARNING_SECONDS;

    let timeoutWarningReason = "none";
    if (maxDurationWarningActive && inactivityWarningActive) {
      timeoutWarningReason =
        maxSecondsRemaining <= inactivitySecondsRemaining
          ? "max_duration"
          : "inactivity";
    } else if (maxDurationWarningActive) {
      timeoutWarningReason = "max_duration";
    } else if (inactivityWarningActive) {
      timeoutWarningReason = "inactivity";
    }

    return {
      timeoutWarningActive: maxDurationWarningActive || inactivityWarningActive,
      timeoutWarningReason,
      maxSecondsRemaining,
      inactivitySecondsRemaining
    };
  }

  bindAudioPlayerHandlers(session) {
    const onStateChange = (oldState, newState) => {
      if (oldState.status !== AudioPlayerStatus.Playing && newState.status === AudioPlayerStatus.Playing) {
        session.lastActivityAt = Date.now();
      }
    };

    session.audioPlayer.on("stateChange", onStateChange);
    session.cleanupHandlers.push(() => {
      session.audioPlayer.off("stateChange", onStateChange);
    });
  }

  describeBotAudioStreamState(stream) {
    if (!stream || typeof stream !== "object") {
      return {
        exists: false,
        destroyed: null,
        writableEnded: null,
        writableFinished: null,
        closed: null,
        writableLength: 0
      };
    }

    return {
      exists: true,
      destroyed: Boolean(stream.destroyed),
      writableEnded: Boolean(stream.writableEnded),
      writableFinished: Boolean(stream.writableFinished),
      closed: Boolean(stream.closed),
      writableLength: Math.max(0, Number(stream.writableLength || 0))
    };
  }

  bindBotAudioStreamLifecycle(session, { stream = session?.botAudioStream, source = "unknown" } = {}) {
    if (!session || !stream || typeof stream.once !== "function") return;
    if (this.boundBotAudioStreams?.has(stream)) return;
    this.boundBotAudioStreams?.add(stream);
    if (!Array.isArray(session.cleanupHandlers)) {
      session.cleanupHandlers = [];
    }

    const resolvedSource = String(source || "unknown");
    const logLifecycle = (event, extraMetadata = null) => {
      const normalizedEvent = String(event || "unknown");
      const details = extraMetadata && typeof extraMetadata === "object" ? extraMetadata : {};
      const streamState = this.describeBotAudioStreamState(stream);
      const lifecycle = {
        event: normalizedEvent,
        source: resolvedSource,
        at: new Date().toISOString(),
        error: details.error || null,
        streamState
      };
      session.lastBotAudioStreamLifecycle = lifecycle;
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "bot_audio_stream_lifecycle",
        metadata: {
          sessionId: session.id,
          event: normalizedEvent,
          source: resolvedSource,
          error: details.error || null,
          streamState
        }
      });
    };

    const maybeRepairPlayback = (triggerEvent) => {
      if (!session || session.ending) return;
      if (stream !== session.botAudioStream) return;
      const queueState =
        session.audioPlaybackQueue && typeof session.audioPlaybackQueue === "object"
          ? session.audioPlaybackQueue
          : null;
      const queuedBytes = Math.max(0, Number(queueState?.queuedBytes || 0));
      const streamBufferedBytes = Math.max(0, Number(stream?.writableLength || 0));
      const hasPendingResponse = Boolean(session.pendingResponse && typeof session.pendingResponse === "object");
      const hasActiveRealtimeResponse = this.isOpenAiRealtimeResponseActive(session);
      const hasPlaybackDemand =
        Boolean(session.botTurnOpen) ||
        hasPendingResponse ||
        hasActiveRealtimeResponse ||
        queuedBytes > 0 ||
        streamBufferedBytes > 0;
      if (!hasPlaybackDemand) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          content: "bot_audio_stream_lifecycle_repair_skipped_idle",
          metadata: {
            sessionId: session.id,
            triggerEvent: String(triggerEvent || "unknown"),
            queuedBytes,
            streamBufferedBytes,
            botTurnOpen: Boolean(session.botTurnOpen),
            pendingResponse: hasPendingResponse,
            openAiActiveResponse: hasActiveRealtimeResponse
          }
        });
        return;
      }
      ensureBotAudioPlaybackReady({
        session,
        store: this.store,
        botUserId: this.client.user?.id || null,
        onStreamCreated: (replacementStream) => {
          this.bindBotAudioStreamLifecycle(session, {
            stream: replacementStream,
            source: "stream_lifecycle_repair"
          });
        }
      });
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "bot_audio_stream_lifecycle_repair_attempted",
        metadata: {
          sessionId: session.id,
          triggerEvent: String(triggerEvent || "unknown")
        }
      });
    };

    const onClose = () => {
      logLifecycle("close");
      maybeRepairPlayback("close");
    };
    const onFinish = () => {
      logLifecycle("finish");
    };
    const onEnd = () => {
      logLifecycle("end");
    };
    const onError = (error) => {
      logLifecycle("error", {
        error: String(error?.message || error || "unknown")
      });
      maybeRepairPlayback("error");
    };

    stream.once("close", onClose);
    stream.once("finish", onFinish);
    stream.once("end", onEnd);
    stream.once("error", onError);

    session.cleanupHandlers.push(() => {
      if (typeof stream.removeListener === "function") {
        stream.removeListener("close", onClose);
        stream.removeListener("finish", onFinish);
        stream.removeListener("end", onEnd);
        stream.removeListener("error", onError);
      }
      this.boundBotAudioStreams?.delete(stream);
    });
  }

  isBargeInOutputSuppressed(session, now = Date.now()) {
    if (!session) return false;
    const suppressedUntil = Number(session.bargeInSuppressionUntil || 0);
    if (suppressedUntil <= 0) return false;
    if (now < suppressedUntil) return true;
    this.clearBargeInOutputSuppression(session, "timeout");
    return false;
  }

  clearBargeInOutputSuppression(session, reason = "cleared") {
    if (!session) return;
    const suppressedUntil = Number(session.bargeInSuppressionUntil || 0);
    if (suppressedUntil <= 0) return;
    const droppedChunks = Math.max(0, Number(session.bargeInSuppressedAudioChunks || 0));
    const droppedBytes = Math.max(0, Number(session.bargeInSuppressedAudioBytes || 0));

    session.bargeInSuppressionUntil = 0;
    session.bargeInSuppressedAudioChunks = 0;
    session.bargeInSuppressedAudioBytes = 0;

    if (reason === "timeout" && droppedChunks <= 0 && droppedBytes <= 0) return;
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.client.user?.id || null,
      content: "voice_barge_in_suppression_cleared",
      metadata: {
        sessionId: session.id,
        reason: String(reason || "cleared"),
        droppedAudioChunks: droppedChunks,
        droppedAudioBytes: droppedBytes
      }
    });
  }

  isBargeInInterruptTargetActive(session) {
    if (!session || session.ending) return false;
    if (this.isBargeInOutputSuppressed(session)) return false;
    return this.getReplyOutputLockState(session).locked;
  }

  normalizeReplyInterruptionPolicy(rawPolicy = null) {
    const policy = rawPolicy && typeof rawPolicy === "object" ? rawPolicy : null;
    if (!policy) return null;

    const normalizedTalkingTo = normalizeVoiceAddressingTargetToken(policy.talkingTo || "");
    const scopeRaw = String(policy.scope || "")
      .trim()
      .toLowerCase();
    const scope = scopeRaw === "all" || normalizedTalkingTo === "ALL" ? "all" : "speaker";
    const allowedUserId = String(policy.allowedUserId || "").trim() || null;
    const assertive =
      policy.assertive === undefined
        ? scope === "all" || Boolean(allowedUserId)
        : Boolean(policy.assertive);
    if (!assertive) return null;
    if (scope === "speaker" && !allowedUserId) return null;

    const normalizedReason =
      String(policy.reason || "")
        .replace(/\s+/g, "_")
        .trim()
        .toLowerCase()
        .slice(0, 80) || null;
    const normalizedSource =
      String(policy.source || "")
        .replace(/\s+/g, "_")
        .trim()
        .toLowerCase()
        .slice(0, 80) || null;

    return {
      assertive: true,
      scope,
      allowedUserId: scope === "all" ? null : allowedUserId,
      talkingTo: normalizedTalkingTo || null,
      reason: normalizedReason,
      source: normalizedSource
    };
  }

  buildReplyInterruptionPolicy({
    session = null,
    userId = null,
    directAddressed = false,
    conversationContext = null,
    generatedVoiceAddressing = null,
    source = "realtime"
  } = {}) {
    if (!session || session.ending) return null;
    const normalizedUserId = String(userId || "").trim() || null;
    const normalizedTalkingTo = normalizeVoiceAddressingTargetToken(generatedVoiceAddressing?.talkingTo || "");
    const targetsAll = normalizedTalkingTo === "ALL";
    const engagedWithCurrentSpeaker = Boolean(conversationContext?.engagedWithCurrentSpeaker);
    const assertive = Boolean(directAddressed) || engagedWithCurrentSpeaker || targetsAll;
    if (!assertive) return null;

    const scope = targetsAll ? "all" : "speaker";
    const reason = targetsAll
      ? "assistant_target_all"
      : directAddressed
        ? "direct_addressed"
        : engagedWithCurrentSpeaker
          ? "engaged_continuation"
          : "assertive_reply";

    return this.normalizeReplyInterruptionPolicy({
      assertive: true,
      scope,
      allowedUserId: scope === "speaker" ? normalizedUserId : null,
      talkingTo: normalizedTalkingTo || null,
      reason,
      source
    });
  }

  isUserAllowedToInterruptReply({
    policy = null,
    userId = null
  } = {}) {
    const normalizedPolicy = this.normalizeReplyInterruptionPolicy(policy);
    if (!normalizedPolicy?.assertive) return true;
    if (normalizedPolicy.scope === "all") return false;
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return false;
    return normalizedUserId === String(normalizedPolicy.allowedUserId || "");
  }

  setActiveReplyInterruptionPolicy(session, policy = null) {
    if (!session) return;
    session.activeReplyInterruptionPolicy = this.normalizeReplyInterruptionPolicy(policy);
  }

  maybeClearActiveReplyInterruptionPolicy(session) {
    if (!session || session.ending) return;
    const lockState = this.getReplyOutputLockState(session);
    if (lockState.locked) return;
    session.activeReplyInterruptionPolicy = null;
  }

  getRealtimeReplySupersedeState({
    session,
    generationStartedAt = 0,
    interruptionPolicy = null
  }) {
    const normalizedPolicy = this.normalizeReplyInterruptionPolicy(interruptionPolicy);
    const activeCaptureUserIds = session?.userCaptures instanceof Map
      ? [...session.userCaptures.keys()].map((entry) => String(entry || "").trim()).filter(Boolean)
      : [];
    const pendingRealtimeTurns = Array.isArray(session?.pendingRealtimeTurns) ? session.pendingRealtimeTurns : [];
    const sampleRateHz = isRealtimeMode(session?.mode)
      ? Number(session?.realtimeInputSampleRateHz) || 24000
      : 24000;
    const pendingRealtimeTurnSummaries = pendingRealtimeTurns.map((entry) => {
      const userId = String(entry?.userId || "").trim();
      const rawPcmBuffer = entry?.pcmBuffer;
      const pcmBuffer = Buffer.isBuffer(rawPcmBuffer)
        ? rawPcmBuffer
        : rawPcmBuffer && ArrayBuffer.isView(rawPcmBuffer)
          ? Buffer.from(rawPcmBuffer.buffer, rawPcmBuffer.byteOffset, rawPcmBuffer.byteLength)
          : null;
      const silenceGate = pcmBuffer?.length
        ? this.evaluatePcmSilenceGate({
            pcmBuffer,
            sampleRateHz
          })
        : null;
      return {
        userId,
        eligibleForSupersede: !silenceGate?.drop
      };
    });
    const totalPendingRealtimeQueueDepth = pendingRealtimeTurnSummaries.length;
    const pendingRealtimeTurnUserIds = pendingRealtimeTurnSummaries
      .filter((entry) => entry.eligibleForSupersede)
      .map((entry) => entry.userId)
      .filter(Boolean);

    const activeCaptureCount = activeCaptureUserIds.length;
    const pendingRealtimeQueueDepth = pendingRealtimeTurnUserIds.length;
    const pendingNearSilentQueueDepth = Math.max(0, totalPendingRealtimeQueueDepth - pendingRealtimeQueueDepth);
    const interruptingActiveCaptureCount = activeCaptureUserIds.filter((captureUserId) =>
      this.isUserAllowedToInterruptReply({
        policy: normalizedPolicy,
        userId: captureUserId
      })
    ).length;
    const interruptingPendingQueueDepth = pendingRealtimeTurnUserIds.filter((turnUserId) =>
      this.isUserAllowedToInterruptReply({
        policy: normalizedPolicy,
        userId: turnUserId
      })
    ).length;
    const normalizedGenerationStartedAt = Math.max(0, Number(generationStartedAt) || 0);
    const lastInboundAudioAt = Math.max(0, Number(session?.lastInboundAudioAt || 0));
    const rawNewerInboundAudio = normalizedGenerationStartedAt > 0 && lastInboundAudioAt > normalizedGenerationStartedAt;
    const newerInboundAudio = rawNewerInboundAudio;
    const shouldSupersede =
      interruptingActiveCaptureCount > 0 ||
      interruptingPendingQueueDepth > 0 ||
      newerInboundAudio;
    return {
      shouldSupersede,
      activeCaptureCount,
      pendingRealtimeQueueDepth,
      totalPendingRealtimeQueueDepth,
      pendingNearSilentQueueDepth,
      interruptingActiveCaptureCount,
      interruptingPendingQueueDepth,
      ignoredActiveCaptureCount: Math.max(0, activeCaptureCount - interruptingActiveCaptureCount),
      ignoredPendingQueueDepth: Math.max(0, pendingRealtimeQueueDepth - interruptingPendingQueueDepth),
      newerInboundAudio,
      rawNewerInboundAudio,
      generationStartedAt: normalizedGenerationStartedAt,
      lastInboundAudioAt,
      interruptionPolicy: normalizedPolicy
    };
  }

  recordRealtimeReplySuperseded({
    session,
    source = "realtime",
    supersedeState = null
  }) {
    if (!session || session.ending) return;
    const normalizedSupersedeState =
      supersedeState && typeof supersedeState === "object" ? supersedeState : {};
    const activeCaptureCount = Number(normalizedSupersedeState.activeCaptureCount || 0);
    const pendingRealtimeQueueDepth = Number(normalizedSupersedeState.pendingRealtimeQueueDepth || 0);
    const totalPendingRealtimeQueueDepth = Number(normalizedSupersedeState.totalPendingRealtimeQueueDepth || 0);
    const pendingNearSilentQueueDepth = Number(normalizedSupersedeState.pendingNearSilentQueueDepth || 0);
    const interruptingActiveCaptureCount = Number(normalizedSupersedeState.interruptingActiveCaptureCount || 0);
    const interruptingPendingQueueDepth = Number(normalizedSupersedeState.interruptingPendingQueueDepth || 0);
    const ignoredActiveCaptureCount = Number(normalizedSupersedeState.ignoredActiveCaptureCount || 0);
    const ignoredPendingQueueDepth = Number(normalizedSupersedeState.ignoredPendingQueueDepth || 0);
    const newerInboundAudio = Boolean(normalizedSupersedeState.newerInboundAudio);
    const rawNewerInboundAudio = Boolean(normalizedSupersedeState.rawNewerInboundAudio);
    const interruptionPolicy = this.normalizeReplyInterruptionPolicy(normalizedSupersedeState.interruptionPolicy);
    const supersedeReason = newerInboundAudio
      ? "newer_inbound_audio"
      : interruptingPendingQueueDepth > 0
        ? "pending_realtime_turn"
        : interruptingActiveCaptureCount > 0
          ? "active_user_capture"
          : pendingRealtimeQueueDepth > 0
            ? "pending_realtime_turn_ignored_by_policy"
            : "active_user_capture_ignored_by_policy";
    const nextCount = Math.max(0, Number(session.realtimeReplySupersededCount || 0)) + 1;
    session.realtimeReplySupersededCount = nextCount;

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.client.user?.id || null,
      content: "realtime_reply_superseded_newer_input",
      metadata: {
        sessionId: session.id,
        source: String(source || "realtime"),
        supersedeReason,
        activeCaptureCount,
        pendingRealtimeQueueDepth,
        totalPendingRealtimeQueueDepth,
        pendingNearSilentQueueDepth,
        interruptingActiveCaptureCount,
        interruptingPendingQueueDepth,
        ignoredActiveCaptureCount,
        ignoredPendingQueueDepth,
        newerInboundAudio,
        rawNewerInboundAudio,
        generationStartedAt: Number(normalizedSupersedeState.generationStartedAt || 0) || null,
        lastInboundAudioAt: Number(normalizedSupersedeState.lastInboundAudioAt || 0) || null,
        interruptionPolicyScope: interruptionPolicy?.scope || null,
        interruptionPolicyReason: interruptionPolicy?.reason || null,
        interruptionPolicyAllowedUserId: interruptionPolicy?.allowedUserId || null,
        interruptionPolicyTalkingTo: interruptionPolicy?.talkingTo || null,
        supersededCount: nextCount
      }
    });
  }

  maybeInterruptBotForAssertiveSpeech({
    session,
    userId = null,
    source = "speaking_start"
  }) {
    if (!session || session.ending) return false;
    if (!this.isBargeInInterruptTargetActive(session)) return false;
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return false;
    if (
      !this.isUserAllowedToInterruptReply({
        policy: session.activeReplyInterruptionPolicy,
        userId: normalizedUserId
      })
    ) {
      return false;
    }
    const capture = session.userCaptures?.get?.(normalizedUserId);
    if (!capture) return false;
    if (capture.speakingEndFinalizeTimer) return false;
    const sampleRateHz = isRealtimeMode(session.mode)
      ? Number(session.realtimeInputSampleRateHz) || 24000
      : 24000;
    const minCaptureBytes = Math.max(2, Math.ceil((sampleRateHz * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000));
    if (Number(capture.bytesSent || 0) < minCaptureBytes) return false;
    if (!this.isCaptureSignalAssertive(capture)) return false;

    return this.interruptBotSpeechForBargeIn({
      session,
      userId: normalizedUserId,
      source: String(source || "speaking_start"),
      minCaptureBytes
    });
  }

  isCaptureSignalAssertive(capture) {
    if (!capture || typeof capture !== "object") return false;
    const sampleCount = Math.max(0, Number(capture.signalSampleCount || 0));
    if (sampleCount <= 0) return false;

    const activeSampleCount = Math.max(0, Number(capture.signalActiveSampleCount || 0));
    const peakAbs = Math.max(0, Number(capture.signalPeakAbs || 0));
    const activeSampleRatio = activeSampleCount / sampleCount;
    const peak = peakAbs / 32768;

    const nearSilentSignal =
      activeSampleRatio <= VOICE_SILENCE_GATE_ACTIVE_RATIO_MAX &&
      peak <= VOICE_SILENCE_GATE_PEAK_MAX;
    return !nearSilentSignal;
  }

  isCaptureEligibleForActivityTouch({ session, capture }) {
    if (!session || !capture || typeof capture !== "object") return false;
    const sampleRateHz = isRealtimeMode(session.mode)
      ? Number(session.realtimeInputSampleRateHz) || 24000
      : 24000;
    const minSpeechBytes = Math.max(
      2,
      Math.ceil((sampleRateHz * 2 * ACTIVITY_TOUCH_MIN_SPEECH_MS) / 1000)
    );
    if (Number(capture.bytesSent || 0) < minSpeechBytes) return false;
    return this.isCaptureSignalAssertive(capture);
  }

  hasAssertiveInboundCapture(session) {
    if (!session || !(session.userCaptures instanceof Map) || session.userCaptures.size <= 0) return false;
    const sampleRateHz = isRealtimeMode(session.mode)
      ? Number(session.realtimeInputSampleRateHz) || 24000
      : 24000;
    const minCaptureBytes = Math.max(2, Math.ceil((sampleRateHz * 2 * BARGE_IN_MIN_SPEECH_MS) / 1000));

    for (const capture of session.userCaptures.values()) {
      if (!capture || typeof capture !== "object") continue;
      if (capture.speakingEndFinalizeTimer) continue;
      if (Number(capture.bytesSent || 0) < minCaptureBytes) continue;
      if (!this.isCaptureSignalAssertive(capture)) continue;
      return true;
    }
    return false;
  }

  interruptBotSpeechForBargeIn({
    session,
    userId = null,
    source = "speaking_start",
    minCaptureBytes = 0
  }) {
    if (!session || session.ending) return false;

    const queueState = this.ensureAudioPlaybackQueueState(session);
    const queuedBytes = Math.max(0, Number(queueState?.queuedBytes || 0));
    const now = Date.now();
    const pendingRequestId = Number(session.pendingResponse?.requestId || 0) || null;
    const interruptionPolicy = this.normalizeReplyInterruptionPolicy(
      session.pendingResponse?.interruptionPolicy || session.activeReplyInterruptionPolicy
    );
    const retryUtteranceText = normalizeVoiceText(
      session.pendingResponse?.utteranceText || session.lastRequestedRealtimeUtterance?.utteranceText || "",
      STT_REPLY_MAX_CHARS
    );
    let responseCancelAttempted = false;
    let responseCancelSucceeded = false;
    let responseCancelError = null;

    const cancelActiveResponse = session.realtimeClient?.cancelActiveResponse;
    if (typeof cancelActiveResponse === "function") {
      responseCancelAttempted = true;
      try {
        responseCancelSucceeded = Boolean(cancelActiveResponse.call(session.realtimeClient));
      } catch (error) {
        responseCancelError = shortError(error);
      }
    }

    this.clearAudioPlaybackQueue(session);
    if (session.botTurnResetTimer) {
      clearTimeout(session.botTurnResetTimer);
      session.botTurnResetTimer = null;
    }
    session.botTurnOpen = false;

    try {
      session.audioPlayer?.stop?.(true);
    } catch {
      // ignore
    }

    try {
      session.botAudioStream?.destroy?.();
    } catch {
      // ignore
    }
    session.botAudioStream = null;

    if (session.pendingResponse && typeof session.pendingResponse === "object") {
      session.lastAudioDeltaAt = Math.max(Number(session.lastAudioDeltaAt || 0), now);
      session.pendingResponse.audioReceivedAt = Number(session.lastAudioDeltaAt || now);
    }

    if (isRealtimeMode(session.mode) && retryUtteranceText) {
      session.pendingBargeInRetry = {
        utteranceText: retryUtteranceText,
        interruptedByUserId: String(userId || "").trim() || null,
        interruptedAt: now,
        source: String(source || "speaking_start"),
        interruptionPolicy
      };
    } else {
      session.pendingBargeInRetry = null;
    }

    session.bargeInSuppressionUntil = now + BARGE_IN_SUPPRESSION_MAX_MS;
    session.bargeInSuppressedAudioChunks = 0;
    session.bargeInSuppressedAudioBytes = 0;

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: String(userId || "").trim() || null,
      content: "voice_barge_in_interrupt",
      metadata: {
        sessionId: session.id,
        source: String(source || "speaking_start"),
        queuedBytesDropped: queuedBytes,
        pendingRequestId,
        minCaptureBytes: Math.max(0, Number(minCaptureBytes || 0)),
        suppressionMs: BARGE_IN_SUPPRESSION_MAX_MS,
        queuedRetryUtterance: Boolean(isRealtimeMode(session.mode) && retryUtteranceText),
        retryInterruptionPolicyScope: interruptionPolicy?.scope || null,
        retryInterruptionPolicyAllowedUserId: interruptionPolicy?.allowedUserId || null,
        responseCancelAttempted,
        responseCancelSucceeded,
        responseCancelError
      }
    });
    return true;
  }

  armAssertiveBargeIn({
    session,
    userId = null,
    source = "speaking_start",
    delayMs = BARGE_IN_ASSERTION_MS
  }) {
    if (!session || session.ending) return;
    if (!this.isBargeInInterruptTargetActive(session)) return;
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return;
    const capture = session.userCaptures?.get?.(normalizedUserId);
    if (!capture) return;
    if (capture.speakingEndFinalizeTimer) return;
    if (capture.bargeInAssertTimer) return;
    const waitMs = Math.max(60, Math.round(Number(delayMs) || BARGE_IN_ASSERTION_MS));
    capture.bargeInAssertTimer = setTimeout(() => {
      capture.bargeInAssertTimer = null;
      const interrupted = this.maybeInterruptBotForAssertiveSpeech({
        session,
        userId: normalizedUserId,
        source: String(source || "speaking_start")
      });
      if (interrupted) return;
      const currentCapture = session.userCaptures?.get?.(normalizedUserId);
      if (!currentCapture || currentCapture.speakingEndFinalizeTimer || !session.botTurnOpen) return;
      this.armAssertiveBargeIn({
        session,
        userId: normalizedUserId,
        source: String(source || "speaking_start"),
        delayMs: Math.max(160, Math.round(BARGE_IN_ASSERTION_MS / 2))
      });
    }, waitMs);
  }

  bindRealtimeHandlers(session, settings = session.settingsSnapshot) {
    if (!session?.realtimeClient) return;
    const runtimeLabel = getRealtimeRuntimeLabel(session.mode);
    const onAudioDelta = (audioBase64) => {
      let chunk = null;
      try {
        chunk = Buffer.from(String(audioBase64 || ""), "base64");
      } catch {
        return;
      }
      if (!chunk || !chunk.length) return;

      const discordPcm = convertXaiOutputToDiscordPcm(
        chunk,
        Number(session.realtimeOutputSampleRateHz) || 24000
      );
      if (!discordPcm.length) return;

      if (this.isBargeInOutputSuppressed(session)) {
        session.lastAudioDeltaAt = Date.now();
        session.bargeInSuppressedAudioChunks = Math.max(0, Number(session.bargeInSuppressedAudioChunks || 0)) + 1;
        session.bargeInSuppressedAudioBytes = Math.max(0, Number(session.bargeInSuppressedAudioBytes || 0)) + discordPcm.length;
        const pending = session.pendingResponse;
        if (pending && typeof pending === "object") {
          pending.audioReceivedAt = Number(session.lastAudioDeltaAt || Date.now());
        }
        return;
      }

      if (
        !ensureBotAudioPlaybackReady({
          session,
          store: this.store,
          botUserId: this.client.user?.id || null,
          onStreamCreated: (stream) => {
            this.bindBotAudioStreamLifecycle(session, {
              stream,
              source: "pipeline_restart"
            });
          }
        })
      ) {
        return;
      }

      session.lastAudioDeltaAt = Date.now();
      if (
        !this.enqueueDiscordPcmForPlayback({
          session,
          discordPcm
        })
      ) {
        return;
      }
      this.markBotTurnOut(session, settings);
      if (session.mode === "openai_realtime") {
        session.pendingRealtimeInputBytes = 0;
      }

      if (this.pendingResponseHasAudio(session)) {
        const pending = session.pendingResponse;
        if (pending) {
          pending.audioReceivedAt = session.lastAudioDeltaAt;
        }
        this.clearResponseSilenceTimers(session);
      }
    };

    const onTranscript = (payload) => {
      const transcriptText =
        payload && typeof payload === "object" ? payload.text : payload;
      const transcriptEventType =
        payload && typeof payload === "object" ? String(payload.eventType || "") : "";
      const transcript = String(transcriptText || "").trim();
      if (!transcript) return;
      const transcriptSource = transcriptSourceFromEventType(transcriptEventType);
      const finalTranscriptEvent = isFinalRealtimeTranscriptEventType(transcriptEventType, transcriptSource);
      const parsedDirective =
        transcriptSource === "output"
          ? parseSoundboardDirectiveSequence(transcript)
          : {
              text: transcript,
              references: []
            };
      const transcriptForLogs = String(parsedDirective?.text || transcript).trim();
      const requestedSoundboardRefs = this.normalizeSoundboardRefs(parsedDirective?.references || []);
      if (finalTranscriptEvent) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          content: `${runtimeLabel}_transcript`,
          metadata: {
            sessionId: session.id,
            transcript: transcriptForLogs || transcript,
            transcriptEventType: transcriptEventType || null,
            transcriptSource,
            soundboardRefs: requestedSoundboardRefs.length ? requestedSoundboardRefs : null
          }
        });
      }

      if (session.mode === "openai_realtime" && transcriptSource === "output") {
        session.pendingRealtimeInputBytes = 0;
      }
      const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
      const useNativeRealtimeReply = this.shouldUseNativeRealtimeReply({
        session,
        settings: resolvedSettings
      });
      if (
        transcriptSource === "output" &&
        transcriptForLogs &&
        finalTranscriptEvent &&
        useNativeRealtimeReply
      ) {
        this.recordVoiceTurn(session, {
          role: "assistant",
          userId: this.client.user?.id || null,
          text: transcriptForLogs
        });
      }

      if (transcriptSource === "output" && requestedSoundboardRefs.length > 0 && finalTranscriptEvent) {
        (async () => {
          let directiveIndex = 0;
          for (const requestedRef of requestedSoundboardRefs) {
            directiveIndex += 1;
            await this.maybeTriggerAssistantDirectedSoundboard({
              session,
              settings: resolvedSettings,
              userId: this.client.user?.id || null,
              transcript: transcriptForLogs || transcript,
              requestedRef,
              source: `realtime_output_transcript_${directiveIndex}`
            });
          }
        })().catch(() => undefined);
      }
    };

    const onErrorEvent = (errorPayload) => {
      if (session.ending) return;
      const details = parseRealtimeErrorPayload(errorPayload);
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `${runtimeLabel}_error_event: ${details.message}`,
        metadata: {
          sessionId: session.id,
          code: details.code,
          param: details.param,
          lastOutboundEventType: details.lastOutboundEventType,
          lastOutboundEvent: details.lastOutboundEvent,
          recentOutboundEvents: details.recentOutboundEvents
        }
      });

      if (
        isRecoverableRealtimeError({
          mode: session.mode,
          code: details.code,
          message: details.message
        })
      ) {
        const normalizedCode = String(details.code || "")
          .trim()
          .toLowerCase();
        const isActiveResponseCollision =
          normalizedCode === "conversation_already_has_active_response" ||
          /active response in progress/i.test(String(details.message || ""));
        session.pendingRealtimeInputBytes = 0;
        const pending = session.pendingResponse;
        if (
          normalizedCode === "input_audio_buffer_commit_empty" &&
          pending &&
          !this.pendingResponseHasAudio(session, pending)
        ) {
          this.clearPendingResponse(session);
        } else if (isActiveResponseCollision && pending) {
          pending.handlingSilence = false;
          this.armResponseSilenceWatchdog({
            session,
            requestId: pending.requestId,
            userId: pending.userId
          });
        }
        return;
      }

      this.endSession({
        guildId: session.guildId,
        reason: "realtime_runtime_error",
        announcement: "voice runtime hit an error, leaving vc.",
        settings
      }).catch(() => undefined);
    };

    const onSocketClosed = (closeInfo) => {
      if (session.ending) return;
      const code = Number(closeInfo?.code || 0) || null;
      const reason = String(closeInfo?.reason || "").trim() || null;
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `${runtimeLabel}_socket_closed`,
        metadata: {
          sessionId: session.id,
          code,
          reason
        }
      });

      this.endSession({
        guildId: session.guildId,
        reason: "realtime_socket_closed",
        announcement: "lost realtime voice runtime, leaving vc.",
        settings
      }).catch(() => undefined);
    };

    const onSocketError = (socketError) => {
      if (session.ending) return;
      const message = String(socketError?.message || "unknown socket error");
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `${runtimeLabel}_socket_error: ${message}`,
        metadata: {
          sessionId: session.id
        }
      });
    };

    const onResponseDone = (event) => {
      if (session.ending) return;
      const hadBargeSuppression = this.isBargeInOutputSuppressed(session);
      if (hadBargeSuppression) {
        this.clearBargeInOutputSuppression(session, "response_done");
      }
      const pending = session.pendingResponse;
      const responseId = parseResponseDoneId(event);
      const responseStatus = parseResponseDoneStatus(event);
      const responseUsage = parseResponseDoneUsage(event);
      const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
      const resolvedResponseModel = session.mode === "openai_realtime"
        ? parseResponseDoneModel(event) ||
          String(session.realtimeClient?.sessionConfig?.model || "").trim() ||
          String(resolvedSettings?.voice?.openaiRealtime?.model || "gpt-realtime").trim() ||
          "gpt-realtime"
        : parseResponseDoneModel(event);
      const responseUsdCost =
        session.mode === "openai_realtime" && responseUsage
          ? estimateUsdCost({
              provider: "openai",
              model: resolvedResponseModel || "gpt-realtime",
              inputTokens: Number(responseUsage.inputTokens || 0),
              outputTokens: Number(responseUsage.outputTokens || 0),
              cacheReadTokens: Number(responseUsage.cacheReadTokens || 0),
              cacheWriteTokens: 0,
              customPricing: resolvedSettings?.llm?.pricing
            })
          : 0;
      const hadAudio = pending ? this.pendingResponseHasAudio(session, pending) : false;

      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `${runtimeLabel}_response_done`,
        usdCost: responseUsdCost,
        metadata: {
          sessionId: session.id,
          requestId: pending?.requestId || null,
          responseId,
          responseStatus,
          responseModel: resolvedResponseModel || null,
          responseUsage,
          hadAudio,
          retryCount: pending ? Number(pending.retryCount || 0) : null,
          hardRecoveryAttempted:
            pending && Object.hasOwn(pending, "hardRecoveryAttempted")
              ? Boolean(pending.hardRecoveryAttempted)
              : null
        }
      });

      if (!pending) return;

      if (hadAudio) {
        this.clearPendingResponse(session);
        return;
      }

      if (session.responseDoneGraceTimer) {
        clearTimeout(session.responseDoneGraceTimer);
      }

      const requestId = Number(pending.requestId || 0);
      const responseUserId = pending.userId || null;
      session.responseDoneGraceTimer = setTimeout(() => {
        session.responseDoneGraceTimer = null;
        if (!session || session.ending) return;
        const current = session.pendingResponse;
        if (!current || Number(current.requestId || 0) !== requestId) return;
        if (this.pendingResponseHasAudio(session, current)) {
          this.clearPendingResponse(session);
          return;
        }
        this.handleSilentResponse({
          session,
          userId: responseUserId,
          trigger: "response_done",
          responseId,
          responseStatus
        }).catch(() => undefined);
      }, RESPONSE_DONE_SILENCE_GRACE_MS);
    };

    session.realtimeClient.on("audio_delta", onAudioDelta);
    session.realtimeClient.on("transcript", onTranscript);
    session.realtimeClient.on("error_event", onErrorEvent);
    session.realtimeClient.on("socket_closed", onSocketClosed);
    session.realtimeClient.on("socket_error", onSocketError);
    session.realtimeClient.on("response_done", onResponseDone);

    session.cleanupHandlers.push(() => {
      session.realtimeClient.off("audio_delta", onAudioDelta);
      session.realtimeClient.off("transcript", onTranscript);
      session.realtimeClient.off("error_event", onErrorEvent);
      session.realtimeClient.off("socket_closed", onSocketClosed);
      session.realtimeClient.off("socket_error", onSocketError);
      session.realtimeClient.off("response_done", onResponseDone);
    });
  }

  ensureAudioPlaybackQueueState(session) {
    if (!session.audioPlaybackQueue || typeof session.audioPlaybackQueue !== "object") {
      session.audioPlaybackQueue = {
        chunks: [],
        headOffset: 0,
        queuedBytes: 0,
        pumping: false,
        timer: null,
        waitingDrain: false,
        drainHandler: null,
        lastWarnAt: 0
      };
    }
    return session.audioPlaybackQueue;
  }

  clearAudioPlaybackQueue(session) {
    if (!session) return;
    const state = this.ensureAudioPlaybackQueueState(session);
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.waitingDrain && state.drainHandler && typeof session.botAudioStream?.off === "function") {
      session.botAudioStream.off("drain", state.drainHandler);
    }
    state.waitingDrain = false;
    state.drainHandler = null;
    state.pumping = false;
    state.chunks = [];
    state.headOffset = 0;
    state.queuedBytes = 0;
    state.lastWarnAt = 0;
    this.maybeClearActiveReplyInterruptionPolicy(session);
  }

  dequeueAudioPlaybackFrame(session, frameBytes = DISCORD_PCM_FRAME_BYTES) {
    const state = this.ensureAudioPlaybackQueueState(session);
    if (!Array.isArray(state.chunks) || !state.chunks.length) return Buffer.alloc(0);

    const boundedFrameBytes = Math.max(1, Math.floor(Number(frameBytes) || DISCORD_PCM_FRAME_BYTES));
    let remaining = boundedFrameBytes;
    const pieces = [];

    while (remaining > 0 && state.chunks.length) {
      const head = state.chunks[0];
      if (!Buffer.isBuffer(head) || !head.length) {
        state.chunks.shift();
        state.headOffset = 0;
        continue;
      }

      const available = head.length - state.headOffset;
      if (available <= 0) {
        state.chunks.shift();
        state.headOffset = 0;
        continue;
      }

      const takeBytes = Math.min(available, remaining);
      const start = state.headOffset;
      const end = start + takeBytes;
      pieces.push(head.subarray(start, end));
      state.headOffset = end;
      state.queuedBytes = Math.max(0, Number(state.queuedBytes || 0) - takeBytes);
      remaining -= takeBytes;

      if (state.headOffset >= head.length) {
        state.chunks.shift();
        state.headOffset = 0;
      }
    }

    if (!pieces.length) return Buffer.alloc(0);
    if (pieces.length === 1) return pieces[0];
    return Buffer.concat(pieces);
  }

  scheduleAudioPlaybackPump(session, delayMs = 0) {
    if (!session || session.ending) return;
    const state = this.ensureAudioPlaybackQueueState(session);
    if (state.timer || state.waitingDrain) return;

    const waitMs = Math.max(0, Math.floor(Number(delayMs) || 0));
    state.timer = setTimeout(() => {
      state.timer = null;
      this.pumpAudioPlaybackQueue(session);
    }, waitMs);
  }

  pumpAudioPlaybackQueue(session) {
    if (!session || session.ending) return;
    const state = this.ensureAudioPlaybackQueueState(session);
    if (state.pumping) return;
    if (!Array.isArray(state.chunks) || !state.chunks.length) return;

    state.pumping = true;
    try {
      if (
        !ensureBotAudioPlaybackReady({
          session,
          store: this.store,
          botUserId: this.client.user?.id || null,
          onStreamCreated: (stream) => {
            this.bindBotAudioStreamLifecycle(session, {
              stream,
              source: "pipeline_restart"
            });
          }
        })
      ) {
        this.scheduleAudioPlaybackPump(session, 20);
        return;
      }

      while (!session.ending && Array.isArray(state.chunks) && state.chunks.length) {
        const chunk = this.dequeueAudioPlaybackFrame(session, AUDIO_PLAYBACK_PUMP_CHUNK_BYTES);
        if (!chunk.length) break;

        try {
          const wrote = session.botAudioStream.write(chunk);
          if (wrote === false && typeof session.botAudioStream?.once === "function") {
            if (!state.waitingDrain) {
              state.waitingDrain = true;
              const onDrain = () => {
                state.waitingDrain = false;
                state.drainHandler = null;
                if (!session.ending) {
                  this.scheduleAudioPlaybackPump(session, 0);
                }
              };
              state.drainHandler = onDrain;
              session.botAudioStream.once("drain", onDrain);
            }
            return;
          }
        } catch (error) {
          this.store.logAction({
            kind: "voice_error",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: this.client.user?.id || null,
            content: `bot_audio_stream_write_failed: ${String(error?.message || error)}`,
            metadata: {
              sessionId: session.id
            }
          });
          this.clearAudioPlaybackQueue(session);
          return;
        }
      }
    } finally {
      state.pumping = false;
    }
  }

  enqueueDiscordPcmForPlayback({ session, discordPcm }) {
    if (!session || session.ending) return false;
    const pcm = Buffer.isBuffer(discordPcm) ? discordPcm : Buffer.from(discordPcm || []);
    if (!pcm.length) return false;

    if (
      !ensureBotAudioPlaybackReady({
        session,
        store: this.store,
        botUserId: this.client.user?.id || null,
        onStreamCreated: (stream) => {
          this.bindBotAudioStreamLifecycle(session, {
            stream,
            source: "pipeline_restart"
          });
        }
      })
    ) {
      return false;
    }

    const state = this.ensureAudioPlaybackQueueState(session);
    const streamBufferedBytesBeforeEnqueue = Math.max(0, Number(session.botAudioStream?.writableLength || 0));
    const projectedBufferedBytes =
      Math.max(0, Number(state.queuedBytes || 0)) + streamBufferedBytesBeforeEnqueue + pcm.length;
    if (
      this.hasAssertiveInboundCapture(session) &&
      session.botTurnOpen &&
      !this.isBargeInOutputSuppressed(session) &&
      projectedBufferedBytes >= AUDIO_PLAYBACK_QUEUE_WARN_BYTES
    ) {
      const interrupted = this.interruptBotSpeechForBargeIn({
        session,
        userId: null,
        source: "playback_queue_overflow_guard",
        minCaptureBytes: 0
      });
      if (interrupted) return false;
    }

    state.chunks.push(pcm);
    state.queuedBytes = Math.max(0, Number(state.queuedBytes || 0)) + pcm.length;
    const now = Date.now();
    const streamBufferedBytes = Math.max(0, Number(session.botAudioStream?.writableLength || 0));
    const totalBufferedBytes = Math.max(0, Number(state.queuedBytes || 0)) + streamBufferedBytes;
    if (
      totalBufferedBytes >= AUDIO_PLAYBACK_QUEUE_WARN_BYTES &&
      now - Number(state.lastWarnAt || 0) >= AUDIO_PLAYBACK_QUEUE_WARN_COOLDOWN_MS
    ) {
      state.lastWarnAt = now;
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "bot_audio_queue_backlog",
        metadata: {
          sessionId: session.id,
          queuedBytes: Math.max(0, Number(state.queuedBytes || 0)),
          streamBufferedBytes,
          totalBufferedBytes,
          warnBufferedBytes: AUDIO_PLAYBACK_QUEUE_WARN_BYTES,
          hardMaxBufferedBytes: AUDIO_PLAYBACK_QUEUE_HARD_MAX_BYTES
        }
      });
    }
    this.scheduleAudioPlaybackPump(session, 0);
    return true;
  }

  getReplyOutputLockState(session) {
    if (!session || session.ending) {
      return {
        locked: true,
        reason: "session_inactive",
        botTurnOpen: false,
        pendingResponse: false,
        openAiActiveResponse: false,
        queueBusy: false,
        queuedBytes: 0,
        streamBufferedBytes: 0
      };
    }

    const queueState =
      session.audioPlaybackQueue && typeof session.audioPlaybackQueue === "object"
        ? session.audioPlaybackQueue
        : null;
    const queuedBytes = Math.max(0, Number(queueState?.queuedBytes || 0));
    const queueBusy = Boolean(queueState?.pumping || queueState?.waitingDrain);
    const streamBufferedBytes = Math.max(0, Number(session.botAudioStream?.writableLength || 0));
    const botTurnOpen = Boolean(session.botTurnOpen);
    const pendingResponse = Boolean(session.pendingResponse && typeof session.pendingResponse === "object");
    const openAiActiveResponse = this.isOpenAiRealtimeResponseActive(session);
    const locked =
      botTurnOpen ||
      pendingResponse ||
      openAiActiveResponse ||
      queueBusy ||
      queuedBytes > 0 ||
      streamBufferedBytes > 0;

    let reason = "idle";
    if (pendingResponse) {
      reason = "pending_response";
    } else if (openAiActiveResponse) {
      reason = "openai_active_response";
    } else if (botTurnOpen) {
      reason = "bot_turn_open";
    } else if (queueBusy) {
      reason = "queue_busy";
    } else if (queuedBytes > 0) {
      reason = "queued_audio";
    } else if (streamBufferedBytes > 0) {
      reason = "stream_buffered_audio";
    }

    return {
      locked,
      reason,
      botTurnOpen,
      pendingResponse,
      openAiActiveResponse,
      queueBusy,
      queuedBytes,
      streamBufferedBytes
    };
  }

  async enqueueChunkedTtsPcmForPlayback({
    session,
    ttsPcm,
    inputSampleRateHz = 24000
  }) {
    if (!session || session.ending) return false;
    const pcm = Buffer.isBuffer(ttsPcm) ? ttsPcm : Buffer.from(ttsPcm || []);
    if (!pcm.length) return false;

    const sampleRate = Math.max(8_000, Math.floor(Number(inputSampleRateHz) || 24_000));
    const chunkBytesRaw = Math.floor((sampleRate * 2 * STT_TTS_CONVERSION_CHUNK_MS) / 1000);
    const chunkBytes = Math.max(2, chunkBytesRaw - (chunkBytesRaw % 2));

    let queuedAny = false;
    let chunkCount = 0;
    for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
      if (session.ending) break;
      const chunk = pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length));
      const discordPcm = convertXaiOutputToDiscordPcm(chunk, sampleRate);
      if (discordPcm.length) {
        queuedAny = this.enqueueDiscordPcmForPlayback({
          session,
          discordPcm
        }) || queuedAny;
      }

      chunkCount += 1;
      if (chunkCount % STT_TTS_CONVERSION_YIELD_EVERY_CHUNKS === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    return queuedAny;
  }

  markBotTurnOut(session, settings = session.settingsSnapshot) {
    const now = Date.now();
    if (now - Number(session.lastBotActivityTouchAt || 0) >= ACTIVITY_TOUCH_THROTTLE_MS) {
      this.touchActivity(session.guildId, settings);
      session.lastBotActivityTouchAt = now;
    }

    const pendingResponse =
      session.pendingResponse && typeof session.pendingResponse === "object"
        ? session.pendingResponse
        : null;
    const pendingLatencyContext =
      pendingResponse?.latencyContext && typeof pendingResponse.latencyContext === "object"
        ? pendingResponse.latencyContext
        : null;
    if (pendingLatencyContext && Number(pendingLatencyContext.audioStartedAtMs || 0) <= 0) {
      pendingLatencyContext.audioStartedAtMs = now;
      this.logVoiceLatencyStage({
        session,
        userId: this.client.user?.id || null,
        stage: "audio_started",
        source: pendingLatencyContext.source || pendingResponse?.source || "realtime",
        captureReason: pendingLatencyContext.captureReason || null,
        requestId: pendingResponse?.requestId || null,
        queueWaitMs: pendingLatencyContext.queueWaitMs,
        pendingQueueDepth: pendingLatencyContext.pendingQueueDepth,
        finalizedAtMs: pendingLatencyContext.finalizedAtMs,
        asrStartedAtMs: pendingLatencyContext.asrStartedAtMs,
        asrCompletedAtMs: pendingLatencyContext.asrCompletedAtMs,
        generationStartedAtMs: pendingLatencyContext.generationStartedAtMs,
        replyRequestedAtMs:
          Number(pendingLatencyContext.replyRequestedAtMs || 0) ||
          Number(pendingResponse?.requestedAt || 0) ||
          0,
        audioStartedAtMs: now
      });
    }

    if (!session.botTurnOpen) {
      session.botTurnOpen = true;
      session.lastAssistantReplyAt = now;
      this.store.logAction({
        kind: "voice_turn_out",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "bot_audio_started",
        metadata: {
          sessionId: session.id
        }
      });
    }

    if (session.botTurnResetTimer) {
      clearTimeout(session.botTurnResetTimer);
    }

    session.botTurnResetTimer = setTimeout(() => {
      session.botTurnOpen = false;
      session.botTurnResetTimer = null;
      this.maybeClearActiveReplyInterruptionPolicy(session);
    }, BOT_TURN_SILENCE_RESET_MS);
  }

  getRealtimeTurnBacklogSize(session) {
    if (!session) return 0;
    const pendingQueueDepth = Array.isArray(session.pendingRealtimeTurns)
      ? session.pendingRealtimeTurns.length
      : 0;
    return Math.max(0, (session.realtimeTurnDrainActive ? 1 : 0) + pendingQueueDepth);
  }

  resolveSpeakingEndFinalizeDelayMs({ session, captureAgeMs }) {
    const normalizedCaptureAgeMs = Math.max(0, Number(captureAgeMs || 0));
    let baseDelayMs = SPEAKING_END_FINALIZE_QUICK_MS;
    if (normalizedCaptureAgeMs < SPEAKING_END_SHORT_CAPTURE_MS) {
      baseDelayMs =
        normalizedCaptureAgeMs < SPEAKING_END_MICRO_CAPTURE_MS
          ? SPEAKING_END_FINALIZE_MICRO_MS
          : SPEAKING_END_FINALIZE_SHORT_MS;
    }

    const activeCaptureCount = Number(session?.userCaptures?.size || 0);
    const realtimeTurnBacklog = this.getRealtimeTurnBacklogSize(session);
    const sttTurnBacklog = Number(session?.pendingSttTurns || 0);
    const turnBacklog = Math.max(0, realtimeTurnBacklog, sttTurnBacklog);

    if (
      activeCaptureCount >= SPEAKING_END_ADAPTIVE_HEAVY_CAPTURE_COUNT ||
      turnBacklog >= SPEAKING_END_ADAPTIVE_HEAVY_BACKLOG
    ) {
      return Math.max(
        SPEAKING_END_FINALIZE_MIN_MS,
        Math.round(baseDelayMs * SPEAKING_END_ADAPTIVE_HEAVY_SCALE)
      );
    }

    if (
      activeCaptureCount >= SPEAKING_END_ADAPTIVE_BUSY_CAPTURE_COUNT ||
      turnBacklog >= SPEAKING_END_ADAPTIVE_BUSY_BACKLOG
    ) {
      return Math.max(
        SPEAKING_END_FINALIZE_MIN_MS,
        Math.round(baseDelayMs * SPEAKING_END_ADAPTIVE_BUSY_SCALE)
      );
    }

    return baseDelayMs;
  }

  isInboundCaptureSuppressed(session) {
    if (!session || session.ending) return true;
    const activeLookupCount = Number(session.voiceLookupBusyCount || 0);
    return activeLookupCount > 0;
  }

  abortActiveInboundCaptures({ session, reason = "capture_suppressed" }) {
    if (!session || session.ending) return;
    const captures: Array<[
      string,
      {
        abort?: (reason?: string) => void;
        opusStream?: { destroy?: () => void };
        decoder?: { destroy?: () => void };
        pcmStream?: { destroy?: () => void };
      }
    ]> = [];
    if (session.userCaptures instanceof Map) {
      for (const [rawUserId, rawCapture] of session.userCaptures.entries()) {
        const normalizedCapture =
          rawCapture && typeof rawCapture === "object"
            ? { ...rawCapture }
            : {};
        captures.push([String(rawUserId || ""), normalizedCapture]);
      }
    }
    for (const [userId, capture] of captures) {
      if (capture && typeof capture.abort === "function") {
        capture.abort(reason);
        continue;
      }

      try {
        capture?.opusStream?.destroy?.();
      } catch {
        // ignore
      }
      try {
        capture?.decoder?.destroy?.();
      } catch {
        // ignore
      }
      try {
        capture?.pcmStream?.destroy?.();
      } catch {
        // ignore
      }
      session.userCaptures?.delete?.(String(userId || ""));
    }
  }

  resolveVoiceThoughtEngineConfig(settings = null) {
    const resolvedSettings = settings || this.store.getSettings();
    const voiceSettings = resolvedSettings?.voice || {};
    const thoughtEngine = voiceSettings?.thoughtEngine || {};
    const enabled =
      thoughtEngine?.enabled !== undefined ? Boolean(thoughtEngine.enabled) : true;
    const provider = normalizeLlmProvider(
      thoughtEngine?.provider,
      voiceSettings?.generationLlm?.provider || "anthropic"
    );
    const configuredModel = String(thoughtEngine?.model || "").trim().slice(0, 120);
    const model = configuredModel || defaultModelForLlmProvider(provider);
    const configuredTemperature = Number(thoughtEngine?.temperature);
    const temperature = clamp(Number.isFinite(configuredTemperature) ? configuredTemperature : 0.8, 0, 2);
    const eagerness = clamp(Number(thoughtEngine?.eagerness) || 0, 0, 100);
    const minSilenceSeconds = clamp(
      Number(thoughtEngine?.minSilenceSeconds) || 20,
      VOICE_THOUGHT_LOOP_MIN_SILENCE_SECONDS,
      VOICE_THOUGHT_LOOP_MAX_SILENCE_SECONDS
    );
    const minSecondsBetweenThoughts = clamp(
      Number(thoughtEngine?.minSecondsBetweenThoughts) || minSilenceSeconds,
      VOICE_THOUGHT_LOOP_MIN_INTERVAL_SECONDS,
      VOICE_THOUGHT_LOOP_MAX_INTERVAL_SECONDS
    );

    return {
      enabled,
      provider,
      model,
      temperature,
      eagerness,
      minSilenceSeconds,
      minSecondsBetweenThoughts
    };
  }

  clearVoiceThoughtLoopTimer(session) {
    if (!session) return;
    if (session.thoughtLoopTimer) {
      clearTimeout(session.thoughtLoopTimer);
      session.thoughtLoopTimer = null;
    }
    session.nextThoughtAt = 0;
  }

  scheduleVoiceThoughtLoop({
    session,
    settings = null,
    delayMs = null
  }) {
    if (!session || session.ending) return;
    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    const thoughtConfig = this.resolveVoiceThoughtEngineConfig(resolvedSettings);
    this.clearVoiceThoughtLoopTimer(session);
    if (!thoughtConfig.enabled) return;

    const defaultDelayMs = thoughtConfig.minSilenceSeconds * 1000;
    const requestedDelayMs = Number(delayMs);
    const waitMs = Math.max(
      120,
      Number.isFinite(requestedDelayMs) ? Math.round(requestedDelayMs) : defaultDelayMs
    );
    session.nextThoughtAt = Date.now() + waitMs;
    session.thoughtLoopTimer = setTimeout(() => {
      session.thoughtLoopTimer = null;
      session.nextThoughtAt = 0;
      this.maybeRunVoiceThoughtLoop({
        session,
        settings: session.settingsSnapshot || this.store.getSettings(),
        trigger: "timer"
      }).catch(() => undefined);
    }, waitMs);
  }

  evaluateVoiceThoughtLoopGate({
    session,
    settings = null,
    config = null,
    now = Date.now()
  }) {
    if (!session || session.ending) {
      return {
        allow: false,
        reason: "session_inactive",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }

    const thoughtConfig = config || this.resolveVoiceThoughtEngineConfig(settings);
    if (!thoughtConfig.enabled) {
      return {
        allow: false,
        reason: "thought_engine_disabled",
        retryAfterMs: thoughtConfig.minSilenceSeconds * 1000
      };
    }

    const minSilenceMs = thoughtConfig.minSilenceSeconds * 1000;
    const minIntervalMs = thoughtConfig.minSecondsBetweenThoughts * 1000;
    const silentDurationMs = Math.max(0, now - Number(session.lastActivityAt || 0));
    if (silentDurationMs < minSilenceMs) {
      return {
        allow: false,
        reason: "silence_window_not_met",
        retryAfterMs: Math.max(200, minSilenceMs - silentDurationMs)
      };
    }

    const sinceLastAttemptMs = Math.max(0, now - Number(session.lastThoughtAttemptAt || 0));
    if (sinceLastAttemptMs < minIntervalMs) {
      return {
        allow: false,
        reason: "thought_attempt_cooldown",
        retryAfterMs: Math.max(300, minIntervalMs - sinceLastAttemptMs)
      };
    }

    if (session.thoughtLoopBusy) {
      return {
        allow: false,
        reason: "thought_loop_busy",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }
    const replyOutputLockState = this.getReplyOutputLockState(session);
    if (replyOutputLockState.locked) {
      return {
        allow: false,
        reason: "bot_turn_open",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS,
        outputLockReason: replyOutputLockState.reason
      };
    }
    if (Number(session.voiceLookupBusyCount || 0) > 0) {
      return {
        allow: false,
        reason: "voice_lookup_busy",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }
    if (Number(session.userCaptures?.size || 0) > 0) {
      return {
        allow: false,
        reason: "active_user_capture",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }
    if (Number(session.pendingSttTurns || 0) > 0) {
      return {
        allow: false,
        reason: "pending_stt_turns",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }
    if (this.getRealtimeTurnBacklogSize(session) > 0) {
      return {
        allow: false,
        reason: "pending_realtime_turns",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }
    if (Array.isArray(session.pendingDeferredTurns) && session.pendingDeferredTurns.length > 0) {
      return {
        allow: false,
        reason: "pending_deferred_turns",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }
    if (this.countHumanVoiceParticipants(session) <= 0) {
      return {
        allow: false,
        reason: "no_human_participants",
        retryAfterMs: minSilenceMs
      };
    }

    return {
      allow: true,
      reason: "ok",
      retryAfterMs: minIntervalMs
    };
  }

  async maybeRunVoiceThoughtLoop({
    session,
    settings = null,
    trigger = "timer"
  }) {
    if (!session || session.ending) return false;
    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    const thoughtConfig = this.resolveVoiceThoughtEngineConfig(resolvedSettings);
    if (!thoughtConfig.enabled) {
      this.clearVoiceThoughtLoopTimer(session);
      return false;
    }

    const gate = this.evaluateVoiceThoughtLoopGate({
      session,
      settings: resolvedSettings,
      config: thoughtConfig
    });
    if (!gate.allow) {
      this.scheduleVoiceThoughtLoop({
        session,
        settings: resolvedSettings,
        delayMs: gate.retryAfterMs
      });
      return false;
    }

    const thoughtChance = clamp(Number(thoughtConfig?.eagerness) || 0, 0, 100) / 100;
    const now = Date.now();
    session.lastThoughtAttemptAt = now;
    if (thoughtChance <= 0) {
      this.scheduleVoiceThoughtLoop({
        session,
        settings: resolvedSettings,
        delayMs: thoughtConfig.minSecondsBetweenThoughts * 1000
      });
      return false;
    }

    const roll = Math.random();
    if (roll > thoughtChance) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "voice_thought_skipped_probability",
        metadata: {
          sessionId: session.id,
          mode: session.mode,
          trigger: String(trigger || "timer"),
          thoughtEagerness: Math.round(thoughtChance * 100),
          roll: Number(roll.toFixed(5))
        }
      });
      this.scheduleVoiceThoughtLoop({
        session,
        settings: resolvedSettings,
        delayMs: thoughtConfig.minSecondsBetweenThoughts * 1000
      });
      return false;
    }

    session.thoughtLoopBusy = true;
    try {
      const thoughtDraft = await this.generateVoiceThoughtCandidate({
        session,
        settings: resolvedSettings,
        config: thoughtConfig,
        trigger
      });
      if (!thoughtDraft) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          content: "voice_thought_generation_skip",
          metadata: {
            sessionId: session.id,
            mode: session.mode,
            trigger: String(trigger || "timer")
          }
        });
        return false;
      }

      const thoughtMemoryFacts = await this.loadVoiceThoughtMemoryFacts({
        session,
        settings: resolvedSettings,
        thoughtCandidate: thoughtDraft
      });
      const thoughtTopicalityBias = resolveVoiceThoughtTopicalityBias({
        silenceMs: Math.max(0, Date.now() - Number(session.lastActivityAt || 0)),
        minSilenceSeconds: thoughtConfig.minSilenceSeconds,
        minSecondsBetweenThoughts: thoughtConfig.minSecondsBetweenThoughts
      });
      const decision = await this.evaluateVoiceThoughtDecision({
        session,
        settings: resolvedSettings,
        thoughtCandidate: thoughtDraft,
        memoryFacts: thoughtMemoryFacts,
        topicalityBias: thoughtTopicalityBias
      });
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "voice_thought_decision",
        metadata: {
          sessionId: session.id,
          mode: session.mode,
          trigger: String(trigger || "timer"),
          allow: Boolean(decision.allow),
          reason: decision.reason,
          thoughtDraft,
          finalThought: decision.finalThought || null,
          memoryFactCount: Number(decision.memoryFactCount || 0),
          usedMemory: Boolean(decision.usedMemory),
          topicTetherStrength: thoughtTopicalityBias.topicTetherStrength,
          randomInspirationStrength: thoughtTopicalityBias.randomInspirationStrength,
          topicDriftPhase: thoughtTopicalityBias.phase,
          topicDriftHint: thoughtTopicalityBias.promptHint,
          llmResponse: decision.llmResponse || null,
          llmProvider: decision.llmProvider || null,
          llmModel: decision.llmModel || null,
          error: decision.error || null
        }
      });
      if (!decision.allow) return false;
      const finalThought = normalizeVoiceText(
        decision.finalThought || thoughtDraft,
        VOICE_THOUGHT_MAX_CHARS
      );
      if (!finalThought) return false;

      const spoken = await this.deliverVoiceThoughtCandidate({
        session,
        settings: resolvedSettings,
        thoughtCandidate: finalThought,
        trigger
      });
      if (spoken) {
        session.lastThoughtSpokenAt = Date.now();
      }
      return spoken;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `voice_thought_loop_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          mode: session.mode,
          trigger: String(trigger || "timer")
        }
      });
      return false;
    } finally {
      session.thoughtLoopBusy = false;
      this.scheduleVoiceThoughtLoop({
        session,
        settings: resolvedSettings,
        delayMs: thoughtConfig.minSecondsBetweenThoughts * 1000
      });
    }
  }

  async generateVoiceThoughtCandidate({
    session,
    settings,
    config,
    trigger = "timer"
  }) {
    if (!session || session.ending) return "";
    if (!this.llm?.generate) return "";

    const thoughtConfig = config || this.resolveVoiceThoughtEngineConfig(settings);
    const participants = this.getVoiceChannelParticipants(session).map((entry) => entry.displayName).filter(Boolean);
    const recentHistory = this.formatVoiceDecisionHistory(session, 6, VOICE_DECIDER_PROMPT_HISTORY_MAX_CHARS);
    const thoughtEagerness = clamp(Number(thoughtConfig?.eagerness) || 0, 0, 100);
    const silenceMs = Math.max(0, Date.now() - Number(session.lastActivityAt || 0));
    const topicalityBias = resolveVoiceThoughtTopicalityBias({
      silenceMs,
      minSilenceSeconds: thoughtConfig.minSilenceSeconds,
      minSecondsBetweenThoughts: thoughtConfig.minSecondsBetweenThoughts
    });
    const botName = getPromptBotName(settings);
    const systemPrompt = [
      `You are the internal thought engine for ${botName} in live Discord voice chat.`,
      "Draft exactly one short natural spoken line that might fit right now.",
      "Thought style: freedom to reflect the social atmosphere. Try to catch a vibe.",
      "It can be funny, insightful, witty, serious, frustrated, or even a short train-of-thought blurb when that still feels socially natural.",
      "It is valid to be random or to reflect the bot's current mood/persona.",
      "Topic drift rule: as silence grows, rely less on old-topic callbacks and more on fresh standalone lines.",
      "When topic tether is low, avoid stale references that require shared context (for example: vague that/they/it callbacks).",
      "If there is no good line, output exactly [SKIP].",
      "No markdown, no quotes, no meta commentary, no soundboard directives."
    ].join("\n");
    const userPromptParts = [
      `Current humans in VC: ${participants.length || 0}.`,
      participants.length ? `Participant names: ${participants.slice(0, 12).join(", ")}.` : "Participant names: none.",
      `Thought eagerness setting: ${thoughtEagerness}/100.`,
      `Silence duration ms: ${Math.max(0, Math.round(silenceMs))}.`,
      `Topic tether strength: ${topicalityBias.topicTetherStrength}/100 (100=strongly topical, 0=fully untethered).`,
      `Random inspiration strength: ${topicalityBias.randomInspirationStrength}/100.`,
      `Topic drift phase: ${topicalityBias.phase}.`,
      `Topic drift guidance: ${topicalityBias.promptHint}`,
      "Goal: seed a light initiative line that can keep conversation moving without forcing it."
    ];
    if (recentHistory) {
      userPromptParts.push(`Recent voice turns:\n${recentHistory}`);
    }
    const userPrompt = userPromptParts.join("\n");
    const generationSettings = {
      ...settings,
      llm: {
        ...(settings?.llm || {}),
        provider: thoughtConfig.provider,
        model: thoughtConfig.model,
        temperature: thoughtConfig.temperature,
        maxOutputTokens: 96
      }
    };

    const generation = await this.llm.generate({
      settings: generationSettings,
      systemPrompt,
      userPrompt,
      contextMessages: [],
      trace: {
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        source: "voice_thought_generation",
        event: String(trigger || "timer")
      }
    });
    const thoughtRaw = String(generation?.text || "").trim();
    const thoughtNoDirective = extractSoundboardDirective(thoughtRaw).text;
    const thoughtCandidate = normalizeVoiceText(thoughtNoDirective, VOICE_THOUGHT_MAX_CHARS);
    if (!thoughtCandidate || thoughtCandidate === "[SKIP]") {
      return "";
    }
    return thoughtCandidate;
  }

  async loadVoiceThoughtMemoryFacts({
    session,
    settings,
    thoughtCandidate
  }) {
    if (!session || session.ending) return [];
    if (!settings?.memory?.enabled) return [];
    if (!this.memory || typeof this.memory.searchDurableFacts !== "function") return [];

    const normalizedThought = normalizeVoiceText(thoughtCandidate, VOICE_THOUGHT_MAX_CHARS);
    if (!normalizedThought) return [];
    const recentHistory = this.formatVoiceDecisionHistory(session, 6, VOICE_DECIDER_PROMPT_HISTORY_MAX_CHARS);
    const queryText = normalizeVoiceText(
      [normalizedThought, recentHistory].filter(Boolean).join("\n"),
      STT_TRANSCRIPT_MAX_CHARS
    );
    if (!queryText) return [];

    try {
      const results = await this.memory.searchDurableFacts({
        guildId: session.guildId,
        channelId: session.textChannelId || null,
        queryText,
        settings,
        trace: {
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          source: "voice_thought_memory_search"
        },
        limit: VOICE_THOUGHT_MEMORY_SEARCH_LIMIT
      });

      const rows = Array.isArray(results) ? results : [];
      const deduped = [];
      const seenFacts = new Set();
      for (const row of rows) {
        const factText = normalizeVoiceText(row?.fact || "", 180);
        if (!factText) continue;
        const dedupeKey = factText.toLowerCase();
        if (seenFacts.has(dedupeKey)) continue;
        seenFacts.add(dedupeKey);
        deduped.push(row);
        if (deduped.length >= VOICE_THOUGHT_MEMORY_SEARCH_LIMIT) break;
      }
      return deduped;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `voice_thought_memory_search_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
      return [];
    }
  }

  async evaluateVoiceThoughtDecision({
    session,
    settings,
    thoughtCandidate,
    memoryFacts = [],
    topicalityBias = null
  }) {
    const normalizedThought = normalizeVoiceText(thoughtCandidate, VOICE_THOUGHT_MAX_CHARS);
    if (!normalizedThought) {
      return {
        allow: false,
        reason: "empty_thought_candidate",
        finalThought: "",
        usedMemory: false,
        memoryFactCount: 0
      };
    }

    const replyDecisionLlm = settings?.voice?.replyDecisionLlm || {};
    if (!this.llm?.generate) {
      return {
        allow: false,
        reason: "llm_generate_unavailable",
        finalThought: "",
        usedMemory: false,
        memoryFactCount: 0
      };
    }

    const llmProvider = normalizeVoiceReplyDecisionProvider(replyDecisionLlm?.provider);
    const llmModel = String(replyDecisionLlm?.model || defaultVoiceReplyDecisionModel(llmProvider))
      .trim()
      .slice(0, 120) || defaultVoiceReplyDecisionModel(llmProvider);
    const participants = this.getVoiceChannelParticipants(session).map((entry) => entry.displayName).filter(Boolean);
    const recentHistory = this.formatVoiceDecisionHistory(session, 8, VOICE_DECIDER_PROMPT_HISTORY_MAX_CHARS);
    const silenceMs = Math.max(0, Date.now() - Number(session.lastActivityAt || 0));
    const resolvedThoughtConfig = this.resolveVoiceThoughtEngineConfig(settings);
    const resolvedTopicalityBias =
      topicalityBias && typeof topicalityBias === "object"
        ? topicalityBias
        : resolveVoiceThoughtTopicalityBias({
            silenceMs,
            minSilenceSeconds: resolvedThoughtConfig.minSilenceSeconds,
            minSecondsBetweenThoughts: resolvedThoughtConfig.minSecondsBetweenThoughts
          });
    const thoughtEagerness = clamp(Number(settings?.voice?.thoughtEngine?.eagerness) || 0, 0, 100);
    const ambientMemoryFacts = Array.isArray(memoryFacts) ? memoryFacts : [];
    const ambientMemory = formatRealtimeMemoryFacts(ambientMemoryFacts, VOICE_THOUGHT_MEMORY_SEARCH_LIMIT);
    const botName = getPromptBotName(settings);

    const systemPrompt = [
      `You decide whether ${botName} should speak a candidate thought line right now in live Discord voice chat.`,
      "Return strict JSON only with keys: allow (boolean), finalThought (string), usedMemory (boolean), reason (string).",
      "If allow is true, finalThought must contain one short spoken line.",
      "If allow is false, finalThought must be an empty string.",
      "You may improve the draft using memory only when it feels natural and additive.",
      "Topic drift bias is required: as silence gets older, prefer fresh standalone lines over stale callbacks to earlier topic details.",
      "When topic tether is low, reject callback-heavy lines that depend on shared old context.",
      "Prefer allow=false over awkward memory references.",
      "No markdown, no extra keys."
    ].join("\n");
    const userPromptParts = [
      `Draft thought: "${normalizedThought}"`,
      `Thought eagerness: ${thoughtEagerness}/100.`,
      `Current human participant count: ${participants.length || 0}.`,
      `Silence duration ms: ${Math.max(0, Math.round(silenceMs))}.`,
      `Topic tether strength: ${resolvedTopicalityBias.topicTetherStrength}/100 (100=strongly topical, 0=fully untethered).`,
      `Random inspiration strength: ${resolvedTopicalityBias.randomInspirationStrength}/100.`,
      `Topic drift phase: ${resolvedTopicalityBias.phase}.`,
      `Topic drift guidance: ${resolvedTopicalityBias.promptHint}`,
      `Final thought hard max chars: ${VOICE_THOUGHT_MAX_CHARS}.`,
      "Decision rule: allow only when saying the final line now would feel natural and additive."
    ];
    if (participants.length) {
      userPromptParts.push(`Participant names: ${participants.slice(0, 12).join(", ")}.`);
    }
    if (recentHistory) {
      userPromptParts.push(`Recent voice turns:\n${recentHistory}`);
    }
    if (ambientMemory) {
      userPromptParts.push(`Ambient durable memory (optional): ${ambientMemory}`);
    }

    try {
      const generation = await this.llm.generate({
        settings: {
          ...settings,
          llm: {
            ...(settings?.llm || {}),
            provider: llmProvider,
            model: llmModel,
            temperature: 0,
            maxOutputTokens: VOICE_THOUGHT_DECISION_MAX_OUTPUT_TOKENS,
            reasoningEffort: String(replyDecisionLlm?.reasoningEffort || "minimal").trim().toLowerCase() || "minimal"
          }
        },
        systemPrompt,
        userPrompt: userPromptParts.join("\n"),
        contextMessages: [],
        jsonSchema: JSON.stringify({
          type: "object",
          additionalProperties: false,
          required: ["allow", "finalThought", "usedMemory", "reason"],
          properties: {
            allow: { type: "boolean" },
            finalThought: {
              type: "string",
              maxLength: VOICE_THOUGHT_MAX_CHARS
            },
            usedMemory: { type: "boolean" },
            reason: {
              type: "string",
              maxLength: 80
            }
          }
        }),
        trace: {
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          source: "voice_thought_decision"
        }
      });
      const raw = String(generation?.text || "").trim();
      const parsed = parseVoiceThoughtDecisionContract(raw);
      if (!parsed.confident) {
        return {
          allow: false,
          reason: "llm_contract_violation",
          finalThought: "",
          usedMemory: false,
          memoryFactCount: ambientMemoryFacts.length,
          llmResponse: raw,
          llmProvider: generation?.provider || llmProvider,
          llmModel: generation?.model || llmModel
        };
      }
      const sanitizedThought = normalizeVoiceText(
        extractSoundboardDirective(parsed.finalThought || "").text,
        VOICE_THOUGHT_MAX_CHARS
      );
      if (parsed.allow && (!sanitizedThought || sanitizedThought === "[SKIP]")) {
        return {
          allow: false,
          reason: "llm_contract_violation",
          finalThought: "",
          usedMemory: false,
          memoryFactCount: ambientMemoryFacts.length,
          llmResponse: raw,
          llmProvider: generation?.provider || llmProvider,
          llmModel: generation?.model || llmModel
        };
      }
      const parsedReason = String(parsed.reason || "")
        .trim()
        .toLowerCase()
        .replace(/[^\w.-]+/g, "_")
        .slice(0, 80);
      return {
        allow: parsed.allow,
        reason: parsedReason || (parsed.allow ? "llm_allow" : "llm_deny"),
        finalThought: parsed.allow ? sanitizedThought : "",
        usedMemory: parsed.allow ? Boolean(parsed.usedMemory) : false,
        memoryFactCount: ambientMemoryFacts.length,
        llmResponse: raw,
        llmProvider: generation?.provider || llmProvider,
        llmModel: generation?.model || llmModel
      };
    } catch (error) {
      return {
        allow: false,
        reason: "llm_error",
        finalThought: "",
        usedMemory: false,
        memoryFactCount: ambientMemoryFacts.length,
        llmProvider,
        llmModel,
        error: String(error?.message || error)
      };
    }
  }

  async deliverVoiceThoughtCandidate({
    session,
    settings,
    thoughtCandidate,
    trigger = "timer"
  }) {
    if (!session || session.ending) return false;
    const line = normalizeVoiceText(thoughtCandidate, STT_REPLY_MAX_CHARS);
    if (!line) return false;

    let requestedRealtimeUtterance = false;
    if (isRealtimeMode(session.mode)) {
      requestedRealtimeUtterance = this.requestRealtimeTextUtterance({
        session,
        text: line,
        userId: this.client.user?.id || null,
        source: "voice_thought_engine"
      });
      if (!requestedRealtimeUtterance) {
        const spokeFallback = await this.speakVoiceLineWithTts({
          session,
          settings,
          text: line,
          source: "voice_thought_engine_tts_fallback"
        });
        if (!spokeFallback) return false;
        session.lastAudioDeltaAt = Date.now();
      }
    } else {
      const spokeLine = await this.speakVoiceLineWithTts({
        session,
        settings,
        text: line,
        source: "voice_thought_engine_tts"
      });
      if (!spokeLine) return false;
      session.lastAudioDeltaAt = Date.now();
    }

    const replyAt = Date.now();
    session.lastAssistantReplyAt = replyAt;
    this.recordVoiceTurn(session, {
      role: "assistant",
      userId: this.client.user?.id || null,
      text: line
    });

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.client.user?.id || null,
      content: "voice_thought_spoken",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        trigger: String(trigger || "timer"),
        thoughtText: line,
        requestedRealtimeUtterance
      }
    });

    return true;
  }

  beginVoiceWebLookupBusy({
    session,
    settings,
    userId = null,
    query = "",
    source = "voice_web_lookup"
  }) {
    if (!session || session.ending) {
      return () => undefined;
    }

    session.voiceLookupBusyCount = Number(session.voiceLookupBusyCount || 0) + 1;
    const busyCount = Number(session.voiceLookupBusyCount || 0);
    if (busyCount === 1) {
      this.abortActiveInboundCaptures({
        session,
        reason: "voice_web_lookup_busy"
      });
      if (session.voiceLookupBusyAnnounceTimer) {
        clearTimeout(session.voiceLookupBusyAnnounceTimer);
        session.voiceLookupBusyAnnounceTimer = null;
      }
      session.voiceLookupBusyAnnounceTimer = setTimeout(() => {
        session.voiceLookupBusyAnnounceTimer = null;
        if (!session || session.ending) return;
        if (Number(session.voiceLookupBusyCount || 0) <= 0) return;
        this.announceVoiceWebLookupBusy({
          session,
          settings,
          userId,
          query,
          source
        }).catch(() => undefined);
      }, VOICE_LOOKUP_BUSY_ANNOUNCE_DELAY_MS);
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "voice_web_lookup_busy_start",
        metadata: {
          sessionId: session.id,
          mode: session.mode,
          source: String(source || "voice_web_lookup"),
          query: String(query || "").trim().slice(0, 220) || null
        }
      });
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const nextCount = Math.max(0, Number(session.voiceLookupBusyCount || 0) - 1);
      session.voiceLookupBusyCount = nextCount;
      if (nextCount > 0) return;
      if (session.voiceLookupBusyAnnounceTimer) {
        clearTimeout(session.voiceLookupBusyAnnounceTimer);
        session.voiceLookupBusyAnnounceTimer = null;
      }
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "voice_web_lookup_busy_end",
        metadata: {
          sessionId: session.id,
          mode: session.mode,
          source: String(source || "voice_web_lookup")
        }
      });
    };
  }

  async announceVoiceWebLookupBusy({
    session,
    settings,
    userId = null,
    query = "",
    source = "voice_web_lookup"
  }) {
    if (!session || session.ending) return;
    const line = await this.generateVoiceLookupBusyLine({
      session,
      settings,
      userId,
      query
    });
    if (!line) return;

    if (isRealtimeMode(session.mode) && this.requestRealtimeTextUtterance({
      session,
      text: line,
      userId,
      source: `${String(source || "voice_web_lookup")}:busy_utterance`
    })) {
      return;
    }

    await this.speakVoiceLineWithTts({
      session,
      settings,
      text: line,
      source: `${String(source || "voice_web_lookup")}:busy_utterance`
    });
  }

  async generateVoiceLookupBusyLine({
    session,
    settings,
    userId = null,
    query = ""
  }) {
    if (!this.llm?.generate) return "";
    const normalizedQuery = normalizeVoiceText(query, 80);
    const tunedSettings = {
      ...settings,
      llm: {
        ...(settings?.llm || {}),
        temperature: clamp(Number(settings?.llm?.temperature) || 0.75, 0.2, 1.1),
        maxOutputTokens: clamp(Number(settings?.llm?.maxOutputTokens) || 28, 8, 40)
      }
    };
    const systemPrompt = [
      `You are ${getPromptBotName(settings)} speaking in live Discord VC.`,
      "Output one short spoken line only (4-12 words).",
      "Line must clearly indicate you're checking something on the web right now.",
      "Keep it casual and natural. No markdown, no tags, no directives."
    ].join("\n");
    const userPrompt = [
      normalizedQuery ? `Lookup query: ${normalizedQuery}` : "Lookup query: (not specified)",
      "Write one quick filler line before lookup results are ready."
    ].join("\n");

    try {
      const generation = await this.llm.generate({
        settings: tunedSettings,
        systemPrompt,
        userPrompt,
        contextMessages: [],
        trace: {
          guildId: session?.guildId || null,
          channelId: session?.textChannelId || null,
          userId: userId || null,
          source: "voice_web_lookup_busy_line"
        }
      });
      const line = normalizeVoiceText(String(generation?.text || ""), VOICE_LOOKUP_BUSY_MAX_CHARS);
      if (!line || line === "[SKIP]") return "";
      return line;
    } catch {
      return "";
    }
  }

  requestRealtimeTextUtterance({
    session,
    text,
    userId = null,
    source = "voice_text_utterance",
    interruptionPolicy = null,
    latencyContext = null
  }) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return false;
    if (Number(session.userCaptures?.size || 0) > 0) return false;
    const realtimeClient = session.realtimeClient;
    if (!realtimeClient || typeof realtimeClient.requestTextUtterance !== "function") return false;
    const utterancePrompt = buildRealtimeTextUtterancePrompt(text, STT_REPLY_MAX_CHARS);
    if (!utterancePrompt) return false;
    const normalizedInterruptionPolicy = this.normalizeReplyInterruptionPolicy(interruptionPolicy);

    try {
      realtimeClient.requestTextUtterance(utterancePrompt);
      this.createTrackedAudioResponse({
        session,
        userId: userId || this.client.user?.id || null,
        source,
        resetRetryState: true,
        emitCreateEvent: false,
        interruptionPolicy: normalizedInterruptionPolicy,
        utteranceText: normalizeVoiceText(text, STT_REPLY_MAX_CHARS),
        latencyContext
      });
      session.pendingBargeInRetry = null;
      session.lastRequestedRealtimeUtterance = {
        utteranceText: normalizeVoiceText(text, STT_REPLY_MAX_CHARS) || null,
        requestedAt: Date.now(),
        source: String(source || "voice_text_utterance"),
        interruptionPolicy: normalizedInterruptionPolicy
      };
      return true;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `voice_text_utterance_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          source: String(source || "voice_text_utterance")
        }
      });
      return false;
    }
  }

  normalizeSoundboardRefs(soundboardRefs = []) {
    return (Array.isArray(soundboardRefs) ? soundboardRefs : [])
      .map((entry) =>
        String(entry || "")
          .trim()
          .slice(0, 180)
      )
      .filter(Boolean)
      .slice(0, 12);
  }

  buildVoiceReplyPlaybackPlan({
    replyText = "",
    trailingSoundboardRefs = []
  }) {
    const parsed = parseSoundboardDirectiveSequence(replyText);
    const sequence = Array.isArray(parsed?.sequence) ? parsed.sequence : [];
    const steps = [];
    const appendSpeech = (rawText) => {
      const normalized = normalizeVoiceText(rawText, STT_REPLY_MAX_CHARS);
      if (!normalized) return;
      const last = steps[steps.length - 1];
      if (last?.type === "speech") {
        last.text = normalizeVoiceText(`${last.text} ${normalized}`, STT_REPLY_MAX_CHARS);
      } else {
        steps.push({
          type: "speech",
          text: normalized
        });
      }
    };

    for (const entry of sequence) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.type === "speech") {
        appendSpeech(entry.text);
        continue;
      }
      if (entry.type === "soundboard") {
        const reference = String(entry.reference || "")
          .trim()
          .slice(0, 180);
        if (!reference) continue;
        steps.push({
          type: "soundboard",
          reference
        });
      }
    }

    for (const reference of this.normalizeSoundboardRefs(trailingSoundboardRefs)) {
      steps.push({
        type: "soundboard",
        reference
      });
    }

    const spokenText = normalizeVoiceText(parsed?.text || "", STT_REPLY_MAX_CHARS);
    const soundboardRefs = steps
      .filter((entry) => entry?.type === "soundboard")
      .map((entry) => entry.reference);
    return {
      spokenText,
      steps,
      soundboardRefs
    };
  }

  async playVoiceReplyInOrder({
    session,
    settings,
    spokenText = "",
    playbackSteps = [],
    source = "voice_reply",
    preferRealtimeUtterance = false,
    interruptionPolicy = null,
    latencyContext = null
  }) {
    if (!session || session.ending) {
      return {
        completed: false,
        spokeLine: false,
        requestedRealtimeUtterance: false,
        playedSoundboardCount: 0
      };
    }
    const steps = Array.isArray(playbackSteps) ? playbackSteps : [];
    if (!steps.length) {
      return {
        completed: true,
        spokeLine: false,
        requestedRealtimeUtterance: false,
        playedSoundboardCount: 0
      };
    }

    const requiresOrderedPlayback = steps.some((entry) => entry?.type === "soundboard");
    let speechStep = 0;
    let soundboardStep = 0;
    let spokeLine = false;
    let requestedRealtimeUtterance = false;
    let playedSoundboardCount = 0;

    for (const step of steps) {
      if (session.ending) {
        return {
          completed: false,
          spokeLine,
          requestedRealtimeUtterance,
          playedSoundboardCount
        };
      }
      if (!step || typeof step !== "object") continue;
      if (step.type === "speech") {
        const segmentText = normalizeVoiceText(step.text, STT_REPLY_MAX_CHARS);
        if (!segmentText) continue;
        speechStep += 1;
        const speechSource = `${String(source || "voice_reply")}:speech_${speechStep}`;
        if (preferRealtimeUtterance) {
          const requested = this.requestRealtimeTextUtterance({
            session,
            text: segmentText,
            userId: this.client.user?.id || null,
            source: speechSource,
            interruptionPolicy,
            latencyContext
          });
          if (requested) {
            spokeLine = true;
            requestedRealtimeUtterance = true;
            if (requiresOrderedPlayback) {
              await this.waitForLeaveDirectivePlayback({
                session,
                expectRealtimeAudio: true,
                source: speechSource
              });
            }
            continue;
          }
        }
        const spoke = await this.speakVoiceLineWithTts({
          session,
          settings,
          text: segmentText,
          source: `${speechSource}:tts_fallback`
        });
        if (!spoke) {
          return {
            completed: false,
            spokeLine,
            requestedRealtimeUtterance,
            playedSoundboardCount
          };
        }
        spokeLine = true;
        if (requiresOrderedPlayback) {
          await this.waitForLeaveDirectivePlayback({
            session,
            expectRealtimeAudio: false,
            source: speechSource
          });
        }
        continue;
      }
      if (step.type === "soundboard") {
        const requestedRef = String(step.reference || "")
          .trim()
          .slice(0, 180);
        if (!requestedRef) continue;
        soundboardStep += 1;
        await this.maybeTriggerAssistantDirectedSoundboard({
          session,
          settings,
          userId: this.client.user?.id || null,
          transcript: spokenText,
          requestedRef,
          source: `${String(source || "voice_reply")}:soundboard_${soundboardStep}`
        });
        playedSoundboardCount += 1;
      }
    }

    return {
      completed: true,
      spokeLine,
      requestedRealtimeUtterance,
      playedSoundboardCount
    };
  }

  async waitForLeaveDirectivePlayback({
    session,
    expectRealtimeAudio = false,
    source = "leave_directive"
  }) {
    if (!session || session.ending) return;
    const hasPlaybackSignals =
      typeof session.botTurnOpen === "boolean" ||
      (session.audioPlaybackQueue && typeof session.audioPlaybackQueue === "object") ||
      (expectRealtimeAudio && session.pendingResponse && typeof session.pendingResponse === "object");
    if (!hasPlaybackSignals) return;

    const waitStartedAt = Date.now();
    let audioRequestedAt = Math.max(
      0,
      Number(session.pendingResponse?.requestedAt || 0),
      Number(session.lastResponseRequestAt || 0)
    );
    if (!audioRequestedAt) {
      audioRequestedAt = waitStartedAt;
    }
    const deadlineAt = waitStartedAt + LEAVE_DIRECTIVE_PLAYBACK_MAX_WAIT_MS;
    let observedPlayback = false;
    let timedOutOnStart = false;

    while (!session.ending) {
      const now = Date.now();
      if (now >= deadlineAt) break;
      const queueState =
        session.audioPlaybackQueue && typeof session.audioPlaybackQueue === "object"
          ? session.audioPlaybackQueue
          : null;
      const queuedBytes = Math.max(0, Number(queueState?.queuedBytes || 0));
      const queueBusy = Boolean(queueState?.pumping || queueState?.waitingDrain);
      const botTurnOpen = Boolean(session.botTurnOpen);
      const pending = session.pendingResponse;
      const pendingHasAudio = pending ? this.pendingResponseHasAudio(session, pending) : false;
      const hasPostRequestAudio = Number(session.lastAudioDeltaAt || 0) >= audioRequestedAt;

      if (botTurnOpen || queueBusy || queuedBytes > 0 || pendingHasAudio || hasPostRequestAudio) {
        observedPlayback = true;
      }

      if (observedPlayback && !botTurnOpen && !queueBusy && queuedBytes <= 0) {
        break;
      }

      const elapsedMs = now - waitStartedAt;
      if (!observedPlayback) {
        if (expectRealtimeAudio && elapsedMs >= LEAVE_DIRECTIVE_REALTIME_AUDIO_START_WAIT_MS) {
          timedOutOnStart = true;
          break;
        }
        if (!expectRealtimeAudio && elapsedMs >= LEAVE_DIRECTIVE_PLAYBACK_NO_SIGNAL_GRACE_MS) {
          break;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, LEAVE_DIRECTIVE_PLAYBACK_POLL_MS));
    }

    const queueState =
      session.audioPlaybackQueue && typeof session.audioPlaybackQueue === "object"
        ? session.audioPlaybackQueue
        : null;
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.client.user?.id || null,
      content: "leave_directive_playback_wait",
      metadata: {
        sessionId: session.id,
        source: String(source || "leave_directive"),
        expectRealtimeAudio,
        observedPlayback,
        timedOutOnStart,
        elapsedMs: Math.max(0, Date.now() - waitStartedAt),
        botTurnOpen: Boolean(session.botTurnOpen),
        queuedBytes: Math.max(0, Number(queueState?.queuedBytes || 0))
      }
    });
  }

  async speakVoiceLineWithTts({
    session,
    settings,
    text,
    source = "voice_tts_line"
  }) {
    if (!session || session.ending) return false;
    if (Number(session.userCaptures?.size || 0) > 0) return false;
    const line = normalizeVoiceText(text, STT_REPLY_MAX_CHARS);
    if (!line) return false;
    if (!this.llm?.synthesizeSpeech) return false;

    const sttSettings = settings?.voice?.sttPipeline || {};
    const ttsModel = String(sttSettings?.ttsModel || "gpt-4o-mini-tts").trim() || "gpt-4o-mini-tts";
    const ttsVoice = String(sttSettings?.ttsVoice || "alloy").trim() || "alloy";
    const ttsSpeedRaw = Number(sttSettings?.ttsSpeed);
    const ttsSpeed = Number.isFinite(ttsSpeedRaw) ? ttsSpeedRaw : 1;

    let ttsPcm = Buffer.alloc(0);
    try {
      const tts = await this.llm.synthesizeSpeech({
        text: line,
        model: ttsModel,
        voice: ttsVoice,
        speed: ttsSpeed,
        responseFormat: "pcm",
        trace: {
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          source
        }
      });
      ttsPcm = tts.audioBuffer;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `voice_tts_line_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          source: String(source || "voice_tts_line")
        }
      });
      return false;
    }

    if (!ttsPcm.length || session.ending) return false;
    const queued = await this.enqueueChunkedTtsPcmForPlayback({
      session,
      ttsPcm,
      inputSampleRateHz: 24000
    });
    if (!queued) return false;
    this.markBotTurnOut(session, settings);
    return true;
  }

  bindSessionHandlers(session, settings) {
    const onStateChange = (_oldState, newState) => {
      if (session.ending) return;
      if (
        newState?.status === VoiceConnectionStatus.Destroyed ||
        newState?.status === VoiceConnectionStatus.Disconnected
      ) {
        this.endSession({
          guildId: session.guildId,
          reason: "connection_lost",
          announcement: "voice connection dropped, i'm out.",
          settings
        }).catch(() => undefined);
      }
    };

    session.connection.on("stateChange", onStateChange);
    session.cleanupHandlers.push(() => {
      session.connection.off("stateChange", onStateChange);
    });

    const speaking = session.connection.receiver?.speaking;
    if (!speaking?.on) return;

    const onSpeakingStart = (userId) => {
      if (String(userId || "") === String(this.client.user?.id || "")) return;
      if (this.isInboundCaptureSuppressed(session)) {
        const now = Date.now();
        if (now - Number(session.lastSuppressedCaptureLogAt || 0) >= VOICE_LOOKUP_BUSY_LOG_COOLDOWN_MS) {
          session.lastSuppressedCaptureLogAt = now;
          this.store.logAction({
            kind: "voice_runtime",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: String(userId || "").trim() || null,
            content: "voice_input_suppressed",
            metadata: {
              sessionId: session.id,
              mode: session.mode,
              reason: "voice_web_lookup_busy"
            }
          });
        }
        return;
      }
      const normalizedUserId = String(userId || "");
      const activeCapture = session.userCaptures.get(normalizedUserId);
      if (activeCapture?.speakingEndFinalizeTimer) {
        clearTimeout(activeCapture.speakingEndFinalizeTimer);
        activeCapture.speakingEndFinalizeTimer = null;
      }
      this.startInboundCapture({
        session,
        userId: normalizedUserId,
        settings
      });
      this.armAssertiveBargeIn({
        session,
        userId: normalizedUserId,
        source: "speaking_start"
      });
    };

    const onSpeakingEnd = (userId) => {
      if (String(userId || "") === String(this.client.user?.id || "")) return;
      const capture = session.userCaptures.get(String(userId || ""));
      if (!capture || typeof capture.finalize !== "function") return;
      if (capture.bargeInAssertTimer) {
        clearTimeout(capture.bargeInAssertTimer);
        capture.bargeInAssertTimer = null;
      }
      if (capture.speakingEndFinalizeTimer) return;
      const captureAgeMs = Math.max(0, Date.now() - Number(capture.startedAt || Date.now()));
      const finalizeDelayMs = this.resolveSpeakingEndFinalizeDelayMs({
        session,
        captureAgeMs
      });
      capture.speakingEndFinalizeTimer = setTimeout(() => {
        capture.speakingEndFinalizeTimer = null;
        capture.finalize("speaking_end");
      }, finalizeDelayMs);
    };

    speaking.on("start", onSpeakingStart);
    speaking.on("end", onSpeakingEnd);
    session.cleanupHandlers.push(() => {
      speaking.removeListener("start", onSpeakingStart);
      speaking.removeListener("end", onSpeakingEnd);
    });
  }

  startInboundCapture({ session, userId, settings = session?.settingsSnapshot }) {
    if (!session || !userId) return;
    if (session.userCaptures.has(userId)) return;

    const opusStream = session.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: INPUT_SPEECH_END_SILENCE_MS
      }
    });

    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960
    });

    const pcmStream = opusStream.pipe(decoder);
    const captureState = {
      userId,
      opusStream,
      decoder,
      pcmStream,
      startedAt: Date.now(),
      bytesSent: 0,
      signalSampleCount: 0,
      signalActiveSampleCount: 0,
      signalPeakAbs: 0,
      pcmChunks: [],
      lastActivityTouchAt: 0,
      idleFlushTimer: null,
      maxFlushTimer: null,
      speakingEndFinalizeTimer: null,
      bargeInAssertTimer: null,
      finalize: null,
      abort: null
    };

    session.userCaptures.set(userId, captureState);

    this.store.logAction({
      kind: "voice_turn_in",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_activity_started",
      metadata: {
        sessionId: session.id
      }
    });

    const cleanupCapture = () => {
      const current = session.userCaptures.get(userId);
      if (!current) return;
      session.userCaptures.delete(userId);

      if (current.idleFlushTimer) {
        clearTimeout(current.idleFlushTimer);
      }
      if (current.maxFlushTimer) {
        clearTimeout(current.maxFlushTimer);
      }
      if (current.speakingEndFinalizeTimer) {
        clearTimeout(current.speakingEndFinalizeTimer);
      }
      if (current.bargeInAssertTimer) {
        clearTimeout(current.bargeInAssertTimer);
      }

      try {
        current.opusStream.destroy();
      } catch {
        // ignore
      }

      try {
        current.decoder.destroy?.();
      } catch {
        // ignore
      }

      try {
        current.pcmStream.destroy();
      } catch {
        // ignore
      }
    };

    const scheduleIdleFlush = () => {
      if (captureState.idleFlushTimer) {
        clearTimeout(captureState.idleFlushTimer);
      }
      captureState.idleFlushTimer = setTimeout(() => {
        finalizeUserTurn("idle_timeout");
      }, CAPTURE_IDLE_FLUSH_MS);
    };

    pcmStream.on("data", (chunk) => {
      const now = Date.now();
      const normalizedPcm = convertDiscordPcmToXaiInput(
        chunk,
        isRealtimeMode(session.mode) ? Number(session.realtimeInputSampleRateHz) || 24000 : 24000
      );
      if (!normalizedPcm.length) return;
      captureState.bytesSent += normalizedPcm.length;
      const sampleCount = Math.floor(normalizedPcm.length / 2);
      if (sampleCount > 0) {
        let peakAbs = Math.max(0, Number(captureState.signalPeakAbs || 0));
        let activeSamples = 0;
        for (let offset = 0; offset < normalizedPcm.length; offset += 2) {
          const sample = normalizedPcm.readInt16LE(offset);
          const absSample = Math.abs(sample);
          if (absSample > peakAbs) peakAbs = absSample;
          if (absSample >= VOICE_SILENCE_GATE_ACTIVE_SAMPLE_MIN_ABS) {
            activeSamples += 1;
          }
        }
        captureState.signalSampleCount = Math.max(0, Number(captureState.signalSampleCount || 0)) + sampleCount;
        captureState.signalActiveSampleCount =
          Math.max(0, Number(captureState.signalActiveSampleCount || 0)) + activeSamples;
        captureState.signalPeakAbs = peakAbs;
      }
      captureState.pcmChunks.push(normalizedPcm);
      if (captureState.speakingEndFinalizeTimer) {
        clearTimeout(captureState.speakingEndFinalizeTimer);
        captureState.speakingEndFinalizeTimer = null;
      }
      scheduleIdleFlush();

      session.lastInboundAudioAt = now;
      if (
        this.isCaptureEligibleForActivityTouch({ session, capture: captureState }) &&
        now - captureState.lastActivityTouchAt >= ACTIVITY_TOUCH_THROTTLE_MS
      ) {
        this.touchActivity(session.guildId, settings);
        captureState.lastActivityTouchAt = now;
      }

      const captureAgeMs = Math.max(0, now - Number(captureState.startedAt || now));
      const signalSampleCount = Math.max(0, Number(captureState.signalSampleCount || 0));
      if (captureAgeMs >= CAPTURE_NEAR_SILENCE_ABORT_MIN_AGE_MS && signalSampleCount > 0) {
        const activeSampleCount = Math.max(0, Number(captureState.signalActiveSampleCount || 0));
        const activeSampleRatio = activeSampleCount / signalSampleCount;
        const peak = Math.max(0, Number(captureState.signalPeakAbs || 0)) / 32768;
        if (
          activeSampleRatio <= CAPTURE_NEAR_SILENCE_ABORT_ACTIVE_RATIO_MAX &&
          peak <= CAPTURE_NEAR_SILENCE_ABORT_PEAK_MAX
        ) {
          finalizeUserTurn("near_silence_early_abort");
          return;
        }
      }

    });

    let captureFinalized = false;
    const finalizeUserTurn = (reason = "stream_end") => {
      if (captureFinalized) return;
      captureFinalized = true;
      const finalizedAt = Date.now();

      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "voice_turn_finalized",
        metadata: {
          sessionId: session.id,
          reason: String(reason || "stream_end"),
          bytesSent: captureState.bytesSent,
          durationMs: Math.max(0, finalizedAt - captureState.startedAt)
        }
      });

      if (captureState.bytesSent <= 0 || session.ending) {
        cleanupCapture();
        return;
      }

      const pcmBuffer = Buffer.concat(captureState.pcmChunks);
      cleanupCapture();
      if (session.mode === "stt_pipeline") {
        this.queueSttPipelineTurn({
          session,
          userId,
          pcmBuffer,
          captureReason: reason
        });
      } else {
        const handledInterruptedReply = this.maybeHandleInterruptedReplyRecovery({
          session,
          userId,
          pcmBuffer,
          captureReason: reason
        });
        if (!handledInterruptedReply) {
          this.queueRealtimeTurn({
            session,
            userId,
            pcmBuffer,
            captureReason: reason,
            finalizedAt
          });
        }
      }
    };
    captureState.finalize = finalizeUserTurn;
    captureState.abort = (reason = "capture_suppressed") => {
      if (captureFinalized) return;
      captureFinalized = true;
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "voice_turn_dropped",
        metadata: {
          sessionId: session.id,
          reason: String(reason || "capture_suppressed"),
          bytesSent: captureState.bytesSent,
          durationMs: Math.max(0, Date.now() - captureState.startedAt)
        }
      });
      cleanupCapture();
    };
    captureState.maxFlushTimer = setTimeout(() => {
      finalizeUserTurn("max_duration");
    }, CAPTURE_MAX_DURATION_MS);

    opusStream.once("error", (error) => {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: `inbound_audio_receive_error: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
      finalizeUserTurn("receive_error");
    });
    decoder.once("error", (error) => {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: `inbound_audio_decode_error: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
      finalizeUserTurn("decode_error");
    });
    pcmStream.once("end", finalizeUserTurn);
    pcmStream.once("close", finalizeUserTurn);
    pcmStream.once("error", (error) => {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: `inbound_audio_stream_error: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
      finalizeUserTurn();
    });
  }

  maybeHandleInterruptedReplyRecovery({
    session,
    userId = null,
    pcmBuffer = null,
    captureReason = "stream_end"
  }) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return false;

    const pendingRetry = session.pendingBargeInRetry && typeof session.pendingBargeInRetry === "object"
      ? session.pendingBargeInRetry
      : null;
    if (!pendingRetry) return false;

    const now = Date.now();
    const interruptedAt = Number(pendingRetry.interruptedAt || 0);
    if (!interruptedAt || now - interruptedAt > BARGE_IN_RETRY_MAX_AGE_MS) {
      session.pendingBargeInRetry = null;
      return false;
    }

    const normalizedUserId = String(userId || "").trim();
    const interruptedByUserId = String(pendingRetry.interruptedByUserId || "").trim();
    if (!normalizedUserId || !interruptedByUserId || normalizedUserId !== interruptedByUserId) {
      return false;
    }

    const sampleRateHz = Number(session.realtimeInputSampleRateHz) || 24000;
    const captureByteLength = Buffer.isBuffer(pcmBuffer) ? pcmBuffer.length : Buffer.from(pcmBuffer || []).length;
    const bargeDurationMs = this.estimatePcm16MonoDurationMs(captureByteLength, sampleRateHz);
    const fullOverride = bargeDurationMs >= BARGE_IN_FULL_OVERRIDE_MIN_MS;
    if (Number(session.userCaptures?.size || 0) > 0) {
      return false;
    }

    if (fullOverride) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: normalizedUserId,
        content: "voice_barge_in_retry_skipped_full_override",
        metadata: {
          sessionId: session.id,
          captureReason: String(captureReason || "stream_end"),
          bargeDurationMs,
          fullOverrideMinMs: BARGE_IN_FULL_OVERRIDE_MIN_MS
        }
      });
      session.pendingBargeInRetry = null;
      return false;
    }

    const retryText = normalizeVoiceText(pendingRetry.utteranceText || "", STT_REPLY_MAX_CHARS);
    const interruptionPolicy = this.normalizeReplyInterruptionPolicy(pendingRetry.interruptionPolicy);
    session.pendingBargeInRetry = null;
    if (!retryText) return false;

    const retried = this.requestRealtimeTextUtterance({
      session,
      text: retryText,
      userId: this.client.user?.id || null,
      source: "barge_in_retry",
      interruptionPolicy
    });
    if (!retried) return false;

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.client.user?.id || null,
      content: "voice_barge_in_retry_requested",
      metadata: {
        sessionId: session.id,
        captureReason: String(captureReason || "stream_end"),
        bargeDurationMs,
        fullOverrideMinMs: BARGE_IN_FULL_OVERRIDE_MIN_MS,
        interruptionPolicyScope: interruptionPolicy?.scope || null,
        interruptionPolicyAllowedUserId: interruptionPolicy?.allowedUserId || null
      }
    });
    return true;
  }

  mergeRealtimeQueuedTurn(existingTurn, incomingTurn) {
    if (!existingTurn) return incomingTurn || null;
    if (!incomingTurn) return existingTurn;

    const existingBuffer = Buffer.isBuffer(existingTurn.pcmBuffer) ? existingTurn.pcmBuffer : Buffer.alloc(0);
    const incomingBuffer = Buffer.isBuffer(incomingTurn.pcmBuffer) ? incomingTurn.pcmBuffer : Buffer.alloc(0);
    if (!incomingBuffer.length) return existingTurn;

    const combinedBytes = existingBuffer.length + incomingBuffer.length;
    const maxMergeBytes = Math.max(1, Number(REALTIME_TURN_PENDING_MERGE_MAX_BYTES) || combinedBytes);
    const droppedHeadBytes = Math.max(0, combinedBytes - maxMergeBytes);
    let mergedBuffer = null;
    if (droppedHeadBytes > 0) {
      const mergedWindow = Buffer.concat([existingBuffer, incomingBuffer], combinedBytes).subarray(droppedHeadBytes);
      mergedBuffer = Buffer.from(mergedWindow);
    } else {
      mergedBuffer = Buffer.concat([existingBuffer, incomingBuffer], combinedBytes);
    }

    const existingFinalizedAt = Math.max(0, Number(existingTurn.finalizedAt || 0));
    const incomingFinalizedAt = Math.max(0, Number(incomingTurn.finalizedAt || 0));
    const mergedFinalizedAt =
      existingFinalizedAt > 0 && incomingFinalizedAt > 0
        ? Math.min(existingFinalizedAt, incomingFinalizedAt)
        : Math.max(existingFinalizedAt, incomingFinalizedAt);

    return {
      ...existingTurn,
      ...incomingTurn,
      pcmBuffer: mergedBuffer,
      queuedAt: Number(incomingTurn.queuedAt || Date.now()),
      finalizedAt: mergedFinalizedAt || 0,
      mergedTurnCount: Math.max(1, Number(existingTurn.mergedTurnCount || 1)) + 1,
      droppedHeadBytes
    };
  }

  queueRealtimeTurn({ session, userId, pcmBuffer, captureReason = "stream_end", finalizedAt = 0 }) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;
    if (!pcmBuffer || !pcmBuffer.length) return;
    const pendingQueue = Array.isArray(session.pendingRealtimeTurns) ? session.pendingRealtimeTurns : [];
    if (!Array.isArray(session.pendingRealtimeTurns)) {
      session.pendingRealtimeTurns = pendingQueue;
    }
    const queuedAt = Date.now();
    const normalizedFinalizedAt = Math.max(0, Number(finalizedAt || 0)) || queuedAt;

    const queuedTurn = {
      session,
      userId,
      pcmBuffer,
      captureReason,
      queuedAt,
      finalizedAt: normalizedFinalizedAt,
      mergedTurnCount: 1,
      droppedHeadBytes: 0
    };

    if (session.realtimeTurnDrainActive) {
      const firstPending = pendingQueue.shift() || null;
      let mergedPending = firstPending || queuedTurn;
      while (pendingQueue.length > 0) {
        const nextPending = pendingQueue.shift();
        if (!nextPending) continue;
        mergedPending = this.mergeRealtimeQueuedTurn(mergedPending, nextPending);
      }
      if (firstPending) {
        mergedPending = this.mergeRealtimeQueuedTurn(mergedPending, queuedTurn);
      }
      if (!mergedPending) return;
      pendingQueue.push(mergedPending);
      if (Number(mergedPending.mergedTurnCount || 1) > 1 || Number(mergedPending.droppedHeadBytes || 0) > 0) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          content: "realtime_turn_coalesced",
          metadata: {
            sessionId: session.id,
            captureReason: String(captureReason || "stream_end"),
            combinedBytes: mergedPending.pcmBuffer.length,
            mergedTurnCount: Number(mergedPending.mergedTurnCount || 1),
            droppedHeadBytes: Number(mergedPending.droppedHeadBytes || 0),
            queueDepth: pendingQueue.length,
            maxQueueDepth: REALTIME_TURN_QUEUE_MAX
          }
        });
      }
      return;
    }

    if (pendingQueue.length > 0) {
      let nextTurn = pendingQueue.shift() || queuedTurn;
      while (pendingQueue.length > 0) {
        const pendingTurn = pendingQueue.shift();
        if (!pendingTurn) continue;
        nextTurn = this.mergeRealtimeQueuedTurn(nextTurn, pendingTurn);
      }
      nextTurn = this.mergeRealtimeQueuedTurn(nextTurn, queuedTurn);
      if (!nextTurn) return;
      this.drainRealtimeTurnQueue(nextTurn).catch(() => undefined);
      return;
    }

    this.drainRealtimeTurnQueue(queuedTurn).catch(() => undefined);
  }

  async drainRealtimeTurnQueue(initialTurn) {
    const session = initialTurn?.session;
    if (!session || session.ending) return;
    if (session.realtimeTurnDrainActive) return;
    const pendingQueue = Array.isArray(session.pendingRealtimeTurns) ? session.pendingRealtimeTurns : [];
    if (!Array.isArray(session.pendingRealtimeTurns)) {
      session.pendingRealtimeTurns = pendingQueue;
    }

    session.realtimeTurnDrainActive = true;
    let turn = initialTurn;

    try {
      while (turn && !session.ending) {
        try {
          await this.runRealtimeTurn(turn);
        } catch (error) {
          this.store.logAction({
            kind: "voice_error",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: turn.userId,
            content: `realtime_turn_failed: ${String(error?.message || error)}`,
            metadata: {
              sessionId: session.id
            }
          });
        }

        const next = pendingQueue.shift();
        turn = next || null;
      }
    } finally {
      session.realtimeTurnDrainActive = false;
      if (session.ending) {
        session.pendingRealtimeTurns = [];
      } else {
        const pending = pendingQueue.shift();
        if (pending) {
          this.drainRealtimeTurnQueue(pending).catch(() => undefined);
        }
      }
    }
  }

  estimatePcm16MonoDurationMs(pcmByteLength, sampleRateHz = 24000) {
    const normalizedBytes = Math.max(0, Number(pcmByteLength) || 0);
    const normalizedRate = Math.max(1, Number(sampleRateHz) || 24000);
    return Math.round((normalizedBytes / (2 * normalizedRate)) * 1000);
  }

  analyzeMonoPcmSignal(pcmBuffer) {
    const buffer = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || []);
    const evenByteLength = Math.max(0, buffer.length - (buffer.length % 2));
    if (evenByteLength <= 0) {
      return {
        sampleCount: 0,
        rms: 0,
        peak: 0,
        activeSampleRatio: 0
      };
    }

    let sumSquares = 0;
    let peakAbs = 0;
    let activeSamples = 0;
    const sampleCount = evenByteLength / 2;
    for (let offset = 0; offset < evenByteLength; offset += 2) {
      const sample = buffer.readInt16LE(offset);
      const absSample = Math.abs(sample);
      sumSquares += sample * sample;
      if (absSample > peakAbs) {
        peakAbs = absSample;
      }
      if (absSample >= VOICE_SILENCE_GATE_ACTIVE_SAMPLE_MIN_ABS) {
        activeSamples += 1;
      }
    }

    const rmsAbs = Math.sqrt(sumSquares / sampleCount);
    return {
      sampleCount,
      rms: rmsAbs / 32768,
      peak: peakAbs / 32768,
      activeSampleRatio: activeSamples / sampleCount
    };
  }

  evaluatePcmSilenceGate({ pcmBuffer, sampleRateHz = 24000 }) {
    const clipDurationMs = this.estimatePcm16MonoDurationMs(pcmBuffer?.length || 0, sampleRateHz);
    const signal = this.analyzeMonoPcmSignal(pcmBuffer);
    const eligibleForGate = clipDurationMs >= VOICE_SILENCE_GATE_MIN_CLIP_MS;
    const nearSilentSignal =
      signal.rms <= VOICE_SILENCE_GATE_RMS_MAX &&
      signal.peak <= VOICE_SILENCE_GATE_PEAK_MAX &&
      signal.activeSampleRatio <= VOICE_SILENCE_GATE_ACTIVE_RATIO_MAX;

    return {
      clipDurationMs,
      ...signal,
      drop: Boolean(eligibleForGate && nearSilentSignal)
    };
  }

  shouldDropFallbackLowSignalTurn({
    transcript,
    usedFallbackModel = false,
    silenceGate,
    captureReason = "stream_end"
  }) {
    if (!usedFallbackModel) return false;
    if (String(captureReason || "stream_end") !== "speaking_end") return false;
    const normalizedTranscript = normalizeVoiceText(transcript, VOICE_TURN_ADDRESSING_TRANSCRIPT_MAX_CHARS);
    if (!normalizedTranscript || !isLowSignalVoiceFragment(normalizedTranscript)) return false;

    const clipDurationMs = Number(silenceGate?.clipDurationMs || 0);
    const rms = Number(silenceGate?.rms || 0);
    const peak = Number(silenceGate?.peak || 0);
    const activeSampleRatio = Number(silenceGate?.activeSampleRatio || 0);

    return (
      clipDurationMs > 0 &&
      clipDurationMs <= VOICE_FALLBACK_NOISE_GATE_MAX_CLIP_MS &&
      rms <= VOICE_FALLBACK_NOISE_GATE_RMS_MAX &&
      peak <= VOICE_FALLBACK_NOISE_GATE_PEAK_MAX &&
      activeSampleRatio <= VOICE_FALLBACK_NOISE_GATE_ACTIVE_RATIO_MAX
    );
  }

  computeLatencyMs(startMs = 0, endMs = 0) {
    const normalizedStart = Number(startMs || 0);
    const normalizedEnd = Number(endMs || 0);
    if (!Number.isFinite(normalizedStart) || !Number.isFinite(normalizedEnd)) return null;
    if (normalizedStart <= 0 || normalizedEnd <= 0) return null;
    if (normalizedEnd < normalizedStart) return null;
    return Math.max(0, Math.round(normalizedEnd - normalizedStart));
  }

  buildVoiceLatencyStageMetrics({
    finalizedAtMs = 0,
    asrStartedAtMs = 0,
    asrCompletedAtMs = 0,
    generationStartedAtMs = 0,
    replyRequestedAtMs = 0,
    audioStartedAtMs = 0
  } = {}) {
    return {
      finalizedToAsrStartMs: this.computeLatencyMs(finalizedAtMs, asrStartedAtMs),
      asrToGenerationStartMs: this.computeLatencyMs(asrCompletedAtMs, generationStartedAtMs),
      generationToReplyRequestMs: this.computeLatencyMs(generationStartedAtMs, replyRequestedAtMs),
      replyRequestToAudioStartMs: this.computeLatencyMs(replyRequestedAtMs, audioStartedAtMs)
    };
  }

  logVoiceLatencyStage(payload = null) {
    const {
      session = null,
      userId = null,
      stage = "unknown",
      source = "realtime",
      captureReason = null,
      requestId = null,
      queueWaitMs = null,
      pendingQueueDepth = null,
      finalizedAtMs = 0,
      asrStartedAtMs = 0,
      asrCompletedAtMs = 0,
      generationStartedAtMs = 0,
      replyRequestedAtMs = 0,
      audioStartedAtMs = 0
    } = payload && typeof payload === "object" ? payload : {};
    if (!session || session.ending) return;
    const metrics = this.buildVoiceLatencyStageMetrics({
      finalizedAtMs,
      asrStartedAtMs,
      asrCompletedAtMs,
      generationStartedAtMs,
      replyRequestedAtMs,
      audioStartedAtMs
    });
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: userId || this.client.user?.id || null,
      content: "voice_latency_stage",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        stage: String(stage || "unknown"),
        source: String(source || "realtime"),
        captureReason: captureReason ? String(captureReason) : null,
        requestId: Number.isFinite(Number(requestId)) && Number(requestId) > 0
          ? Number(requestId)
          : null,
        queueWaitMs: Number.isFinite(Number(queueWaitMs))
          ? Math.max(0, Math.round(Number(queueWaitMs)))
          : null,
        pendingQueueDepth: Number.isFinite(Number(pendingQueueDepth))
          ? Math.max(0, Math.round(Number(pendingQueueDepth)))
          : null,
        finalizedToAsrStartMs: metrics.finalizedToAsrStartMs,
        asrToGenerationStartMs: metrics.asrToGenerationStartMs,
        generationToReplyRequestMs: metrics.generationToReplyRequestMs,
        replyRequestToAudioStartMs: metrics.replyRequestToAudioStartMs
      }
    });

    if (String(stage || "").toLowerCase() === "audio_started") {
      const totalMs = [
        metrics.finalizedToAsrStartMs,
        metrics.asrToGenerationStartMs,
        metrics.generationToReplyRequestMs,
        metrics.replyRequestToAudioStartMs
      ].reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0);

      const entry = {
        at: Date.now(),
        stage: String(stage),
        source: String(source || "realtime"),
        finalizedToAsrStartMs: metrics.finalizedToAsrStartMs,
        asrToGenerationStartMs: metrics.asrToGenerationStartMs,
        generationToReplyRequestMs: metrics.generationToReplyRequestMs,
        replyRequestToAudioStartMs: metrics.replyRequestToAudioStartMs,
        totalMs,
        queueWaitMs: Number.isFinite(Number(queueWaitMs))
          ? Math.max(0, Math.round(Number(queueWaitMs)))
          : null,
        pendingQueueDepth: Number.isFinite(Number(pendingQueueDepth))
          ? Math.max(0, Math.round(Number(pendingQueueDepth)))
          : null
      };

      if (!Array.isArray(session.latencyStages)) session.latencyStages = [];
      session.latencyStages.push(entry);
      if (session.latencyStages.length > 12) {
        session.latencyStages = session.latencyStages.slice(-12);
      }
    }
  }

  resolveRealtimeReplyStrategy({ session, settings = null }) {
    if (!session || !isRealtimeMode(session.mode)) return "brain";
    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    const strategy = String(resolvedSettings?.voice?.realtimeReplyStrategy || "brain")
      .trim()
      .toLowerCase();
    if (strategy === "native") {
      return "native";
    }
    return "brain";
  }

  shouldUseNativeRealtimeReply({ session, settings = null }) {
    return this.resolveRealtimeReplyStrategy({ session, settings }) === "native";
  }

  async runRealtimeTurn({
    session,
    userId,
    pcmBuffer,
    captureReason = "stream_end",
    queuedAt = 0,
    finalizedAt = 0
  }) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;
    if (!pcmBuffer?.length) return;
    const queueWaitMs = queuedAt ? Math.max(0, Date.now() - Number(queuedAt || Date.now())) : 0;
    const finalizedAtMs = Math.max(0, Number(finalizedAt || 0)) || Math.max(0, Number(queuedAt || 0));
    const pendingQueueDepth = Array.isArray(session.pendingRealtimeTurns) ? session.pendingRealtimeTurns.length : 0;
    if (
      pendingQueueDepth > 0 &&
      queueWaitMs >= REALTIME_TURN_STALE_SKIP_MS &&
      String(captureReason || "") !== "bot_turn_open_deferred_flush"
    ) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "realtime_turn_skipped_stale",
        metadata: {
          sessionId: session.id,
          captureReason: String(captureReason || "stream_end"),
          queueWaitMs,
          pendingQueueDepth,
          pcmBytes: pcmBuffer.length
        }
      });
      return;
    }

    const settings = session.settingsSnapshot || this.store.getSettings();
    const asrLanguageGuidance = resolveVoiceAsrLanguageGuidance(settings);
    const preferredModel =
      session.mode === "openai_realtime"
        ? settings?.voice?.openaiRealtime?.inputTranscriptionModel
        : settings?.voice?.sttPipeline?.transcriptionModel;
    const transcriptionModel = String(preferredModel || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
    const sampleRateHz = Number(session.realtimeInputSampleRateHz) || 24000;
    const transcriptionPlan = resolveRealtimeTurnTranscriptionPlan({
      mode: session.mode,
      configuredModel: transcriptionModel,
      pcmByteLength: pcmBuffer.length,
      sampleRateHz
    });
    const silenceGate = this.evaluatePcmSilenceGate({
      pcmBuffer,
      sampleRateHz
    });
    const clipDurationMs = silenceGate.clipDurationMs;
    if (silenceGate.drop) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "voice_turn_dropped_silence_gate",
        metadata: {
          sessionId: session.id,
          source: "realtime",
          captureReason: String(captureReason || "stream_end"),
          pcmBytes: pcmBuffer.length,
          clipDurationMs,
          rms: Number(silenceGate.rms.toFixed(6)),
          peak: Number(silenceGate.peak.toFixed(6)),
          activeSampleRatio: Number(silenceGate.activeSampleRatio.toFixed(6)),
          queueWaitMs,
          pendingQueueDepth
        }
      });
      return;
    }
    const minAsrClipBytes = Math.max(
      2,
      Math.ceil(((VOICE_TURN_MIN_ASR_CLIP_MS / 1000) * sampleRateHz * 2))
    );
    const isShortSpeakingEndClip =
      String(captureReason || "stream_end") === "speaking_end" &&
      pcmBuffer.length < minAsrClipBytes;
    const skipShortClipAsr = Boolean(isShortSpeakingEndClip);
    let turnTranscript = "";
    let asrStartedAtMs = 0;
    let asrCompletedAtMs = 0;
    let resolvedFallbackModel = transcriptionPlan.fallbackModel || null;
    let resolvedTranscriptionPlanReason = transcriptionPlan.reason;
    let usedFallbackModelForTranscript = false;
    if (skipShortClipAsr) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "realtime_turn_transcription_skipped_short_clip",
        metadata: {
          sessionId: session.id,
          captureReason: String(captureReason || "stream_end"),
          pcmBytes: pcmBuffer.length,
          clipDurationMs,
          minAsrClipMs: VOICE_TURN_MIN_ASR_CLIP_MS,
          minAsrClipBytes
        }
      });
    } else if (this.llm?.isAsrReady?.() && this.llm?.transcribeAudio) {
      asrStartedAtMs = Date.now();
      turnTranscript = await this.transcribePcmTurn({
        session,
        userId,
        pcmBuffer,
        model: transcriptionPlan.primaryModel,
        sampleRateHz,
        captureReason,
        traceSource: "voice_realtime_turn_decider",
        errorPrefix: "voice_realtime_transcription_failed",
        emptyTranscriptRuntimeEvent: "voice_realtime_transcription_empty",
        emptyTranscriptErrorStreakThreshold: VOICE_EMPTY_TRANSCRIPT_ERROR_STREAK,
        asrLanguage: asrLanguageGuidance.language,
        asrPrompt: asrLanguageGuidance.prompt
      });

      if (
        !turnTranscript &&
        !resolvedFallbackModel &&
        session.mode === "voice_agent" &&
        transcriptionPlan.primaryModel === "gpt-4o-mini-transcribe"
      ) {
        resolvedFallbackModel = "gpt-4o-transcribe";
        resolvedTranscriptionPlanReason = "mini_with_full_fallback_runtime";
      }

      if (
        !turnTranscript &&
        resolvedFallbackModel &&
        resolvedFallbackModel !== transcriptionPlan.primaryModel
      ) {
        turnTranscript = await this.transcribePcmTurn({
          session,
          userId,
          pcmBuffer,
          model: resolvedFallbackModel,
          sampleRateHz,
          captureReason,
          traceSource: "voice_realtime_turn_decider_fallback",
          errorPrefix: "voice_realtime_transcription_fallback_failed",
          emptyTranscriptRuntimeEvent: "voice_realtime_transcription_empty",
          emptyTranscriptErrorStreakThreshold: VOICE_EMPTY_TRANSCRIPT_ERROR_STREAK,
          suppressEmptyTranscriptLogs: true,
          asrLanguage: asrLanguageGuidance.language,
          asrPrompt: asrLanguageGuidance.prompt
        });
        if (turnTranscript) {
          usedFallbackModelForTranscript = true;
        }
      }
      asrCompletedAtMs = Date.now();
    }

    if (
      turnTranscript &&
      this.shouldDropFallbackLowSignalTurn({
        transcript: turnTranscript,
        usedFallbackModel: usedFallbackModelForTranscript,
        silenceGate,
        captureReason
      })
    ) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "voice_turn_dropped_low_signal_fallback",
        metadata: {
          sessionId: session.id,
          source: "realtime",
          captureReason: String(captureReason || "stream_end"),
          transcript: turnTranscript,
          clipDurationMs,
          rms: Number(silenceGate.rms.toFixed(6)),
          peak: Number(silenceGate.peak.toFixed(6)),
          activeSampleRatio: Number(silenceGate.activeSampleRatio.toFixed(6)),
          transcriptionModelPrimary: transcriptionPlan.primaryModel,
          transcriptionModelFallback: resolvedFallbackModel || null,
          transcriptionUsedFallbackModel: true
        }
      });
      return;
    }

    const persistRealtimeTranscriptTurn = this.shouldPersistUserTranscriptTimelineTurn({
      session,
      settings,
      transcript: turnTranscript
    });
    if (turnTranscript && persistRealtimeTranscriptTurn) {
      this.recordVoiceTurn(session, {
        role: "user",
        userId,
        text: turnTranscript
      });
      this.queueVoiceMemoryIngest({
        session,
        settings,
        userId,
        transcript: turnTranscript,
        source: "voice_realtime_ingest",
        captureReason,
        errorPrefix: "voice_realtime_memory_ingest_failed"
      });
    }

    const decision = await this.evaluateVoiceReplyDecision({
      session,
      settings,
      userId,
      transcript: turnTranscript,
      source: "realtime",
      transcriptionContext: {
        usedFallbackModel: usedFallbackModelForTranscript,
        captureReason: String(captureReason || "stream_end"),
        clipDurationMs
      }
    });
    this.updateFocusedSpeakerWindow({
      session,
      userId,
      allow: Boolean(decision.allow),
      directAddressed: Boolean(decision.directAddressed),
      reason: decision.reason
    });
    const decisionVoiceAddressing = this.normalizeVoiceAddressingAnnotation({
      rawAddressing: decision?.voiceAddressing,
      directAddressed: Boolean(decision.directAddressed),
      directedConfidence: Number(decision.directAddressConfidence),
      source: "decision",
      reason: decision.reason
    });
    this.annotateLatestVoiceTurnAddressing({
      session,
      role: "user",
      userId,
      text: decision.transcript || turnTranscript,
      addressing: decisionVoiceAddressing
    });
    const decisionAddressingState = this.buildVoiceAddressingState({
      session,
      userId
    });

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_turn_addressing",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source: "realtime",
        captureReason: String(captureReason || "stream_end"),
        queueWaitMs,
        allow: Boolean(decision.allow),
        reason: decision.reason,
        participantCount: Number(decision.participantCount || 0),
        directAddressed: Boolean(decision.directAddressed),
        talkingTo: decisionVoiceAddressing?.talkingTo || null,
        directedConfidence: Number.isFinite(Number(decisionVoiceAddressing?.directedConfidence))
          ? Number(clamp(Number(decisionVoiceAddressing.directedConfidence), 0, 1).toFixed(3))
          : 0,
        addressingSource: decisionVoiceAddressing?.source || null,
        addressingReason: decisionVoiceAddressing?.reason || null,
        currentSpeakerTarget: decisionAddressingState?.currentSpeakerTarget || null,
        currentSpeakerDirectedConfidence: Number.isFinite(
          Number(decisionAddressingState?.currentSpeakerDirectedConfidence)
        )
          ? Number(clamp(Number(decisionAddressingState.currentSpeakerDirectedConfidence), 0, 1).toFixed(3))
          : 0,
        transcript: decision.transcript || turnTranscript || null,
        transcriptionModelPrimary: transcriptionPlan.primaryModel,
        transcriptionModelFallback: resolvedFallbackModel || null,
        transcriptionUsedFallbackModel: usedFallbackModelForTranscript,
        transcriptionPlanReason: resolvedTranscriptionPlanReason,
        clipDurationMs,
        asrSkippedShortClip: skipShortClipAsr,
        llmResponse: decision.llmResponse || null,
        llmProvider: decision.llmProvider || null,
        llmModel: decision.llmModel || null,
        conversationState: decision.conversationContext?.engagementState || null,
        conversationEngaged: Boolean(decision.conversationContext?.engaged),
        engagedWithCurrentSpeaker: Boolean(decision.conversationContext?.engagedWithCurrentSpeaker),
        recentAssistantReply: Boolean(decision.conversationContext?.recentAssistantReply),
        msSinceAssistantReply: Number.isFinite(decision.conversationContext?.msSinceAssistantReply)
          ? Math.round(decision.conversationContext.msSinceAssistantReply)
          : null,
        msSinceDirectAddress: Number.isFinite(decision.conversationContext?.msSinceDirectAddress)
          ? Math.round(decision.conversationContext.msSinceDirectAddress)
          : null,
        msSinceInboundAudio: Number.isFinite(decision.msSinceInboundAudio)
          ? Math.round(decision.msSinceInboundAudio)
          : null,
        requiredSilenceMs: Number.isFinite(decision.requiredSilenceMs)
          ? Math.round(decision.requiredSilenceMs)
          : null,
        retryAfterMs: Number.isFinite(decision.retryAfterMs)
          ? Math.round(decision.retryAfterMs)
          : null,
        error: decision.error || null
      }
    });

    const useNativeRealtimeReply = this.shouldUseNativeRealtimeReply({ session, settings });
    if (!decision.allow) {
      if (
        decision.reason === "bot_turn_open" ||
        decision.reason === "awaiting_non_direct_silence_window"
      ) {
        this.queueDeferredBotTurnOpenTurn({
          session,
          userId,
          transcript: decision.transcript || turnTranscript,
          pcmBuffer,
          captureReason,
          source: "realtime",
          directAddressed: Boolean(decision.directAddressed),
          deferReason: decision.reason,
          flushDelayMs: decision.retryAfterMs
        });
      }
      return;
    }

    if (useNativeRealtimeReply) {
      await this.forwardRealtimeTurnAudio({
        session,
        settings,
        userId,
        transcript: turnTranscript,
        pcmBuffer,
        captureReason
      });
      return;
    }

    await this.runRealtimeBrainReply({
      session,
      settings,
      userId,
      transcript: turnTranscript,
      directAddressed: Boolean(decision.directAddressed),
      directAddressConfidence: Number(decision.directAddressConfidence),
      conversationContext: decision.conversationContext || null,
      source: "realtime",
      latencyContext: {
        finalizedAtMs,
        asrStartedAtMs,
        asrCompletedAtMs,
        queueWaitMs,
        pendingQueueDepth,
        captureReason: String(captureReason || "stream_end")
      }
    });
  }

  queueDeferredBotTurnOpenTurn({
    session,
    userId = null,
    transcript = "",
    pcmBuffer = null,
    captureReason = "stream_end",
    source = "voice_turn",
    directAddressed = false,
    deferReason = "bot_turn_open",
    flushDelayMs = null
  }) {
    if (!session || session.ending) return;
    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedTranscript) return;
    const normalizedDeferReason = String(deferReason || "bot_turn_open").trim() || "bot_turn_open";
    const normalizedFlushDelayMs = Number.isFinite(Number(flushDelayMs))
      ? Math.max(20, Math.round(Number(flushDelayMs)))
      : BOT_TURN_DEFERRED_FLUSH_DELAY_MS;
    const pendingQueue = Array.isArray(session.pendingDeferredTurns) ? session.pendingDeferredTurns : [];
    if (!Array.isArray(session.pendingDeferredTurns)) {
      session.pendingDeferredTurns = pendingQueue;
    }
    if (pendingQueue.length >= BOT_TURN_DEFERRED_QUEUE_MAX) {
      pendingQueue.shift();
    }
    pendingQueue.push({
      userId: String(userId || "").trim() || null,
      transcript: normalizedTranscript,
      pcmBuffer: pcmBuffer?.length ? pcmBuffer : null,
      captureReason: String(captureReason || "stream_end"),
      source: String(source || "voice_turn"),
      directAddressed: Boolean(directAddressed),
      deferReason: normalizedDeferReason,
      flushDelayMs: normalizedFlushDelayMs,
      queuedAt: Date.now()
    });
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_turn_deferred_bot_turn_open",
      metadata: {
        sessionId: session.id,
        source: String(source || "voice_turn"),
        mode: session.mode,
        captureReason: String(captureReason || "stream_end"),
        deferReason: normalizedDeferReason,
        directAddressed: Boolean(directAddressed),
        flushDelayMs: normalizedFlushDelayMs,
        deferredQueueSize: pendingQueue.length
      }
    });
    this.scheduleDeferredBotTurnOpenFlush({
      session,
      delayMs: normalizedFlushDelayMs
    });
  }

  scheduleDeferredBotTurnOpenFlush({ session, delayMs = BOT_TURN_DEFERRED_FLUSH_DELAY_MS }) {
    if (!session || session.ending) return;
    if (session.deferredTurnFlushTimer) {
      clearTimeout(session.deferredTurnFlushTimer);
    }
    session.deferredTurnFlushTimer = setTimeout(() => {
      session.deferredTurnFlushTimer = null;
      this.flushDeferredBotTurnOpenTurns({ session }).catch(() => undefined);
    }, Math.max(20, Number(delayMs) || BOT_TURN_DEFERRED_FLUSH_DELAY_MS));
  }

  async flushDeferredBotTurnOpenTurns({ session }) {
    if (!session || session.ending) return;
    const pendingQueue = Array.isArray(session.pendingDeferredTurns) ? session.pendingDeferredTurns : [];
    if (!pendingQueue.length) return;

    const replyOutputLockState = this.getReplyOutputLockState(session);
    if (replyOutputLockState.locked || Number(session.userCaptures?.size || 0) > 0) {
      this.scheduleDeferredBotTurnOpenFlush({ session });
      return;
    }

    const deferredTurns = pendingQueue.splice(0, pendingQueue.length);
    if (!deferredTurns.length) return;
    const coalescedTurns = deferredTurns.slice(-BOT_TURN_DEFERRED_COALESCE_MAX);
    const latestTurn = coalescedTurns[coalescedTurns.length - 1];
    const coalescedTranscript = normalizeVoiceText(
      coalescedTurns
        .map((entry) => String(entry?.transcript || "").trim())
        .filter(Boolean)
        .join(" "),
      STT_TRANSCRIPT_MAX_CHARS
    );
    if (!coalescedTranscript) return;
    const coalescedPcmBuffer = isRealtimeMode(session.mode)
      ? Buffer.concat(
          coalescedTurns
            .map((entry) => (entry?.pcmBuffer?.length ? entry.pcmBuffer : null))
            .filter(Boolean)
        )
      : null;

    const settings = session.settingsSnapshot || this.store.getSettings();
    const useNativeRealtimeReply = this.shouldUseNativeRealtimeReply({ session, settings });
    const decision = await this.evaluateVoiceReplyDecision({
      session,
      settings,
      userId: latestTurn?.userId || null,
      transcript: coalescedTranscript,
      source: "bot_turn_open_deferred_flush"
    });
    this.updateFocusedSpeakerWindow({
      session,
      userId: latestTurn?.userId || null,
      allow: Boolean(decision.allow),
      directAddressed: Boolean(decision.directAddressed),
      reason: decision.reason
    });
    const decisionVoiceAddressing = this.normalizeVoiceAddressingAnnotation({
      rawAddressing: decision?.voiceAddressing,
      directAddressed: Boolean(decision.directAddressed),
      directedConfidence: Number(decision.directAddressConfidence),
      source: "decision",
      reason: decision.reason
    });
    this.annotateLatestVoiceTurnAddressing({
      session,
      role: "user",
      userId: latestTurn?.userId || null,
      text: decision.transcript || coalescedTranscript,
      addressing: decisionVoiceAddressing
    });
    const decisionAddressingState = this.buildVoiceAddressingState({
      session,
      userId: latestTurn?.userId || null
    });

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: latestTurn?.userId || null,
      content: "voice_turn_addressing",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source: "bot_turn_open_deferred_flush",
        captureReason: latestTurn?.captureReason || "stream_end",
        allow: Boolean(decision.allow),
        reason: decision.reason,
        participantCount: Number(decision.participantCount || 0),
        directAddressed: Boolean(decision.directAddressed),
        talkingTo: decisionVoiceAddressing?.talkingTo || null,
        directedConfidence: Number.isFinite(Number(decisionVoiceAddressing?.directedConfidence))
          ? Number(clamp(Number(decisionVoiceAddressing.directedConfidence), 0, 1).toFixed(3))
          : 0,
        addressingSource: decisionVoiceAddressing?.source || null,
        addressingReason: decisionVoiceAddressing?.reason || null,
        currentSpeakerTarget: decisionAddressingState?.currentSpeakerTarget || null,
        currentSpeakerDirectedConfidence: Number.isFinite(
          Number(decisionAddressingState?.currentSpeakerDirectedConfidence)
        )
          ? Number(clamp(Number(decisionAddressingState.currentSpeakerDirectedConfidence), 0, 1).toFixed(3))
          : 0,
        transcript: decision.transcript || coalescedTranscript || null,
        deferredTurnCount: coalescedTurns.length,
        llmResponse: decision.llmResponse || null,
        llmProvider: decision.llmProvider || null,
        llmModel: decision.llmModel || null,
        conversationState: decision.conversationContext?.engagementState || null,
        conversationEngaged: Boolean(decision.conversationContext?.engaged),
        engagedWithCurrentSpeaker: Boolean(decision.conversationContext?.engagedWithCurrentSpeaker),
        recentAssistantReply: Boolean(decision.conversationContext?.recentAssistantReply),
        msSinceAssistantReply: Number.isFinite(decision.conversationContext?.msSinceAssistantReply)
          ? Math.round(decision.conversationContext.msSinceAssistantReply)
          : null,
        msSinceDirectAddress: Number.isFinite(decision.conversationContext?.msSinceDirectAddress)
          ? Math.round(decision.conversationContext.msSinceDirectAddress)
          : null,
        msSinceInboundAudio: Number.isFinite(decision.msSinceInboundAudio)
          ? Math.round(decision.msSinceInboundAudio)
          : null,
        requiredSilenceMs: Number.isFinite(decision.requiredSilenceMs)
          ? Math.round(decision.requiredSilenceMs)
          : null,
        retryAfterMs: Number.isFinite(decision.retryAfterMs)
          ? Math.round(decision.retryAfterMs)
          : null,
        error: decision.error || null
      }
    });
    if (!decision.allow) {
      if (
        decision.reason === "bot_turn_open" ||
        decision.reason === "awaiting_non_direct_silence_window"
      ) {
        this.queueDeferredBotTurnOpenTurn({
          session,
          userId: latestTurn?.userId || null,
          transcript: coalescedTranscript,
          pcmBuffer: coalescedPcmBuffer,
          captureReason: latestTurn?.captureReason || "stream_end",
          source: "bot_turn_open_deferred_flush",
          directAddressed: Boolean(decision.directAddressed),
          deferReason: decision.reason,
          flushDelayMs: decision.retryAfterMs
        });
      }
      return;
    }

    if (session.mode === "stt_pipeline") {
      await this.runSttPipelineReply({
        session,
        settings,
        userId: latestTurn?.userId || null,
        transcript: coalescedTranscript,
        directAddressed: Boolean(decision.directAddressed),
        directAddressConfidence: Number(decision.directAddressConfidence),
        conversationContext: decision.conversationContext || null
      });
      return;
    }

    if (!isRealtimeMode(session.mode)) return;
    if (useNativeRealtimeReply) {
      if (!coalescedPcmBuffer?.length) return;
      await this.forwardRealtimeTurnAudio({
        session,
        settings,
        userId: latestTurn?.userId || null,
        transcript: coalescedTranscript,
        pcmBuffer: coalescedPcmBuffer,
        captureReason: "bot_turn_open_deferred_flush"
      });
      return;
    }

    await this.runRealtimeBrainReply({
      session,
      settings,
      userId: latestTurn?.userId || null,
      transcript: coalescedTranscript,
      directAddressed: Boolean(decision.directAddressed),
      directAddressConfidence: Number(decision.directAddressConfidence),
      conversationContext: decision.conversationContext || null,
      source: "bot_turn_open_deferred_flush"
    });
  }

  async forwardRealtimeTurnAudio({
    session,
    settings,
    userId,
    transcript = "",
    pcmBuffer,
    captureReason = "stream_end"
  }) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return false;
    if (!pcmBuffer?.length) return false;
    try {
      session.realtimeClient.appendInputAudioPcm(pcmBuffer);
      session.pendingRealtimeInputBytes = Math.max(0, Number(session.pendingRealtimeInputBytes || 0)) + pcmBuffer.length;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: `audio_append_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          mode: session.mode
        }
      });
      return false;
    }

    if (session.mode === "openai_realtime") {
      await this.prepareOpenAiRealtimeTurnContext({
        session,
        settings,
        userId,
        transcript,
        captureReason
      });
    }
    this.scheduleResponseFromBufferedAudio({ session, userId });
    return true;
  }

  queueVoiceMemoryIngest({
    session,
    settings,
    userId,
    transcript,
    source = "voice_stt_pipeline_ingest",
    captureReason = "stream_end",
    errorPrefix = "voice_stt_memory_ingest_failed"
  }) {
    if (!settings?.memory?.enabled) return;
    if (!this.memory || typeof this.memory.ingestMessage !== "function") return;

    const normalizedUserId = String(userId || "").trim();
    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedUserId || !normalizedTranscript) return;

    void this.memory
      .ingestMessage({
        messageId: `voice-${String(session.guildId || "guild")}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        authorId: normalizedUserId,
        authorName: this.resolveVoiceSpeakerName(session, normalizedUserId) || "unknown",
        content: normalizedTranscript,
        settings,
        trace: {
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: normalizedUserId,
          source: String(source || "voice_stt_pipeline_ingest")
        }
      })
      .catch((error) => {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: normalizedUserId || null,
          content: `${String(errorPrefix || "voice_stt_memory_ingest_failed")}: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id,
            captureReason: String(captureReason || "stream_end")
          }
        });
      });
  }

  buildVoiceConversationContext({
    session = null,
    userId = null,
    directAddressed = false,
    addressedToOtherParticipant = false,
    now = Date.now()
  } = {}) {
    const normalizedUserId = String(userId || "").trim();
    const focusedSpeakerUserId = String(session?.focusedSpeakerUserId || "").trim();
    const sameAsFocusedSpeaker =
      Boolean(normalizedUserId) &&
      Boolean(focusedSpeakerUserId) &&
      normalizedUserId === focusedSpeakerUserId;
    const focusedSpeakerAt = Number(session?.focusedSpeakerAt || 0);
    const msSinceFocusedSpeaker = focusedSpeakerAt > 0 ? Math.max(0, now - focusedSpeakerAt) : null;
    const focusedSpeakerFresh =
      sameAsFocusedSpeaker &&
      Number.isFinite(msSinceFocusedSpeaker) &&
      msSinceFocusedSpeaker <= FOCUSED_SPEAKER_CONTINUATION_MS;

    const lastAudioDeltaAt = Number(session?.lastAudioDeltaAt || 0);
    const msSinceAssistantReply = lastAudioDeltaAt > 0 ? Math.max(0, now - lastAudioDeltaAt) : null;
    const recentAssistantReply =
      Number.isFinite(msSinceAssistantReply) &&
      msSinceAssistantReply <= FOCUSED_SPEAKER_CONTINUATION_MS;

    const lastDirectAddressUserId = String(session?.lastDirectAddressUserId || "").trim();
    const sameAsRecentDirectAddress =
      Boolean(normalizedUserId) &&
      Boolean(lastDirectAddressUserId) &&
      normalizedUserId === lastDirectAddressUserId;
    const lastDirectAddressAt = Number(session?.lastDirectAddressAt || 0);
    const msSinceDirectAddress = lastDirectAddressAt > 0 ? Math.max(0, now - lastDirectAddressAt) : null;
    const recentDirectAddress =
      Number.isFinite(msSinceDirectAddress) &&
      msSinceDirectAddress <= FOCUSED_SPEAKER_CONTINUATION_MS;

    const engagedWithCurrentSpeaker =
      Boolean(directAddressed) ||
      focusedSpeakerFresh ||
      (recentAssistantReply && sameAsFocusedSpeaker) ||
      (recentDirectAddress && sameAsRecentDirectAddress);
    const engaged =
      !addressedToOtherParticipant &&
      engagedWithCurrentSpeaker;

    return {
      engagementState: engaged ? "engaged" : "wake_word_biased",
      engaged,
      engagedWithCurrentSpeaker,
      recentAssistantReply,
      recentDirectAddress,
      sameAsFocusedSpeaker,
      sameAsRecentDirectAddress,
      msSinceAssistantReply: Number.isFinite(msSinceAssistantReply) ? msSinceAssistantReply : null,
      msSinceDirectAddress: Number.isFinite(msSinceDirectAddress) ? msSinceDirectAddress : null,
      msSinceFocusedSpeaker: Number.isFinite(msSinceFocusedSpeaker) ? msSinceFocusedSpeaker : null
    };
  }

  async evaluateVoiceReplyDecision({
    session,
    settings,
    userId,
    transcript,
    source: _source = "stt_pipeline",
    transcriptionContext = null
  }) {
    const normalizedTranscript = normalizeVoiceText(transcript, VOICE_TURN_ADDRESSING_TRANSCRIPT_MAX_CHARS);
    const normalizedUserId = String(userId || "").trim();
    const participantCount = this.countHumanVoiceParticipants(session);
    const speakerName = this.resolveVoiceSpeakerName(session, userId) || "someone";
    const participantList = this.getVoiceChannelParticipants(session)
      .map((entry) => entry.displayName)
      .filter(Boolean)
      .slice(0, 10);
    const addressedToOtherParticipant = isLikelyVocativeAddressToOtherParticipant({
      transcript: normalizedTranscript,
      participantDisplayNames: participantList,
      botName: getPromptBotName(settings),
      speakerName
    });
    const now = Date.now();
    if (!normalizedTranscript) {
      const emptyConversationContext = this.buildVoiceConversationContext({
        session,
        userId: normalizedUserId,
        directAddressed: false,
        addressedToOtherParticipant,
        now
      });
      return {
        allow: false,
        reason: "missing_transcript",
        participantCount,
        directAddressed: false,
        directAddressConfidence: 0,
        directAddressThreshold: DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD,
        transcript: "",
        conversationContext: emptyConversationContext
      };
    }
    const directAddressedByWakePhrase = normalizedTranscript
      ? isVoiceTurnAddressedToBot(normalizedTranscript, settings)
      : false;
    const joinWindowAgeMs = Math.max(0, now - Number(session?.startedAt || 0));
    const joinWindowActive = Boolean(session?.startedAt) && joinWindowAgeMs <= JOIN_GREETING_LLM_WINDOW_MS;
    const replyDecisionLlm = settings?.voice?.replyDecisionLlm || {};
    const classifierEnabled =
      replyDecisionLlm?.enabled !== undefined ? Boolean(replyDecisionLlm.enabled) : true;

    const normalizeWakeTokens = (value = "") =>
      String(value || "")
        .trim()
        .toLowerCase()
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "")
        .match(/[\p{L}\p{N}]+/gu) || [];
    const containsTokenSequence = (tokens = [], sequence = []) => {
      if (!Array.isArray(tokens) || !Array.isArray(sequence)) return false;
      if (!tokens.length || !sequence.length || sequence.length > tokens.length) return false;
      for (let start = 0; start <= tokens.length - sequence.length; start += 1) {
        let matched = true;
        for (let index = 0; index < sequence.length; index += 1) {
          if (tokens[start + index] !== sequence[index]) {
            matched = false;
            break;
          }
        }
        if (matched) return true;
      }
      return false;
    };
    const botWakeTokens = normalizeWakeTokens(settings?.botName || "");
    const transcriptWakeTokens = normalizeWakeTokens(normalizedTranscript);
    const transcriptWakeTokenSet = new Set(transcriptWakeTokens);
    const mergedWakeToken = botWakeTokens.length >= 2 ? botWakeTokens.join("") : "";
    const mergedWakeTokenAddressed = Boolean(mergedWakeToken) && transcriptWakeTokenSet.has(mergedWakeToken);
    const exactWakeSequenceAddressed = containsTokenSequence(transcriptWakeTokens, botWakeTokens);
    const primaryWakeToken = botWakeTokens.find((token) => token.length >= 4 && !["bot", "ai", "assistant"].includes(token))
      || botWakeTokens.find((token) => token.length >= 4)
      || "";
    const primaryWakeTokenAddressed = primaryWakeToken ? transcriptWakeTokenSet.has(primaryWakeToken) : false;
    const deterministicDirectAddressed =
      directAddressedByWakePhrase &&
      (
        primaryWakeTokenAddressed ||
        exactWakeSequenceAddressed ||
        !mergedWakeTokenAddressed
      );
    const nameCueDetected = hasBotNameCue({
      transcript: normalizedTranscript,
      botName: getPromptBotName(settings)
    });
    const shouldRunAddressClassifier =
      classifierEnabled &&
      !deterministicDirectAddressed &&
      !mergedWakeTokenAddressed &&
      nameCueDetected;
    const directAddressAssessment = shouldRunAddressClassifier
      ? await scoreDirectAddressConfidence({
          llm: this.llm,
          settings,
          transcript: normalizedTranscript,
          botName: getPromptBotName(settings),
          mode: "voice",
          speakerName,
          participantNames: participantList,
          threshold: DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD,
          fallbackConfidence: deterministicDirectAddressed ? 0.92 : 0,
          trace: {
            guildId: session?.guildId || null,
            channelId: session?.textChannelId || null,
            userId: normalizedUserId || null,
            source: "voice_direct_address",
            event: String(_source || "stt_pipeline")
          }
        })
      : {
          confidence: deterministicDirectAddressed ? 0.92 : 0,
          threshold: DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD,
          addressed: deterministicDirectAddressed,
          reason: deterministicDirectAddressed ? "deterministic_wake_phrase" : "deterministic_not_direct",
          source: "fallback",
          llmProvider: null,
          llmModel: null,
          llmResponse: null,
          error: null
        };
    const directAddressConfidence = Number(directAddressAssessment.confidence) || 0;
    const directAddressThreshold = Number(directAddressAssessment.threshold) || DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD;
    const directAddressed =
      !addressedToOtherParticipant &&
      directAddressConfidence >= directAddressThreshold;
    const usedFallbackModel = Boolean(transcriptionContext?.usedFallbackModel);
    const replyEagerness = clamp(Number(settings?.voice?.replyEagerness) || 0, 0, 100);
    const baseConversationContext = this.buildVoiceConversationContext({
      session,
      userId: normalizedUserId,
      directAddressed,
      addressedToOtherParticipant,
      now
    });
    const voiceAddressingState = this.buildVoiceAddressingState({
      session,
      userId: normalizedUserId,
      now
    });
    const currentTurnAddressing = this.normalizeVoiceAddressingAnnotation({
      directAddressed,
      directedConfidence: directAddressConfidence,
      source: "decision",
      reason: directAddressAssessment?.reason || null
    });
    const conversationContext = {
      ...baseConversationContext,
      voiceAddressingState,
      currentTurnAddressing
    };
    const formatAgeMs = (value) =>
      Number.isFinite(value) ? String(Math.max(0, Math.round(value))) : "none";
    const configuredNonDirectSilenceMs = Number(settings?.voice?.nonDirectReplyMinSilenceMs);
    const nonDirectReplyMinSilenceMs = clamp(
      Number.isFinite(configuredNonDirectSilenceMs)
        ? Math.round(configuredNonDirectSilenceMs)
        : NON_DIRECT_REPLY_MIN_SILENCE_MS,
      600,
      12_000
    );

    const replyOutputLockState = this.getReplyOutputLockState(session);
    if (replyOutputLockState.locked) {
      return {
        allow: false,
        reason: "bot_turn_open",
        participantCount,
        directAddressed,
        directAddressConfidence,
        directAddressThreshold,
        transcript: normalizedTranscript,
        conversationContext,
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS,
        outputLockReason: replyOutputLockState.reason
      };
    }

    const lowSignalFragment = isLowSignalVoiceFragment(normalizedTranscript);
    const wakeWordPing = isLikelyWakeWordPing(normalizedTranscript);
    const lowSignalLlmEligible =
      !directAddressed &&
      !usedFallbackModel &&
      (joinWindowActive || shouldUseLlmForLowSignalTurn(normalizedTranscript));
    if (lowSignalFragment) {
      if (directAddressed && wakeWordPing) {
        return {
          allow: true,
          reason: "direct_address_wake_ping",
          participantCount,
          directAddressed,
          directAddressConfidence,
          directAddressThreshold,
          transcript: normalizedTranscript,
          conversationContext
        };
      }
      const clipDurationMs = Math.max(0, Number(transcriptionContext?.clipDurationMs || 0));
      const captureReason = String(transcriptionContext?.captureReason || "stream_end").trim() || "stream_end";
      const msSinceAssistantReply = Number(conversationContext?.msSinceAssistantReply ?? Number.NaN);
      const lowSignalRecentReplyClip =
        !directAddressed &&
        !addressedToOtherParticipant &&
        captureReason === "speaking_end" &&
        clipDurationMs > 0 &&
        clipDurationMs <= VOICE_LOW_SIGNAL_POST_REPLY_MAX_CLIP_MS &&
        Number.isFinite(msSinceAssistantReply) &&
        msSinceAssistantReply <= nonDirectReplyMinSilenceMs;
      if (lowSignalRecentReplyClip) {
        return {
          allow: false,
          reason: "low_signal_recent_reply_clip",
          participantCount,
          directAddressed,
          directAddressConfidence,
          directAddressThreshold,
          transcript: normalizedTranscript,
          conversationContext,
          requiredSilenceMs: nonDirectReplyMinSilenceMs,
          retryAfterMs: Math.max(60, nonDirectReplyMinSilenceMs - Math.round(msSinceAssistantReply))
        };
      }
      if (!lowSignalLlmEligible) {
        return {
          allow: false,
          reason: usedFallbackModel ? "low_signal_fallback_fragment" : "low_signal_fragment",
          participantCount,
          directAddressed,
          directAddressConfidence,
          directAddressThreshold,
          transcript: normalizedTranscript,
          conversationContext
        };
      }
    }

    const focusedSpeakerUserId = String(session?.focusedSpeakerUserId || "").trim();
    const focusedSpeakerAgeMs = now - Number(session?.focusedSpeakerAt || 0);
    const focusedSpeakerFollowup =
      !directAddressed &&
      normalizedUserId &&
      focusedSpeakerUserId &&
      normalizedUserId === focusedSpeakerUserId &&
      focusedSpeakerAgeMs >= 0 &&
      focusedSpeakerAgeMs <= FOCUSED_SPEAKER_CONTINUATION_MS &&
      !addressedToOtherParticipant;
    if (focusedSpeakerFollowup) {
      return {
        allow: true,
        reason: "focused_speaker_followup",
        participantCount,
        directAddressed,
        directAddressConfidence,
        directAddressThreshold,
        transcript: normalizedTranscript,
        conversationContext
      };
    }

    const botRecentReplyFollowup =
      !directAddressed &&
      !addressedToOtherParticipant &&
      !lowSignalFragment &&
      Boolean(conversationContext.recentAssistantReply) &&
      Boolean(conversationContext.sameAsFocusedSpeaker);
    if (botRecentReplyFollowup) {
      return {
        allow: true,
        reason: "bot_recent_reply_followup",
        participantCount,
        directAddressed,
        directAddressConfidence,
        directAddressThreshold,
        transcript: normalizedTranscript,
        conversationContext
      };
    }

    if (directAddressed) {
      return {
        allow: true,
        reason: "direct_address_fast_path",
        participantCount,
        directAddressed,
        directAddressConfidence,
        directAddressThreshold,
        transcript: normalizedTranscript,
        conversationContext
      };
    }

    if (!directAddressed && replyEagerness <= 0) {
      return {
        allow: false,
        reason: "eagerness_disabled_without_direct_address",
        participantCount,
        directAddressed,
        directAddressConfidence,
        directAddressThreshold,
        transcript: normalizedTranscript,
        conversationContext
      };
    }

    const sessionMode = String(session?.mode || settings?.voice?.mode || "")
      .trim()
      .toLowerCase();
    const requestedDecisionProvider = replyDecisionLlm?.provider;
    const llmProvider = normalizeVoiceReplyDecisionProvider(requestedDecisionProvider);
    const requestedDecisionModel = replyDecisionLlm?.model;
    const llmModel = String(requestedDecisionModel || defaultVoiceReplyDecisionModel(llmProvider))
      .trim()
      .slice(0, 120) || defaultVoiceReplyDecisionModel(llmProvider);

    const mergedWithGeneration =
      sessionMode === "stt_pipeline" ||
      (isRealtimeMode(sessionMode) &&
        this.resolveRealtimeReplyStrategy({
          session,
          settings
        }) === "brain");
    const configuredCrossSpeakerWakeMs = Number(settings?.voice?.crossSpeakerWakeMs);
    const crossSpeakerWakeMs = clamp(
      Number.isFinite(configuredCrossSpeakerWakeMs)
        ? Math.round(configuredCrossSpeakerWakeMs)
        : DIRECT_ADDRESS_CROSS_SPEAKER_WAKE_MS,
      1200,
      20_000
    );
    const lastInboundAudioAt = Number(session?.lastInboundAudioAt || 0);
    const msSinceInboundAudio =
      lastInboundAudioAt > 0 ? Math.max(0, now - lastInboundAudioAt) : null;
    const msSinceDirectAddress = Number(conversationContext?.msSinceDirectAddress || 0);
    const directAddressWakeAcrossSpeakers =
      Boolean(conversationContext?.recentDirectAddress) &&
      !conversationContext?.sameAsRecentDirectAddress &&
      Number.isFinite(msSinceDirectAddress) &&
      msSinceDirectAddress <= crossSpeakerWakeMs;
    const wakeModeActive =
      Boolean(conversationContext?.recentAssistantReply) ||
      Boolean(conversationContext?.sameAsRecentDirectAddress) ||
      directAddressWakeAcrossSpeakers;
    const shouldDelayNonDirectMergedRealtimeReply =
      !classifierEnabled &&
      isRealtimeMode(sessionMode) &&
      mergedWithGeneration &&
      participantCount > 1 &&
      !directAddressed &&
      (addressedToOtherParticipant || (!nameCueDetected && directAddressConfidence < directAddressThreshold && !wakeModeActive)) &&
      Number.isFinite(msSinceInboundAudio) &&
      msSinceInboundAudio < nonDirectReplyMinSilenceMs;
    if (shouldDelayNonDirectMergedRealtimeReply) {
      return {
        allow: false,
        reason: "awaiting_non_direct_silence_window",
        participantCount,
        directAddressed,
        directAddressConfidence,
        directAddressThreshold,
        transcript: normalizedTranscript,
        llmProvider,
        llmModel,
        conversationContext,
        msSinceInboundAudio,
        requiredSilenceMs: nonDirectReplyMinSilenceMs,
        retryAfterMs: Math.max(60, nonDirectReplyMinSilenceMs - Number(msSinceInboundAudio || 0))
      };
    }
    if (!classifierEnabled) {
      return {
        allow: mergedWithGeneration,
        reason:
          mergedWithGeneration
            ? "classifier_disabled_merged_with_generation"
            : "classifier_disabled",
        participantCount,
        directAddressed,
        directAddressConfidence,
        directAddressThreshold,
        transcript: normalizedTranscript,
        llmProvider,
        llmModel,
        conversationContext
      };
    }

    if (!this.llm?.generate) {
      return {
        allow: false,
        reason: "llm_generate_unavailable",
        participantCount,
        directAddressed,
        directAddressConfidence,
        directAddressThreshold,
        transcript: normalizedTranscript,
        llmProvider,
        llmModel,
        conversationContext
      };
    }

    const botName = getPromptBotName(settings);
    const recentHistory = this.formatVoiceDecisionHistory(session, 6, VOICE_DECIDER_PROMPT_HISTORY_MAX_CHARS);
    const trackedTurnCount = Array.isArray(session?.recentVoiceTurns) ? session.recentVoiceTurns.length : 0;
    this.updateModelContextSummary(session, "decider", {
      source: String(_source || "stt_pipeline"),
      capturedAt: new Date(now).toISOString(),
      availableTurns: trackedTurnCount,
      maxTurns: VOICE_DECIDER_HISTORY_MAX_TURNS,
      promptHistoryChars: recentHistory.length,
      transcriptChars: normalizedTranscript.length,
      directAddressed: Boolean(directAddressed),
      directAddressConfidence: Number(directAddressConfidence.toFixed(3)),
      directAddressThreshold: Number(directAddressThreshold.toFixed(2)),
      joinWindowActive,
      hasAddressingState: Boolean(
        voiceAddressingState?.currentSpeakerTarget ||
          (Array.isArray(voiceAddressingState?.recentAddressingGuesses) &&
            voiceAddressingState.recentAddressingGuesses.length > 0)
      )
    });
    const configuredMaxDecisionAttempts = Number(replyDecisionLlm?.maxAttempts);
    const maxDecisionAttempts = clamp(
      Math.floor(Number.isFinite(configuredMaxDecisionAttempts) ? configuredMaxDecisionAttempts : 1),
      1,
      3
    );
    const primaryDecisionSettings = {
      ...settings,
      llm: {
        ...(settings?.llm || {}),
        provider: llmProvider,
        model: llmModel,
        temperature: 0,
        maxOutputTokens: resolveVoiceReplyDecisionMaxOutputTokens(llmProvider, llmModel),
        reasoningEffort: String(replyDecisionLlm?.reasoningEffort || "minimal").trim().toLowerCase() || "minimal"
      }
    };

    const configuredPrompts = replyDecisionLlm?.prompts;
    const interpolateBotName = (template, fallback) => {
      const chosen = String(template || "").trim() || String(fallback || "").trim();
      return chosen.replace(/\{\{\s*botName\s*\}\}/gi, botName);
    };
    const wakeVariantHint = interpolateBotName(
      configuredPrompts?.wakeVariantHint,
      VOICE_REPLY_DECIDER_WAKE_VARIANT_HINT_DEFAULT
    );

    const fullContextPromptParts = [
      `Bot name: ${botName}.`,
      `Second-person references in this transcript ("you", "your") default to ${botName} (YOU) unless another human target is explicit.`,
      `Reply eagerness: ${replyEagerness}/100.`,
      `Human participants in channel: ${participantCount}.`,
      `Current speaker: ${speakerName}.`,
      `Join window active: ${joinWindowActive ? "yes" : "no"}.`,
      `Join window age ms: ${joinWindowAgeMs}.`,
      "Join-window bias rule: if Join window active is yes and this turn is a short greeting/check-in, default to YES unless another human target is explicit.",
      `Conversation engagement state: ${conversationContext.engagementState}.`,
      `Engaged with current speaker: ${conversationContext.engagedWithCurrentSpeaker ? "yes" : "no"}.`,
      `Current speaker matches focused speaker: ${conversationContext.sameAsFocusedSpeaker ? "yes" : "no"}.`,
      `Current speaker matches last direct-address speaker: ${conversationContext.sameAsRecentDirectAddress ? "yes" : "no"}.`,
      `Recent bot reply ms ago: ${formatAgeMs(conversationContext.msSinceAssistantReply)}.`,
      `Recent direct address ms ago: ${formatAgeMs(conversationContext.msSinceDirectAddress)}.`,
      `Directly addressed: ${directAddressed ? "yes" : "no"}.`,
      `Direct-address confidence: ${directAddressConfidence.toFixed(3)} (threshold ${directAddressThreshold.toFixed(2)}).`,
      `Likely aimed at another participant: ${addressedToOtherParticipant ? "yes" : "no"}.`,
      `Latest transcript: "${normalizedTranscript}".`,
      wakeVariantHint
    ];
    if (voiceAddressingState) {
      fullContextPromptParts.push(
        `Current speaker addressing guess: ${voiceAddressingState.currentSpeakerTarget || "unknown"} (confidence ${Number(voiceAddressingState.currentSpeakerDirectedConfidence || 0).toFixed(2)}).`
      );
      if (voiceAddressingState.lastDirectedToMe) {
        fullContextPromptParts.push(
          `Last directed-to-me turn: ${voiceAddressingState.lastDirectedToMe.speakerName} ${formatAgeMs(voiceAddressingState.lastDirectedToMe.ageMs)}ms ago (confidence ${Number(voiceAddressingState.lastDirectedToMe.directedConfidence || 0).toFixed(2)}).`
        );
      }
    }
    if (participantList.length) {
      fullContextPromptParts.push(`Participants: ${participantList.join(", ")}.`);
    }
    if (recentHistory) {
      fullContextPromptParts.push(`Recent voice turns:\n${recentHistory}`);
    }

    const compactContextPromptParts = [
      `Bot name: ${botName}.`,
      `Current speaker: ${speakerName}.`,
      `Join window active: ${joinWindowActive ? "yes" : "no"}.`,
      "Join-window bias rule: if Join window active is yes and this turn is a short greeting/check-in, default to YES unless another human target is explicit.",
      `Conversation engagement state: ${conversationContext.engagementState}.`,
      `Engaged with current speaker: ${conversationContext.engagedWithCurrentSpeaker ? "yes" : "no"}.`,
      `Current speaker matches focused speaker: ${conversationContext.sameAsFocusedSpeaker ? "yes" : "no"}.`,
      `Recent bot reply ms ago: ${formatAgeMs(conversationContext.msSinceAssistantReply)}.`,
      `Directly addressed: ${directAddressed ? "yes" : "no"}.`,
      `Direct-address confidence: ${directAddressConfidence.toFixed(3)} (threshold ${directAddressThreshold.toFixed(2)}).`,
      `Likely aimed at another participant: ${addressedToOtherParticipant ? "yes" : "no"}.`,
      `Reply eagerness: ${replyEagerness}/100.`,
      `Participants: ${participantCount}.`,
      `Transcript: "${normalizedTranscript}".`,
      wakeVariantHint
    ];
    if (voiceAddressingState) {
      compactContextPromptParts.push(
        `Current speaker addressing guess: ${voiceAddressingState.currentSpeakerTarget || "unknown"} (confidence ${Number(voiceAddressingState.currentSpeakerDirectedConfidence || 0).toFixed(2)}).`
      );
    }
    if (participantList.length) {
      compactContextPromptParts.push(`Known participants: ${participantList.join(", ")}.`);
    }
    if (recentHistory) {
      compactContextPromptParts.push(`Recent turns:\n${recentHistory}`);
    }

    const systemPromptCompact = interpolateBotName(
      configuredPrompts?.systemPromptCompact,
      VOICE_REPLY_DECIDER_SYSTEM_PROMPT_COMPACT_DEFAULT
    );
    const systemPromptFull = interpolateBotName(
      configuredPrompts?.systemPromptFull,
      VOICE_REPLY_DECIDER_SYSTEM_PROMPT_FULL_DEFAULT
    );
    const systemPromptStrict = interpolateBotName(
      configuredPrompts?.systemPromptStrict,
      VOICE_REPLY_DECIDER_SYSTEM_PROMPT_STRICT_DEFAULT
    );

    const decisionProcedure = [
      {
        label: "primary_compact_context",
        settings: primaryDecisionSettings,
        systemPrompt: systemPromptCompact,
        userPrompt: compactContextPromptParts.join("\n")
      },
      {
        label: "primary_full_context",
        settings: primaryDecisionSettings,
        systemPrompt: systemPromptFull,
        userPrompt: fullContextPromptParts.join("\n\n")
      },
      {
        label: "primary_minimal_context",
        settings: primaryDecisionSettings,
        systemPrompt: systemPromptStrict,
        userPrompt:
          `Join window active: ${joinWindowActive ? "yes" : "no"}.\n` +
          "Join-window bias rule: if Join window active is yes and this turn is a short greeting/check-in, default to YES unless another human target is explicit.\n" +
          `Conversation engagement state: ${conversationContext.engagementState}.\n` +
          `Directly addressed: ${directAddressed ? "yes" : "no"}.\n` +
          `Direct-address confidence: ${directAddressConfidence.toFixed(3)} (threshold ${directAddressThreshold.toFixed(2)}).\n` +
          `Transcript: "${normalizedTranscript}".`
      }
    ].slice(0, maxDecisionAttempts);
    const claudeDecisionJsonSchema =
      llmProvider === "claude-code"
        ? JSON.stringify({
            type: "object",
            additionalProperties: false,
            properties: {
              decision: {
                type: "string",
                enum: ["YES", "NO"]
              }
            },
            required: ["decision"]
          })
        : "";

    const invalidOutputs = [];
    const generationErrors = [];
    for (let index = 0; index < decisionProcedure.length; index += 1) {
      const step = decisionProcedure[index];
      try {
        const generation = await this.llm.generate({
          settings: step.settings,
          systemPrompt: step.systemPrompt,
          userPrompt: step.userPrompt,
          contextMessages: [],
          jsonSchema: claudeDecisionJsonSchema,
          trace: {
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId,
            source: "voice_reply_decision",
            event: step.label
          }
        });
        const raw = String(generation?.text || "").trim();
        const parsed = parseVoiceDecisionContract(raw);
        if (parsed.confident) {
          const resolvedProvider = generation?.provider || llmProvider;
          const resolvedModel = generation?.model || step?.settings?.llm?.model || llmModel;
          return {
            allow: parsed.allow,
            reason: parsed.allow ? (index === 0 ? "llm_yes" : "llm_yes_retry") : index === 0 ? "llm_no" : "llm_no_retry",
            participantCount,
            directAddressed,
            directAddressConfidence,
            directAddressThreshold,
            transcript: normalizedTranscript,
            llmResponse: raw,
            llmProvider: resolvedProvider,
            llmModel: resolvedModel,
            conversationContext
          };
        }

        invalidOutputs.push({
          step: step.label,
          text: raw || "(empty)"
        });
        break;
      } catch (error) {
        generationErrors.push({
          step: step.label,
          error: String(error?.message || error)
        });
      }
    }

    if (!invalidOutputs.length && generationErrors.length) {
      return {
        allow: false,
        reason: "llm_error",
        participantCount,
        directAddressed,
        directAddressConfidence,
        directAddressThreshold,
        transcript: normalizedTranscript,
        llmProvider,
        llmModel,
        error: generationErrors.map((row) => `${row.step}: ${row.error}`).join(" | "),
        conversationContext
      };
    }

    return {
      allow: false,
      reason: "llm_contract_violation",
      participantCount,
      directAddressed,
      directAddressConfidence,
      directAddressThreshold,
      transcript: normalizedTranscript,
      llmResponse: invalidOutputs.map((row) => `${row.step}=${row.text}`).join(" | "),
      llmProvider,
      llmModel,
      error: generationErrors.length
        ? generationErrors.map((row) => `${row.step}: ${row.error}`).join(" | ")
        : undefined,
      conversationContext
    };
  }

  formatVoiceDecisionHistory(session, maxTurns = 6, maxTotalChars = VOICE_DECIDER_PROMPT_HISTORY_MAX_CHARS) {
    const turns = Array.isArray(session?.recentVoiceTurns) ? session.recentVoiceTurns : [];
    if (!turns.length) return "";
    const lines = turns
      .slice(-Math.max(1, Number(maxTurns) || 6))
      .map((turn) => {
        const role = turn?.role === "assistant" ? "assistant" : "user";
        const text = normalizeVoiceText(turn?.text || "", VOICE_DECIDER_HISTORY_MAX_CHARS);
        if (!text) return "";
        const speaker =
          role === "assistant"
            ? getPromptBotName(session?.settingsSnapshot || this.store.getSettings())
            : String(turn?.speakerName || "someone").trim() || "someone";
        const addressing =
          turn?.addressing && typeof turn.addressing === "object" ? turn.addressing : null;
        const talkingTo =
          String(addressing?.talkingTo || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80) || null;
        const directedConfidenceRaw = Number(addressing?.directedConfidence);
        const directedConfidence = Number.isFinite(directedConfidenceRaw)
          ? clamp(directedConfidenceRaw, 0, 1)
          : 0;
        const addressingSuffix = talkingTo
          ? ` [to ${talkingTo}; confidence ${directedConfidence.toFixed(2)}]`
          : "";
        return `${speaker}: "${text}"${addressingSuffix}`;
      })
      .filter(Boolean);

    const boundedLines = [];
    let totalChars = 0;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line) continue;
      const delimiterChars = boundedLines.length > 0 ? 1 : 0;
      const projectedChars = totalChars + delimiterChars + line.length;
      if (projectedChars > Math.max(120, Number(maxTotalChars) || VOICE_DECIDER_PROMPT_HISTORY_MAX_CHARS)) {
        break;
      }
      boundedLines.push(line);
      totalChars = projectedChars;
    }

    return boundedLines.reverse().join("\n");
  }

  normalizeVoiceAddressingAnnotation({
    rawAddressing = null,
    directAddressed = false,
    directedConfidence = Number.NaN,
    source = "",
    reason = null
  } = {}) {
    const input = rawAddressing && typeof rawAddressing === "object" ? rawAddressing : null;
    const talkingToToken = normalizeVoiceAddressingTargetToken(input?.talkingTo ?? input?.target ?? "");
    let talkingTo = talkingToToken || null;

    const confidenceRaw = Number(
      input?.directedConfidence ?? input?.confidence ?? directedConfidence
    );
    let normalizedDirectedConfidence = Number.isFinite(confidenceRaw)
      ? clamp(confidenceRaw, 0, 1)
      : 0;

    if (directAddressed && !talkingTo) {
      talkingTo = "ME";
    }
    if (directAddressed && talkingTo === "ME") {
      normalizedDirectedConfidence = Math.max(normalizedDirectedConfidence, 0.72);
    }

    if (!talkingTo && normalizedDirectedConfidence <= 0) return null;

    const normalizedSource = String(source || "")
      .replace(/\s+/g, "_")
      .trim()
      .toLowerCase()
      .slice(0, 48);
    const normalizedReason =
      String(reason || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 140) || null;

    return {
      talkingTo,
      directedConfidence: Number(normalizedDirectedConfidence.toFixed(3)),
      source: normalizedSource || null,
      reason: normalizedReason
    };
  }

  mergeVoiceAddressingAnnotation(existing, incoming) {
    const current = existing && typeof existing === "object" ? existing : null;
    const next = incoming && typeof incoming === "object" ? incoming : null;
    if (!next) return current;
    if (!current) return next;

    const currentTarget = String(current.talkingTo || "").trim();
    const nextTarget = String(next.talkingTo || "").trim();
    const currentConfidence = Number.isFinite(Number(current.directedConfidence))
      ? clamp(Number(current.directedConfidence), 0, 1)
      : 0;
    const nextConfidence = Number.isFinite(Number(next.directedConfidence))
      ? clamp(Number(next.directedConfidence), 0, 1)
      : 0;
    const nextSource = String(next.source || "").trim().toLowerCase();
    const shouldReplace =
      (nextTarget && !currentTarget) ||
      nextConfidence > currentConfidence + 0.02 ||
      (nextSource === "generation" && nextTarget && nextConfidence >= currentConfidence - 0.05);

    return shouldReplace
      ? {
          ...current,
          ...next
        }
      : current;
  }

  findLatestVoiceTurnIndex(rows, { role = "user", userId = null, text = null, textMaxChars = STT_TRANSCRIPT_MAX_CHARS }) {
    const source = Array.isArray(rows) ? rows : [];
    if (!source.length) return -1;
    const normalizedRole = role === "assistant" ? "assistant" : "user";
    const normalizedUserId = String(userId || "").trim() || null;
    const normalizedText = text ? normalizeVoiceText(text, textMaxChars) : "";

    for (let index = source.length - 1; index >= 0; index -= 1) {
      const row = source[index];
      if (!row || typeof row !== "object") continue;
      const rowRole = row.role === "assistant" ? "assistant" : "user";
      if (rowRole !== normalizedRole) continue;
      if (String(row.userId || "") !== String(normalizedUserId || "")) continue;
      if (normalizedText) {
        const rowText = normalizeVoiceText(row.text || "", textMaxChars);
        if (!rowText || rowText !== normalizedText) continue;
      }
      return index;
    }
    return -1;
  }

  annotateLatestVoiceTurnAddressing({
    session = null,
    role = "user",
    userId = null,
    text = "",
    addressing = null
  } = {}) {
    if (!session || session.ending) return false;
    const normalizedAddressing =
      addressing && typeof addressing === "object"
        ? this.normalizeVoiceAddressingAnnotation({ rawAddressing: addressing })
        : null;
    if (!normalizedAddressing) return false;

    const modelTurns = Array.isArray(session.recentVoiceTurns) ? session.recentVoiceTurns : [];
    const transcriptTurns = Array.isArray(session.transcriptTurns) ? session.transcriptTurns : [];
    const modelTurnIndex = this.findLatestVoiceTurnIndex(modelTurns, {
      role,
      userId,
      text,
      textMaxChars: VOICE_DECIDER_HISTORY_MAX_CHARS
    });
    const transcriptTurnIndex = this.findLatestVoiceTurnIndex(transcriptTurns, {
      role,
      userId,
      text,
      textMaxChars: STT_TRANSCRIPT_MAX_CHARS
    });
    if (modelTurnIndex < 0 && transcriptTurnIndex < 0) return false;

    if (modelTurnIndex >= 0) {
      const current = modelTurns[modelTurnIndex]?.addressing;
      modelTurns[modelTurnIndex] = {
        ...modelTurns[modelTurnIndex],
        addressing: this.mergeVoiceAddressingAnnotation(current, normalizedAddressing)
      };
    }
    if (transcriptTurnIndex >= 0) {
      const current = transcriptTurns[transcriptTurnIndex]?.addressing;
      transcriptTurns[transcriptTurnIndex] = {
        ...transcriptTurns[transcriptTurnIndex],
        addressing: this.mergeVoiceAddressingAnnotation(current, normalizedAddressing)
      };
    }

    return true;
  }

  buildVoiceAddressingState({ session = null, userId = null, now = Date.now(), maxItems = 6 } = {}) {
    const sourceTurns = Array.isArray(session?.transcriptTurns) ? session.transcriptTurns : [];
    if (!sourceTurns.length) return null;

    const normalizedUserId = String(userId || "").trim();
    const normalizedMaxItems = Math.max(1, Math.min(12, Math.floor(Number(maxItems) || 6)));
    const annotatedRows = sourceTurns
      .filter((row) => row && typeof row === "object" && (row.role === "user" || row.role === "assistant"))
      .map((row) => {
        const normalized = this.normalizeVoiceAddressingAnnotation({
          rawAddressing: row?.addressing
        });
        if (!normalized) return null;
        const atRaw = Number(row?.at || 0);
        const at = atRaw > 0 ? atRaw : null;
        const ageMs = at ? Math.max(0, now - at) : null;
        return {
          role: row.role === "assistant" ? "assistant" : "user",
          userId: String(row?.userId || "").trim() || null,
          speakerName: String(row?.speakerName || "").trim() || "someone",
          talkingTo: normalized.talkingTo || null,
          directedConfidence: Number(normalized.directedConfidence || 0),
          at,
          ageMs
        };
      })
      .filter(Boolean);
    if (!annotatedRows.length) return null;

    const recentAddressingGuesses = annotatedRows
      .slice(-normalizedMaxItems)
      .map((row) => ({
        speakerName: row.speakerName,
        talkingTo: row.talkingTo || null,
        directedConfidence: Number(clamp(Number(row.directedConfidence) || 0, 0, 1).toFixed(3)),
        ageMs: Number.isFinite(row.ageMs) ? Math.round(row.ageMs) : null
      }));

    const currentSpeakerRow = normalizedUserId
      ? [...annotatedRows]
          .reverse()
          .find((row) => row.role === "user" && String(row.userId || "") === normalizedUserId) || null
      : null;
    const lastDirectedToMeRow =
      [...annotatedRows]
        .reverse()
        .find((row) => row.role === "user" && row.talkingTo === "ME" && Number(row.directedConfidence || 0) > 0) ||
      null;

    return {
      currentSpeakerTarget: currentSpeakerRow?.talkingTo || null,
      currentSpeakerDirectedConfidence: Number(
        clamp(Number(currentSpeakerRow?.directedConfidence) || 0, 0, 1).toFixed(3)
      ),
      lastDirectedToMe: lastDirectedToMeRow
        ? {
            speakerName: lastDirectedToMeRow.speakerName,
            directedConfidence: Number(clamp(Number(lastDirectedToMeRow.directedConfidence) || 0, 0, 1).toFixed(3)),
            ageMs: Number.isFinite(lastDirectedToMeRow.ageMs) ? Math.round(lastDirectedToMeRow.ageMs) : null
          }
        : null,
      recentAddressingGuesses
    };
  }

  shouldPersistUserTranscriptTimelineTurn({ session = null, settings = null, transcript = "" } = {}) {
    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedTranscript) return false;
    const resolvedSettings = settings || session?.settingsSnapshot || this.store.getSettings();
    const directAddressed = isVoiceTurnAddressedToBot(normalizedTranscript, resolvedSettings);
    if (directAddressed) return true;
    return !isLowSignalVoiceFragment(normalizedTranscript);
  }

  recordVoiceTurn(session, { role = "user", userId = null, text = "", addressing = null } = {}) {
    if (!session || session.ending) return;
    const normalizedContextText = normalizeVoiceText(text, VOICE_DECIDER_HISTORY_MAX_CHARS);
    const normalizedTranscriptText = normalizeVoiceText(text, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedContextText || !normalizedTranscriptText) return;

    const normalizedRole = role === "assistant" ? "assistant" : "user";
    const normalizedUserId = String(userId || "").trim() || null;
    const turns = Array.isArray(session.recentVoiceTurns) ? session.recentVoiceTurns : [];
    const transcriptTurns = Array.isArray(session.transcriptTurns) ? session.transcriptTurns : [];
    const speakerName =
      normalizedRole === "assistant"
        ? getPromptBotName(session.settingsSnapshot || this.store.getSettings())
        : this.resolveVoiceSpeakerName(session, normalizedUserId) || "someone";
    const previous = turns[turns.length - 1];
    if (
      previous &&
      previous.role === normalizedRole &&
      String(previous.userId || "") === String(normalizedUserId || "") &&
      String(previous.text || "") === normalizedContextText
    ) {
      return;
    }

    const nextAt = Date.now();
    const normalizedSpeakerName = String(speakerName || "").trim() || "someone";
    const normalizedAddressing = this.normalizeVoiceAddressingAnnotation({
      rawAddressing: addressing
    });
    const modelTurnEntry = {
      role: normalizedRole,
      userId: normalizedUserId,
      speakerName: normalizedSpeakerName,
      text: normalizedContextText,
      at: nextAt
    };
    if (normalizedAddressing) {
      modelTurnEntry.addressing = normalizedAddressing;
    }
    const transcriptTurnEntry = {
      role: normalizedRole,
      userId: normalizedUserId,
      speakerName: normalizedSpeakerName,
      text: normalizedTranscriptText,
      at: nextAt
    };
    if (normalizedAddressing) {
      transcriptTurnEntry.addressing = normalizedAddressing;
    }
    session.recentVoiceTurns = [
      ...turns,
      modelTurnEntry
    ].slice(-VOICE_DECIDER_HISTORY_MAX_TURNS);
    session.transcriptTurns = [
      ...transcriptTurns,
      transcriptTurnEntry
    ].slice(-VOICE_TRANSCRIPT_TIMELINE_MAX_TURNS);
  }

  updateModelContextSummary(session, section, summary = null) {
    if (!session || session.ending) return;
    const key = section === "decider" ? "decider" : "generation";
    const current =
      session.modelContextSummary && typeof session.modelContextSummary === "object"
        ? session.modelContextSummary
        : { generation: null, decider: null };
    current[key] = summary && typeof summary === "object" ? summary : null;
    session.modelContextSummary = current;
  }

  updateFocusedSpeakerWindow({
    session = null,
    userId = null,
    allow = false,
    directAddressed = false,
    reason = ""
  } = {}) {
    if (!session || session.ending) return;
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return;

    const now = Date.now();
    const normalizedReason = String(reason || "").trim().toLowerCase();
    if (directAddressed) {
      session.lastDirectAddressAt = now;
      session.lastDirectAddressUserId = normalizedUserId;
    }
    if (
      allow &&
      (
        directAddressed ||
        normalizedReason === "focused_speaker_followup" ||
        normalizedReason === "bot_recent_reply_followup" ||
        normalizedReason === "llm_yes" ||
        normalizedReason === "llm_yes_retry"
      )
    ) {
      session.focusedSpeakerUserId = normalizedUserId;
      session.focusedSpeakerAt = now;
      return;
    }
    if (directAddressed && normalizedReason === "bot_turn_open") {
      session.focusedSpeakerUserId = normalizedUserId;
      session.focusedSpeakerAt = now;
      return;
    }

    if (now - Number(session.focusedSpeakerAt || 0) > FOCUSED_SPEAKER_CONTINUATION_MS) {
      session.focusedSpeakerUserId = null;
      session.focusedSpeakerAt = 0;
    }
  }

  countHumanVoiceParticipants(session) {
    const guild = this.client.guilds.cache.get(String(session?.guildId || ""));
    const voiceChannelId = String(session?.voiceChannelId || "");
    if (!guild || !voiceChannelId) return 1;

    const channel = guild.channels?.cache?.get(voiceChannelId) || null;
    if (channel?.members && typeof channel.members.forEach === "function") {
      let count = 0;
      channel.members.forEach((member) => {
        if (!member?.user?.bot) count += 1;
      });
      return Math.max(0, count);
    }

    if (guild.members?.cache) {
      let count = 0;
      guild.members.cache.forEach((member) => {
        if (member?.user?.bot) return;
        if (String(member?.voice?.channelId || "") !== voiceChannelId) return;
        count += 1;
      });
      return Math.max(0, count);
    }

    return 1;
  }

  async prepareOpenAiRealtimeTurnContext({ session, settings, userId, transcript = "", captureReason: _captureReason = "stream_end" }) {
    if (!session || session.ending) return;
    if (session.mode !== "openai_realtime") return;

    const normalizedTranscript = normalizeVoiceText(transcript, REALTIME_CONTEXT_TRANSCRIPT_MAX_CHARS);
    const memorySlice = await this.buildOpenAiRealtimeMemorySlice({
      session,
      settings,
      userId,
      transcript: normalizedTranscript
    });

    await this.refreshOpenAiRealtimeInstructions({
      session,
      settings,
      reason: "turn_context",
      speakerUserId: userId,
      transcript: normalizedTranscript,
      memorySlice
    });
  }

  async buildOpenAiRealtimeMemorySlice({ session, settings, userId, transcript = "" }) {
    const empty = {
      userFacts: [],
      relevantFacts: []
    };

    if (!settings?.memory?.enabled) return empty;
    if (!this.memory || typeof this.memory !== "object") return empty;

    const normalizedUserId = String(userId || "").trim();
    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedUserId || !normalizedTranscript) return empty;

    const slice = await loadPromptMemorySliceFromMemory({
      settings,
      memory: this.memory,
      userId: normalizedUserId,
      guildId: session.guildId,
      channelId: session.textChannelId,
      queryText: normalizedTranscript,
      trace: {
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: normalizedUserId
      },
      source: "voice_realtime_instruction_context",
      onError: ({ error }) => {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: normalizedUserId,
          content: `voice_realtime_memory_slice_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id
          }
        });
      }
    });

    return {
      userFacts: slice.userFacts,
      relevantFacts: slice.relevantFacts
    };
  }

  scheduleOpenAiRealtimeInstructionRefresh({
    session,
    settings,
    reason = "voice_context_refresh",
    speakerUserId = null,
    transcript = "",
    memorySlice = null
  }) {
    if (!session || session.ending) return;
    if (session.mode !== "openai_realtime") return;

    if (session.realtimeInstructionRefreshTimer) {
      clearTimeout(session.realtimeInstructionRefreshTimer);
      session.realtimeInstructionRefreshTimer = null;
    }

    session.realtimeInstructionRefreshTimer = setTimeout(() => {
      session.realtimeInstructionRefreshTimer = null;
      this.refreshOpenAiRealtimeInstructions({
        session,
        settings: settings || session.settingsSnapshot || this.store.getSettings(),
        reason,
        speakerUserId,
        transcript,
        memorySlice
      }).catch(() => undefined);
    }, REALTIME_INSTRUCTION_REFRESH_DEBOUNCE_MS);
  }

  async refreshOpenAiRealtimeInstructions({
    session,
    settings,
    reason = "voice_context_refresh",
    speakerUserId = null,
    transcript = "",
    memorySlice = null
  }) {
    if (!session || session.ending) return;
    if (session.mode !== "openai_realtime") return;
    if (!session.realtimeClient || typeof session.realtimeClient.updateInstructions !== "function") return;

    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    const instructions = this.buildOpenAiRealtimeInstructions({
      session,
      settings: resolvedSettings,
      speakerUserId,
      transcript,
      memorySlice
    });
    if (!instructions) return;
    if (instructions === session.lastOpenAiRealtimeInstructions) return;

    try {
      session.realtimeClient.updateInstructions(instructions);
      session.lastOpenAiRealtimeInstructions = instructions;
      session.lastOpenAiRealtimeInstructionsAt = Date.now();

      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "openai_realtime_instructions_updated",
        metadata: {
          sessionId: session.id,
          reason: String(reason || "voice_context_refresh"),
          speakerUserId: speakerUserId ? String(speakerUserId) : null,
          participantCount: this.getVoiceChannelParticipants(session).length,
          transcriptChars: transcript ? String(transcript).length : 0,
          userFactCount: Array.isArray(memorySlice?.userFacts) ? memorySlice.userFacts.length : 0,
          relevantFactCount: Array.isArray(memorySlice?.relevantFacts) ? memorySlice.relevantFacts.length : 0,
          instructionsChars: instructions.length
        }
      });
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `openai_realtime_instruction_update_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          reason: String(reason || "voice_context_refresh")
        }
      });
    }
  }

  buildOpenAiRealtimeInstructions({ session, settings, speakerUserId = null, transcript = "", memorySlice = null }) {
    const baseInstructions = String(session?.baseVoiceInstructions || this.buildVoiceInstructions(settings)).trim();
    const speakerName = this.resolveVoiceSpeakerName(session, speakerUserId);
    const normalizedTranscript = normalizeVoiceText(transcript, REALTIME_CONTEXT_TRANSCRIPT_MAX_CHARS);
    const streamWatchBrainContext = this.getStreamWatchBrainContextForPrompt(session, settings);
    const participants = this.getVoiceChannelParticipants(session);
    const recentMembershipEvents = this.getRecentVoiceMembershipEvents(session, {
      maxItems: VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT
    });
    const guild = this.client.guilds.cache.get(String(session?.guildId || "")) || null;
    const voiceChannel = guild?.channels?.cache?.get(String(session?.voiceChannelId || "")) || null;
    const roster =
      participants.length > 0
        ? participants
            .slice(0, REALTIME_CONTEXT_MEMBER_LIMIT)
            .map((participant) => participant.displayName)
            .join(", ")
        : "unknown";
    const membershipSummary = recentMembershipEvents.length
      ? recentMembershipEvents
          .map((entry) => {
            const action = entry.eventType === "join" ? "joined" : "left";
            return `${entry.displayName} ${action} (${Math.max(0, Math.round(entry.ageMs))}ms ago)`;
          })
          .join(" | ")
      : "none";
    const userFacts = formatRealtimeMemoryFacts(memorySlice?.userFacts, REALTIME_MEMORY_FACT_LIMIT);
    const relevantFacts = formatRealtimeMemoryFacts(memorySlice?.relevantFacts, REALTIME_MEMORY_FACT_LIMIT);

    const sections = [baseInstructions];
    sections.push(
      [
        "Live server context:",
        `- Server: ${String(guild?.name || "unknown").trim() || "unknown"}`,
        `- Voice channel: ${String(voiceChannel?.name || "unknown").trim() || "unknown"}`,
        `- Humans currently in channel: ${roster}`,
        `- Recent membership changes: ${membershipSummary}`,
        "- If someone recently joined, a quick natural greeting is usually good.",
        "- If someone recently left, a brief natural goodbye/acknowledgement is usually good."
      ].join("\n")
    );

    if (speakerName || normalizedTranscript) {
      sections.push(
        [
          "Current turn context:",
          speakerName ? `- Active speaker: ${speakerName}` : null,
          normalizedTranscript ? `- Latest speaker transcript: ${normalizedTranscript}` : null
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    if (userFacts || relevantFacts) {
      sections.push(
        [
          "Durable memory context:",
          userFacts ? `- Known facts about active speaker: ${userFacts}` : null,
          relevantFacts ? `- Other relevant memory: ${relevantFacts}` : null
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    if (streamWatchBrainContext?.notes?.length) {
      sections.push(
        [
          "Screen-share stream frame context:",
          `- Guidance: ${String(streamWatchBrainContext.prompt || "").trim()}`,
          ...streamWatchBrainContext.notes.slice(-8).map((note) => `- ${note}`),
          "- Treat these notes as snapshots, not a continuous feed."
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    return sections.join("\n\n").slice(0, 5200);
  }

  getVoiceChannelParticipants(session) {
    const guild = this.client.guilds.cache.get(String(session?.guildId || ""));
    const voiceChannelId = String(session?.voiceChannelId || "");
    if (!guild || !voiceChannelId) return [];

    const channel = guild.channels?.cache?.get(voiceChannelId) || null;
    if (!channel?.members || typeof channel.members.forEach !== "function") return [];

    const participants = [];
    channel.members.forEach((member) => {
      if (!member || member.user?.bot) return;
      const displayName = String(member.displayName || member.user?.globalName || member.user?.username || "").trim();
      if (!displayName) return;
      participants.push({
        userId: String(member.id || ""),
        displayName
      });
    });

    return participants.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  getRecentVoiceMembershipEvents(
    session,
    { now = Date.now(), maxItems = VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT } = {}
  ) {
    const events = Array.isArray(session?.membershipEvents) ? session.membershipEvents : [];
    const normalizedNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const boundedMax = clamp(
      Math.floor(Number(maxItems) || VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT),
      1,
      VOICE_MEMBERSHIP_EVENT_MAX_TRACKED
    );

    return events
      .map((entry) => {
        const eventType = String(entry?.eventType || "")
          .trim()
          .toLowerCase();
        if (eventType !== "join" && eventType !== "leave") return null;

        const userId = String(entry?.userId || "").trim();
        const displayName = String(entry?.displayName || "")
          .trim()
          .slice(0, 80);
        const at = Number(entry?.at || 0);
        if (!Number.isFinite(at) || at <= 0) return null;

        return {
          userId,
          displayName: displayName || "unknown",
          eventType,
          at,
          ageMs: Math.max(0, normalizedNow - at)
        };
      })
      .filter((entry) => entry && entry.ageMs <= VOICE_MEMBERSHIP_EVENT_FRESH_MS)
      .slice(-boundedMax);
  }

  recordVoiceMembershipEvent({ session, userId, eventType, displayName = "", at = Date.now() }) {
    if (!session || session.ending) return null;
    const normalizedUserId = String(userId || "").trim();
    const normalizedEventType = String(eventType || "")
      .trim()
      .toLowerCase();
    if (!normalizedUserId) return null;
    if (normalizedEventType !== "join" && normalizedEventType !== "leave") return null;

    const membershipEvents = Array.isArray(session.membershipEvents) ? session.membershipEvents : [];
    if (!Array.isArray(session.membershipEvents)) {
      session.membershipEvents = membershipEvents;
    }

    const eventAt = Number.isFinite(Number(at)) ? Math.max(0, Number(at)) : Date.now();
    const resolvedDisplayName =
      String(displayName || "").trim() || this.resolveVoiceSpeakerName(session, normalizedUserId) || "unknown";
    const previous = membershipEvents[membershipEvents.length - 1];
    const duplicate =
      previous &&
      String(previous.userId || "").trim() === normalizedUserId &&
      String(previous.eventType || "").trim().toLowerCase() === normalizedEventType &&
      eventAt - Number(previous.at || 0) <= 2500;
    if (duplicate) {
      return null;
    }

    const eventRow = {
      userId: normalizedUserId,
      displayName: resolvedDisplayName.slice(0, 80),
      eventType: normalizedEventType,
      at: eventAt
    };
    membershipEvents.push(eventRow);
    if (membershipEvents.length > VOICE_MEMBERSHIP_EVENT_MAX_TRACKED) {
      session.membershipEvents = membershipEvents.slice(-VOICE_MEMBERSHIP_EVENT_MAX_TRACKED);
    } else {
      session.membershipEvents = membershipEvents;
    }
    return eventRow;
  }

  resolveVoiceSpeakerName(session, userId) {
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return "";

    const participants = this.getVoiceChannelParticipants(session);
    const inChannel = participants.find((participant) => participant.userId === normalizedUserId);
    if (inChannel?.displayName) return inChannel.displayName;

    const guild = this.client.guilds.cache.get(String(session?.guildId || "")) || null;
    const guildName =
      guild?.members?.cache?.get(normalizedUserId)?.displayName ||
      guild?.members?.cache?.get(normalizedUserId)?.user?.globalName ||
      guild?.members?.cache?.get(normalizedUserId)?.user?.username ||
      null;
    if (guildName) return String(guildName);

    const userName = this.client.users?.cache?.get(normalizedUserId)?.username || "";
    return String(userName || "").trim();
  }

  getPendingSttTurnQueue(session) {
    if (!session) return [];
    const pendingQueue = Array.isArray(session.pendingSttTurnsQueue) ? session.pendingSttTurnsQueue : [];
    if (!Array.isArray(session.pendingSttTurnsQueue)) {
      session.pendingSttTurnsQueue = pendingQueue;
    }
    return pendingQueue;
  }

  syncPendingSttTurnCount(session) {
    if (!session) return;
    const pendingQueueDepth = Array.isArray(session.pendingSttTurnsQueue) ? session.pendingSttTurnsQueue.length : 0;
    session.pendingSttTurns = Math.max(0, (session.sttTurnDrainActive ? 1 : 0) + pendingQueueDepth);
  }

  shouldCoalesceSttTurn(prevTurn, nextTurn) {
    if (!prevTurn || !nextTurn) return false;
    const prevUserId = String(prevTurn.userId || "").trim();
    const nextUserId = String(nextTurn.userId || "").trim();
    if (!prevUserId || !nextUserId || prevUserId !== nextUserId) return false;

    const prevCaptureReason = String(prevTurn.captureReason || "").trim();
    const nextCaptureReason = String(nextTurn.captureReason || "").trim();
    if (!prevCaptureReason || !nextCaptureReason || prevCaptureReason !== nextCaptureReason) return false;

    const prevQueuedAt = Number(prevTurn.queuedAt || 0);
    const nextQueuedAt = Number(nextTurn.queuedAt || 0);
    if (!prevQueuedAt || !nextQueuedAt) return false;
    if (nextQueuedAt - prevQueuedAt > STT_TURN_COALESCE_WINDOW_MS) return false;

    const prevBuffer = Buffer.isBuffer(prevTurn.pcmBuffer) ? prevTurn.pcmBuffer : null;
    const nextBuffer = Buffer.isBuffer(nextTurn.pcmBuffer) ? nextTurn.pcmBuffer : null;
    if (!prevBuffer?.length || !nextBuffer?.length) return false;
    if (prevBuffer.length + nextBuffer.length > STT_TURN_COALESCE_MAX_BYTES) return false;

    return true;
  }

  queueSttPipelineTurn({ session, userId, pcmBuffer, captureReason = "stream_end" }) {
    if (!session || session.ending) return;
    if (session.mode !== "stt_pipeline") return;
    if (!pcmBuffer || !pcmBuffer.length) return;

    const pendingQueue = this.getPendingSttTurnQueue(session);
    const queuedTurn = {
      session,
      userId,
      pcmBuffer,
      captureReason,
      queuedAt: Date.now()
    };

    if (session.sttTurnDrainActive) {
      const lastQueuedTurn = pendingQueue[pendingQueue.length - 1] || null;
      if (this.shouldCoalesceSttTurn(lastQueuedTurn, queuedTurn)) {
        lastQueuedTurn.pcmBuffer = Buffer.concat([lastQueuedTurn.pcmBuffer, queuedTurn.pcmBuffer]);
        lastQueuedTurn.captureReason = queuedTurn.captureReason;
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          content: "stt_pipeline_turn_coalesced",
          metadata: {
            sessionId: session.id,
            captureReason: String(captureReason || "stream_end"),
            combinedBytes: lastQueuedTurn.pcmBuffer.length,
            queueDepth: pendingQueue.length
          }
        });
        return;
      }

      if (pendingQueue.length >= STT_TURN_QUEUE_MAX) {
        const droppedTurn = pendingQueue.shift();
        if (droppedTurn) {
          this.store.logAction({
            kind: "voice_runtime",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId,
            content: "stt_pipeline_turn_superseded",
            metadata: {
              sessionId: session.id,
              replacedCaptureReason: String(droppedTurn.captureReason || "stream_end"),
              replacingCaptureReason: String(captureReason || "stream_end"),
              replacedQueueAgeMs: Math.max(0, Date.now() - Number(droppedTurn.queuedAt || Date.now())),
              maxQueueDepth: STT_TURN_QUEUE_MAX
            }
          });
        }
      }
      pendingQueue.push(queuedTurn);
      this.syncPendingSttTurnCount(session);
      return;
    }

    if (pendingQueue.length > 0) {
      if (pendingQueue.length >= STT_TURN_QUEUE_MAX) {
        pendingQueue.shift();
      }
      pendingQueue.push(queuedTurn);
      const nextTurn = pendingQueue.shift();
      if (!nextTurn) return;
      this.drainSttPipelineTurnQueue(nextTurn).catch(() => undefined);
      return;
    }

    this.drainSttPipelineTurnQueue(queuedTurn).catch(() => undefined);
  }

  async drainSttPipelineTurnQueue(initialTurn) {
    const session = initialTurn?.session;
    if (!session || session.ending) return;
    if (session.mode !== "stt_pipeline") return;
    if (session.sttTurnDrainActive) return;
    const pendingQueue = this.getPendingSttTurnQueue(session);

    session.sttTurnDrainActive = true;
    this.syncPendingSttTurnCount(session);
    let turn = initialTurn;

    try {
      while (turn && !session.ending) {
        try {
          await this.runSttPipelineTurn(turn);
        } catch (error) {
          this.store.logAction({
            kind: "voice_error",
            guildId: session.guildId,
            channelId: session.textChannelId,
            userId: turn.userId,
            content: `stt_pipeline_turn_failed: ${String(error?.message || error)}`,
            metadata: {
              sessionId: session.id
            }
          });
        }

        const nextTurn = pendingQueue.shift();
        turn = nextTurn || null;
        this.syncPendingSttTurnCount(session);
      }
    } finally {
      session.sttTurnDrainActive = false;
      if (session.ending) {
        session.pendingSttTurnsQueue = [];
      } else {
        const pendingTurn = pendingQueue.shift();
        if (pendingTurn) {
          this.syncPendingSttTurnCount(session);
          this.drainSttPipelineTurnQueue(pendingTurn).catch(() => undefined);
        }
      }
      this.syncPendingSttTurnCount(session);
    }
  }

  async runSttPipelineTurn({ session, userId, pcmBuffer, captureReason = "stream_end", queuedAt = 0 }) {
    if (!session || session.ending) return;
    if (session.mode !== "stt_pipeline") return;
    if (!pcmBuffer?.length) return;
    if (!this.llm?.transcribeAudio || !this.llm?.synthesizeSpeech) return;

    const queueWaitMs = queuedAt ? Math.max(0, Date.now() - Number(queuedAt || Date.now())) : 0;
    const pendingQueueDepth = Array.isArray(session.pendingSttTurnsQueue) ? session.pendingSttTurnsQueue.length : 0;
    const staleTurn = queueWaitMs >= STT_TURN_STALE_SKIP_MS;
    if (staleTurn && pendingQueueDepth > 1) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "stt_pipeline_turn_skipped_stale",
        metadata: {
          sessionId: session.id,
          captureReason: String(captureReason || "stream_end"),
          queueWaitMs,
          pendingQueueDepth,
          pcmBytes: pcmBuffer.length,
          droppedBeforeAsr: true
        }
      });
      return;
    }

    const settings = session.settingsSnapshot || this.store.getSettings();
    const asrLanguageGuidance = resolveVoiceAsrLanguageGuidance(settings);
    const sttSettings = settings?.voice?.sttPipeline || {};
    const transcriptionModelPrimary =
      String(sttSettings?.transcriptionModel || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
    const sampleRateHz = 24000;
    const silenceGate = this.evaluatePcmSilenceGate({
      pcmBuffer,
      sampleRateHz
    });
    const clipDurationMs = silenceGate.clipDurationMs;
    if (silenceGate.drop) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "voice_turn_dropped_silence_gate",
        metadata: {
          sessionId: session.id,
          source: "stt_pipeline",
          captureReason: String(captureReason || "stream_end"),
          pcmBytes: pcmBuffer.length,
          clipDurationMs,
          rms: Number(silenceGate.rms.toFixed(6)),
          peak: Number(silenceGate.peak.toFixed(6)),
          activeSampleRatio: Number(silenceGate.activeSampleRatio.toFixed(6)),
          queueWaitMs,
          pendingQueueDepth
        }
      });
      return;
    }
    let transcriptionModelFallback = null;
    let transcriptionPlanReason = "configured_model";
    if (transcriptionModelPrimary === "gpt-4o-mini-transcribe") {
      transcriptionModelFallback = "gpt-4o-transcribe";
      transcriptionPlanReason = "mini_with_full_fallback_runtime";
    }
    let usedFallbackModelForTranscript = false;

    let transcript = await this.transcribePcmTurn({
      session,
      userId,
      pcmBuffer,
      model: transcriptionModelPrimary,
      sampleRateHz,
      captureReason,
      traceSource: "voice_stt_pipeline_turn",
      errorPrefix: "stt_pipeline_transcription_failed",
      emptyTranscriptRuntimeEvent: "voice_stt_transcription_empty",
      emptyTranscriptErrorStreakThreshold: VOICE_EMPTY_TRANSCRIPT_ERROR_STREAK,
      asrLanguage: asrLanguageGuidance.language,
      asrPrompt: asrLanguageGuidance.prompt
    });
    if (
      !transcript &&
      transcriptionModelFallback &&
      transcriptionModelFallback !== transcriptionModelPrimary
    ) {
      transcript = await this.transcribePcmTurn({
        session,
        userId,
        pcmBuffer,
        model: transcriptionModelFallback,
        sampleRateHz,
        captureReason,
        traceSource: "voice_stt_pipeline_turn_fallback",
        errorPrefix: "stt_pipeline_transcription_fallback_failed",
        emptyTranscriptRuntimeEvent: "voice_stt_transcription_empty",
        emptyTranscriptErrorStreakThreshold: VOICE_EMPTY_TRANSCRIPT_ERROR_STREAK,
        suppressEmptyTranscriptLogs: true,
        asrLanguage: asrLanguageGuidance.language,
        asrPrompt: asrLanguageGuidance.prompt
      });
      if (transcript) {
        usedFallbackModelForTranscript = true;
      }
    }
    if (!transcript) return;
    if (
      this.shouldDropFallbackLowSignalTurn({
        transcript,
        usedFallbackModel: usedFallbackModelForTranscript,
        silenceGate,
        captureReason
      })
    ) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "voice_turn_dropped_low_signal_fallback",
        metadata: {
          sessionId: session.id,
          source: "stt_pipeline",
          captureReason: String(captureReason || "stream_end"),
          transcript,
          clipDurationMs,
          rms: Number(silenceGate.rms.toFixed(6)),
          peak: Number(silenceGate.peak.toFixed(6)),
          activeSampleRatio: Number(silenceGate.activeSampleRatio.toFixed(6)),
          transcriptionModelPrimary,
          transcriptionModelFallback,
          transcriptionUsedFallbackModel: true
        }
      });
      return;
    }
    if (session.ending) return;

    this.touchActivity(session.guildId, settings);
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "stt_pipeline_transcript",
      metadata: {
        sessionId: session.id,
        captureReason: String(captureReason || "stream_end"),
        transcript,
        transcriptionModelPrimary,
        transcriptionModelFallback,
        transcriptionUsedFallbackModel: usedFallbackModelForTranscript,
        transcriptionPlanReason,
        clipDurationMs
      }
    });
    const persistSttTranscriptTurn = this.shouldPersistUserTranscriptTimelineTurn({
      session,
      settings,
      transcript
    });
    if (persistSttTranscriptTurn) {
      this.recordVoiceTurn(session, {
        role: "user",
        userId,
        text: transcript
      });

      this.queueVoiceMemoryIngest({
        session,
        settings,
        userId,
        transcript,
        source: "voice_stt_pipeline_ingest",
        captureReason,
        errorPrefix: "voice_stt_memory_ingest_failed"
      });
    }
    if (staleTurn) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "stt_pipeline_turn_skipped_stale",
        metadata: {
          sessionId: session.id,
          captureReason: String(captureReason || "stream_end"),
          queueWaitMs,
          pendingQueueDepth,
          pcmBytes: pcmBuffer.length,
          droppedBeforeAsr: false
        }
      });
      return;
    }

    const turnDecision = await this.evaluateVoiceReplyDecision({
      session,
      settings,
      userId,
      transcript,
      source: "stt_pipeline",
      transcriptionContext: {
        usedFallbackModel: usedFallbackModelForTranscript,
        captureReason: String(captureReason || "stream_end"),
        clipDurationMs
      }
    });
    this.updateFocusedSpeakerWindow({
      session,
      userId,
      allow: Boolean(turnDecision.allow),
      directAddressed: Boolean(turnDecision.directAddressed),
      reason: turnDecision.reason
    });
    const turnVoiceAddressing = this.normalizeVoiceAddressingAnnotation({
      rawAddressing: turnDecision?.voiceAddressing,
      directAddressed: Boolean(turnDecision.directAddressed),
      directedConfidence: Number(turnDecision.directAddressConfidence),
      source: "decision",
      reason: turnDecision.reason
    });
    this.annotateLatestVoiceTurnAddressing({
      session,
      role: "user",
      userId,
      text: turnDecision.transcript || transcript,
      addressing: turnVoiceAddressing
    });
    const turnAddressingState = this.buildVoiceAddressingState({
      session,
      userId
    });

    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId,
      content: "voice_turn_addressing",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source: "stt_pipeline",
        captureReason: String(captureReason || "stream_end"),
        allow: Boolean(turnDecision.allow),
        reason: turnDecision.reason,
        participantCount: Number(turnDecision.participantCount || 0),
        directAddressed: Boolean(turnDecision.directAddressed),
        talkingTo: turnVoiceAddressing?.talkingTo || null,
        directedConfidence: Number.isFinite(Number(turnVoiceAddressing?.directedConfidence))
          ? Number(clamp(Number(turnVoiceAddressing.directedConfidence), 0, 1).toFixed(3))
          : 0,
        addressingSource: turnVoiceAddressing?.source || null,
        addressingReason: turnVoiceAddressing?.reason || null,
        currentSpeakerTarget: turnAddressingState?.currentSpeakerTarget || null,
        currentSpeakerDirectedConfidence: Number.isFinite(
          Number(turnAddressingState?.currentSpeakerDirectedConfidence)
        )
          ? Number(clamp(Number(turnAddressingState.currentSpeakerDirectedConfidence), 0, 1).toFixed(3))
          : 0,
        transcript: turnDecision.transcript || transcript || null,
        transcriptionModelPrimary,
        transcriptionModelFallback,
        transcriptionUsedFallbackModel: usedFallbackModelForTranscript,
        transcriptionPlanReason,
        clipDurationMs,
        asrSkippedShortClip: false,
        llmResponse: turnDecision.llmResponse || null,
        llmProvider: turnDecision.llmProvider || null,
        llmModel: turnDecision.llmModel || null,
        conversationState: turnDecision.conversationContext?.engagementState || null,
        conversationEngaged: Boolean(turnDecision.conversationContext?.engaged),
        engagedWithCurrentSpeaker: Boolean(turnDecision.conversationContext?.engagedWithCurrentSpeaker),
        recentAssistantReply: Boolean(turnDecision.conversationContext?.recentAssistantReply),
        msSinceAssistantReply: Number.isFinite(turnDecision.conversationContext?.msSinceAssistantReply)
          ? Math.round(turnDecision.conversationContext.msSinceAssistantReply)
          : null,
        msSinceDirectAddress: Number.isFinite(turnDecision.conversationContext?.msSinceDirectAddress)
          ? Math.round(turnDecision.conversationContext.msSinceDirectAddress)
          : null,
        msSinceInboundAudio: Number.isFinite(turnDecision.msSinceInboundAudio)
          ? Math.round(turnDecision.msSinceInboundAudio)
          : null,
        requiredSilenceMs: Number.isFinite(turnDecision.requiredSilenceMs)
          ? Math.round(turnDecision.requiredSilenceMs)
          : null,
        retryAfterMs: Number.isFinite(turnDecision.retryAfterMs)
          ? Math.round(turnDecision.retryAfterMs)
          : null,
        error: turnDecision.error || null
      }
    });
    if (!turnDecision.allow) {
      if (
        turnDecision.reason === "bot_turn_open" ||
        turnDecision.reason === "awaiting_non_direct_silence_window"
      ) {
        this.queueDeferredBotTurnOpenTurn({
          session,
          userId,
          transcript: turnDecision.transcript || transcript,
          captureReason,
          source: "stt_pipeline",
          directAddressed: Boolean(turnDecision.directAddressed),
          deferReason: turnDecision.reason,
          flushDelayMs: turnDecision.retryAfterMs
        });
      }
      return;
    }

    await this.runSttPipelineReply({
      session,
      settings,
      userId,
      transcript,
      directAddressed: Boolean(turnDecision.directAddressed),
      directAddressConfidence: Number(turnDecision.directAddressConfidence),
      conversationContext: turnDecision.conversationContext || null
    });
  }

  async runSttPipelineReply({
    session,
    settings,
    userId,
    transcript,
    directAddressed = false,
    directAddressConfidence = Number.NaN,
    conversationContext = null
  }) {
    if (!session || session.ending) return;
    if (session.mode !== "stt_pipeline") return;
    if (!this.llm?.synthesizeSpeech) return;
    if (typeof this.generateVoiceTurn !== "function") return;

    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedTranscript) return;
    const contextTranscript = normalizeVoiceText(normalizedTranscript, STT_REPLY_MAX_CHARS);
    const contextTurns = Array.isArray(session.recentVoiceTurns)
      ? session.recentVoiceTurns
          .filter((row) => row && typeof row === "object")
          .slice(-STT_CONTEXT_MAX_MESSAGES)
      : [];
    if (contextTurns.length > 0 && contextTranscript) {
      const lastTurn = contextTurns[contextTurns.length - 1];
      const lastRole = lastTurn?.role === "assistant" ? "assistant" : "user";
      const lastContent = normalizeVoiceText(lastTurn?.text, STT_REPLY_MAX_CHARS);
      if (lastRole === "user" && lastContent && lastContent === contextTranscript) {
        contextTurns.pop();
      }
    }
    const contextMessages = contextTurns
      .map((row) => ({
        role: row.role === "assistant" ? "assistant" : "user",
        content: normalizeVoiceText(row.text, STT_REPLY_MAX_CHARS)
      }))
      .filter((row) => row.content);
    const contextMessageChars = contextMessages.reduce((total, row) => total + String(row?.content || "").length, 0);
    this.updateModelContextSummary(session, "generation", {
      source: "stt_pipeline",
      capturedAt: new Date().toISOString(),
      availableTurns: contextTurns.length,
      sentTurns: contextMessages.length,
      maxTurns: STT_CONTEXT_MAX_MESSAGES,
      contextChars: contextMessageChars,
      transcriptChars: normalizedTranscript.length,
      directAddressed: Boolean(directAddressed)
    });
    const soundboardCandidateInfo = await this.resolveSoundboardCandidates({
      session,
      settings
    });
    const soundboardCandidateLines = (Array.isArray(soundboardCandidateInfo?.candidates)
      ? soundboardCandidateInfo.candidates
      : []
    )
      .map((entry) => formatSoundboardCandidateLine(entry))
      .filter(Boolean)
      .slice(0, SOUNDBOARD_MAX_CANDIDATES);
    const resolvedConversationContext =
      conversationContext && typeof conversationContext === "object"
        ? conversationContext
        : this.buildVoiceConversationContext({
          session,
          userId,
          directAddressed: Boolean(directAddressed)
        });
    const participantRoster = this.getVoiceChannelParticipants(session).slice(0, REALTIME_CONTEXT_MEMBER_LIMIT);
    const recentMembershipEvents = this.getRecentVoiceMembershipEvents(session, {
      maxItems: VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT
    });
    const contextNow = Date.now();
    const joinWindowAgeMs = Math.max(0, contextNow - Number(session?.startedAt || 0));
    const joinWindowActive = Boolean(session?.startedAt) && joinWindowAgeMs <= JOIN_GREETING_LLM_WINDOW_MS;
    const sessionTiming = this.buildVoiceSessionTimingContext(session);
    const streamWatchBrainContext = this.getStreamWatchBrainContextForPrompt(session, settings);
    const voiceAddressingState = this.buildVoiceAddressingState({
      session,
      userId,
      now: contextNow
    });
    const generationConversationContext = {
      ...(resolvedConversationContext || {}),
      joinWindowActive,
      joinWindowAgeMs: Math.round(joinWindowAgeMs),
      sessionTimeoutWarningActive: Boolean(sessionTiming?.timeoutWarningActive),
      sessionTimeoutWarningReason: String(sessionTiming?.timeoutWarningReason || "none"),
      streamWatchBrainContext,
      voiceAddressingState
    };

    let replyText = "";
    let requestedSoundboardRefs = [];
    let usedWebSearchFollowup = false;
    let usedOpenArticleFollowup = false;
    let usedScreenShareOffer = false;
    let leaveVoiceChannelRequested = false;
    let generatedVoiceAddressing = null;
    let releaseLookupBusy = null;
    try {
      const generated = await this.generateVoiceTurn({
        settings,
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        transcript: normalizedTranscript,
        directAddressed: Boolean(directAddressed),
        contextMessages,
        sessionId: session.id,
        isEagerTurn: !directAddressed && !generationConversationContext?.engaged,
        joinWindowActive,
        joinWindowAgeMs,
        voiceEagerness: Number(settings?.voice?.replyEagerness) || 0,
        conversationContext: generationConversationContext,
        sessionTiming,
        participantRoster,
        recentMembershipEvents,
        soundboardCandidates: soundboardCandidateLines,
        onWebLookupStart: async ({ query }) => {
          if (typeof releaseLookupBusy === "function") return;
          releaseLookupBusy = this.beginVoiceWebLookupBusy({
            session,
            settings,
            userId,
            query,
            source: "stt_pipeline_web_lookup"
          });
        },
        onWebLookupComplete: async () => {
          if (typeof releaseLookupBusy !== "function") return;
          releaseLookupBusy();
          releaseLookupBusy = null;
        },
        webSearchTimeoutMs: Number(settings?.voice?.webSearchTimeoutMs)
      });
      const generatedPayload =
        generated && typeof generated === "object"
          ? generated
          : {
              text: generated,
              soundboardRefs: [],
              usedWebSearchFollowup: false,
              usedOpenArticleFollowup: false,
              usedScreenShareOffer: false,
              leaveVoiceChannelRequested: false,
              voiceAddressing: null
            };
      replyText = normalizeVoiceText(generatedPayload?.text || "", STT_REPLY_MAX_CHARS);
      requestedSoundboardRefs = this.normalizeSoundboardRefs(generatedPayload?.soundboardRefs);
      usedWebSearchFollowup = Boolean(generatedPayload?.usedWebSearchFollowup);
      usedOpenArticleFollowup = Boolean(generatedPayload?.usedOpenArticleFollowup);
      usedScreenShareOffer = Boolean(generatedPayload?.usedScreenShareOffer);
      leaveVoiceChannelRequested = Boolean(generatedPayload?.leaveVoiceChannelRequested);
      generatedVoiceAddressing = this.normalizeVoiceAddressingAnnotation({
        rawAddressing: generatedPayload?.voiceAddressing,
        directAddressed: Boolean(directAddressed),
        directedConfidence: Number(directAddressConfidence),
        source: "generation",
        reason: "voice_generation"
      });
      if (generatedVoiceAddressing) {
        this.annotateLatestVoiceTurnAddressing({
          session,
          role: "user",
          userId,
          text: normalizedTranscript,
          addressing: generatedVoiceAddressing
        });
      }
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: `stt_pipeline_generation_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
      return;
    } finally {
      if (typeof releaseLookupBusy === "function") {
        releaseLookupBusy();
        releaseLookupBusy = null;
      }
    }
    if (session.ending) return;
    const playbackPlan = this.buildVoiceReplyPlaybackPlan({
      replyText,
      trailingSoundboardRefs: requestedSoundboardRefs
    });
    if (!playbackPlan.spokenText && playbackPlan.soundboardRefs.length === 0 && !leaveVoiceChannelRequested) return;
    const playbackResult = await this.playVoiceReplyInOrder({
      session,
      settings,
      spokenText: playbackPlan.spokenText,
      playbackSteps: playbackPlan.steps,
      source: "stt_pipeline_reply",
      preferRealtimeUtterance: false
    });
    if (!playbackResult.completed) return;
    const spokeLine = Boolean(playbackResult.spokeLine);

    try {
      const replyAt = Date.now();
      const replyRuntimeEvent = playbackPlan.spokenText
        ? "stt_pipeline_reply_spoken"
        : playbackPlan.soundboardRefs.length > 0
          ? "stt_pipeline_soundboard_only"
          : leaveVoiceChannelRequested
            ? "stt_pipeline_leave_directive"
            : "stt_pipeline_reply_skipped";
      if (spokeLine) {
        session.lastAudioDeltaAt = replyAt;
      }
      session.lastAssistantReplyAt = replyAt;
      if (playbackPlan.spokenText) {
        this.recordVoiceTurn(session, {
          role: "assistant",
          userId: this.client.user?.id || null,
          text: playbackPlan.spokenText
        });
      }
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: replyRuntimeEvent,
        metadata: {
          sessionId: session.id,
          replyText: playbackPlan.spokenText || null,
          spokeLine,
          soundboardRefs: playbackPlan.soundboardRefs,
          playedSoundboardCount: Number(playbackResult.playedSoundboardCount || 0),
          usedWebSearchFollowup,
          usedOpenArticleFollowup,
          usedScreenShareOffer,
          talkingTo: generatedVoiceAddressing?.talkingTo || null,
          directedConfidence: Number.isFinite(Number(generatedVoiceAddressing?.directedConfidence))
            ? Number(clamp(Number(generatedVoiceAddressing.directedConfidence), 0, 1).toFixed(3))
            : 0,
          leaveVoiceChannelRequested,
          joinWindowActive,
          joinWindowAgeMs: Math.round(joinWindowAgeMs),
          contextTurnsSent: contextMessages.length,
          contextTurnsAvailable: contextTurns.length,
          contextCharsSent: contextMessageChars
        }
      });
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `stt_pipeline_audio_write_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
    }

    if (!leaveVoiceChannelRequested || session.ending) return;

    if (playbackPlan.spokenText && spokeLine) {
      await this.waitForLeaveDirectivePlayback({
        session,
        expectRealtimeAudio: false,
        source: "stt_pipeline_leave_directive"
      });
    }

    await this.endSession({
      guildId: session.guildId,
      reason: "assistant_leave_directive",
      requestedByUserId: this.client.user?.id || null,
      settings,
      announcement: "wrapping up vc."
    }).catch((error) => {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: `assistant_leave_directive_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          mode: session.mode
        }
      });
    });
  }

  async runRealtimeBrainReply({
    session,
    settings,
    userId,
    transcript = "",
    directAddressed = false,
    directAddressConfidence = Number.NaN,
    conversationContext = null,
    source = "realtime",
    latencyContext = null
  }) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return false;
    if (typeof this.generateVoiceTurn !== "function") {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: "realtime_generation_unavailable",
        metadata: {
          sessionId: session.id,
          source: String(source || "realtime")
        }
      });
      return false;
    }

    const normalizedTranscript = normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    if (!normalizedTranscript) return false;
    const contextTranscript = normalizeVoiceText(normalizedTranscript, STT_REPLY_MAX_CHARS);
    const contextTurns = Array.isArray(session.recentVoiceTurns)
      ? session.recentVoiceTurns
          .filter((row) => row && typeof row === "object")
          .slice(-STT_CONTEXT_MAX_MESSAGES)
      : [];
    if (contextTurns.length > 0 && contextTranscript) {
      const lastTurn = contextTurns[contextTurns.length - 1];
      const lastRole = lastTurn?.role === "assistant" ? "assistant" : "user";
      const lastContent = normalizeVoiceText(lastTurn?.text, STT_REPLY_MAX_CHARS);
      if (lastRole === "user" && lastContent && lastContent === contextTranscript) {
        contextTurns.pop();
      }
    }
    const contextMessages = contextTurns
      .map((row) => ({
        role: row.role === "assistant" ? "assistant" : "user",
        content: normalizeVoiceText(row.text, STT_REPLY_MAX_CHARS)
      }))
      .filter((row) => row.content);
    const contextMessageChars = contextMessages.reduce((total, row) => total + String(row?.content || "").length, 0);
    this.updateModelContextSummary(session, "generation", {
      source: String(source || "realtime"),
      capturedAt: new Date().toISOString(),
      availableTurns: contextTurns.length,
      sentTurns: contextMessages.length,
      maxTurns: STT_CONTEXT_MAX_MESSAGES,
      contextChars: contextMessageChars,
      transcriptChars: normalizedTranscript.length,
      directAddressed: Boolean(directAddressed)
    });
    const soundboardCandidateInfo = await this.resolveSoundboardCandidates({
      session,
      settings
    });
    const soundboardCandidateLines = (Array.isArray(soundboardCandidateInfo?.candidates)
      ? soundboardCandidateInfo.candidates
      : []
    )
      .map((entry) => formatSoundboardCandidateLine(entry))
      .filter(Boolean)
      .slice(0, SOUNDBOARD_MAX_CANDIDATES);
    const resolvedConversationContext =
      conversationContext && typeof conversationContext === "object"
        ? conversationContext
        : this.buildVoiceConversationContext({
          session,
          userId,
          directAddressed: Boolean(directAddressed)
        });
    const participantRoster = this.getVoiceChannelParticipants(session).slice(0, REALTIME_CONTEXT_MEMBER_LIMIT);
    const recentMembershipEvents = this.getRecentVoiceMembershipEvents(session, {
      maxItems: VOICE_MEMBERSHIP_EVENT_PROMPT_LIMIT
    });
    const contextNow = Date.now();
    const joinWindowAgeMs = Math.max(0, contextNow - Number(session?.startedAt || 0));
    const joinWindowActive = Boolean(session?.startedAt) && joinWindowAgeMs <= JOIN_GREETING_LLM_WINDOW_MS;
    const sessionTiming = this.buildVoiceSessionTimingContext(session);
    const streamWatchBrainContext = this.getStreamWatchBrainContextForPrompt(session, settings);
    const voiceAddressingState = this.buildVoiceAddressingState({
      session,
      userId,
      now: contextNow
    });
    const generationConversationContext = {
      ...(resolvedConversationContext || {}),
      joinWindowActive,
      joinWindowAgeMs: Math.round(joinWindowAgeMs),
      sessionTimeoutWarningActive: Boolean(sessionTiming?.timeoutWarningActive),
      sessionTimeoutWarningReason: String(sessionTiming?.timeoutWarningReason || "none"),
      streamWatchBrainContext,
      voiceAddressingState
    };
    const normalizedLatencyContext =
      latencyContext && typeof latencyContext === "object" ? latencyContext : {};
    const latencyFinalizedAtMs = Math.max(0, Number(normalizedLatencyContext.finalizedAtMs || 0));
    const latencyAsrStartedAtMs = Math.max(0, Number(normalizedLatencyContext.asrStartedAtMs || 0));
    const latencyAsrCompletedAtMs = Math.max(0, Number(normalizedLatencyContext.asrCompletedAtMs || 0));
    const latencyQueueWaitMs = Number.isFinite(Number(normalizedLatencyContext.queueWaitMs))
      ? Math.max(0, Math.round(Number(normalizedLatencyContext.queueWaitMs)))
      : null;
    const latencyPendingQueueDepth = Number.isFinite(Number(normalizedLatencyContext.pendingQueueDepth))
      ? Math.max(0, Math.round(Number(normalizedLatencyContext.pendingQueueDepth)))
      : null;
    const latencyCaptureReason =
      String(normalizedLatencyContext.captureReason || "").trim() || null;

    const generationStartedAt = Date.now();
    let releaseLookupBusy = null;
    let generatedPayload = null;
    let generatedVoiceAddressing = null;
    try {
      const generated = await this.generateVoiceTurn({
        settings,
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        transcript: normalizedTranscript,
        directAddressed: Boolean(directAddressed),
        contextMessages,
        sessionId: session.id,
        isEagerTurn: !directAddressed && !generationConversationContext?.engaged,
        joinWindowActive,
        joinWindowAgeMs,
        voiceEagerness: Number(settings?.voice?.replyEagerness) || 0,
        conversationContext: generationConversationContext,
        sessionTiming,
        participantRoster,
        recentMembershipEvents,
        soundboardCandidates: soundboardCandidateLines,
        onWebLookupStart: async ({ query }) => {
          if (typeof releaseLookupBusy === "function") return;
          releaseLookupBusy = this.beginVoiceWebLookupBusy({
            session,
            settings,
            userId,
            query,
            source: `${String(source || "realtime")}:web_lookup`
          });
        },
        onWebLookupComplete: async () => {
          if (typeof releaseLookupBusy !== "function") return;
          releaseLookupBusy();
          releaseLookupBusy = null;
        },
        webSearchTimeoutMs: Number(settings?.voice?.webSearchTimeoutMs)
      });
      generatedPayload =
        generated && typeof generated === "object"
          ? generated
          : {
              text: generated,
              soundboardRefs: [],
              usedWebSearchFollowup: false,
              usedOpenArticleFollowup: false,
              usedScreenShareOffer: false,
              leaveVoiceChannelRequested: false,
              voiceAddressing: null
            };
      generatedVoiceAddressing = this.normalizeVoiceAddressingAnnotation({
        rawAddressing: generatedPayload?.voiceAddressing,
        directAddressed: Boolean(directAddressed),
        directedConfidence: Number(directAddressConfidence),
        source: "generation",
        reason: "voice_generation"
      });
      if (generatedVoiceAddressing) {
        this.annotateLatestVoiceTurnAddressing({
          session,
          role: "user",
          userId,
          text: normalizedTranscript,
          addressing: generatedVoiceAddressing
        });
      }
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: `realtime_generation_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id,
          source: String(source || "realtime")
        }
      });
      return false;
    } finally {
      if (typeof releaseLookupBusy === "function") {
        releaseLookupBusy();
      }
    }

    const replyText = normalizeVoiceText(generatedPayload?.text || "", STT_REPLY_MAX_CHARS);
    const requestedSoundboardRefs = this.normalizeSoundboardRefs(generatedPayload?.soundboardRefs);
    const usedWebSearchFollowup = Boolean(generatedPayload?.usedWebSearchFollowup);
    const usedOpenArticleFollowup = Boolean(generatedPayload?.usedOpenArticleFollowup);
    const usedScreenShareOffer = Boolean(generatedPayload?.usedScreenShareOffer);
    const leaveVoiceChannelRequested = Boolean(generatedPayload?.leaveVoiceChannelRequested);
    const replyInterruptionPolicy = this.buildReplyInterruptionPolicy({
      session,
      userId,
      directAddressed: Boolean(directAddressed),
      conversationContext: resolvedConversationContext,
      generatedVoiceAddressing,
      source: String(source || "realtime")
    });
    const supersedeAfterGeneration = this.getRealtimeReplySupersedeState({
      session,
      generationStartedAt,
      interruptionPolicy: replyInterruptionPolicy
    });
    if (supersedeAfterGeneration.shouldSupersede) {
      this.recordRealtimeReplySuperseded({
        session,
        source: String(source || "realtime"),
        supersedeState: supersedeAfterGeneration
      });
      return true;
    }
    const playbackPlan = this.buildVoiceReplyPlaybackPlan({
      replyText,
      trailingSoundboardRefs: requestedSoundboardRefs
    });
    if (!playbackPlan.spokenText && playbackPlan.soundboardRefs.length === 0 && !leaveVoiceChannelRequested) {
      const skipCause = !replyText
        ? "empty_reply_text"
        : replyText === "[SKIP]"
          ? "model_skip"
          : "no_playback_steps";
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "realtime_reply_skipped",
        metadata: {
          sessionId: session.id,
          mode: session.mode,
          source: String(source || "realtime"),
          usedWebSearchFollowup,
          usedOpenArticleFollowup,
          usedScreenShareOffer,
          talkingTo: generatedVoiceAddressing?.talkingTo || null,
          directedConfidence: Number.isFinite(Number(generatedVoiceAddressing?.directedConfidence))
            ? Number(clamp(Number(generatedVoiceAddressing.directedConfidence), 0, 1).toFixed(3))
            : 0,
          soundboardRefs: [],
          leaveVoiceChannelRequested,
          skipCause,
          replyTextPreview: replyText ? replyText.slice(0, 220) : null,
          joinWindowActive,
          joinWindowAgeMs: Math.round(joinWindowAgeMs),
          conversationState: resolvedConversationContext?.engagementState || null,
          engagedWithCurrentSpeaker: Boolean(resolvedConversationContext?.engagedWithCurrentSpeaker),
          contextTurnsSent: contextMessages.length,
          contextTurnsAvailable: contextTurns.length,
          contextCharsSent: contextMessageChars
        }
      });
      return true;
    }

    if (playbackPlan.spokenText && session.mode === "openai_realtime") {
      void this.prepareOpenAiRealtimeTurnContext({
        session,
        settings,
        userId,
        transcript: normalizedTranscript,
        captureReason: String(source || "realtime")
      }).catch((error) => {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          content: `openai_realtime_turn_context_refresh_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id,
            source: String(source || "realtime")
          }
        });
      });
    }

    const supersedeBeforePlayback = this.getRealtimeReplySupersedeState({
      session,
      generationStartedAt,
      interruptionPolicy: replyInterruptionPolicy
    });
    if (supersedeBeforePlayback.shouldSupersede) {
      this.recordRealtimeReplySuperseded({
        session,
        source: String(source || "realtime"),
        supersedeState: supersedeBeforePlayback
      });
      return true;
    }

    const replyRequestedAt = Date.now();
    const replyLatencyContext = {
      finalizedAtMs: latencyFinalizedAtMs,
      asrStartedAtMs: latencyAsrStartedAtMs,
      asrCompletedAtMs: latencyAsrCompletedAtMs,
      generationStartedAtMs: generationStartedAt,
      replyRequestedAtMs: replyRequestedAt,
      audioStartedAtMs: 0,
      source: String(source || "realtime"),
      captureReason: latencyCaptureReason,
      queueWaitMs: latencyQueueWaitMs,
      pendingQueueDepth: latencyPendingQueueDepth
    };
    this.setActiveReplyInterruptionPolicy(session, replyInterruptionPolicy);
    session.lastAssistantReplyAt = replyRequestedAt;
    const playbackResult = await this.playVoiceReplyInOrder({
      session,
      settings,
      spokenText: playbackPlan.spokenText,
      playbackSteps: playbackPlan.steps,
      source: `${String(source || "realtime")}:reply`,
      preferRealtimeUtterance: true,
      interruptionPolicy: replyInterruptionPolicy,
      latencyContext: replyLatencyContext
    });
    if (!playbackResult.completed) {
      this.maybeClearActiveReplyInterruptionPolicy(session);
      return false;
    }
    const pendingRequestId = Number(session.pendingResponse?.requestId || 0) || null;
    this.logVoiceLatencyStage({
      session,
      userId: this.client.user?.id || null,
      stage: "reply_requested",
      source: String(source || "realtime"),
      captureReason: latencyCaptureReason,
      requestId: pendingRequestId,
      queueWaitMs: latencyQueueWaitMs,
      pendingQueueDepth: latencyPendingQueueDepth,
      finalizedAtMs: latencyFinalizedAtMs,
      asrStartedAtMs: latencyAsrStartedAtMs,
      asrCompletedAtMs: latencyAsrCompletedAtMs,
      generationStartedAtMs: generationStartedAt,
      replyRequestedAtMs: replyRequestedAt,
      audioStartedAtMs: 0
    });
    const requestedRealtimeUtterance = Boolean(playbackResult.requestedRealtimeUtterance);
    if (playbackResult.spokeLine && !requestedRealtimeUtterance) {
      session.lastAudioDeltaAt = replyRequestedAt;
      session.lastAssistantReplyAt = replyRequestedAt;
    }
    if (playbackPlan.spokenText) {
      this.recordVoiceTurn(session, {
        role: "assistant",
        userId: this.client.user?.id || null,
        text: playbackPlan.spokenText
      });
    }
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.client.user?.id || null,
      content: "realtime_reply_requested",
      metadata: {
        sessionId: session.id,
        mode: session.mode,
        source: String(source || "realtime"),
        requestId: pendingRequestId,
        replyText: playbackPlan.spokenText || null,
        requestedRealtimeUtterance,
        soundboardRefs: playbackPlan.soundboardRefs,
        playedSoundboardCount: Number(playbackResult.playedSoundboardCount || 0),
        usedWebSearchFollowup,
        usedOpenArticleFollowup,
        usedScreenShareOffer,
        talkingTo: generatedVoiceAddressing?.talkingTo || null,
        directedConfidence: Number.isFinite(Number(generatedVoiceAddressing?.directedConfidence))
          ? Number(clamp(Number(generatedVoiceAddressing.directedConfidence), 0, 1).toFixed(3))
          : 0,
        leaveVoiceChannelRequested,
        joinWindowActive,
        joinWindowAgeMs: Math.round(joinWindowAgeMs),
        contextTurnsSent: contextMessages.length,
        contextTurnsAvailable: contextTurns.length,
        contextCharsSent: contextMessageChars
      }
    });

    if (leaveVoiceChannelRequested && !session.ending) {
      if (playbackPlan.spokenText && playbackResult.spokeLine) {
        await this.waitForLeaveDirectivePlayback({
          session,
          expectRealtimeAudio: requestedRealtimeUtterance,
          source: `${String(source || "realtime")}:leave_directive`
        });
      }
      await this.endSession({
        guildId: session.guildId,
        reason: "assistant_leave_directive",
        requestedByUserId: this.client.user?.id || null,
        settings,
        announcement: "wrapping up vc."
      }).catch((error) => {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          content: `assistant_leave_directive_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id,
            mode: session.mode,
            source: String(source || "realtime")
          }
        });
      });
    }

    return true;
  }

  async transcribePcmTurn({
    session,
    userId,
    pcmBuffer,
    model,
    sampleRateHz = 24000,
    captureReason = "stream_end",
    traceSource = "voice_stt_pipeline_turn",
    errorPrefix = "stt_pipeline_transcription_failed",
    emptyTranscriptRuntimeEvent = "voice_transcription_empty",
    emptyTranscriptErrorStreakThreshold = 1,
    suppressEmptyTranscriptLogs = false,
    asrLanguage = "",
    asrPrompt = ""
  }) {
    if (!this.llm?.transcribeAudio || !pcmBuffer?.length) return "";
    const resolvedModel = String(model || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
    const source = String(traceSource || "voice_stt_pipeline_turn");
    const emptyTranscriptThreshold = Math.max(1, Math.floor(Number(emptyTranscriptErrorStreakThreshold) || 1));
    if (!session.asrEmptyTranscriptStreakBySource || typeof session.asrEmptyTranscriptStreakBySource !== "object") {
      session.asrEmptyTranscriptStreakBySource = {};
    }
    const streaks = session.asrEmptyTranscriptStreakBySource;
    const wavBytes = encodePcm16MonoAsWav(pcmBuffer, sampleRateHz);
    try {
      const transcript = await this.llm.transcribeAudio({
        audioBytes: wavBytes,
        fileName: "turn.wav",
        model: resolvedModel,
        language: asrLanguage,
        prompt: asrPrompt,
        trace: {
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          source
        }
      });
      streaks[source] = 0;
      return normalizeVoiceText(transcript, STT_TRANSCRIPT_MAX_CHARS);
    } catch (error) {
      const message = String(error?.message || error);
      const emptyTranscriptError = /ASR returned empty transcript\.?/i.test(message);
      if (emptyTranscriptError) {
        if (suppressEmptyTranscriptLogs) {
          return "";
        }
        const nextStreak = Math.max(0, Number(streaks[source] || 0)) + 1;
        streaks[source] = nextStreak;
        const escalated = nextStreak >= emptyTranscriptThreshold;
        this.store.logAction({
          kind: escalated ? "voice_error" : "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId,
          content: escalated
            ? `${String(errorPrefix || "stt_pipeline_transcription_failed")}: ${message}`
            : String(emptyTranscriptRuntimeEvent || "voice_transcription_empty"),
          metadata: {
            sessionId: session.id,
            model: resolvedModel,
            language: String(asrLanguage || "").trim() || null,
            prompt: String(asrPrompt || "").trim() || null,
            captureReason: String(captureReason || "stream_end"),
            source,
            emptyTranscript: true,
            emptyTranscriptStreak: nextStreak,
            emptyTranscriptErrorThreshold: emptyTranscriptThreshold
          }
        });
        return "";
      }
      streaks[source] = 0;
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: `${String(errorPrefix || "stt_pipeline_transcription_failed")}: ${message}`,
        metadata: {
          sessionId: session.id,
          model: resolvedModel,
          language: String(asrLanguage || "").trim() || null,
          prompt: String(asrPrompt || "").trim() || null,
          captureReason: String(captureReason || "stream_end"),
          source
        }
      });
      return "";
    }
  }

  scheduleResponseFromBufferedAudio({ session, userId = null }) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;

    if (session.responseFlushTimer) {
      clearTimeout(session.responseFlushTimer);
    }

    session.responseFlushTimer = setTimeout(() => {
      session.responseFlushTimer = null;
      this.flushResponseFromBufferedAudio({ session, userId });
    }, RESPONSE_FLUSH_DEBOUNCE_MS);
  }

  flushResponseFromBufferedAudio({ session, userId = null }) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;

    const now = Date.now();
    const msSinceLastRequest = now - Number(session.lastResponseRequestAt || 0);
    if (msSinceLastRequest < MIN_RESPONSE_REQUEST_GAP_MS) {
      const waitMs = Math.max(20, MIN_RESPONSE_REQUEST_GAP_MS - msSinceLastRequest);
      session.responseFlushTimer = setTimeout(() => {
        session.responseFlushTimer = null;
        this.flushResponseFromBufferedAudio({ session, userId });
      }, waitMs);
      return;
    }

    // Don't commit/request while users are still actively streaming audio chunks.
    // This avoids partial-turn commits that can return no-audio responses.
    if (Number(session.userCaptures?.size || 0) > 0) {
      this.scheduleResponseFromBufferedAudio({ session, userId });
      return;
    }

    if (this.isBargeInOutputSuppressed(session)) {
      this.scheduleResponseFromBufferedAudio({ session, userId });
      return;
    }

    const replyOutputLockState = this.getReplyOutputLockState(session);
    if (replyOutputLockState.locked) {
      this.scheduleResponseFromBufferedAudio({
        session,
        userId: session.pendingResponse?.userId || userId
      });
      return;
    }

    const pendingInputBytes = Math.max(0, Number(session.pendingRealtimeInputBytes || 0));
    const minCommitBytes = getRealtimeCommitMinimumBytes(
      session.mode,
      Number(session.realtimeInputSampleRateHz) || 24000
    );
    if (pendingInputBytes < minCommitBytes) {
      return;
    }

    if (this.getRealtimeTurnBacklogSize(session) > 0) {
      this.scheduleResponseFromBufferedAudio({ session, userId });
      return;
    }

    if (this.isOpenAiRealtimeResponseActive(session)) {
      session.responseFlushTimer = setTimeout(() => {
        session.responseFlushTimer = null;
        this.flushResponseFromBufferedAudio({ session, userId });
      }, OPENAI_ACTIVE_RESPONSE_RETRY_MS);
      return;
    }

    try {
      session.realtimeClient.commitInputAudioBuffer();
      session.pendingRealtimeInputBytes = 0;
      const created = this.createTrackedAudioResponse({
        session,
        userId,
        source: "turn_flush",
        resetRetryState: true,
        emitCreateEvent: session.mode !== "openai_realtime"
      });
      if (!created) {
        this.scheduleResponseFromBufferedAudio({ session, userId });
      }
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId,
        content: `audio_commit_failed: ${String(error?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
    }
  }

  createTrackedAudioResponse({
    session,
    userId = null,
    source = "turn_flush",
    resetRetryState = false,
    emitCreateEvent = true,
    interruptionPolicy = undefined,
    utteranceText = undefined,
    latencyContext = undefined
  }) {
    if (!session || session.ending) return false;
    if (!isRealtimeMode(session.mode)) return false;
    if (emitCreateEvent && this.isOpenAiRealtimeResponseActive(session)) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "response_create_skipped_active_response",
        metadata: {
          sessionId: session.id,
          source: String(source || "turn_flush")
        }
      });
      return false;
    }
    if (emitCreateEvent) {
      session.realtimeClient.createAudioResponse();
    }

    const now = Date.now();
    const requestId = Number(session.nextResponseRequestId || 0) + 1;
    session.nextResponseRequestId = requestId;
    const previous = session.pendingResponse;
    const interruptionPolicySeed =
      interruptionPolicy === undefined
        ? previous?.interruptionPolicy || session.activeReplyInterruptionPolicy
        : interruptionPolicy;
    const normalizedInterruptionPolicy = this.normalizeReplyInterruptionPolicy(interruptionPolicySeed);
    const utteranceTextSeed = utteranceText === undefined ? previous?.utteranceText || "" : utteranceText || "";
    const normalizedUtteranceText =
      normalizeVoiceText(utteranceTextSeed, STT_REPLY_MAX_CHARS) || null;
    const latencyContextSeed =
      latencyContext === undefined
        ? previous?.latencyContext || null
        : latencyContext;
    const normalizedLatencyContext =
      latencyContextSeed && typeof latencyContextSeed === "object"
        ? {
            finalizedAtMs: Math.max(0, Number(latencyContextSeed.finalizedAtMs || 0)),
            asrStartedAtMs: Math.max(0, Number(latencyContextSeed.asrStartedAtMs || 0)),
            asrCompletedAtMs: Math.max(0, Number(latencyContextSeed.asrCompletedAtMs || 0)),
            generationStartedAtMs: Math.max(0, Number(latencyContextSeed.generationStartedAtMs || 0)),
            replyRequestedAtMs: Math.max(
              0,
              Number(latencyContextSeed.replyRequestedAtMs || 0)
            ) || now,
            audioStartedAtMs: Math.max(0, Number(latencyContextSeed.audioStartedAtMs || 0)),
            source: String(latencyContextSeed.source || source || "turn_flush"),
            captureReason: String(latencyContextSeed.captureReason || "").trim() || null,
            queueWaitMs: Number.isFinite(Number(latencyContextSeed.queueWaitMs))
              ? Math.max(0, Math.round(Number(latencyContextSeed.queueWaitMs)))
              : null,
            pendingQueueDepth: Number.isFinite(Number(latencyContextSeed.pendingQueueDepth))
              ? Math.max(0, Math.round(Number(latencyContextSeed.pendingQueueDepth)))
              : null
          }
        : null;

    session.pendingResponse = {
      requestId,
      userId: userId || previous?.userId || null,
      requestedAt: now,
      retryCount: resetRetryState ? 0 : Number(previous?.retryCount || 0),
      hardRecoveryAttempted: resetRetryState ? false : Boolean(previous?.hardRecoveryAttempted),
      source: String(source || "turn_flush"),
      handlingSilence: false,
      audioReceivedAt: 0,
      interruptionPolicy: normalizedInterruptionPolicy,
      utteranceText: normalizedUtteranceText,
      latencyContext: normalizedLatencyContext
    };
    session.lastResponseRequestAt = now;
    this.setActiveReplyInterruptionPolicy(session, normalizedInterruptionPolicy);
    this.clearResponseSilenceTimers(session);
    this.armResponseSilenceWatchdog({
      session,
      requestId,
      userId: session.pendingResponse.userId
    });
    return true;
  }

  pendingResponseHasAudio(session, pendingResponse = session?.pendingResponse) {
    if (!session || !pendingResponse) return false;
    const requestedAt = Number(pendingResponse.requestedAt || 0);
    if (!requestedAt) return false;
    return Number(session.lastAudioDeltaAt || 0) >= requestedAt;
  }

  clearResponseSilenceTimers(session) {
    if (!session) return;
    if (session.responseWatchdogTimer) {
      clearTimeout(session.responseWatchdogTimer);
      session.responseWatchdogTimer = null;
    }
    if (session.responseDoneGraceTimer) {
      clearTimeout(session.responseDoneGraceTimer);
      session.responseDoneGraceTimer = null;
    }
  }

  clearPendingResponse(session) {
    if (!session) return;
    this.clearResponseSilenceTimers(session);
    session.pendingResponse = null;
    this.maybeClearActiveReplyInterruptionPolicy(session);
  }

  isOpenAiRealtimeResponseActive(session) {
    if (!session || session.mode !== "openai_realtime") return false;
    const checker = session.realtimeClient?.isResponseInProgress;
    if (typeof checker !== "function") return false;
    try {
      return Boolean(checker.call(session.realtimeClient));
    } catch {
      return false;
    }
  }

  armResponseSilenceWatchdog({ session, requestId, userId = null }) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;
    if (!Number.isFinite(Number(requestId)) || Number(requestId) <= 0) return;

    if (session.responseWatchdogTimer) {
      clearTimeout(session.responseWatchdogTimer);
    }

    session.responseWatchdogTimer = setTimeout(() => {
      session.responseWatchdogTimer = null;
      if (!session || session.ending) return;
      const pending = session.pendingResponse;
      if (!pending) return;
      if (Number(pending.requestId || 0) !== Number(requestId)) return;
      if (this.pendingResponseHasAudio(session, pending)) {
        this.clearPendingResponse(session);
        return;
      }
      this.handleSilentResponse({
        session,
        userId: pending.userId || userId,
        trigger: "watchdog"
      }).catch(() => undefined);
    }, RESPONSE_SILENCE_RETRY_DELAY_MS);
  }

  async handleSilentResponse({
    session,
    userId = null,
    trigger = "watchdog",
    responseId = null,
    responseStatus = null
  }) {
    if (!session || session.ending) return;
    if (!isRealtimeMode(session.mode)) return;
    const pending = session.pendingResponse;
    if (!pending) return;
    if (pending.handlingSilence) return;
    if (this.pendingResponseHasAudio(session, pending)) {
      this.clearPendingResponse(session);
      return;
    }

    pending.handlingSilence = true;
    this.clearResponseSilenceTimers(session);

    if (Number(session.userCaptures?.size || 0) > 0) {
      pending.handlingSilence = false;
      this.armResponseSilenceWatchdog({
        session,
        requestId: pending.requestId,
        userId: pending.userId || userId
      });
      return;
    }

    const resolvedUserId = pending.userId || userId || this.client.user?.id || null;
    const setHandlingDone = () => {
      const active = session.pendingResponse;
      if (active && Number(active.requestId || 0) === Number(pending.requestId || 0)) {
        active.handlingSilence = false;
      }
    };

    if (pending.retryCount < MAX_RESPONSE_SILENCE_RETRIES) {
      pending.retryCount += 1;
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: resolvedUserId,
        content: "response_silent_retry",
        metadata: {
          sessionId: session.id,
          requestId: pending.requestId,
          retryCount: pending.retryCount,
          maxRetries: MAX_RESPONSE_SILENCE_RETRIES,
          responseRequestedAt: pending.requestedAt,
          trigger,
          responseId,
          responseStatus
        }
      });

      try {
        const created = this.createTrackedAudioResponse({
          session,
          userId: resolvedUserId,
          source: "silent_retry",
          resetRetryState: false
        });
        if (!created) {
          this.armResponseSilenceWatchdog({
            session,
            requestId: pending.requestId,
            userId: pending.userId || userId
          });
        }
      } catch (error) {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: resolvedUserId,
          content: `response_retry_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id,
            requestId: pending.requestId
          }
        });
        this.clearPendingResponse(session);
        await this.endSession({
          guildId: session.guildId,
          reason: "response_stalled",
          announcement: "voice output stalled and stayed silent, leaving vc.",
          settings: session.settingsSnapshot
        });
      } finally {
        setHandlingDone();
      }
      return;
    }

    if (!pending.hardRecoveryAttempted) {
      pending.hardRecoveryAttempted = true;
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: resolvedUserId,
        content: "response_silent_hard_recovery",
        metadata: {
          sessionId: session.id,
          requestId: pending.requestId,
          retryCount: pending.retryCount,
          trigger,
          responseId,
          responseStatus
        }
      });

      try {
        const pendingInputBytes = Math.max(0, Number(session.pendingRealtimeInputBytes || 0));
        const minCommitBytes = getRealtimeCommitMinimumBytes(
          session.mode,
          Number(session.realtimeInputSampleRateHz) || 24000
        );
        if (pendingInputBytes >= minCommitBytes) {
          session.realtimeClient.commitInputAudioBuffer();
          session.pendingRealtimeInputBytes = 0;
        }
        const created = this.createTrackedAudioResponse({
          session,
          userId: resolvedUserId,
          source: "hard_recovery",
          resetRetryState: false
        });
        if (!created) {
          this.armResponseSilenceWatchdog({
            session,
            requestId: pending.requestId,
            userId: pending.userId || userId
          });
        }
      } catch (error) {
        this.store.logAction({
          kind: "voice_error",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: resolvedUserId,
          content: `response_hard_recovery_failed: ${String(error?.message || error)}`,
          metadata: {
            sessionId: session.id,
            requestId: pending.requestId
          }
        });
        this.clearPendingResponse(session);
        await this.endSession({
          guildId: session.guildId,
          reason: "response_stalled",
          announcement: "voice output stalled and stayed silent, leaving vc.",
          settings: session.settingsSnapshot
        });
      } finally {
        setHandlingDone();
      }
      return;
    }

    this.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: resolvedUserId,
      content: "response_silent_fallback",
      metadata: {
        sessionId: session.id,
        requestId: pending.requestId,
        retryCount: pending.retryCount,
        hardRecoveryAttempted: pending.hardRecoveryAttempted,
        trigger,
        responseId,
        responseStatus
      }
    });
    this.clearPendingResponse(session);
    // Drop this stuck turn and keep the VC session alive; a fresh user turn can recover.
  }

  async endSession({
    guildId,
    reason = "unknown",
    requestedByUserId = null,
    announceChannel = null,
    announcement = undefined,
    settings = null,
    messageId = null
  }) {
    const session = this.sessions.get(String(guildId));
    if (!session) return false;
    if (session.ending) return false;

    session.ending = true;
    this.sessions.delete(String(guildId));

    if (session.maxTimer) clearTimeout(session.maxTimer);
    if (session.inactivityTimer) clearTimeout(session.inactivityTimer);
    if (session.botTurnResetTimer) clearTimeout(session.botTurnResetTimer);
    if (session.botDisconnectTimer) clearTimeout(session.botDisconnectTimer);
    if (session.responseFlushTimer) clearTimeout(session.responseFlushTimer);
    if (session.responseWatchdogTimer) clearTimeout(session.responseWatchdogTimer);
    if (session.responseDoneGraceTimer) clearTimeout(session.responseDoneGraceTimer);
    if (session.realtimeInstructionRefreshTimer) clearTimeout(session.realtimeInstructionRefreshTimer);
    if (session.deferredTurnFlushTimer) clearTimeout(session.deferredTurnFlushTimer);
    if (session.voiceLookupBusyAnnounceTimer) clearTimeout(session.voiceLookupBusyAnnounceTimer);
    this.clearVoiceThoughtLoopTimer(session);
    session.thoughtLoopBusy = false;
    session.pendingResponse = null;
    session.sttTurnDrainActive = false;
    session.pendingSttTurnsQueue = [];
    session.pendingSttTurns = 0;
    session.pendingRealtimeTurns = [];
    session.pendingDeferredTurns = [];
    session.pendingBargeInRetry = null;
    session.lastRequestedRealtimeUtterance = null;
    session.activeReplyInterruptionPolicy = null;
    session.voiceLookupBusyAnnounceTimer = null;
    session.bargeInSuppressionUntil = 0;
    session.bargeInSuppressedAudioChunks = 0;
    session.bargeInSuppressedAudioBytes = 0;
    this.clearAudioPlaybackQueue(session);

    for (const capture of session.userCaptures.values()) {
      if (capture.idleFlushTimer) {
        clearTimeout(capture.idleFlushTimer);
      }
      if (capture.maxFlushTimer) {
        clearTimeout(capture.maxFlushTimer);
      }
      if (capture.speakingEndFinalizeTimer) {
        clearTimeout(capture.speakingEndFinalizeTimer);
      }
      if (capture.bargeInAssertTimer) {
        clearTimeout(capture.bargeInAssertTimer);
      }
      try {
        capture.opusStream.destroy();
      } catch {
        // ignore
      }
      try {
        capture.decoder.destroy?.();
      } catch {
        // ignore
      }
      try {
        capture.pcmStream.destroy();
      } catch {
        // ignore
      }
    }
    session.userCaptures.clear();

    for (const cleanup of session.cleanupHandlers || []) {
      try {
        cleanup();
      } catch {
        // ignore
      }
    }

    try {
      session.botAudioStream?.end?.();
    } catch {
      // ignore
    }

    try {
      session.audioPlayer?.stop?.(true);
    } catch {
      // ignore
    }

    try {
      await session.realtimeClient?.close?.();
    } catch {
      // ignore
    }

    try {
      session.connection?.destroy?.();
    } catch {
      // ignore
    }

    const fallbackConnection = getVoiceConnection(String(guildId));
    if (fallbackConnection && fallbackConnection !== session.connection) {
      try {
        fallbackConnection.destroy();
      } catch {
        // ignore
      }
    }

    const durationSeconds = Math.max(0, Math.floor((Date.now() - session.startedAt) / 1000));
    this.store.logAction({
      kind: "voice_session_end",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: requestedByUserId || this.client.user?.id || null,
      content: reason,
      metadata: {
        sessionId: session.id,
        mode: session.mode || "voice_agent",
        voiceChannelId: session.voiceChannelId,
        durationSeconds,
        requestedByUserId
      }
    });

    const channel = announceChannel || this.client.channels.cache.get(session.textChannelId);
    if (announcement !== null) {
      const normalizedReason = String(reason || "")
        .trim()
        .toLowerCase();
      const mustNotify = normalizedReason !== "switch_channel" && normalizedReason !== "nl_leave";
      const announcementHint = String(announcement || "").trim();
      const details = {
        voiceChannelId: session.voiceChannelId,
        durationSeconds,
        announcementHint: announcementHint || null
      };
      await this.sendOperationalMessage({
        channel,
        settings: settings || session.settingsSnapshot,
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: requestedByUserId || this.client.user?.id || null,
        messageId,
        event: "voice_session_end",
        reason,
        details,
        mustNotify
      });
    }

    return true;
  }

  async handleVoiceStateUpdate(oldState, newState) {
    const botId = String(this.client.user?.id || "");
    if (!botId) return;

    const stateUserId = String(newState?.id || oldState?.id || "");
    const guildId = String(newState?.guild?.id || oldState?.guild?.id || "");
    if (!guildId) return;

    const session = this.sessions.get(guildId);
    if (!session) return;
    const oldChannelId = String(oldState?.channelId || "");
    const newChannelId = String(newState?.channelId || "");
    const sessionVoiceChannelId = String(session.voiceChannelId || "");

    if (stateUserId !== botId) {
      const stateMember = newState?.member || oldState?.member || null;
      const stateUserIsBot = Boolean(stateMember?.user?.bot);
      const movedIntoSession = sessionVoiceChannelId && oldChannelId !== sessionVoiceChannelId && newChannelId === sessionVoiceChannelId;
      const movedOutOfSession = sessionVoiceChannelId && oldChannelId === sessionVoiceChannelId && newChannelId !== sessionVoiceChannelId;
      if (!stateUserIsBot && (movedIntoSession || movedOutOfSession)) {
        const recordedEvent = this.recordVoiceMembershipEvent({
          session,
          userId: stateUserId,
          eventType: movedIntoSession ? "join" : "leave",
          displayName: stateMember?.displayName || stateMember?.user?.globalName || stateMember?.user?.username || ""
        });
        if (recordedEvent) {
          this.store.logAction({
            kind: "voice_runtime",
            guildId,
            channelId: session.textChannelId,
            userId: stateUserId,
            content: "voice_membership_changed",
            metadata: {
              sessionId: session.id,
              eventType: recordedEvent.eventType,
              memberUserId: recordedEvent.userId,
              displayName: recordedEvent.displayName,
              participantCount: this.countHumanVoiceParticipants(session)
            }
          });
        }
      }
      if (
        session.mode === "openai_realtime" &&
        sessionVoiceChannelId &&
        (oldChannelId === sessionVoiceChannelId || newChannelId === sessionVoiceChannelId)
      ) {
        this.scheduleOpenAiRealtimeInstructionRefresh({
          session,
          settings: session.settingsSnapshot,
          reason: "voice_membership_changed",
          speakerUserId: stateUserId
        });
      }
      return;
    }

    if (!newState?.channelId) {
      if (!session.botDisconnectTimer) {
        this.store.logAction({
          kind: "voice_runtime",
          guildId,
          channelId: session.textChannelId,
          userId: this.client.user?.id || null,
          content: "bot_disconnect_grace_started",
          metadata: {
            sessionId: session.id,
            graceMs: BOT_DISCONNECT_GRACE_MS
          }
        });
        session.botDisconnectTimer = setTimeout(() => {
          session.botDisconnectTimer = null;
          const liveSession = this.sessions.get(guildId);
          if (!liveSession || liveSession.ending) return;

          const guild = this.client.guilds.cache.get(guildId) || null;
          const liveChannelId = String(guild?.members?.me?.voice?.channelId || "").trim();
          if (liveChannelId) {
            liveSession.voiceChannelId = liveChannelId;
            liveSession.lastActivityAt = Date.now();
            this.scheduleOpenAiRealtimeInstructionRefresh({
              session: liveSession,
              settings: liveSession.settingsSnapshot,
              reason: "voice_channel_recovered"
            });
            this.store.logAction({
              kind: "voice_runtime",
              guildId,
              channelId: liveSession.textChannelId,
              userId: this.client.user?.id || null,
              content: "bot_disconnect_grace_resolved",
              metadata: {
                sessionId: liveSession.id,
                voiceChannelId: liveChannelId
              }
            });
            return;
          }

          this.endSession({
            guildId,
            reason: "bot_disconnected",
            announcement: "i got disconnected from vc.",
            settings: liveSession.settingsSnapshot
          }).catch(() => undefined);
        }, BOT_DISCONNECT_GRACE_MS);
      }
      return;
    }

    if (session.botDisconnectTimer) {
      clearTimeout(session.botDisconnectTimer);
      session.botDisconnectTimer = null;
      this.store.logAction({
        kind: "voice_runtime",
        guildId,
        channelId: session.textChannelId,
        userId: this.client.user?.id || null,
        content: "bot_disconnect_grace_cleared",
        metadata: {
          sessionId: session.id,
          voiceChannelId: String(newState.channelId)
        }
      });
    }

    if (String(newState.channelId) !== session.voiceChannelId) {
      session.voiceChannelId = String(newState.channelId);
      session.lastActivityAt = Date.now();
      this.scheduleOpenAiRealtimeInstructionRefresh({
        session,
        settings: session.settingsSnapshot,
        reason: "voice_channel_changed"
      });
    }
  }

  buildVoiceInstructions(settings, { soundboardCandidates = [] } = {}) {
    const botName = getPromptBotName(settings);
    const style = getPromptStyle(settings, "playful slang");
    const allowNsfwHumor = shouldAllowVoiceNsfwHumor(settings);
    const memoryEnabled = Boolean(settings?.memory?.enabled);
    const soundboardEnabled = Boolean(settings?.voice?.soundboard?.enabled);
    const soundboardCandidateLines = (Array.isArray(soundboardCandidates) ? soundboardCandidates : [])
      .map((entry) => formatSoundboardCandidateLine(entry))
      .filter(Boolean)
      .slice(0, SOUNDBOARD_MAX_CANDIDATES);
    const voiceToneGuardrails = buildVoiceToneGuardrails();
    const voiceGuidance = getPromptVoiceGuidance(settings, [
      "Talk like a person hanging out, not like an assistant.",
      "You're chill, but eager to be helpful whenever it makes sense.",
      "Use occasional slang naturally (not every sentence)."
    ]);
    const lines = [
      `You are ${botName}, a real-feeling regular in a Discord server, speaking in live voice chat.`,
      `Stay in-character as ${botName}. Style: ${style}.`,
      ...voiceGuidance,
      ...voiceToneGuardrails,
      allowNsfwHumor
        ? "Adult/NSFW humor is allowed for consenting adults, but never include minors, coercion, or targeted harassment."
        : "Keep humor non-sexual by default unless users explicitly request a safe toned-down joke.",
      getPromptCapabilityHonestyLine(settings),
      memoryEnabled
        ? getPromptMemoryEnabledLine(
            settings,
            "You have persistent memory across conversations via saved durable facts. Do not claim each conversation starts from zero."
          )
        : getPromptMemoryDisabledLine(settings),
      getPromptImpossibleActionLine(settings, "If asked to do something impossible, say it casually."),
      ...buildHardLimitsSection(settings, { maxItems: 12 })
    ];

    if (soundboardEnabled && soundboardCandidateLines.length) {
      lines.push("Soundboard control is enabled.");
      lines.push("Available sound refs:");
      lines.push(soundboardCandidateLines.join("\n"));
      lines.push(
        "If you want soundboard effects, insert one or more directives where they should fire: [[SOUNDBOARD:<sound_ref>]] using exact refs from the list."
      );
      lines.push("If no sound should play, omit that directive.");
      lines.push("Never mention or explain the directive in normal speech.");
    }

    return lines.join("\n");
  }

  async sendOperationalMessage({
    channel,
    settings = null,
    guildId = null,
    channelId = null,
    userId = null,
    messageId = null,
    event = "voice_runtime",
    reason = null,
    details = {},
    mustNotify = true
  }) {
    return await sendOperationalMessage(this, {
      channel,
      settings,
      guildId,
      channelId,
      userId,
      messageId,
      event,
      reason,
      details,
      mustNotify
    });
  }

  async resolveOperationalChannel(
    channel,
    channelId,
    { guildId = null, userId = null, messageId = null, event = null, reason = null } = {}
  ) {
    return await resolveOperationalChannel(this, channel, channelId, {
      guildId,
      userId,
      messageId,
      event,
      reason
    });
  }

  async sendToChannel(
    channel,
    text,
    { guildId = null, channelId = null, userId = null, messageId = null, event = null, reason = null } = {}
  ) {
    return await sendToChannel(this, channel, text, {
      guildId,
      channelId,
      userId,
      messageId,
      event,
      reason
    });
  }

  getMissingJoinPermissionInfo({ guild, voiceChannel }) {
    const me = guild?.members?.me;
    if (!me) {
      return {
        reason: "bot_member_unavailable",
        missingPermissions: []
      };
    }

    const perms = voiceChannel?.permissionsFor?.(me);
    const missingPermissions = [];
    if (!perms?.has(PermissionFlagsBits.Connect)) missingPermissions.push("CONNECT");
    if (!perms?.has(PermissionFlagsBits.Speak)) missingPermissions.push("SPEAK");
    if (!missingPermissions.length) return null;
    return {
      reason: "missing_voice_permissions",
      missingPermissions
    };
  }

}


export {
  parseVoiceDecisionContract,
  resolveRealtimeTurnTranscriptionPlan
} from "./voiceDecisionRuntime.ts";
