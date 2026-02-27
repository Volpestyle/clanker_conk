import test from "node:test";
import assert from "node:assert/strict";
import { XaiRealtimeClient } from "./voice/xaiRealtimeClient.ts";

test("XaiRealtimeClient requestTextUtterance sends text item then audio response request", () => {
  const client = new XaiRealtimeClient({ apiKey: "test-key" });
  const outbound = [];
  client.send = (payload) => {
    outbound.push(payload);
  };

  client.requestTextUtterance("say this");

  assert.equal(outbound.length, 2);
  assert.equal(outbound[0]?.type, "conversation.item.create");
  assert.equal(outbound[0]?.item?.type, "message");
  assert.equal(outbound[0]?.item?.role, "user");
  assert.equal(outbound[0]?.item?.content?.[0]?.type, "input_text");
  assert.equal(outbound[0]?.item?.content?.[0]?.text, "say this");
  assert.equal(outbound[1]?.type, "response.create");
  assert.deepEqual(outbound[1]?.response?.modalities, ["audio", "text"]);
});
