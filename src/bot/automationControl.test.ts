import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  applyAutomationControlAction,
  composeAutomationControlReply,
  formatAutomationListLine,
  resolveAutomationTargetsForControl
} from "./automationControl.ts";

function baseAutomationRow(overrides = {}) {
  return {
    id: 41,
    guild_id: "guild-1",
    channel_id: "text-1",
    title: "daily recap",
    instruction: "post recap",
    schedule: { kind: "interval", everyMinutes: 30 },
    status: "active",
    next_run_at: "2026-03-01T12:00:00.000Z",
    ...overrides
  };
}

function createMessage(overrides = {}) {
  return {
    guildId: "guild-1",
    channelId: "text-1",
    id: "msg-1",
    channel: { id: "text-1" },
    author: {
      id: "user-1",
      username: "alice"
    },
    member: {
      displayName: "alice"
    },
    ...overrides
  };
}

function createBot(overrides = {}) {
  const {
    store: storeOverrides = {},
    client: clientOverrides = {},
    ...rest
  } = overrides;

  const defaultStore = {
    listAutomations() {
      return [];
    },
    countAutomations() {
      return 0;
    },
    createAutomation() {
      return null;
    },
    setAutomationStatus() {
      return null;
    },
    getAutomationById() {
      return null;
    },
    findAutomationsByQuery() {
      return [];
    },
    getMostRecentAutomations() {
      return [];
    },
    logAction() {}
  };

  const defaultClient = {
    channels: {
      cache: new Map()
    }
  };

  return {
    store: {
      ...defaultStore,
      ...storeOverrides
    },
    client: {
      ...defaultClient,
      ...clientOverrides
    },
    isChannelAllowed() {
      return true;
    },
    maybeRunAutomationCycle: async () => undefined,
    ...rest
  };
}

test("composeAutomationControlReply falls back when model text is skipped and appends details", () => {
  const text = composeAutomationControlReply({
    modelText: "[SKIP]",
    fallbackText: "sounds good",
    detailLines: ["- #1 [active] daily recap", "", "next: tomorrow"]
  });

  assert.equal(text, "sounds good\n- #1 [active] daily recap\nnext: tomorrow");
});

test("formatAutomationListLine handles missing channel and paused state", () => {
  const line = formatAutomationListLine(
    baseAutomationRow({
      channel_id: null,
      next_run_at: null,
      status: "paused"
    })
  );

  assert.equal(line.includes("[paused]"), true);
  assert.equal(line.includes("next: paused"), true);
  assert.equal(line.includes("(unknown channel)"), true);
});

test("resolveAutomationTargetsForControl prioritizes direct automation id", () => {
  const paused = baseAutomationRow({
    id: 9,
    status: "paused"
  });
  const bot = createBot({
    store: {
      getAutomationById(id) {
        return id === 9 ? paused : null;
      }
    }
  });

  const targets = resolveAutomationTargetsForControl(bot, {
    guildId: "guild-1",
    channelId: "text-1",
    operation: "resume",
    automationId: 9
  });
  assert.deepEqual(targets, [paused]);
});

test("resolveAutomationTargetsForControl falls back from channel query to guild query", () => {
  const globalMatch = baseAutomationRow({
    id: 17
  });
  const calls = [];
  const bot = createBot({
    store: {
      findAutomationsByQuery(args) {
        calls.push(args);
        if (args.channelId) return [];
        return [globalMatch];
      }
    }
  });

  const targets = resolveAutomationTargetsForControl(bot, {
    guildId: "guild-1",
    channelId: "text-1",
    operation: "delete",
    targetQuery: "daily recap"
  });

  assert.deepEqual(targets, [globalMatch]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].channelId, "text-1");
  assert.equal(calls[1].channelId, undefined);
});

test("applyAutomationControlAction list returns an empty-state response", async () => {
  const bot = createBot({
    store: {
      listAutomations() {
        return [];
      }
    }
  });

  const result = await applyAutomationControlAction(bot, {
    message: createMessage(),
    settings: {},
    automationAction: {
      operation: "list"
    }
  });

  assert.equal(result?.handled, true);
  assert.equal(result?.metadata?.ok, true);
  assert.equal(result?.metadata?.count, 0);
  assert.equal(result?.fallbackText, "no scheduled jobs right now.");
});

test("applyAutomationControlAction create rejects blocked target channels", async () => {
  const bot = createBot({
    isChannelAllowed() {
      return false;
    }
  });

  const result = await applyAutomationControlAction(bot, {
    message: createMessage(),
    settings: {},
    automationAction: {
      operation: "create",
      instruction: "post updates",
      schedule: { kind: "interval", everyMinutes: 10 },
      targetChannelId: "blocked-channel"
    }
  });

  assert.equal(result?.metadata?.ok, false);
  assert.equal(result?.metadata?.reason, "target_channel_blocked");
  assert.equal(result?.metadata?.targetChannelId, "blocked-channel");
});

test("applyAutomationControlAction create persists and logs automation rows", async () => {
  const created = baseAutomationRow({
    id: 77,
    status: "active"
  });
  const logs = [];
  let cycleRuns = 0;

  const channels = new Map();
  channels.set("text-1", {
    id: "text-1",
    isTextBased() {
      return true;
    },
    async send() {}
  });

  const bot = createBot({
    client: {
      channels: {
        cache: channels
      }
    },
    store: {
      createAutomation() {
        return created;
      },
      logAction(entry) {
        logs.push(entry);
      }
    },
    maybeRunAutomationCycle: async () => {
      cycleRuns += 1;
    }
  });

  const result = await applyAutomationControlAction(bot, {
    message: createMessage(),
    settings: {},
    automationAction: {
      operation: "create",
      title: "daily recap",
      instruction: "post updates in the channel",
      schedule: { kind: "interval", everyMinutes: 5 },
      runImmediately: true
    }
  });

  assert.equal(result?.metadata?.ok, true);
  assert.equal(result?.metadata?.automationId, 77);
  assert.equal(result?.metadata?.runImmediately, true);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.kind, "automation_created");
  assert.equal(cycleRuns, 1);
});

test("applyAutomationControlAction resume updates status and schedules cycle", async () => {
  const paused = baseAutomationRow({
    id: 19,
    status: "paused",
    next_run_at: null
  });
  const updates = [];
  let cycleRuns = 0;

  const bot = createBot({
    store: {
      getAutomationById(id) {
        return id === 19 ? paused : null;
      },
      setAutomationStatus(args) {
        updates.push(args);
        return {
          ...paused,
          status: args.status,
          next_run_at: args.nextRunAt
        };
      }
    },
    maybeRunAutomationCycle: async () => {
      cycleRuns += 1;
    }
  });

  const result = await applyAutomationControlAction(bot, {
    message: createMessage(),
    settings: {},
    automationAction: {
      operation: "resume",
      automationId: 19
    }
  });

  assert.equal(result?.metadata?.ok, true);
  assert.equal(result?.fallbackText, "resumed.");
  assert.equal(result?.metadata?.updatedIds?.[0], 19);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.status, "active");
  assert.equal(typeof updates[0]?.nextRunAt, "string");
  assert.equal(cycleRuns, 1);
});
