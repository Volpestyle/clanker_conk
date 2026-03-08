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
      "If the turn is laughter, filler, backchannel noise (haha, lol, hmm, mm, uh-huh, yup), or self-talk/thinking out loud"
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
      "The transcript contains your name or a phonetic variant of it. This is a strong signal the speaker is talking to you"
    ),
    true
  );
});
