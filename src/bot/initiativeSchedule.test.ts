import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  evaluateInitiativeSchedule,
  evaluateSpontaneousInitiativeSchedule,
  getInitiativeAverageIntervalMs,
  getInitiativeMinGapMs,
  getInitiativePacingMode,
  getInitiativePostingIntervalMs,
  pickInitiativeChannel
} from "./initiativeSchedule.ts";

function baseSettings(overrides = {}) {
  const base = {
    initiative: {
      maxPostsPerDay: 12,
      minMinutesBetweenPosts: 30,
      pacingMode: "even",
      postOnStartup: true,
      spontaneity: 40
    },
    permissions: {
      initiativeChannelIds: []
    }
  };

  return {
    ...base,
    ...overrides,
    initiative: {
      ...base.initiative,
      ...(overrides.initiative || {})
    },
    permissions: {
      ...base.permissions,
      ...(overrides.permissions || {})
    }
  };
}

test("initiative interval uses the larger of min-gap and even pacing", () => {
  const gapDominant = getInitiativePostingIntervalMs(
    baseSettings({
      initiative: {
        maxPostsPerDay: 999,
        minMinutesBetweenPosts: 60
      }
    })
  );
  assert.equal(gapDominant, 60 * 60 * 1000);

  const pacingDominant = getInitiativePostingIntervalMs(
    baseSettings({
      initiative: {
        maxPostsPerDay: 2,
        minMinutesBetweenPosts: 1
      }
    })
  );
  assert.equal(pacingDominant, 12 * 60 * 60 * 1000);
});

test("initiative helper accessors normalize mode and timing values", () => {
  const settings = baseSettings({
    initiative: {
      maxPostsPerDay: 6,
      minMinutesBetweenPosts: 7,
      pacingMode: "SpOnTaNeOuS"
    }
  });
  assert.equal(getInitiativeAverageIntervalMs(settings), 4 * 60 * 60 * 1000);
  assert.equal(getInitiativePacingMode(settings), "spontaneous");
  assert.equal(getInitiativeMinGapMs(settings), 7 * 60 * 1000);
});

test("evaluateInitiativeSchedule blocks startup posting when disabled", () => {
  const result = evaluateInitiativeSchedule({
    settings: baseSettings({
      initiative: {
        postOnStartup: false
      }
    }),
    startup: true,
    lastPostTs: null,
    elapsedMs: null,
    posts24h: 0
  });

  assert.equal(result.shouldPost, false);
  assert.equal(result.trigger, "startup_disabled");
});

test("evaluateInitiativeSchedule bootstraps first startup post when enabled", () => {
  const result = evaluateInitiativeSchedule({
    settings: baseSettings(),
    startup: true,
    lastPostTs: null,
    elapsedMs: null,
    posts24h: 0
  });

  assert.equal(result.shouldPost, true);
  assert.equal(result.trigger, "startup_bootstrap");
});

test("evaluateInitiativeSchedule enforces min-gap before any non-startup post", () => {
  const settings = baseSettings({
    initiative: {
      minMinutesBetweenPosts: 15
    }
  });
  const result = evaluateInitiativeSchedule({
    settings,
    startup: false,
    lastPostTs: Date.now() - 120_000,
    elapsedMs: 120_000,
    posts24h: 0
  });

  assert.equal(result.shouldPost, false);
  assert.equal(result.trigger, "min_gap_block");
  assert.equal(result.requiredIntervalMs, 15 * 60 * 1000);
});

test("evaluateInitiativeSchedule supports even pacing wait and due transitions", () => {
  const settings = baseSettings({
    initiative: {
      maxPostsPerDay: 8,
      minMinutesBetweenPosts: 30,
      pacingMode: "even"
    }
  });
  const required = getInitiativePostingIntervalMs(settings);

  const waiting = evaluateInitiativeSchedule({
    settings,
    startup: false,
    lastPostTs: Date.now() - (required - 10_000),
    elapsedMs: required - 10_000,
    posts24h: 1
  });
  assert.equal(waiting.shouldPost, false);
  assert.equal(waiting.trigger, "even_wait");

  const due = evaluateInitiativeSchedule({
    settings,
    startup: false,
    lastPostTs: Date.now() - (required + 1_000),
    elapsedMs: required + 1_000,
    posts24h: 1
  });
  assert.equal(due.shouldPost, true);
  assert.equal(due.trigger, "even_due");
});

test("evaluateSpontaneousInitiativeSchedule forces a post after force window", () => {
  const settings = baseSettings({
    initiative: {
      pacingMode: "spontaneous",
      maxPostsPerDay: 10,
      minMinutesBetweenPosts: 20,
      spontaneity: 80
    }
  });
  const average = getInitiativeAverageIntervalMs(settings);
  const minGap = getInitiativeMinGapMs(settings);
  const forceAfterMs = Math.max(minGap, Math.round(average * (1.6 - 0.8 * 0.55)));

  const result = evaluateSpontaneousInitiativeSchedule({
    settings,
    lastPostTs: Date.now() - (forceAfterMs + 5_000),
    elapsedMs: forceAfterMs + 5_000,
    posts24h: 1,
    minGapMs: minGap
  });

  assert.equal(result.shouldPost, true);
  assert.equal(result.trigger, "spontaneous_force_due");
  assert.equal(result.requiredIntervalMs, forceAfterMs);
});

test("pickInitiativeChannel skips unavailable and disallowed channels", () => {
  const channels = new Map();
  channels.set("voice-1", {
    id: "voice-1",
    isTextBased() {
      return false;
    }
  });
  channels.set("text-2", {
    id: "text-2",
    isTextBased() {
      return true;
    },
    async send() {}
  });

  const picked = pickInitiativeChannel({
    settings: baseSettings({
      permissions: {
        initiativeChannelIds: ["voice-1", "text-2"]
      }
    }),
    client: {
      channels: {
        cache: channels
      }
    },
    isChannelAllowed(_settings, channelId) {
      return channelId === "text-2";
    }
  });

  assert.equal(picked?.id, "text-2");

  const none = pickInitiativeChannel({
    settings: baseSettings({
      permissions: {
        initiativeChannelIds: ["text-2"]
      }
    }),
    client: {
      channels: {
        cache: channels
      }
    },
    isChannelAllowed() {
      return false;
    }
  });
  assert.equal(none, null);
});
