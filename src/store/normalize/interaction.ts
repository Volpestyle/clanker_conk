import { normalizeOpenAiReasoningEffort } from "../../llm/llmHelpers.ts";
import {
  DEFAULT_SETTINGS,
  type Settings,
  type SettingsModelBinding
} from "../../settings/settingsSchema.ts";
import { SETTINGS_NUMERIC_CONSTRAINTS } from "../../settings/settingsConstraints.ts";
import {
  isRecord,
  normalizeBoolean,
  normalizeInt,
  normalizeNumber
} from "./primitives.ts";
import { normalizeExecutionPolicy } from "./shared.ts";

export function normalizeInteractionSection(
  section: Settings["interaction"],
  orchestratorFallback: SettingsModelBinding
): Settings["interaction"] {
  const activity = section.activity;
  const replyGeneration = section.replyGeneration;
  const followup = section.followup;
  const startup = section.startup;
  const sessions = section.sessions;

  return {
    activity: {
      ambientReplyEagerness: normalizeInt(
        activity.ambientReplyEagerness,
        DEFAULT_SETTINGS.interaction.activity.ambientReplyEagerness,
        0,
        100
      ),
      responseWindowEagerness: normalizeInt(
        activity.responseWindowEagerness,
        DEFAULT_SETTINGS.interaction.activity.responseWindowEagerness,
        0,
        100
      ),
      reactivity: normalizeInt(
        activity.reactivity,
        DEFAULT_SETTINGS.interaction.activity.reactivity,
        0,
        100
      ),
      minSecondsBetweenMessages: normalizeInt(
        activity.minSecondsBetweenMessages,
        DEFAULT_SETTINGS.interaction.activity.minSecondsBetweenMessages,
        5,
        300
      ),
      replyCoalesceWindowSeconds: normalizeInt(
        activity.replyCoalesceWindowSeconds,
        DEFAULT_SETTINGS.interaction.activity.replyCoalesceWindowSeconds,
        0,
        20
      ),
      replyCoalesceMaxMessages: normalizeInt(
        activity.replyCoalesceMaxMessages,
        DEFAULT_SETTINGS.interaction.activity.replyCoalesceMaxMessages,
        1,
        20
      )
    },
    replyGeneration: {
      temperature: normalizeNumber(
        replyGeneration.temperature,
        DEFAULT_SETTINGS.interaction.replyGeneration.temperature,
        0,
        2
      ),
      maxOutputTokens: normalizeInt(
        replyGeneration.maxOutputTokens,
        DEFAULT_SETTINGS.interaction.replyGeneration.maxOutputTokens,
        32,
        16_384
      ),
      reasoningEffort:
        normalizeOpenAiReasoningEffort(
          replyGeneration.reasoningEffort,
          DEFAULT_SETTINGS.interaction.replyGeneration.reasoningEffort
        ) || "",
      pricing: isRecord(replyGeneration.pricing) ? replyGeneration.pricing : {}
    },
    followup: {
      enabled: normalizeBoolean(followup.enabled, DEFAULT_SETTINGS.interaction.followup.enabled),
      execution: normalizeExecutionPolicy(
        followup.execution,
        orchestratorFallback.provider,
        orchestratorFallback.model
      ),
      toolBudget: {
        maxToolSteps: normalizeInt(
          followup.toolBudget.maxToolSteps,
          DEFAULT_SETTINGS.interaction.followup.toolBudget.maxToolSteps,
          0,
          6
        ),
        maxTotalToolCalls: normalizeInt(
          followup.toolBudget.maxTotalToolCalls,
          DEFAULT_SETTINGS.interaction.followup.toolBudget.maxTotalToolCalls,
          0,
          12
        ),
        maxWebSearchCalls: normalizeInt(
          followup.toolBudget.maxWebSearchCalls,
          DEFAULT_SETTINGS.interaction.followup.toolBudget.maxWebSearchCalls,
          0,
          8
        ),
        maxMemoryLookupCalls: normalizeInt(
          followup.toolBudget.maxMemoryLookupCalls,
          DEFAULT_SETTINGS.interaction.followup.toolBudget.maxMemoryLookupCalls,
          0,
          8
        ),
        maxImageLookupCalls: normalizeInt(
          followup.toolBudget.maxImageLookupCalls,
          DEFAULT_SETTINGS.interaction.followup.toolBudget.maxImageLookupCalls,
          0,
          8
        ),
        toolTimeoutMs: normalizeInt(
          followup.toolBudget.toolTimeoutMs,
          DEFAULT_SETTINGS.interaction.followup.toolBudget.toolTimeoutMs,
          1_000,
          120_000
        )
      }
    },
    startup: {
      catchupEnabled: normalizeBoolean(
        startup.catchupEnabled,
        DEFAULT_SETTINGS.interaction.startup.catchupEnabled
      ),
      catchupLookbackHours: normalizeInt(
        startup.catchupLookbackHours,
        DEFAULT_SETTINGS.interaction.startup.catchupLookbackHours,
        SETTINGS_NUMERIC_CONSTRAINTS.interaction.startup.catchupLookbackHours.min,
        SETTINGS_NUMERIC_CONSTRAINTS.interaction.startup.catchupLookbackHours.max
      ),
      catchupMaxMessagesPerChannel: normalizeInt(
        startup.catchupMaxMessagesPerChannel,
        DEFAULT_SETTINGS.interaction.startup.catchupMaxMessagesPerChannel,
        SETTINGS_NUMERIC_CONSTRAINTS.interaction.startup.catchupMaxMessagesPerChannel.min,
        SETTINGS_NUMERIC_CONSTRAINTS.interaction.startup.catchupMaxMessagesPerChannel.max
      ),
      maxCatchupRepliesPerChannel: normalizeInt(
        startup.maxCatchupRepliesPerChannel,
        DEFAULT_SETTINGS.interaction.startup.maxCatchupRepliesPerChannel,
        SETTINGS_NUMERIC_CONSTRAINTS.interaction.startup.maxCatchupRepliesPerChannel.min,
        SETTINGS_NUMERIC_CONSTRAINTS.interaction.startup.maxCatchupRepliesPerChannel.max
      )
    },
    sessions: {
      sessionIdleTimeoutMs: normalizeInt(
        sessions.sessionIdleTimeoutMs,
        DEFAULT_SETTINGS.interaction.sessions.sessionIdleTimeoutMs,
        SETTINGS_NUMERIC_CONSTRAINTS.interaction.sessions.sessionIdleTimeoutMs.min,
        SETTINGS_NUMERIC_CONSTRAINTS.interaction.sessions.sessionIdleTimeoutMs.max
      ),
      maxConcurrentSessions: normalizeInt(
        sessions.maxConcurrentSessions,
        DEFAULT_SETTINGS.interaction.sessions.maxConcurrentSessions,
        SETTINGS_NUMERIC_CONSTRAINTS.interaction.sessions.maxConcurrentSessions.min,
        SETTINGS_NUMERIC_CONSTRAINTS.interaction.sessions.maxConcurrentSessions.max
      )
    }
  };
}
