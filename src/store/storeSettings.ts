// Extracted Store Methods
import type { Database } from "bun:sqlite";

import { deepMerge, nowIso } from "../utils.ts";
import { SETTINGS_KEY } from "./store.ts";
import { safeJsonParse } from "../normalization/valueParsers.ts";
import { DEFAULT_SETTINGS } from "../settings/settingsSchema.ts";
import { normalizeSettings } from "./settingsNormalization.ts";

type RuntimeSettings = ReturnType<typeof normalizeSettings>;

interface SettingsStore {
  db: Database;
  getSettings(): RuntimeSettings;
  setSettings(next: unknown): RuntimeSettings;
}

interface SettingsValueRow {
  value: string;
  updated_at?: string;
}

export interface RuntimeSettingsRecord {
  settings: RuntimeSettings;
  updatedAt: string;
}

export type VersionedSettingsPatchResult =
  | {
      ok: true;
      settings: RuntimeSettings;
      updatedAt: string;
    }
  | ({
      ok: false;
    } & RuntimeSettingsRecord);

const CANONICAL_DEFAULT_SETTINGS = normalizeSettings({});
const LEGACY_BOOTSTRAP_DEFAULT_SETTINGS_JSON = JSON.stringify(normalizeSettings(DEFAULT_SETTINGS));
const LEGACY_PRESET_NAME_MAP = {
  claude_oauth_local_tools: "claude_oauth",
  claude_oauth_openai_tools: "claude_oauth",
  claude_oauth_max: "claude_oauth",
  anthropic_brain_openai_tools: "claude_api",
  anthropic_api_openai_tools: "claude_api",
  openai_native: "openai_native_realtime",
  custom: "openai_api"
} as const;
const LEGACY_VOICE_ADMISSION_MODE_MAP = {
  hard_classifier: "classifier_gate",
  deterministic_only: "generation_decides",
  generation_only: "generation_decides",
  generation: "generation_decides"
} as const;
const LEGACY_OPERATIONAL_MESSAGES_MAP = {
  important_only: "essential",
  off: "none"
} as const;
const LEGACY_DEFAULT_INTERRUPTION_MODE_MAP = {
  requester_only: "speaker",
  off: "none",
  uninterruptible: "none",
  all: "anyone"
} as const;

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function migrateLegacyStoredSettings(raw: unknown): unknown {
  if (!isRecordLike(raw)) return raw;

  let migrated = raw;
  const rawAgentStack = isRecordLike(raw.agentStack) ? raw.agentStack : null;
  const preset = typeof rawAgentStack?.preset === "string" ? rawAgentStack.preset.trim() : "";
  const canonicalPreset = LEGACY_PRESET_NAME_MAP[preset as keyof typeof LEGACY_PRESET_NAME_MAP];

  if (canonicalPreset && rawAgentStack) {
    migrated = {
      ...migrated,
      agentStack: {
        ...rawAgentStack,
        preset: canonicalPreset
      }
    };
  }

  const migratedRecord = migrated as Record<string, unknown>;
  const rawVoice = isRecordLike(migratedRecord.voice) ? migratedRecord.voice : null;
  const rawAdmission = rawVoice && isRecordLike(rawVoice.admission) ? rawVoice.admission : null;
  const admissionMode = typeof rawAdmission?.mode === "string" ? rawAdmission.mode.trim().toLowerCase() : "";
  const canonicalAdmissionMode =
    LEGACY_VOICE_ADMISSION_MODE_MAP[admissionMode as keyof typeof LEGACY_VOICE_ADMISSION_MODE_MAP];

  if (canonicalAdmissionMode && rawVoice) {
    migrated = {
      ...migratedRecord,
      voice: {
        ...rawVoice,
        admission: {
          ...rawAdmission,
          mode: canonicalAdmissionMode
        }
      }
    };
  }

  const migratedVoice = isRecordLike((migrated as Record<string, unknown>).voice)
    ? (migrated as Record<string, unknown>).voice as Record<string, unknown>
    : null;
  const rawConversationPolicy = migratedVoice && isRecordLike(migratedVoice.conversationPolicy)
    ? migratedVoice.conversationPolicy as Record<string, unknown>
    : null;
  const operationalMessages =
    typeof rawConversationPolicy?.operationalMessages === "string"
      ? rawConversationPolicy.operationalMessages.trim().toLowerCase()
      : "";
  const canonicalOperationalMessages =
    LEGACY_OPERATIONAL_MESSAGES_MAP[
      operationalMessages as keyof typeof LEGACY_OPERATIONAL_MESSAGES_MAP
    ];
  const defaultInterruptionMode =
    typeof rawConversationPolicy?.defaultInterruptionMode === "string"
      ? rawConversationPolicy.defaultInterruptionMode.trim().toLowerCase()
      : "";
  const canonicalDefaultInterruptionMode =
    LEGACY_DEFAULT_INTERRUPTION_MODE_MAP[
      defaultInterruptionMode as keyof typeof LEGACY_DEFAULT_INTERRUPTION_MODE_MAP
    ];

  if ((canonicalOperationalMessages || canonicalDefaultInterruptionMode) && migratedVoice && rawConversationPolicy) {
    migrated = {
      ...(migrated as Record<string, unknown>),
      voice: {
        ...migratedVoice,
        conversationPolicy: {
          ...rawConversationPolicy,
          ...(canonicalOperationalMessages
            ? {
                operationalMessages: canonicalOperationalMessages
              }
            : {}),
          ...(canonicalDefaultInterruptionMode
            ? {
                defaultInterruptionMode: canonicalDefaultInterruptionMode
              }
            : {})
        }
      }
    };
  }

  return migrated;
}

