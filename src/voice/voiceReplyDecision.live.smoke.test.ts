import { test } from "bun:test";
import assert from "node:assert/strict";
import { appConfig } from "../config.ts";
import { LLMService } from "../llm.ts";
import { defaultVoiceReplyDecisionModel, normalizeVoiceReplyDecisionProvider } from "./voiceDecisionRuntime.ts";
import { VoiceSessionManager } from "./voiceSessionManager.ts";

function envFlag(name) {
  const normalized = String(process.env[name] || "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function hasProviderCredentials(provider) {
  if (provider === "anthropic") return Boolean(appConfig.anthropicApiKey);
  if (provider === "xai") return Boolean(appConfig.xaiApiKey);
  if (provider === "claude-code") return true;
  return Boolean(appConfig.openaiApiKey);
}

function createManager(llm) {
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
    appConfig,
    llm,
    memory: null
  });
  manager.countHumanVoiceParticipants = () => 2;
  manager.getVoiceChannelParticipants = () => [{ displayName: "speaker-1" }, { displayName: "speaker-2" }];
  return manager;
}

test("smoke: live voice decision model admits wake-variant turns", { timeout: 30_000 }, async () => {
  if (!envFlag("RUN_LIVE_VOICE_DECIDER_SMOKE")) return;

  const provider = normalizeVoiceReplyDecisionProvider(process.env.LIVE_VOICE_DECIDER_PROVIDER || "anthropic");
  const model =
    String(process.env.LIVE_VOICE_DECIDER_MODEL || defaultVoiceReplyDecisionModel(provider)).trim() ||
    defaultVoiceReplyDecisionModel(provider);

  assert.equal(
    hasProviderCredentials(provider),
    true,
    `Missing API credentials for live voice decider provider "${provider}".`
  );

  const manager = createManager(
    new LLMService({
      appConfig,
      store: {
        logAction() {}
      }
    })
  );

  const settings = {
    botName: "clanker conk",
    memory: {
      enabled: false
    },
    llm: {
      provider: "openai",
      model: "gpt-4.1-mini"
    },
    voice: {
      replyEagerness: 50,
      replyDecisionLlm: {
        provider,
        model,
        maxAttempts: 2
      }
    }
  };
  const cases = [
    { transcript: "Yo, what's up, Clink?", expected: true },
    { transcript: "yo plink", expected: true },
    { transcript: "hi clunky", expected: true },
    { transcript: "is that u clank?", expected: true },
    { transcript: "is that you clinker?", expected: true },
    { transcript: "did i just hear a clanka?", expected: true },
    { transcript: "I love the clankers of the world", expected: true },
    { transcript: "i pulled a prank on him!", expected: false },
    { transcript: "pranked ya", expected: false },
    { transcript: "get pranked", expected: false },
    { transcript: "get stanked", expected: false },
    { transcript: "its stinky in here", expected: false }
  ];

  for (const row of cases) {
    const decision = await manager.evaluateVoiceReplyDecision({
      session: {
        guildId: "live-smoke-guild",
        textChannelId: "live-smoke-text",
        voiceChannelId: "live-smoke-voice",
        botTurnOpen: false
      },
      userId: "speaker-1",
      settings,
      transcript: row.transcript
    });

    assert.equal(
      decision.allow,
      row.expected,
      `Expected ${row.expected ? "YES" : "NO"} for "${row.transcript}", got reason="${decision.reason}" llmResponse="${String(decision.llmResponse || "")}".`
    );
  }
});
