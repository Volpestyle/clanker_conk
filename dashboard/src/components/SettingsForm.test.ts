import { test } from "bun:test";
import assert from "node:assert/strict";
import { applyFormDraftUpdate } from "./SettingsForm.tsx";

test("applyFormDraftUpdate preserves the latest draft across consecutive updates", () => {
  const initialDraft = {
    voiceReplyPath: "bridge",
    voiceTtsMode: "realtime"
  };

  const afterReplyPathChange = applyFormDraftUpdate(initialDraft, (draft) => ({
    ...draft,
    voiceReplyPath: "brain"
  }));

  const afterTtsChange = applyFormDraftUpdate(afterReplyPathChange, (draft) => ({
    ...draft,
    voiceTtsMode: "api"
  }));

  assert.equal(afterReplyPathChange.voiceReplyPath, "brain");
  assert.equal(afterTtsChange.voiceReplyPath, "brain");
  assert.equal(afterTtsChange.voiceTtsMode, "api");
});
