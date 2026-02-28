import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  CUSTOM_MODEL_OPTION_VALUE,
  formToSettingsPatch,
  resolvePresetModelSelection,
  resolveProviderModelOptions,
  settingsToForm
} from "./settingsFormModel.ts";

test("settingsFormModel converts settings to form defaults and back to normalized patch", () => {
  const form = settingsToForm({
    botName: "clanker conk",
    persona: {
      flavor: "chaotic but kind",
      hardLimits: ["no hate", "no hate", "keep it fun"]
    },
    llm: {
      provider: "openai",
      model: "gpt-4.1-mini"
    },
    permissions: {
      initiativeChannelIds: ["1", "2"],
      allowedChannelIds: ["2", "3"],
      blockedChannelIds: ["9"],
      blockedUserIds: ["u-1"]
    }
  });

  assert.equal(form.botName, "clanker conk");
  assert.equal(form.personaFlavor, "chaotic but kind");
  assert.equal(form.personaHardLimits, "no hate\nno hate\nkeep it fun");
  assert.equal(form.provider, "openai");
  assert.equal(form.model, "gpt-4.1-mini");
  assert.equal(form.initiativeChannels, "1\n2");
  assert.equal(form.allowedChannels, "2\n3");

  form.personaHardLimits = "no hate\nno hate\nkeep it fun\n";
  form.allowedChannels = "2\n2\n3\n";
  form.initiativeDiscoveryRssFeeds = "https://one.example/feed\nhttps://one.example/feed\n";
  form.initiativeDiscoveryXHandles = "@alice\n@alice\nbob\n";

  const patch = formToSettingsPatch(form);
  assert.deepEqual(patch.persona.hardLimits, ["no hate", "keep it fun"]);
  assert.deepEqual(patch.permissions.allowedChannelIds, ["2", "3"]);
  assert.deepEqual(patch.initiative.discovery.rssFeeds, ["https://one.example/feed"]);
  assert.deepEqual(patch.initiative.discovery.xHandles, ["@alice", "bob"]);
});

test("resolveProviderModelOptions merges catalog values with provider fallback defaults", () => {
  const openai = resolveProviderModelOptions(
    {
      openai: ["gpt-4.1-mini", "gpt-4.1-mini", "gpt-5.2"]
    },
    "openai"
  );
  assert.deepEqual(openai, ["gpt-4.1-mini", "gpt-5.2"]);

  const anthropic = resolveProviderModelOptions(
    {
      anthropic: []
    },
    "anthropic"
  );
  assert.deepEqual(anthropic, ["claude-haiku-4-5"]);
});

test("resolvePresetModelSelection enforces claude-code preset behavior", () => {
  const nonClaude = resolvePresetModelSelection({
    modelCatalog: {
      openai: ["gpt-4.1-mini"]
    },
    provider: "openai",
    model: "custom-model-not-listed"
  });
  assert.equal(nonClaude.isClaudeCodeProvider, false);
  assert.equal(nonClaude.selectedPresetModel, CUSTOM_MODEL_OPTION_VALUE);

  const claudeCode = resolvePresetModelSelection({
    modelCatalog: {
      "claude-code": ["opus", "sonnet"]
    },
    provider: "claude-code",
    model: "nonexistent"
  });
  assert.equal(claudeCode.isClaudeCodeProvider, true);
  assert.equal(claudeCode.selectedPresetModel, "opus");
});

test("formToSettingsPatch keeps stt pipeline reply decider independent from main text llm", () => {
  const form = settingsToForm({
    llm: {
      provider: "claude-code",
      model: "sonnet"
    },
    voice: {
      mode: "stt_pipeline",
      replyDecisionLlm: {
        provider: "openai",
        model: "gpt-4.1-mini"
      }
    }
  });

  form.voiceReplyDecisionLlmEnabled = false;
  form.voiceReplyDecisionLlmProvider = "openai";
  form.voiceReplyDecisionLlmModel = "gpt-4.1-mini";
  const patch = formToSettingsPatch(form);
  assert.equal(patch.voice.replyDecisionLlm.enabled, false);
  assert.equal(patch.voice.replyDecisionLlm.provider, "openai");
  assert.equal(patch.voice.replyDecisionLlm.model, "gpt-4.1-mini");
});
