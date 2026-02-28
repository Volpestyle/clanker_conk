import { Database } from "bun:sqlite";
import { normalizeSettings } from "../../../src/store/settingsNormalization.ts";
import type { ActionRow, MessageRow, ReplayBaseArgs } from "./types.ts";
import { parseJsonSafe } from "./utils.ts";

export function openReadOnlyDb(dbPath: string) {
  return new Database(dbPath, { readonly: true, create: false });
}

function queryRows<T extends Record<string, unknown>>(
  db: Database,
  sql: string,
  params: unknown[] = []
): T[] {
  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as T[];
  return Array.isArray(rows) ? rows : [];
}

export function loadRuntimeSettings(db: Database) {
  const settingsRow = db
    .prepare("SELECT value FROM settings WHERE key = 'runtime_settings' LIMIT 1")
    .get() as { value?: string } | undefined;
  if (!settingsRow?.value) {
    throw new Error("runtime_settings not found in DB");
  }
  return normalizeSettings(parseJsonSafe(String(settingsRow.value || "")) || {});
}

export function loadMessagesForReplay(
  db: Database,
  {
    contextSince,
    since,
    until,
    channelId,
    maxTurns
  }: {
    contextSince: string;
    since: string;
    until: string;
    channelId: string;
    maxTurns: number;
  }
) {
  const messages = queryRows<MessageRow>(
    db,
    `
      SELECT
        message_id,
        created_at,
        guild_id,
        channel_id,
        author_id,
        author_name,
        is_bot,
        content,
        referenced_message_id
      FROM messages
      WHERE created_at >= ?
        AND (? = '' OR created_at <= ?)
        AND (? = '' OR channel_id = ?)
      ORDER BY created_at ASC
    `,
    [contextSince, until, until, channelId, channelId]
  );

  const boundedMaxTurns = Math.max(0, Math.floor(maxTurns) || 0);
  const candidateMessages = messages.filter(
    (row) => Number(row.is_bot) !== 1 && String(row.created_at || "") >= since
  );
  const replayMessages =
    boundedMaxTurns > 0 ? candidateMessages.slice(0, boundedMaxTurns) : candidateMessages;

  return { messages, replayMessages };
}

export function resolveBotUserId(messages: MessageRow[]) {
  const botCounts = new Map<string, number>();
  for (const row of messages) {
    const authorId = String(row.author_id || "").trim();
    if (!authorId) continue;
    const current = botCounts.get(authorId) || 0;
    botCounts.set(authorId, current + (Number(row.is_bot) === 1 ? 1 : 0));
  }
  const sortedBotCandidates = [...botCounts.entries()].sort((a, b) => b[1] - a[1]);
  const botUserId = sortedBotCandidates[0]?.[0] || "";
  if (!botUserId) {
    throw new Error("could not resolve bot user id from messages table");
  }
  return botUserId;
}

export function loadInitiativeChannelIds(runtimeSettings: Record<string, unknown>) {
  const permissions = runtimeSettings.permissions as {
    initiativeChannelIds?: unknown[];
  } | null;
  if (!permissions || !Array.isArray(permissions.initiativeChannelIds)) {
    return new Set<string>();
  }
  return new Set(permissions.initiativeChannelIds.map((value) => String(value)));
}

export function primeReplayHistory(messages: MessageRow[], since: string) {
  const historyByChannel = new Map<string, MessageRow[]>();
  const historyByMessageId = new Map<string, MessageRow>();

  for (const row of messages) {
    if (String(row.created_at || "") >= since) continue;
    const channelId = String(row.channel_id || "");
    if (!channelId) continue;
    const history = historyByChannel.get(channelId) || [];
    history.push(row);
    historyByChannel.set(channelId, history);
    historyByMessageId.set(String(row.message_id), row);
  }

  return { historyByChannel, historyByMessageId };
}

export function parseMetadataObject(row: ActionRow) {
  const raw = String(row.metadata || "").trim();
  if (!raw) return {};
  const parsed = parseJsonSafe(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

export function queryRecordedActions(
  db: Database,
  args: ReplayBaseArgs,
  contextSince: string,
  kinds: string[],
  extraWhere = "",
  includeMessageId = false
) {
  const selectedColumns = includeMessageId
    ? "id, created_at, channel_id, kind, content, metadata, message_id"
    : "id, created_at, channel_id, kind, content, metadata";

  const kindPlaceholders = kinds.map(() => "?").join(", ");
  return queryRows<ActionRow>(
    db,
    `
      SELECT ${selectedColumns}
      FROM actions
      WHERE created_at >= ?
        AND (? = '' OR created_at <= ?)
        AND (? = '' OR channel_id = ?)
        AND kind IN (${kindPlaceholders})
        ${extraWhere}
      ORDER BY id ASC
    `,
    [
      contextSince,
      args.until,
      args.until,
      args.channelId,
      args.channelId,
      ...kinds
    ]
  );
}
