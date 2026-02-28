import { test } from "bun:test";
import assert from "node:assert/strict";
import { ADDRESSING_SMOKE_CASES } from "../addressingSmokeCases.ts";
import {
  getReplyAddressSignal,
  shouldForceRespondForAddressSignal
} from "./replyAdmission.ts";

const BASE_SETTINGS = {
  botName: "clanker conk"
};

const BASE_RUNTIME = {
  botUserId: "bot-1",
  isDirectlyAddressed() {
    return false;
  },
  async scoreDirectAddressConfidence() {
    return {
      confidence: 0,
      addressed: false,
      threshold: 0.62,
      source: "fallback",
      reason: "stub"
    };
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

test("reply admission uses classifier confidence callback for ambiguous addressing", async () => {
  const expectedByText = new Map(
    ADDRESSING_SMOKE_CASES.map((row) => [
      row.text.toLowerCase(),
      row.expected
    ])
  );
  const runtime = {
    ...BASE_RUNTIME,
    async scoreDirectAddressConfidence({ message }) {
      const key = String(message?.content || "").trim().toLowerCase();
      const expected = Boolean(expectedByText.get(key));
      return {
        confidence: expected ? 0.88 : 0.18,
        addressed: expected,
        threshold: 0.62,
        source: "llm",
        reason: expected ? "test_llm_direct" : "test_llm_not_direct"
      };
    }
  };
  for (const row of ADDRESSING_SMOKE_CASES) {
    const signal = await getReplyAddressSignal(runtime, BASE_SETTINGS, buildMessage(row.text), []);
    assert.equal(Boolean(signal.triggered), row.expected, row.text);
  }
});

test("reply admission treats classifier-positive ambiguous token as direct admission signal", async () => {
  const signal = await getReplyAddressSignal(
    {
      ...BASE_RUNTIME,
      async scoreDirectAddressConfidence() {
        return {
          confidence: 0.83,
          addressed: true,
          threshold: 0.62,
          source: "llm",
          reason: "test_llm_direct"
        };
      }
    },
    BASE_SETTINGS,
    buildMessage("join vc clink"),
    []
  );

  assert.equal(signal.direct, true);
  assert.equal(signal.triggered, true);
  assert.equal(signal.reason, "llm_direct_address");
});

test("reply admission ignores classifier-negative ambiguous token in generic prose", async () => {
  const signal = await getReplyAddressSignal(
    {
      ...BASE_RUNTIME,
      async scoreDirectAddressConfidence() {
        return {
          confidence: 0.21,
          addressed: false,
          threshold: 0.62,
          source: "llm",
          reason: "test_llm_not_direct"
        };
      }
    },
    BASE_SETTINGS,
    buildMessage("the cable made a clink sound"),
    []
  );

  assert.equal(signal.direct, false);
  assert.equal(signal.triggered, false);
  assert.equal(signal.reason, "llm_decides");
});

test("reply admission only force-responds for non-fuzzy address signals", () => {
  assert.equal(
    shouldForceRespondForAddressSignal({
      direct: true,
      inferred: true,
      triggered: true,
      reason: "llm_direct_address"
    }),
    false
  );
  assert.equal(
    shouldForceRespondForAddressSignal({
      direct: true,
      inferred: false,
      triggered: true,
      reason: "name_exact"
    }),
    true
  );
});
