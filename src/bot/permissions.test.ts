import { test } from "bun:test";
import assert from "node:assert/strict";
import { createTestSettings } from "../testSettings.ts";
import {
  isChannelAllowed,
  isDiscoveryChannel,
  isReplyChannel,
  isUserBlocked
} from "./permissions.ts";

test("isChannelAllowed blocks explicit blocked channels before allow logic", () => {
  const settings = createTestSettings({
    permissions: {
      replies: {
        blockedChannelIds: ["blocked-1"],
        allowedChannelIds: ["blocked-1", "allowed-1"]
      }
    }
  });

  assert.equal(isChannelAllowed(settings, "blocked-1"), false);
  assert.equal(isChannelAllowed(settings, "allowed-1"), true);
});

test("isChannelAllowed defaults open when allowlist is empty", () => {
  const settings = createTestSettings({
    permissions: {
      replies: {
        allowedChannelIds: [],
        blockedChannelIds: []
      }
    }
  });

  assert.equal(isChannelAllowed(settings, "any-channel"), true);
});

test("isReplyChannel matches the unsolicited reply channel list", () => {
  const settings = createTestSettings({
    permissions: {
      replies: {
        replyChannelIds: ["reply-1"]
      }
    }
  });

  assert.equal(isReplyChannel(settings, "reply-1"), true);
  assert.equal(isReplyChannel(settings, "other"), false);
});

test("isDiscoveryChannel matches the discovery channel list", () => {
  const settings = createTestSettings({
    permissions: {
      replies: {
        discoveryChannelIds: ["discovery-1"]
      }
    }
  });

  assert.equal(isDiscoveryChannel(settings, "discovery-1"), true);
  assert.equal(isDiscoveryChannel(settings, "other"), false);
});

test("isUserBlocked matches normalized blocked user ids", () => {
  const settings = createTestSettings({
    permissions: {
      replies: {
        blockedUserIds: ["user-1"]
      }
    }
  });

  assert.equal(isUserBlocked(settings, "user-1"), true);
  assert.equal(isUserBlocked(settings, "user-2"), false);
});
