import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createVoiceTestManager,
  createVoiceTestSettings
} from "./voiceTestHarness.ts";

function buildInterruptedMusicSession(interruptedByUserId: string) {
  const interruptedAt = Date.now() - 500;
  return {
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    mode: "openai_realtime",
    botTurnOpen: false,
    lastAssistantReplyAt: interruptedAt - 100,
    musicWakeLatchedUntil: 0,
    musicWakeLatchedByUserId: null,
    interruptedAssistantReply: {
      utteranceText: "still talking about minecraft",
      interruptedByUserId,
      interruptedAt,
      source: "test_interrupt"
    },
    music: {
      phase: "playing",
      active: true,
      ducked: false
    }
  };
}

test("reply decider admits interrupted same-speaker follow-up during active music even when wake latch is closed", async () => {
  const manager = createVoiceTestManager();
  const decision = await manager.evaluateVoiceReplyDecision({
    session: buildInterruptedMusicSession("speaker-1"),
    userId: "speaker-1",
    settings: createVoiceTestSettings({
      voice: {
        conversationPolicy: {
          ambientReplyEagerness: 60,
          replyPath: "brain"
        },
        admission: {
          mode: "generation_decides"
        }
      }
    }),
    transcript: "do you play tic-tac-toe aria?"
  });

  assert.equal(decision.allow, true);
  assert.equal(decision.reason, "interrupted_reply_followup");
  assert.equal(Boolean(decision.conversationContext?.interruptedAssistantReply?.utteranceText), true);
  assert.equal(Boolean(decision.conversationContext?.musicWakeLatched), false);
});

test("reply decider keeps interrupted-reply music follow-up scoped to the interrupter", async () => {
  const manager = createVoiceTestManager();
  const decision = await manager.evaluateVoiceReplyDecision({
    session: buildInterruptedMusicSession("speaker-1"),
    userId: "speaker-2",
    settings: createVoiceTestSettings({
      voice: {
        conversationPolicy: {
          ambientReplyEagerness: 60,
          replyPath: "brain"
        },
        admission: {
          mode: "generation_decides"
        }
      }
    }),
    transcript: "do you play tic-tac-toe aria?"
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "music_playing_not_awake");
});
