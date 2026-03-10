import { test } from "bun:test";
import assert from "node:assert/strict";

import { normalizeSettings } from "../store/settingsNormalization.ts";
import { getEligibleInitiativeChannelIds } from "./initiativeEngine.ts";

test("getEligibleInitiativeChannelIds uses the canonical unified reply-channel pool", () => {
  const rawSettings: unknown = {
    permissions: {
      replies: {
        replyChannelIds: ["reply-1"]
      }
    },
    initiative: {
      discovery: {
        channelIds: ["disc-1"]
      }
    }
  };

  const settings = normalizeSettings(rawSettings);

  assert.deepEqual(getEligibleInitiativeChannelIds(settings), ["reply-1", "disc-1"]);
});
