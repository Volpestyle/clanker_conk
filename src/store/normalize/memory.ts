import { DEFAULT_SETTINGS, type Settings } from "../../settings/settingsSchema.ts";
import {
  normalizeBoolean,
  normalizeInt,
  normalizeString
} from "./primitives.ts";

export function normalizeMemorySection(section: Settings["memory"]): Settings["memory"] {
  const promptSlice = section.promptSlice;
  const reflection = section.reflection;

  return {
    enabled: normalizeBoolean(section.enabled, DEFAULT_SETTINGS.memory.enabled),
    promptSlice: {
      maxRecentMessages: normalizeInt(
        promptSlice.maxRecentMessages,
        DEFAULT_SETTINGS.memory.promptSlice.maxRecentMessages,
        4,
        120
      )
    },
    embeddingModel: normalizeString(
      section.embeddingModel,
      DEFAULT_SETTINGS.memory.embeddingModel,
      120
    ),
    reflection: {
      enabled: normalizeBoolean(reflection.enabled, DEFAULT_SETTINGS.memory.reflection.enabled),
      hour: normalizeInt(reflection.hour, DEFAULT_SETTINGS.memory.reflection.hour, 0, 23),
      minute: normalizeInt(reflection.minute, DEFAULT_SETTINGS.memory.reflection.minute, 0, 59),
      maxFactsPerReflection: normalizeInt(
        reflection.maxFactsPerReflection,
        DEFAULT_SETTINGS.memory.reflection.maxFactsPerReflection,
        1,
        100
      )
    }
  };
}
