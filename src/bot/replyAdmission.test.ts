import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  getReplyAddressSignal,
  shouldAttemptReplyDecision
} from "./replyAdmission.ts";
import { createTestSettings } from "../testSettings.ts";

const BASE_SETTINGS = createTestSettings({
  identity: {
    botName: "clanker conk",
    botNameAliases: ["clank"]
  }
});

const BASE_RUNTIME = {
  botUserId: "bot-1",
  isDirectlyAddressed() {
    return false;
  }
};

function buildMessage(content = "") {
  return {
    content,
    reference: null,
    referencedMessage: null
  };
}

test("reply admission treats exact bot-name token commands as direct address", async () => {
  const signal = await getReplyAddressSignal(
    BASE_RUNTIME,
    BASE_SETTINGS,
    buildMessage("Clanker go tell the silly boys in vc to go to bed"),
    []
  );

  assert.equal(signal.direct, true);
  assert.equal(signal.triggered, true);
  assert.equal(signal.reason, "name_exact");
});

test("reply admission treats merged bot-name token commands as direct address", async () => {
  const signal = await getReplyAddressSignal(
    BASE_RUNTIME,
    BASE_SETTINGS,
    buildMessage("clankerconk can you answer this?"),
    []
  );

  assert.equal(signal.direct, true);
  assert.equal(signal.triggered, true);
  assert.equal(signal.reason, "name_exact");
});

test("reply admission treats configured alias commands as direct address", async () => {
  const signal = await getReplyAddressSignal(
    BASE_RUNTIME,
    BASE_SETTINGS,
    buildMessage("clank join vc"),
    []
  );

  assert.equal(signal.direct, true);
  assert.equal(signal.triggered, true);
  assert.equal(signal.reason, "name_alias");
});

test("reply admission ignores ambiguous soundalike tokens in generic prose", async () => {
  const signal = await getReplyAddressSignal(
    BASE_RUNTIME,
    BASE_SETTINGS,
    buildMessage("the cable made a clink sound"),
    []
  );

  assert.equal(signal.direct, false);
  assert.equal(signal.triggered, false);
  assert.equal(signal.reason, "llm_decides");
});

test("reply admission forceDecisionLoop bypasses unsolicited gating", () => {
  const shouldRun = shouldAttemptReplyDecision({
    botUserId: "bot-1",
    settings: {
      permissions: {
        allowUnsolicitedReplies: false
      }
    },
    recentMessages: [],
    addressSignal: {
      direct: false,
      inferred: false,
      triggered: false,
      reason: "llm_decides"
    },
    forceDecisionLoop: true,
    triggerMessageId: "msg-1"
  });

  assert.equal(shouldRun, true);
});

test("reply admission unsolicited turns require followup window when not directly addressed", () => {
  const settings = {
    permissions: {
      allowUnsolicitedReplies: true
    },
    interaction: {
      activity: {
        ambientReplyEagerness: 10,
        responseWindowEagerness: 60
      }
    }
  };

  const withoutWindow = shouldAttemptReplyDecision({
    botUserId: "bot-1",
    settings,
    recentMessages: [],
    addressSignal: {
      direct: false,
      inferred: false,
      triggered: false,
      reason: "llm_decides"
    },
    triggerMessageId: "msg-1"
  });
  assert.equal(withoutWindow, false);

  const withWindow = shouldAttemptReplyDecision({
    botUserId: "bot-1",
    settings,
    recentMessages: [
      {
        message_id: "bot-ctx-1",
        author_id: "bot-1"
      }
    ],
    addressSignal: {
      direct: false,
      inferred: false,
      triggered: false,
      reason: "llm_decides"
    },
    triggerMessageId: "msg-1"
  });
  assert.equal(withWindow, true);
});

test("reply admission disables recent-window followups when response-window eagerness is zero", () => {
  const noAddress = {
    direct: false,
    inferred: false,
    triggered: false,
    reason: "llm_decides"
  };

  assert.equal(
    shouldAttemptReplyDecision({
      botUserId: "bot-1",
      settings: {
        permissions: {
          allowUnsolicitedReplies: true
        },
        interaction: {
          activity: {
            ambientReplyEagerness: 10,
            responseWindowEagerness: 0
          }
        }
      },
      recentMessages: [
        {
          message_id: "bot-ctx-1",
          author_id: "bot-1"
        }
      ],
      addressSignal: noAddress,
      triggerMessageId: "msg-1"
    }),
    false
  );
});

test("reply admission admits at high eagerness even without recent window", () => {
  const highEagernessSettings = {
    permissions: { allowUnsolicitedReplies: true },
    interaction: { activity: { ambientReplyEagerness: 80 } }
  };
  const lowEagernessSettings = {
    permissions: { allowUnsolicitedReplies: true },
    interaction: { activity: { ambientReplyEagerness: 50 } }
  };
  const noAddress = {
    direct: false,
    inferred: false,
    triggered: false,
    reason: "llm_decides"
  };

  // High eagerness: admitted even without bot in recent window
  assert.equal(
    shouldAttemptReplyDecision({
      botUserId: "bot-1",
      settings: highEagernessSettings,
      recentMessages: [],
      addressSignal: noAddress,
      triggerMessageId: "msg-1"
    }),
    true
  );

  // Low eagerness: blocked without recent window (model not consulted)
  assert.equal(
    shouldAttemptReplyDecision({
      botUserId: "bot-1",
      settings: lowEagernessSettings,
      recentMessages: [],
      addressSignal: noAddress,
      triggerMessageId: "msg-1"
    }),
    false
  );
});

test("reply admission uses response-window eagerness separately from ambient eagerness", () => {
  const noAddress = {
    direct: false,
    inferred: false,
    triggered: false,
    reason: "llm_decides"
  };
  const settings = {
    permissions: { allowUnsolicitedReplies: true },
    interaction: {
      activity: {
        ambientReplyEagerness: 10,
        responseWindowEagerness: 80
      }
    }
  };

  assert.equal(
    shouldAttemptReplyDecision({
      botUserId: "bot-1",
      settings,
      recentMessages: [
        { message_id: "older-1", author_id: "someone-else" },
        { message_id: "older-2", author_id: "someone-else" },
        { message_id: "older-3", author_id: "someone-else" },
        { message_id: "bot-ctx", author_id: "bot-1" }
      ],
      addressSignal: noAddress,
      triggerMessageId: "msg-1"
    }),
    true
  );
});
