import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildVoiceTurnPrompt } from "./index.ts";

test("buildVoiceTurnPrompt treats event cues as room context", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    inputKind: "event",
    transcript: "[alice joined the voice channel]"
  });

  assert.equal(
    prompt.includes(
      "This is a voice-room event cue, not literal quoted speech."
    ),
    true
  );
  assert.equal(
    prompt.includes(
      "If a brief acknowledgement of the join/leave would feel natural, you may reply briefly. Otherwise use [SKIP]."
    ),
    true
  );
});

test("buildVoiceTurnPrompt biases low-information eager turns toward skip", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "haha",
    isEagerTurn: true,
    voiceEagerness: 50
  });

  assert.equal(
    prompt.includes(
      "If the turn is only laughter, filler, or backchannel noise (for example haha, lol, hmm, mm, uh-huh, yup), strongly prefer [SKIP] unless there is a clear question, request, or obvious conversational value in replying."
    ),
    true
  );
});

test("buildVoiceTurnPrompt treats fuzzy bot-name cues as a positive signal", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "hey clanker play some music",
    botName: "clanker conk",
    directAddressed: false
  });

  assert.equal(
    prompt.includes(
      "The transcript may be using clanker conk's name or a phonetic variation of it. Treat that as a positive signal that the speaker may be talking to you."
    ),
    true
  );
  assert.equal(
    prompt.includes(
      "The transcript may contain your name or a phonetic variant of it. Treat that as a positive signal that the speaker may be talking to you."
    ),
    true
  );
});
