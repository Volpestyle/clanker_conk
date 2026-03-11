import { clamp } from "../utils.ts";
import {
  RECENT_ENGAGEMENT_WINDOW_MS,
  VOICE_THOUGHT_LOOP_BUSY_RETRY_MS,
  VOICE_THOUGHT_MAX_CHARS
} from "./voiceSessionManager.constants.ts";
import { normalizeVoiceText } from "./voiceSessionHelpers.ts";
import type { DeferredActionQueue } from "./deferredActionQueue.ts";
import type { TurnProcessor } from "./turnProcessor.ts";
import type {
  MusicPlaybackPhase,
  VoicePendingAmbientThought,
  VoiceSession
} from "./voiceSessionTypes.ts";
import { musicPhaseIsActive } from "./voiceSessionTypes.ts";

type ThoughtSettings = Record<string, unknown> | null;

interface ThoughtConfigLike {
  enabled: boolean;
  eagerness: number;
  minSilenceSeconds: number;
  minSecondsBetweenThoughts: number;
}

interface ThoughtTopicalityBias {
  topicTetherStrength: number;
  randomInspirationStrength: number;
  phase: string;
  promptHint: string;
}

interface VoiceThoughtDecision {
  action: "speak_now" | "hold" | "drop";
  reason: string;
  finalThought?: string | null;
  memoryFactCount?: number;
  usedMemory?: boolean;
  llmResponse?: string | null;
  llmProvider?: string | null;
  llmModel?: string | null;
  error?: string | null;
}

type ThoughtStoreLike = {
  getSettings: () => ThoughtSettings;
  logAction: (entry: {
    kind: string;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    content: string;
    metadata?: Record<string, unknown>;
  }) => void;
};

export interface ThoughtEngineHost {
  client: {
    user?: {
      id?: string | null;
    } | null;
  };
  store: ThoughtStoreLike;
  resolveVoiceThoughtEngineConfig: (settings: ThoughtSettings) => ThoughtConfigLike;
  buildVoiceConversationContext: (args: {
    session: VoiceSession;
    userId?: string | null;
    directAddressed?: boolean;
    participantCount?: number | null;
    now?: number;
  }) => {
    attentionMode: "ACTIVE" | "AMBIENT";
  };
  isCommandOnlyActive: (session: VoiceSession, settings?: ThoughtSettings) => boolean;
  getMusicPhase: (session: VoiceSession) => MusicPlaybackPhase;
  getOutputChannelState: (session: VoiceSession) => {
    locked: boolean;
    lockReason?: string | null;
  };
  hasDeferredTurnBlockingActiveCapture: (session: VoiceSession) => boolean;
  turnProcessor: Pick<TurnProcessor, "getRealtimeTurnBacklogSize">;
  deferredActionQueue: Pick<DeferredActionQueue, "getDeferredQueuedUserTurns">;
  countHumanVoiceParticipants: (session: VoiceSession) => number;
  generateVoiceThoughtCandidate: (args: {
    session: VoiceSession;
    settings: ThoughtSettings;
    config: ThoughtConfigLike;
    trigger?: string;
    pendingThought?: VoicePendingAmbientThought | null;
  }) => Promise<string>;
  loadVoiceThoughtMemoryFacts: (args: {
    session: VoiceSession;
    settings: ThoughtSettings;
    thoughtCandidate: string;
  }) => Promise<unknown[]>;
  evaluateVoiceThoughtDecision: (args: {
    session: VoiceSession;
    settings: ThoughtSettings;
    thoughtCandidate: string;
    memoryFacts: unknown[];
    topicalityBias: ThoughtTopicalityBias;
    pendingThought?: VoicePendingAmbientThought | null;
  }) => Promise<VoiceThoughtDecision>;
  deliverVoiceThoughtCandidate: (args: {
    session: VoiceSession;
    settings: ThoughtSettings;
    thoughtCandidate: string;
    trigger?: string;
  }) => Promise<boolean>;
  resolveVoiceThoughtTopicalityBias: (args: {
    silenceMs?: number;
    minSilenceSeconds?: number;
    minSecondsBetweenThoughts?: number;
  }) => ThoughtTopicalityBias;
}

