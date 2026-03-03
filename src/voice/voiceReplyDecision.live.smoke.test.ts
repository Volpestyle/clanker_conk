import { test } from "bun:test";
import assert from "node:assert/strict";
import { ADDRESSING_SMOKE_CASES } from "../addressingSmokeCases.ts";
import { VoiceSessionManager } from "./voiceSessionManager.ts";

function createManager() {
  const fakeStore = {
    logAction() {},
    getSettings() {
      return {
        botName: "clanker conk"
      };
    }
  };
  const manager = new VoiceSessionManager({
    client: {
      on() {},
      off() {},
      guilds: { cache: new Map() },
      users: { cache: new Map() },
      user: { id: "bot-user", username: "clanker conk" }
    },
    store: fakeStore,
    appConfig: {},
    llm: {
      generate: async () => ({ text: "NO" })
    },
    memory: null
  });
  manager.countHumanVoiceParticipants = () => 2;
  manager.getVoiceChannelParticipants = () => [{ displayName: "speaker-1" }, { displayName: "speaker-2" }];
  return manager;
}

test("smoke: voice decision routes wake-word turns via direct_address_fast_path", async () => {
  const manager = createManager();

  const settings = {
    botName: "clanker conk",
    memory: { enabled: false },
    llm: { provider: "openai", model: "claude-haiku-4-5" },
    voice: {
      replyEagerness: 50,
      replyDecisionLlm: { provider: "anthropic", model: "claude-haiku-4-5" }
    }
  };

  const wakeWordCases = ADDRESSING_SMOKE_CASES.filter((row) => row.expected === true);
  for (const row of wakeWordCases) {
    const decision = await manager.evaluateVoiceReplyDecision({
      session: {
        guildId: "smoke-guild",
        textChannelId: "smoke-text",
        voiceChannelId: "smoke-voice",
        botTurnOpen: false,
        mode: "stt_pipeline"
      },
      userId: "speaker-1",
      settings,
      transcript: row.text
    });

    assert.equal(
      decision.allow,
      true,
      `Expected allow=true for "${row.text}", got reason="${decision.reason}".`
    );
    assert.ok(
      ["direct_address_fast_path", "brain_decides"].includes(decision.reason),
      `Expected direct_address_fast_path or brain_decides for "${row.text}", got "${decision.reason}".`
    );
  }
});

test("smoke: voice decision forwards non-addressed turns to brain in stt_pipeline mode", async () => {
  const manager = createManager();

  const settings = {
    botName: "clanker conk",
    memory: { enabled: false },
    llm: { provider: "openai", model: "claude-haiku-4-5" },
    voice: {
      replyEagerness: 50,
      replyDecisionLlm: { provider: "anthropic", model: "claude-haiku-4-5" }
    }
  };

  const nonAddressedCases = ADDRESSING_SMOKE_CASES.filter((row) => row.expected === false);
  for (const row of nonAddressedCases) {
    const decision = await manager.evaluateVoiceReplyDecision({
      session: {
        guildId: "smoke-guild",
        textChannelId: "smoke-text",
        voiceChannelId: "smoke-voice",
        botTurnOpen: false,
        mode: "stt_pipeline"
      },
      userId: "speaker-1",
      settings,
      transcript: row.text
    });

    assert.equal(
      decision.allow,
      true,
      `Expected allow=true (brain_decides) for "${row.text}", got reason="${decision.reason}".`
    );
    assert.equal(decision.reason, "brain_decides");
  }
});
