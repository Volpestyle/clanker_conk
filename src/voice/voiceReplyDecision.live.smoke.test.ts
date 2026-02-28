import { test } from "bun:test";
import assert from "node:assert/strict";
import { appConfig } from "../config.ts";
import { LLMService } from "../llm.ts";
import { ADDRESSING_SMOKE_CASES } from "../addressingSmokeCases.ts";
import { parseBooleanFlag } from "../normalization/valueParsers.ts";
import { defaultVoiceReplyDecisionModel, normalizeVoiceReplyDecisionProvider } from "./voiceDecisionRuntime.ts";
import { VoiceSessionManager } from "./voiceSessionManager.ts";

function envFlag(name) {
  return parseBooleanFlag(process.env[name], false);
}

function hasProviderCredentials(provider) {
  if (provider === "anthropic") return Boolean(appConfig.anthropicApiKey);
  if (provider === "xai") return Boolean(appConfig.xaiApiKey);
  if (provider === "claude-code") return true;
  return Boolean(appConfig.openaiApiKey);
}

function smokeTimeoutMs(provider) {
  return provider === "claude-code" ? 60_000 : 30_000;
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

const configuredProvider = normalizeVoiceReplyDecisionProvider(process.env.LIVE_VOICE_DECIDER_PROVIDER || "anthropic");

test("smoke: live voice decision model admits wake-variant turns", { timeout: smokeTimeoutMs(configuredProvider) }, async () => {
  if (!envFlag("RUN_LIVE_VOICE_DECIDER_SMOKE")) return;

  const provider = configuredProvider;
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
      provider: "anthropic",
      model: "claude-sonnet-4-5"
    },
    voice: {
      replyEagerness: 50,
      replyDecisionLlm: {
        provider,
        model,
        maxAttempts: 2,
        reasoningEffort: String(process.env.LIVE_VOICE_DECIDER_REASONING_EFFORT || "minimal").trim().toLowerCase() || "minimal"
      }
    }
  };
  for (const row of ADDRESSING_SMOKE_CASES) {
    const decision = await manager.evaluateVoiceReplyDecision({
      session: {
        guildId: "live-smoke-guild",
        textChannelId: "live-smoke-text",
        voiceChannelId: "live-smoke-voice",
        botTurnOpen: false
      },
      userId: "speaker-1",
      settings,
      transcript: row.text
    });

    assert.equal(
      decision.allow,
      row.expected,
      `Expected ${row.expected ? "YES" : "NO"} for "${row.text}", got reason="${decision.reason}" llmResponse="${String(decision.llmResponse || "")}".`
    );
  }

  const joinGreetingDecision = await manager.evaluateVoiceReplyDecision({
    session: {
      guildId: "live-smoke-guild",
      textChannelId: "live-smoke-text",
      voiceChannelId: "live-smoke-voice",
      botTurnOpen: false,
      startedAt: Date.now() - 5_000
    },
    userId: "speaker-1",
    settings,
    transcript: "hola"
  });

  assert.equal(
    joinGreetingDecision.allow,
    true,
    `Expected YES for join-window greeting "hola", got reason="${joinGreetingDecision.reason}" llmResponse="${String(joinGreetingDecision.llmResponse || "")}".`
  );
});
