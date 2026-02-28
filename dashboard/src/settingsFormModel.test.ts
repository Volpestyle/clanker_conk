import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  formToSettingsPatch,
  resolveModelOptionsFromText,
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
      model: "claude-haiku-4-5"
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
  assert.equal(form.model, "claude-haiku-4-5");
  assert.equal(form.voiceGenerationLlmProvider, "anthropic");
  assert.equal(form.voiceGenerationLlmModel, "claude-haiku-4-5");
  assert.equal(form.voiceThoughtEngineEnabled, true);
  assert.equal(form.voiceThoughtEngineProvider, "anthropic");
  assert.equal(form.voiceThoughtEngineModel, "claude-haiku-4-5");
  assert.equal(form.voiceThoughtEngineEagerness, 0);
  assert.equal(form.initiativeChannels, "1\n2");
  assert.equal(form.allowedChannels, "2\n3");
  assert.equal(form.voiceRealtimeReplyStrategy, "brain");

  form.personaHardLimits = "no hate\nno hate\nkeep it fun\n";
  form.allowedChannels = "2\n2\n3\n";
  form.initiativeDiscoveryRssFeeds = "https://one.example/feed\nhttps://one.example/feed\n";
  form.initiativeDiscoveryXHandles = "@alice\n@alice\nbob\n";

  const patch = formToSettingsPatch(form);
  assert.deepEqual(patch.persona.hardLimits, ["no hate", "keep it fun"]);
  assert.deepEqual(patch.permissions.allowedChannelIds, ["2", "3"]);
  assert.deepEqual(patch.initiative.discovery.rssFeeds, ["https://one.example/feed"]);
  assert.deepEqual(patch.initiative.discovery.xHandles, ["@alice", "bob"]);
  assert.equal(patch.voice.realtimeReplyStrategy, "brain");
  assert.equal(patch.voice.thoughtEngine.enabled, true);
  assert.equal(patch.voice.thoughtEngine.provider, "anthropic");
  assert.equal(patch.voice.thoughtEngine.model, "claude-haiku-4-5");
  assert.equal(patch.voice.thoughtEngine.eagerness, 0);
});

test("settingsToForm preserves explicit empty prompt overrides", () => {
  const form = settingsToForm({
    prompt: {
      capabilityHonestyLine: "",
      impossibleActionLine: "",
      memoryEnabledLine: "",
      memoryDisabledLine: "",
      skipLine: "",
      textGuidance: [],
      voiceGuidance: [],
      voiceOperationalGuidance: [],
      mediaPromptCraftGuidance: ""
    }
  });

  assert.equal(form.promptCapabilityHonestyLine, "");
  assert.equal(form.promptImpossibleActionLine, "");
  assert.equal(form.promptMemoryEnabledLine, "");
  assert.equal(form.promptMemoryDisabledLine, "");
  assert.equal(form.promptSkipLine, "");
  assert.equal(form.promptTextGuidance, "");
  assert.equal(form.promptVoiceGuidance, "");
  assert.equal(form.promptVoiceOperationalGuidance, "");
  assert.equal(form.promptMediaPromptCraftGuidance, "");
});

test("settingsToForm uses default prompt guidance lists when omitted", () => {
  const form = settingsToForm({});
  assert.equal(form.promptTextGuidance.length > 0, true);
  assert.equal(form.promptVoiceGuidance.length > 0, true);
  assert.equal(form.promptVoiceOperationalGuidance.length > 0, true);
});

test("resolveProviderModelOptions merges catalog values with provider fallback defaults", () => {
  const openai = resolveProviderModelOptions(
    {
      openai: ["claude-haiku-4-5", "claude-haiku-4-5", "gpt-5.2"]
    },
    "openai"
  );
  assert.deepEqual(openai, ["claude-haiku-4-5", "gpt-5.2"]);

  const anthropic = resolveProviderModelOptions(
    {
      anthropic: []
    },
    "anthropic"
  );
  assert.deepEqual(anthropic, ["claude-haiku-4-5"]);
});

test("resolvePresetModelSelection always resolves to a real dropdown option", () => {
  const nonClaude = resolvePresetModelSelection({
    modelCatalog: {
      openai: ["claude-haiku-4-5"]
    },
    provider: "openai",
    model: "custom-model-not-listed"
  });
  assert.equal(nonClaude.selectedPresetModel, "claude-haiku-4-5");

  const claudeCode = resolvePresetModelSelection({
    modelCatalog: {
      "claude-code": ["opus", "sonnet"]
    },
    provider: "claude-code",
    model: "nonexistent"
  });
  assert.equal(claudeCode.selectedPresetModel, "opus");
});

test("resolveModelOptionsFromText normalizes model lists for dropdown options", () => {
  const options = resolveModelOptionsFromText(
    "gpt-image-1.5\ngpt-image-1.5\n",
    "grok-imagine-image",
    ["", "grok-imagine-image"]
  );
  assert.deepEqual(options, ["gpt-image-1.5", "grok-imagine-image"]);
});

test("formToSettingsPatch keeps stt pipeline voice generation and reply decider independent from main text llm", () => {
  const form = settingsToForm({
    llm: {
      provider: "claude-code",
      model: "sonnet"
    },
    voice: {
      mode: "stt_pipeline",
      generationLlm: {
        provider: "anthropic",
        model: "claude-haiku-4-5"
      },
      replyDecisionLlm: {
        provider: "openai",
        model: "claude-haiku-4-5"
      }
    }
  });

  form.voiceGenerationLlmProvider = "anthropic";
  form.voiceGenerationLlmModel = "claude-haiku-4-5";
  form.voiceReplyDecisionLlmEnabled = false;
  form.voiceReplyDecisionLlmProvider = "openai";
  form.voiceReplyDecisionLlmModel = "claude-haiku-4-5";
  form.voiceReplyDecisionWakeVariantHint = "wake hint {{botName}}";
  form.voiceReplyDecisionSystemPromptCompact = "compact {{botName}}";
  form.voiceReplyDecisionSystemPromptFull = "full {{botName}}";
  form.voiceReplyDecisionSystemPromptStrict = "strict {{botName}}";
  const patch = formToSettingsPatch(form);
  assert.equal(patch.voice.generationLlm.provider, "anthropic");
  assert.equal(patch.voice.generationLlm.model, "claude-haiku-4-5");
  assert.equal(patch.voice.replyDecisionLlm.enabled, false);
  assert.equal(patch.voice.replyDecisionLlm.provider, "openai");
  assert.equal(patch.voice.replyDecisionLlm.model, "claude-haiku-4-5");
  assert.equal(patch.voice.replyDecisionLlm.prompts.wakeVariantHint, "wake hint {{botName}}");
  assert.equal(patch.voice.replyDecisionLlm.prompts.systemPromptCompact, "compact {{botName}}");
  assert.equal(patch.voice.replyDecisionLlm.prompts.systemPromptFull, "full {{botName}}");
  assert.equal(patch.voice.replyDecisionLlm.prompts.systemPromptStrict, "strict {{botName}}");
});

test("settingsFormModel round-trips realtime reply strategy", () => {
  const form = settingsToForm({
    voice: {
      mode: "openai_realtime",
      realtimeReplyStrategy: "native"
    }
  });

  assert.equal(form.voiceRealtimeReplyStrategy, "native");
  const patch = formToSettingsPatch(form);
  assert.equal(patch.voice.realtimeReplyStrategy, "native");
});
