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
  }
};

function buildMessage(content = "") {
  return {
    content,
    reference: null,
    referencedMessage: null
  };
}

test("reply admission treats exact bot-name token commands as direct address", () => {
  const signal = getReplyAddressSignal(
    BASE_RUNTIME,
    BASE_SETTINGS,
    buildMessage("Clanker go tell the silly boys in vc to go to bed"),
    []
  );

  assert.equal(signal.direct, true);
  assert.equal(signal.triggered, true);
  assert.equal(signal.reason, "name_exact");
});

test("reply admission treats merged bot-name token commands as direct address", () => {
  const signal = getReplyAddressSignal(
    BASE_RUNTIME,
    BASE_SETTINGS,
    buildMessage("clankerconk can you answer this?"),
    []
  );

  assert.equal(signal.direct, true);
  assert.equal(signal.triggered, true);
  assert.equal(signal.reason, "name_exact");
});

test("reply admission text addressing matches shared voice smoke phrase table", () => {
  for (const row of ADDRESSING_SMOKE_CASES) {
    const signal = getReplyAddressSignal(BASE_RUNTIME, BASE_SETTINGS, buildMessage(row.text), []);
    assert.equal(Boolean(signal.triggered), row.expected, row.text);
  }
});

test("reply admission treats command-shaped fuzzy name token as direct admission signal", () => {
  const signal = getReplyAddressSignal(
    BASE_RUNTIME,
    BASE_SETTINGS,
    buildMessage("join vc clink"),
    []
  );

  assert.equal(signal.direct, true);
  assert.equal(signal.triggered, true);
  assert.equal(signal.reason, "name_variant");
});

test("reply admission ignores non-command fuzzy token in generic prose", () => {
  const signal = getReplyAddressSignal(
    BASE_RUNTIME,
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
      reason: "name_variant"
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
