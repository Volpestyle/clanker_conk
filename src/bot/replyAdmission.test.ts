import { test } from "bun:test";
import assert from "node:assert/strict";
import { ADDRESSING_SMOKE_CASES } from "../addressingSmokeCases.ts";
import { getReplyAddressSignal } from "./replyAdmission.ts";

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

test("reply admission text addressing matches shared voice smoke phrase table", () => {
  for (const row of ADDRESSING_SMOKE_CASES) {
    const signal = getReplyAddressSignal(BASE_RUNTIME, BASE_SETTINGS, buildMessage(row.text), []);
    assert.equal(Boolean(signal.triggered), row.expected, row.text);
  }
});

