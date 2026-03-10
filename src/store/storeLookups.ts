// Extracted Store Methods
import type { Database } from "bun:sqlite";

import { nowIso } from "../utils.ts";

interface LookupStore {
  db: Database;
}

interface SharedLinkPresenceRow {
  found: number;
}

export function wasLinkSharedSince(store: LookupStore, url, sinceIso) {
const normalizedUrl = String(url || "").trim();
if (!normalizedUrl) return false;

const row = store.db
  .prepare<SharedLinkPresenceRow, [string, string]>(
    `SELECT 1 AS found
         FROM shared_links
         WHERE url = ? AND last_shared_at >= ?
         LIMIT 1`
  )
  .get(normalizedUrl, String(sinceIso));

return Boolean(row);
}

export function recordSharedLink(store: LookupStore, { url, source = null }) {
const normalizedUrl = String(url || "").trim();
if (!normalizedUrl) return;

const now = nowIso();
store.db
  .prepare(
    `INSERT INTO shared_links(url, first_shared_at, last_shared_at, share_count, source)
         VALUES(?, ?, ?, 1, ?)
         ON CONFLICT(url) DO UPDATE SET
           last_shared_at = excluded.last_shared_at,
           share_count = shared_links.share_count + 1,
           source = excluded.source`
  )
  .run(normalizedUrl, now, now, source ? String(source).slice(0, 120) : null);
}
