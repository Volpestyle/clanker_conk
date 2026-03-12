import type { SettingsInput } from "./settingsSchema.ts";
import { normalizeSettings } from "../store/settingsNormalization.ts";
import { deepMerge } from "../utils.ts";

type JsonRecord = Record<string, unknown>;

function isRecordLike(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneIntentCandidate(value: unknown): JsonRecord {
  if (!isRecordLike(value)) return {};
  return deepMerge({}, value) as JsonRecord;
}

function getCandidateValue(root: JsonRecord, path: string[]) {
  let current: unknown = root;
  for (const segment of path) {
    if (!isRecordLike(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function deleteCandidatePath(root: JsonRecord, path: string[]): JsonRecord {
  if (path.length === 0) return {};
  const [head, ...rest] = path;
  const clone = { ...root };
  if (!Object.prototype.hasOwnProperty.call(clone, head)) {
    return clone;
  }
  if (rest.length === 0) {
    delete clone[head];
    return clone;
  }

  const currentChild = clone[head];
  if (!isRecordLike(currentChild)) {
    delete clone[head];
    return clone;
  }

  const nextChild = deleteCandidatePath(currentChild, rest);
  if (Object.keys(nextChild).length === 0) {
    delete clone[head];
  } else {
    clone[head] = nextChild;
  }
  return clone;
}

function normalizeIntentTargetJson(candidate: JsonRecord) {
  return JSON.stringify(normalizeSettings(candidate));
}

function effectiveMatches(candidate: JsonRecord, targetJson: string) {
  return normalizeIntentTargetJson(candidate) === targetJson;
}

function pruneIntentAtPath(root: JsonRecord, path: string[], targetJson: string): JsonRecord {
  const current = getCandidateValue(root, path);
  if (!isRecordLike(current)) return root;

  let workingRoot = root;
  for (const key of Object.keys(current)) {
    const childPath = [...path, key];
    const withoutChild = deleteCandidatePath(workingRoot, childPath);
    if (effectiveMatches(withoutChild, targetJson)) {
      workingRoot = withoutChild;
      continue;
    }

    const nextChild = getCandidateValue(workingRoot, childPath);
    if (!isRecordLike(nextChild)) {
      continue;
    }

    workingRoot = pruneIntentAtPath(workingRoot, childPath, targetJson);
    const prunedChild = getCandidateValue(workingRoot, childPath);
    if (!isRecordLike(prunedChild) || Object.keys(prunedChild).length > 0) {
      continue;
    }

    const withoutEmptyChild = deleteCandidatePath(workingRoot, childPath);
    if (effectiveMatches(withoutEmptyChild, targetJson)) {
      workingRoot = withoutEmptyChild;
    }
  }

  return workingRoot;
}

export function minimizeSettingsIntent(value: unknown): SettingsInput {
  const source =
    isRecordLike(value) && isRecordLike(value.intent)
      ? value.intent
      : value;
  const candidate = cloneIntentCandidate(source);
  const targetJson = normalizeIntentTargetJson(candidate);
  return pruneIntentAtPath(candidate, [], targetJson) as SettingsInput;
}
