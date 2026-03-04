import { clamp } from "../utils.ts";

const ADAPTIVE_STYLE_NOTE_MAX_CHARS = 420;

type AdaptiveStyleNoteRow = {
  id?: string | number;
  directiveKind?: string | null;
  noteText?: string | null;
  updatedAt?: string | null;
};

type AdaptiveDirectiveMutationResult = {
  ok: boolean;
  error?: string;
  status?: string;
  note?: AdaptiveStyleNoteRow | null;
};

type SharedAdaptiveStyleRuntime = {
  store: {
    getActiveAdaptiveStyleNotes: (guildId: string, limit?: number) => AdaptiveStyleNoteRow[];
    addAdaptiveStyleNote: (opts: {
      guildId: string;
      directiveKind?: string;
      noteText: string;
      actorUserId?: string | null;
      actorName?: string | null;
      sourceMessageId?: string | null;
      sourceText?: string | null;
      source?: string;
    }) => AdaptiveDirectiveMutationResult;
    removeAdaptiveStyleNote: (opts: {
      noteId: number;
      guildId: string;
      actorUserId?: string | null;
      actorName?: string | null;
      removalReason?: string | null;
      source?: string;
    }) => AdaptiveDirectiveMutationResult;
  };
};

function normalizeInlineText(value: unknown, maxChars = ADAPTIVE_STYLE_NOTE_MAX_CHARS) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function normalizeLowerTokens(value: unknown) {
  return [...new Set(
    normalizeInlineText(value, 320)
      .toLowerCase()
      .match(/[a-z0-9]{2,}/g) || []
  )].slice(0, 12);
}

function resolveAdaptiveStyleNoteByReference(
  activeNotes: AdaptiveStyleNoteRow[],
  {
    noteRef = "",
    target = ""
  }: {
    noteRef?: unknown;
    target?: unknown;
  }
) {
  const normalizedNoteRef = normalizeInlineText(noteRef, 40).toLowerCase();
  const normalizedTarget = normalizeInlineText(target, 320).toLowerCase();
  const refMatch = normalizedNoteRef.match(/s?(\d+)/i);
  if (refMatch) {
    const refId = Number(refMatch[1]);
    const exactRef = activeNotes.find((row) => Number(row?.id) === refId);
    if (exactRef) {
      return {
        note: exactRef,
        matchReason: "ref"
      };
    }
  }

  const targetTokens = normalizeLowerTokens(normalizedTarget);
  let bestNote: AdaptiveStyleNoteRow | null = null;
  let bestScore = 0;
  let bestMatchReason = "";
  for (const row of activeNotes) {
    const noteText = normalizeInlineText(row?.noteText, 320).toLowerCase();
    if (!noteText) continue;
    if (normalizedTarget && noteText === normalizedTarget) {
      return {
        note: row,
        matchReason: "exact_text"
      };
    }
    let score = 0;
    let matchReason = "";
    if (normalizedTarget && (noteText.includes(normalizedTarget) || normalizedTarget.includes(noteText))) {
      score += 40;
      matchReason = "substring";
    }
    if (normalizedNoteRef && noteText.includes(normalizedNoteRef)) {
      score += 15;
      matchReason = matchReason || "ref_text";
    }
    if (targetTokens.length > 0) {
      const noteTokens = normalizeLowerTokens(noteText);
      const noteTokenSet = new Set(noteTokens);
      const overlap = targetTokens.filter((token) => noteTokenSet.has(token)).length;
      score += overlap * 6;
      if (!matchReason && overlap > 0) {
        matchReason = "token_overlap";
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestNote = row;
      bestMatchReason = matchReason || "fuzzy";
    }
  }

  if (!bestNote || bestScore < 12) {
    return {
      note: null,
      matchReason: ""
    };
  }
  return {
    note: bestNote,
    matchReason: bestMatchReason
  };
}

export async function executeSharedAdaptiveDirectiveAdd({
  runtime,
  guildId,
  directiveKind = "guidance",
  actorUserId = null,
  actorName = null,
  sourceMessageId = null,
  sourceText = "",
  noteText = "",
  source = "conversation"
}: {
  runtime: SharedAdaptiveStyleRuntime;
  guildId: string;
  directiveKind?: string | null;
  actorUserId?: string | null;
  actorName?: string | null;
  sourceMessageId?: string | null;
  sourceText?: string;
  noteText?: unknown;
  source?: string;
}) {
  const normalizedGuildId = normalizeInlineText(guildId, 80);
  const normalizedNoteText = normalizeInlineText(noteText, ADAPTIVE_STYLE_NOTE_MAX_CHARS);
  if (!normalizedGuildId) {
    return { ok: false, error: "guild_required", note: null };
  }
  if (!normalizedNoteText) {
    return { ok: false, error: "note_required", note: null };
  }
  return runtime.store.addAdaptiveStyleNote({
    guildId: normalizedGuildId,
    directiveKind: String(directiveKind || "guidance"),
    noteText: normalizedNoteText,
    actorUserId: actorUserId ? normalizeInlineText(actorUserId, 80) : null,
    actorName: actorName ? normalizeInlineText(actorName, 80) : null,
    sourceMessageId: sourceMessageId ? normalizeInlineText(sourceMessageId, 120) : null,
    sourceText: normalizeInlineText(sourceText, 1000),
    source
  });
}

export async function executeSharedAdaptiveDirectiveRemove({
  runtime,
  guildId,
  actorUserId = null,
  actorName = null,
  sourceMessageId: _sourceMessageId = null,
  sourceText = "",
  noteRef = "",
  target = "",
  removalReason = "",
  source = "conversation"
}: {
  runtime: SharedAdaptiveStyleRuntime;
  guildId: string;
  actorUserId?: string | null;
  actorName?: string | null;
  sourceMessageId?: string | null;
  sourceText?: string;
  noteRef?: unknown;
  target?: unknown;
  removalReason?: unknown;
  source?: string;
}) {
  const normalizedGuildId = normalizeInlineText(guildId, 80);
  if (!normalizedGuildId) {
    return { ok: false, error: "guild_required", note: null, matchReason: "" };
  }
  const activeNotes = runtime.store.getActiveAdaptiveStyleNotes(normalizedGuildId, clamp(48, 1, 200));
  const resolved = resolveAdaptiveStyleNoteByReference(activeNotes, {
    noteRef,
    target
  });
  if (!resolved.note || !Number.isInteger(Number(resolved.note.id))) {
    return {
      ok: false,
      error: "note_not_found",
      note: null,
      matchReason: ""
    };
  }
  const normalizedReason =
    normalizeInlineText(removalReason, 240) ||
    normalizeInlineText(sourceText, 240) ||
    normalizeInlineText(target, 240) ||
    normalizeInlineText(noteRef, 80);
  const result = runtime.store.removeAdaptiveStyleNote({
    noteId: Number(resolved.note.id),
    guildId: normalizedGuildId,
    actorUserId: actorUserId ? normalizeInlineText(actorUserId, 80) : null,
    actorName: actorName ? normalizeInlineText(actorName, 80) : null,
    removalReason: normalizedReason || null,
    source
  });
  return {
    ...result,
    matchReason: resolved.matchReason
  };
}
