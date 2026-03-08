import assert from "node:assert/strict";
import { env } from "node:process";
import { waitForDashboardReady } from "./dashboard.ts";

export type VoiceHistorySession = {
  sessionId: string;
  guildId: string;
  mode: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  endReason: string;
};

export type VoiceHistoryEvent = {
  created_at: string;
  kind: string;
  content?: string | null;
  guild_id?: string | null;
  channel_id?: string | null;
  user_id?: string | null;
  metadata?: Record<string, unknown> | null;
};

function envNumber(name: string, defaultValue: number): number {
  const value = env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function getDashboardBaseUrl(): string {
  const host = String(env.DASHBOARD_HOST || "127.0.0.1").trim() || "127.0.0.1";
  const port = envNumber("DASHBOARD_PORT", 8787);
  return `http://${host}:${port}`;
}

function getDashboardHeaders(): Record<string, string> {
  const token = String(env.DASHBOARD_TOKEN || "").trim();
  return token ? { "x-dashboard-token": token } : {};
}

async function fetchDashboardJson<T>(path: string): Promise<T> {
  await waitForDashboardReady();
  const response = await fetch(`${getDashboardBaseUrl()}${path}`, {
    headers: getDashboardHeaders()
  });
  assert.equal(response.ok, true, `Dashboard request failed for ${path}: ${response.status}`);
  return response.json() as Promise<T>;
}

export class VoiceHistoryAssertionHelper {
  async listRecentSessions({ sinceHours = 24, limit = 100 } = {}): Promise<VoiceHistorySession[]> {
    return fetchDashboardJson<VoiceHistorySession[]>(
      `/api/voice/history/sessions?sinceHours=${encodeURIComponent(String(sinceHours))}&limit=${encodeURIComponent(String(limit))}`
    );
  }

  async waitForLatestSession({ guildId, endedAfterMs, timeoutMs = 30_000, pollMs = 500 }: {
    guildId?: string;
    endedAfterMs?: number;
    timeoutMs?: number;
    pollMs?: number;
  } = {}): Promise<VoiceHistorySession> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const sessions = await this.listRecentSessions();
      const match = sessions.find((session) => {
        if (guildId && String(session.guildId || "") !== String(guildId)) return false;
        if (endedAfterMs && Date.parse(String(session.endedAt || "")) < endedAfterMs) return false;
        return true;
      });
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(`Timed out waiting for voice history session for guild ${guildId || "<any>"}`);
  }

  async getSessionEvents(sessionId: string): Promise<VoiceHistoryEvent[]> {
    return fetchDashboardJson<VoiceHistoryEvent[]>(
      `/api/voice/history/sessions/${encodeURIComponent(sessionId)}/events`
    );
  }

  async waitForSessionEvents(sessionId: string, { minEvents = 1, timeoutMs = 30_000, pollMs = 500 } = {}): Promise<VoiceHistoryEvent[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const events = await this.getSessionEvents(sessionId);
      if (events.length >= minEvents) return events;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(`Timed out waiting for ${minEvents} voice history events for session ${sessionId}`);
  }

  assertEventSequence(events: VoiceHistoryEvent[], expectedContents: string[]): void {
    let searchIndex = 0;
    for (const expected of expectedContents) {
      const foundIndex = events.findIndex((event, index) => {
        if (index < searchIndex) return false;
        return String(event.content || "") === expected;
      });
      assert.ok(foundIndex >= 0, `Expected event content ${expected} in order. Saw: ${events.map((event) => event.content).join(", ")}`);
      searchIndex = foundIndex + 1;
    }
  }

  findEventsByContent(events: VoiceHistoryEvent[], content: string): VoiceHistoryEvent[] {
    return events.filter((event) => String(event.content || "") === content);
  }

  findLastEventByContent(events: VoiceHistoryEvent[], content: string): VoiceHistoryEvent | null {
    const matches = this.findEventsByContent(events, content);
    return matches.length > 0 ? matches[matches.length - 1] : null;
  }

  assertAnyEventMetadataIncludes(events: VoiceHistoryEvent[], content: string, key: string, expectedSubstring: string): void {
    const matches = this.findEventsByContent(events, content);
    assert.ok(matches.length > 0, `Expected at least one ${content} event`);
    const matched = matches.some((event) => String(event.metadata?.[key] || "").toLowerCase().includes(expectedSubstring.toLowerCase()));
    assert.ok(matched, `Expected ${content} metadata.${key} to include ${expectedSubstring}`);
  }
}
