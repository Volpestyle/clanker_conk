import { test } from "bun:test";
import assert from "node:assert/strict";
import { getReplyCoalesceWaitMs } from "./queueGateway.ts";

function buildSettings(replyCoalesceWindowSeconds = 4) {
  return {
    activity: {
      replyCoalesceWindowSeconds
    }
  };
}

test("getReplyCoalesceWaitMs applies edge grace only when enabled", () => {
  const nowMs = 1_000_000;
  const settings = buildSettings(4);
  const message = {
    createdTimestamp: nowMs - 4_050
  };

  const withoutGrace = getReplyCoalesceWaitMs(settings, message, { nowMs });
  assert.equal(withoutGrace, 0);

  const withGrace = getReplyCoalesceWaitMs(settings, message, {
    nowMs,
    allowEdgeGrace: true,
    edgeGraceMs: 250
  });
  assert.equal(withGrace, 200);
});

test("getReplyCoalesceWaitMs still uses normal in-window wait before edge grace", () => {
  const nowMs = 1_000_000;
  const settings = buildSettings(4);
  const message = {
    createdTimestamp: nowMs - 3_500
  };

  const withGraceEnabled = getReplyCoalesceWaitMs(settings, message, {
    nowMs,
    allowEdgeGrace: true,
    edgeGraceMs: 250
  });
  assert.equal(withGraceEnabled, 500);
});