function mergeSettingsPatch(current: RuntimeSettings, patch: unknown): RuntimeSettings {
  const patchRecord = isRecordLike(patch) ? patch : {};
  const merged = deepMerge(current, patchRecord);

  if (Object.prototype.hasOwnProperty.call(patchRecord, "memoryLlm")) {
    merged.memoryLlm = patchRecord.memoryLlm;
  }

  return normalizeSettings(merged);
}

export function rewriteRuntimeSettingsRow(store: SettingsStore, rawValue: string | null | undefined) {
  const parsed = safeJsonParse(rawValue, DEFAULT_SETTINGS);
  const normalizedParsed = normalizeSettings(migrateLegacyStoredSettings(parsed));
  const normalized =
    JSON.stringify(normalizedParsed) === LEGACY_BOOTSTRAP_DEFAULT_SETTINGS_JSON
      ? CANONICAL_DEFAULT_SETTINGS
      : normalizedParsed;
  const normalizedJson = JSON.stringify(normalized);
  if (normalizedJson === String(rawValue || "")) return normalized;

  store.db
    .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?")
    .run(normalizedJson, nowIso(), SETTINGS_KEY);
  return normalized;
}

export function getSettings(store: SettingsStore) {
  const row = store.db
    .prepare<SettingsValueRow, [string]>("SELECT value FROM settings WHERE key = ?")
    .get(SETTINGS_KEY);
  const parsed = safeJsonParse(row?.value, DEFAULT_SETTINGS);
  return normalizeSettings(parsed);
}

export function getSettingsRecord(store: SettingsStore): RuntimeSettingsRecord {
  const row = store.db
    .prepare<SettingsValueRow, [string]>("SELECT value, updated_at FROM settings WHERE key = ?")
    .get(SETTINGS_KEY);
  const parsed = safeJsonParse(row?.value, DEFAULT_SETTINGS);
  return {
    settings: normalizeSettings(parsed),
    updatedAt: String(row?.updated_at || "")
  };
}

export function setSettings(store: SettingsStore, next) {
  const normalized = normalizeSettings(next);
  store.db
    .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?")
    .run(JSON.stringify(normalized), nowIso(), SETTINGS_KEY);
  return normalized;
}

export function patchSettings(store: SettingsStore, patch) {
  const current = store.getSettings();
  return store.setSettings(mergeSettingsPatch(current, patch));
}

export function patchSettingsWithVersion(
  store: SettingsStore,
  patch: unknown,
  expectedUpdatedAt: string
): VersionedSettingsPatchResult {
  const current = getSettingsRecord(store);
  if (current.updatedAt && expectedUpdatedAt !== current.updatedAt) {
    return {
      ok: false,
      ...current
    };
  }

  const nextSettings = mergeSettingsPatch(current.settings, patch);
  const nextUpdatedAt = nowIso();
  const result = store.db
    .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ? AND updated_at = ?")
    .run(JSON.stringify(nextSettings), nextUpdatedAt, SETTINGS_KEY, current.updatedAt);

  if (Number(result.changes || 0) !== 1) {
    return {
      ok: false,
      ...getSettingsRecord(store)
    };
  }

  return {
    ok: true,
    settings: nextSettings,
    updatedAt: nextUpdatedAt
  };
}

export function resetSettings(store: SettingsStore) {
  return store.setSettings(CANONICAL_DEFAULT_SETTINGS);
}
