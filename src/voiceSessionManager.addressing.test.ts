import test from "node:test";
import assert from "node:assert/strict";
import { VoiceSessionManager } from "./voice/voiceSessionManager.ts";

function createManager(participantCount) {
  const fakeClient = {
    on() {},
    off() {},
    guilds: { cache: new Map() },
    users: { cache: new Map() },
    user: { id: "bot-user" }
  };
  const fakeStore = {
    logAction() {}
  };
  const manager = new VoiceSessionManager({
    client: fakeClient,
    store: fakeStore,
    appConfig: {}
  });
  manager.countHumanVoiceParticipants = () => participantCount;
  return manager;
}

test("focused speaker follow-up allows 1:1 turn without transcript", () => {
  const manager = createManager(2);
  const session = {
    focusedSpeakerUserId: "speaker-1",
    focusedSpeakerExpiresAt: Date.now() + 5_000
  };

  const decision = manager.assessVoiceTurnAddressing({
    session,
    userId: "speaker-1",
    settings: { botName: "clanker conk" },
    transcript: ""
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "focused_speaker_followup_no_transcript");
});

test("focused speaker follow-up still requires transcript in larger groups", () => {
  const manager = createManager(4);
  const session = {
    focusedSpeakerUserId: "speaker-1",
    focusedSpeakerExpiresAt: Date.now() + 5_000
  };

  const decision = manager.assessVoiceTurnAddressing({
    session,
    userId: "speaker-1",
    settings: { botName: "clanker conk" },
    transcript: ""
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "needs_addressing_transcript");
});

test("focus follows active speaker continuity and does not stick after speaker switch", () => {
  const manager = createManager(2);
  const session = {
    focusedSpeakerUserId: "speaker-1",
    focusedSpeakerExpiresAt: Date.now() + 30_000,
    lastHumanTurnUserId: "speaker-2",
    lastHumanTurnAt: Date.now()
  };

  const decision = manager.assessVoiceTurnAddressing({
    session,
    userId: "speaker-1",
    settings: { botName: "clanker conk" },
    transcript: "so what happened then?"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "not_addressed_in_group");
});