export class ThoughtEngine {
  constructor(private readonly host: ThoughtEngineHost) {}

  clearVoiceThoughtLoopTimer(session: VoiceSession) {
    if (!session) return;
    if (session.thoughtLoopTimer) {
      clearTimeout(session.thoughtLoopTimer);
      session.thoughtLoopTimer = null;
    }
    session.nextThoughtAt = 0;
  }

  private getPendingAmbientThought(session: VoiceSession | null | undefined) {
    const pendingThought = session?.pendingAmbientThought;
    if (!pendingThought || typeof pendingThought !== "object") return null;
    const currentText = normalizeVoiceText(pendingThought.currentText || "", VOICE_THOUGHT_MAX_CHARS);
    if (!currentText) return null;
    return {
      ...pendingThought,
      draftText: normalizeVoiceText(pendingThought.draftText || currentText, VOICE_THOUGHT_MAX_CHARS) || currentText,
      currentText,
      invalidationReason: String(pendingThought.invalidationReason || "").trim() || null
    } satisfies VoicePendingAmbientThought;
  }

  private clearPendingAmbientThought(
    session: VoiceSession,
    {
      reason = "cleared",
      now = Date.now(),
      trigger = "timer"
    }: {
      reason?: string;
      now?: number;
      trigger?: string;
    } = {}
  ) {
    const pendingThought = this.getPendingAmbientThought(session);
    session.pendingAmbientThought = null;
    if (!pendingThought) return null;
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.botUserId,
      content: "voice_pending_thought_cleared",
      metadata: {
        sessionId: session.id,
        trigger,
        reason,
        thoughtId: pendingThought.id,
        thoughtText: pendingThought.currentText,
        thoughtRevision: pendingThought.revision,
        ageMs: Math.max(0, Math.round(now - Number(pendingThought.createdAt || now)))
      }
    });
    return pendingThought;
  }

  private resolvePendingThoughtRevisitDelayMs(config: ThoughtConfigLike) {
    const minIntervalMs = Math.max(1_000, Math.round(Number(config.minSecondsBetweenThoughts || 0) * 1_000));
    return Math.max(1_500, Math.min(minIntervalMs, 10_000));
  }

  private resolvePendingThoughtExpiryMs(config: ThoughtConfigLike) {
    const minIntervalMs = Math.max(1_000, Math.round(Number(config.minSecondsBetweenThoughts || 0) * 1_000));
    return Math.max(60_000, minIntervalMs * 4);
  }

  private resolvePendingThoughtExpiryAt(
    existingThought: VoicePendingAmbientThought | null,
    config: ThoughtConfigLike,
    now = Date.now()
  ) {
    const createdAt = Number(existingThought?.createdAt || now);
    const boundedExpiryAt = createdAt + this.resolvePendingThoughtExpiryMs(config);
    const previousExpiryAt = Number(existingThought?.expiresAt || 0);
    return previousExpiryAt > 0 ? Math.min(previousExpiryAt, boundedExpiryAt) : boundedExpiryAt;
  }

  private pendingThoughtIsExpired(
    pendingThought: VoicePendingAmbientThought | null | undefined,
    config: ThoughtConfigLike,
    now = Date.now()
  ) {
    if (!pendingThought) return false;
    const expiresAt = this.resolvePendingThoughtExpiryAt(pendingThought, config, now);
    return expiresAt > 0 && now >= expiresAt;
  }

  private upsertPendingAmbientThought({
    session,
    config,
    now = Date.now(),
    trigger = "timer",
    thoughtDraft = "",
    thoughtText = "",
    decision
  }: {
    session: VoiceSession;
    config: ThoughtConfigLike;
    now?: number;
    trigger?: string;
    thoughtDraft: string;
    thoughtText: string;
    decision: VoiceThoughtDecision;
  }) {
    const existingThought = this.getPendingAmbientThought(session);
    const normalizedDraft = normalizeVoiceText(thoughtDraft, VOICE_THOUGHT_MAX_CHARS);
    const normalizedThought = normalizeVoiceText(thoughtText, VOICE_THOUGHT_MAX_CHARS);
    if (!normalizedThought) {
      return this.clearPendingAmbientThought(session, {
        reason: "empty_hold_thought",
        now,
        trigger
      });
    }
    const expiresAt = this.resolvePendingThoughtExpiryAt(existingThought, config, now);
    if (expiresAt <= now) {
      return this.clearPendingAmbientThought(session, {
        reason: "expired",
        now,
        trigger
      });
    }
    const nextThought: VoicePendingAmbientThought = {
      id: existingThought?.id || `${session.id}:thought:${now.toString(36)}`,
      status: "queued",
      trigger: String(trigger || existingThought?.trigger || "timer"),
      draftText: normalizedDraft || existingThought?.draftText || normalizedThought,
      currentText: normalizedThought,
      createdAt: existingThought?.createdAt || now,
      updatedAt: now,
      basisAt: now,
      notBeforeAt: now + this.resolvePendingThoughtRevisitDelayMs(config),
      expiresAt,
      revision: existingThought ? Math.max(1, Number(existingThought.revision || 1)) + 1 : 1,
      lastDecisionReason: String(decision.reason || "").trim() || null,
      lastDecisionAction: "hold",
      memoryFactCount: Math.max(0, Number(decision.memoryFactCount || 0)),
      usedMemory: Boolean(decision.usedMemory),
      invalidatedAt: null,
      invalidatedByUserId: null,
      invalidationReason: null
    };
    session.pendingAmbientThought = nextThought;
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: this.botUserId,
      content: existingThought ? "voice_pending_thought_updated" : "voice_pending_thought_created",
      metadata: {
        sessionId: session.id,
        trigger,
        thoughtId: nextThought.id,
        thoughtText: nextThought.currentText,
        draftText: nextThought.draftText,
        thoughtRevision: nextThought.revision,
        notBeforeAt: new Date(nextThought.notBeforeAt).toISOString(),
        expiresAt: new Date(nextThought.expiresAt).toISOString(),
        reason: nextThought.lastDecisionReason,
        usedMemory: nextThought.usedMemory,
        memoryFactCount: nextThought.memoryFactCount
      }
    });
    return nextThought;
  }

  private resolveNextLoopDelayMs({
    session,
    config,
    now = Date.now()
  }: {
    session: VoiceSession;
    config: ThoughtConfigLike;
    now?: number;
  }) {
    const pendingThought = this.getPendingAmbientThought(session);
    if (pendingThought) {
      return Math.max(200, Number(pendingThought.notBeforeAt || now) - now);
    }
    return Math.max(200, Math.round(Number(config.minSecondsBetweenThoughts || 0) * 1_000));
  }

  markPendingAmbientThoughtStale(
    session: VoiceSession | null | undefined,
    {
      userId = null,
      reason = "room_activity",
      now = Date.now()
    }: {
      userId?: string | null;
      reason?: string;
      now?: number;
    } = {}
  ) {
    const pendingThought = this.getPendingAmbientThought(session);
    if (!session || !pendingThought) return false;
    session.pendingAmbientThought = {
      ...pendingThought,
      status: "reconsider",
      updatedAt: now,
      basisAt: now,
      invalidatedAt: now,
      invalidatedByUserId: String(userId || "").trim() || null,
      invalidationReason: String(reason || "").trim() || pendingThought.invalidationReason || null
    };
    return true;
  }

  scheduleVoiceThoughtLoop({
    session,
    settings = null,
    delayMs = null
  }: {
    session: VoiceSession;
    settings?: ThoughtSettings;
    delayMs?: number | null;
  }) {
    if (!session || session.ending) return;
    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    const thoughtConfig = this.host.resolveVoiceThoughtEngineConfig(resolvedSettings);
    this.clearVoiceThoughtLoopTimer(session);
    if (!thoughtConfig.enabled) return;

    const defaultDelayMs = thoughtConfig.minSilenceSeconds * 1000;
    const requestedDelayMs = Number(delayMs);
    const waitMs = Math.max(
      120,
      Number.isFinite(requestedDelayMs) ? Math.round(Number(delayMs)) : defaultDelayMs
    );
    session.nextThoughtAt = Date.now() + waitMs;
    session.thoughtLoopTimer = setTimeout(() => {
      session.thoughtLoopTimer = null;
      session.nextThoughtAt = 0;
      this.spawnVoiceThoughtLoop({
        session,
        settings: session.settingsSnapshot || this.store.getSettings(),
        trigger: "timer"
      });
    }, waitMs);
  }

  private spawnVoiceThoughtLoop({
    session,
    settings = null,
    trigger = "timer"
  }: {
    session: VoiceSession;
    settings?: ThoughtSettings;
    trigger?: string;
  }) {
    void this.maybeRunVoiceThoughtLoop({
      session,
      settings,
      trigger
    }).catch((error: unknown) => {
      session.thoughtLoopBusy = false;
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.botUserId,
        content: `voice_thought_loop_schedule_failed: ${String((error as Error)?.message || error)}`,
        metadata: {
          sessionId: session.id,
          mode: session.mode,
          trigger: String(trigger || "timer")
        }
      });
      if (session.ending) return;
      this.scheduleVoiceThoughtLoop({
        session,
        settings: settings || session.settingsSnapshot || this.store.getSettings(),
        delayMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      });
    });
  }

  evaluateVoiceThoughtLoopGate({
    session,
    settings = null,
    config = null,
    now = Date.now()
  }: {
    session: VoiceSession;
    settings?: ThoughtSettings;
    config?: ThoughtConfigLike | null;
    now?: number;
  }) {
    if (!session || session.ending) {
      return {
        allow: false,
        reason: "session_inactive",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }

    const thoughtConfig = config || this.host.resolveVoiceThoughtEngineConfig(settings);
    if (!thoughtConfig.enabled) {
      return {
        allow: false,
        reason: "thought_engine_disabled",
        retryAfterMs: thoughtConfig.minSilenceSeconds * 1000
      };
    }

    if (this.host.isCommandOnlyActive(session, settings)) {
      return {
        allow: false,
        reason: "command_only_mode",
        retryAfterMs: thoughtConfig.minSilenceSeconds * 1000
      };
    }

    if (musicPhaseIsActive(this.host.getMusicPhase(session))) {
      return {
        allow: false,
        reason: "music_playback_active",
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

    const pendingThought = this.getPendingAmbientThought(session);
    const pendingThoughtNotBeforeMs = Math.max(0, Number(pendingThought?.notBeforeAt || 0) - now);
    if (pendingThought && pendingThoughtNotBeforeMs > 0) {
      return {
        allow: false,
        reason: "pending_thought_backoff",
        retryAfterMs: Math.max(300, pendingThoughtNotBeforeMs)
      };
    }
    if (!pendingThought) {
      const sinceLastAttemptMs = Math.max(0, now - Number(session.lastThoughtAttemptAt || 0));
      if (sinceLastAttemptMs < minIntervalMs) {
        return {
          allow: false,
          reason: "thought_attempt_cooldown",
          retryAfterMs: Math.max(300, minIntervalMs - sinceLastAttemptMs)
        };
      }
    }

    const conversationContext = this.host.buildVoiceConversationContext({
      session,
      userId: null,
      directAddressed: false,
      now
    });
    if (conversationContext.attentionMode === "ACTIVE") {
      const activeSignalAges = [
        Number(session.lastAssistantReplyAt || 0) > 0
          ? Math.max(0, now - Number(session.lastAssistantReplyAt || 0))
          : null,
        Number(session.lastDirectAddressAt || 0) > 0
          ? Math.max(0, now - Number(session.lastDirectAddressAt || 0))
          : null
      ].filter((value): value is number => Number.isFinite(value) && value >= 0);
      const retryAfterMs = activeSignalAges.length > 0
        ? Math.max(
          500,
          ...activeSignalAges.map((ageMs) => Math.max(0, RECENT_ENGAGEMENT_WINDOW_MS - ageMs))
        )
        : VOICE_THOUGHT_LOOP_BUSY_RETRY_MS;
      return {
        allow: false,
        reason: "attention_active",
        retryAfterMs
      };
    }

    if (session.thoughtLoopBusy) {
      return {
        allow: false,
        reason: "thought_loop_busy",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }
    const outputChannelState = this.host.getOutputChannelState(session);
    if (outputChannelState.locked) {
      return {
        allow: false,
        reason: "bot_turn_open",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS,
        outputLockReason: outputChannelState.lockReason
      };
    }
    if (this.host.hasDeferredTurnBlockingActiveCapture(session)) {
      return {
        allow: false,
        reason: "active_user_capture",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }
    if (Number(session.pendingFileAsrTurns || 0) > 0) {
      return {
        allow: false,
        reason: "pending_stt_turns",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }
    if (this.host.turnProcessor.getRealtimeTurnBacklogSize(session) > 0) {
      return {
        allow: false,
        reason: "pending_realtime_turns",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }
    if (this.host.deferredActionQueue.getDeferredQueuedUserTurns(session).length > 0) {
      return {
        allow: false,
        reason: "pending_deferred_turns",
        retryAfterMs: VOICE_THOUGHT_LOOP_BUSY_RETRY_MS
      };
    }
    if (this.host.countHumanVoiceParticipants(session) <= 0) {
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
  }: {
    session: VoiceSession;
    settings?: ThoughtSettings;
    trigger?: string;
  }) {
    if (!session || session.ending) return false;
    const resolvedSettings = settings || session.settingsSnapshot || this.store.getSettings();
    const thoughtConfig = this.host.resolveVoiceThoughtEngineConfig(resolvedSettings);
    if (!thoughtConfig.enabled) {
      this.clearVoiceThoughtLoopTimer(session);
      return false;
    }

    const loopStartedAt = Date.now();
    const pendingThoughtBeforeGate = this.getPendingAmbientThought(session);
    if (this.pendingThoughtIsExpired(pendingThoughtBeforeGate, thoughtConfig, loopStartedAt)) {
      this.clearPendingAmbientThought(session, {
        reason: "expired",
        now: loopStartedAt,
        trigger
      });
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

    const pendingThought = this.getPendingAmbientThought(session);
    const isPendingThoughtPass = Boolean(pendingThought);
    const thoughtChance = clamp(Number(thoughtConfig?.eagerness) || 0, 0, 100) / 100;
    const now = Date.now();
    session.lastThoughtAttemptAt = now;
    if (!isPendingThoughtPass && thoughtChance <= 0) {
      this.scheduleVoiceThoughtLoop({
        session,
        settings: resolvedSettings,
        delayMs: thoughtConfig.minSecondsBetweenThoughts * 1000
      });
      return false;
    }

    const roll = Math.random();
    if (!isPendingThoughtPass && roll > thoughtChance) {
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.botUserId,
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
      const thoughtDraft = await this.host.generateVoiceThoughtCandidate({
        session,
        settings: resolvedSettings,
        config: thoughtConfig,
        trigger,
        pendingThought
      });
      const normalizedThoughtDraft = normalizeVoiceText(
        thoughtDraft || pendingThought?.currentText || "",
        VOICE_THOUGHT_MAX_CHARS
      );
      if (!normalizedThoughtDraft) {
        if (pendingThought) {
          this.clearPendingAmbientThought(session, {
            reason: "pending_thought_evaporated",
            now,
            trigger
          });
        }
        this.store.logAction({
          kind: "voice_runtime",
          guildId: session.guildId,
          channelId: session.textChannelId,
          userId: this.botUserId,
          content: "voice_thought_generation_skip",
          metadata: {
            sessionId: session.id,
            mode: session.mode,
            trigger: String(trigger || "timer"),
            hadPendingThought: isPendingThoughtPass,
            pendingThoughtId: pendingThought?.id || null
          }
        });
        return false;
      }

      const thoughtMemoryFacts = await this.host.loadVoiceThoughtMemoryFacts({
        session,
        settings: resolvedSettings,
        thoughtCandidate: normalizedThoughtDraft
      });
      const thoughtTopicalityBias = this.host.resolveVoiceThoughtTopicalityBias({
        silenceMs: Math.max(0, Date.now() - Number(session.lastActivityAt || 0)),
        minSilenceSeconds: thoughtConfig.minSilenceSeconds,
        minSecondsBetweenThoughts: thoughtConfig.minSecondsBetweenThoughts
      });
      const decision = await this.host.evaluateVoiceThoughtDecision({
        session,
        settings: resolvedSettings,
        thoughtCandidate: normalizedThoughtDraft,
        memoryFacts: thoughtMemoryFacts,
        topicalityBias: thoughtTopicalityBias,
        pendingThought
      });
      this.store.logAction({
        kind: "voice_runtime",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.botUserId,
        content: "voice_thought_decision",
        metadata: {
          sessionId: session.id,
          mode: session.mode,
          trigger: String(trigger || "timer"),
          action: decision.action,
          allow: decision.action === "speak_now",
          reason: decision.reason,
          hadPendingThought: isPendingThoughtPass,
          pendingThoughtId: pendingThought?.id || null,
          pendingThoughtRevision: pendingThought?.revision || null,
          thoughtDraft: normalizedThoughtDraft,
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
      const finalThought = normalizeVoiceText(
        decision.finalThought || normalizedThoughtDraft,
        VOICE_THOUGHT_MAX_CHARS
      );
      if (decision.action === "drop") {
        this.clearPendingAmbientThought(session, {
          reason: decision.reason || "llm_drop",
          now,
          trigger
        });
        return false;
      }
      if (!finalThought) {
        this.clearPendingAmbientThought(session, {
          reason: "empty_final_thought",
          now,
          trigger
        });
        return false;
      }
      if (decision.action === "hold") {
        this.upsertPendingAmbientThought({
          session,
          config: thoughtConfig,
          now,
          trigger,
          thoughtDraft: normalizedThoughtDraft,
          thoughtText: finalThought,
          decision
        });
        return false;
      }

      const spoken = await this.host.deliverVoiceThoughtCandidate({
        session,
        settings: resolvedSettings,
        thoughtCandidate: finalThought,
        trigger
      });
      if (spoken) {
        const deliveredAt = Date.now();
        session.lastThoughtSpokenAt = deliveredAt;
        this.clearPendingAmbientThought(session, {
          reason: "spoken",
          now: deliveredAt,
          trigger
        });
      } else {
        this.upsertPendingAmbientThought({
          session,
          config: thoughtConfig,
          now: Date.now(),
          trigger,
          thoughtDraft: normalizedThoughtDraft,
          thoughtText: finalThought,
          decision: {
            ...decision,
            action: "hold",
            reason: "delivery_failed"
          }
        });
      }
      return spoken;
    } catch (error) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: this.botUserId,
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
        delayMs: this.resolveNextLoopDelayMs({
          session,
          config: thoughtConfig,
          now: Date.now()
        })
      });
    }
  }

  private get botUserId() {
    return this.host.client.user?.id || null;
  }

  private get store() {
    return this.host.store;
  }
}
