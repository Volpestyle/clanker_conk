import { useState, useEffect } from "react";

function parseList(val) {
  return [...new Set(String(val || "").split(/[\n,]/g).map((x) => x.trim()).filter(Boolean))];
}

function parseLineList(val) {
  return [...new Set(String(val || "").split(/\n/g).map((x) => x.trim()).filter(Boolean))];
}

function formatList(items) {
  return (items || []).join("\n");
}

function parseMappingList(val) {
  const lines = String(val || "")
    .split(/\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  const out = {};
  for (const line of lines) {
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();
    if (!key || !value) continue;
    out[key] = value;
  }
  return out;
}

function formatMappingList(map) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return "";
  return Object.entries(map)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export default function SettingsForm({ settings, onSave, toast }) {
  const [form, setForm] = useState(null);

  useEffect(() => {
    if (!settings) return;
    const activity = settings.activity || {};
    setForm((current) => ({
      ...(current || {}),
      botName: settings.botName || "clanker conk",
      personaFlavor:
        settings.persona?.flavor || "playful, chaotic-good, slangy Gen Z/Gen A energy without being toxic",
      personaHardLimits: formatList(settings.persona?.hardLimits),
      replyLevel: activity.replyLevel ?? 35,
      reactionLevel: activity.reactionLevel ?? 20,
      minGap: activity.minSecondsBetweenMessages ?? 20,
      allowReplies: settings.permissions?.allowReplies ?? true,
      allowInitiative: settings.permissions?.allowInitiativeReplies !== false,
      allowReactions: settings.permissions?.allowReactions ?? true,
      memoryEnabled: settings.memory?.enabled ?? true,
      provider: settings.llm?.provider ?? "openai",
      model: settings.llm?.model ?? "gpt-4.1-mini",
      temperature: settings.llm?.temperature ?? 0.9,
      maxTokens: settings.llm?.maxOutputTokens ?? 220,
      webSearchEnabled: settings.webSearch?.enabled ?? false,
      webSearchSafeMode: settings.webSearch?.safeSearch ?? true,
      webSearchPerHour: settings.webSearch?.maxSearchesPerHour ?? 12,
      webSearchMaxResults: settings.webSearch?.maxResults ?? 5,
      webSearchMaxPages: settings.webSearch?.maxPagesToRead ?? 3,
      webSearchMaxChars: settings.webSearch?.maxCharsPerPage ?? 1400,
      webSearchProviderOrder: (settings.webSearch?.providerOrder || ["brave", "serpapi"]).join(","),
      webSearchRecencyDaysDefault: settings.webSearch?.recencyDaysDefault ?? 30,
      webSearchMaxConcurrentFetches: settings.webSearch?.maxConcurrentFetches ?? 5,
      videoContextEnabled: settings.videoContext?.enabled ?? true,
      videoContextPerHour: settings.videoContext?.maxLookupsPerHour ?? 12,
      videoContextMaxVideos: settings.videoContext?.maxVideosPerMessage ?? 2,
      videoContextMaxChars: settings.videoContext?.maxTranscriptChars ?? 1200,
      videoContextKeyframeInterval: settings.videoContext?.keyframeIntervalSeconds ?? 8,
      videoContextMaxKeyframes: settings.videoContext?.maxKeyframesPerVideo ?? 3,
      videoContextAsrFallback: settings.videoContext?.allowAsrFallback ?? false,
      videoContextMaxAsrSeconds: settings.videoContext?.maxAsrSeconds ?? 120,
      voiceEnabled: settings.voice?.enabled ?? false,
      voiceJoinOnTextNL: settings.voice?.joinOnTextNL ?? true,
      voiceRequireDirectMention: settings.voice?.requireDirectMentionForJoin ?? true,
      voiceIntentConfidenceThreshold: settings.voice?.intentConfidenceThreshold ?? 0.75,
      voiceMaxSessionMinutes: settings.voice?.maxSessionMinutes ?? 10,
      voiceInactivityLeaveSeconds: settings.voice?.inactivityLeaveSeconds ?? 90,
      voiceMaxSessionsPerDay: settings.voice?.maxSessionsPerDay ?? 12,
      voiceAllowedChannelIds: formatList(settings.voice?.allowedVoiceChannelIds),
      voiceBlockedChannelIds: formatList(settings.voice?.blockedVoiceChannelIds),
      voiceBlockedUserIds: formatList(settings.voice?.blockedVoiceUserIds),
      voiceXaiVoice: settings.voice?.xai?.voice ?? "Rex",
      voiceXaiAudioFormat: settings.voice?.xai?.audioFormat ?? "audio/pcm",
      voiceXaiSampleRateHz: settings.voice?.xai?.sampleRateHz ?? 24000,
      voiceXaiRegion: settings.voice?.xai?.region ?? "us-east-1",
      voiceSoundboardEnabled: settings.voice?.soundboard?.enabled ?? true,
      voiceSoundboardAllowExternalSounds: settings.voice?.soundboard?.allowExternalSounds ?? false,
      voiceSoundboardPreferredSoundIds: formatList(settings.voice?.soundboard?.preferredSoundIds),
      voiceSoundboardMappings: formatMappingList(settings.voice?.soundboard?.mappings),
      maxMessages: settings.permissions?.maxMessagesPerHour ?? 20,
      maxReactions: settings.permissions?.maxReactionsPerHour ?? 24,
      catchupEnabled: settings.startup?.catchupEnabled !== false,
      catchupLookbackHours: settings.startup?.catchupLookbackHours ?? 6,
      catchupMaxMessages: settings.startup?.catchupMaxMessagesPerChannel ?? 20,
      catchupMaxReplies: settings.startup?.maxCatchupRepliesPerChannel ?? 2,
      autonomousInitiativeEnabled: settings.initiative?.enabled ?? false,
      initiativePostsPerDay: settings.initiative?.maxPostsPerDay ?? 6,
      initiativeMinMinutes: settings.initiative?.minMinutesBetweenPosts ?? 120,
      initiativePacingMode: settings.initiative?.pacingMode === "spontaneous" ? "spontaneous" : "even",
      initiativeSpontaneity: settings.initiative?.spontaneity ?? 65,
      initiativeStartupPost: settings.initiative?.postOnStartup ?? false,
      initiativeImageEnabled: settings.initiative?.allowImagePosts ?? false,
      initiativeVideoEnabled: settings.initiative?.allowVideoPosts ?? false,
      replyImageEnabled: settings.initiative?.allowReplyImages ?? false,
      replyVideoEnabled: settings.initiative?.allowReplyVideos ?? false,
      replyGifEnabled: settings.initiative?.allowReplyGifs ?? false,
      maxImagesPerDay: settings.initiative?.maxImagesPerDay ?? 10,
      maxVideosPerDay: settings.initiative?.maxVideosPerDay ?? 6,
      maxGifsPerDay: settings.initiative?.maxGifsPerDay ?? 30,
      initiativeSimpleImageModel: settings.initiative?.simpleImageModel ?? "gpt-image-1.5",
      initiativeComplexImageModel: settings.initiative?.complexImageModel ?? "grok-imagine-image",
      initiativeVideoModel: settings.initiative?.videoModel ?? "grok-imagine-video",
      initiativeAllowedImageModels: formatList(settings.initiative?.allowedImageModels ?? []),
      initiativeAllowedVideoModels: formatList(settings.initiative?.allowedVideoModels ?? []),
      initiativeDiscoveryEnabled: settings.initiative?.discovery?.enabled ?? true,
      initiativeDiscoveryLinkChance: settings.initiative?.discovery?.linkChancePercent ?? 80,
      initiativeDiscoveryMaxLinks: settings.initiative?.discovery?.maxLinksPerPost ?? 2,
      initiativeDiscoveryMaxCandidates: settings.initiative?.discovery?.maxCandidatesForPrompt ?? 6,
      initiativeDiscoveryFreshnessHours: settings.initiative?.discovery?.freshnessHours ?? 96,
      initiativeDiscoveryDedupeHours: settings.initiative?.discovery?.dedupeHours ?? 168,
      initiativeDiscoveryRandomness: settings.initiative?.discovery?.randomness ?? 55,
      initiativeDiscoveryFetchLimit: settings.initiative?.discovery?.sourceFetchLimit ?? 10,
      initiativeDiscoveryAllowNsfw: settings.initiative?.discovery?.allowNsfw ?? false,
      initiativeDiscoverySourceReddit: settings.initiative?.discovery?.sources?.reddit ?? true,
      initiativeDiscoverySourceHackerNews: settings.initiative?.discovery?.sources?.hackerNews ?? true,
      initiativeDiscoverySourceYoutube: settings.initiative?.discovery?.sources?.youtube ?? true,
      initiativeDiscoverySourceRss: settings.initiative?.discovery?.sources?.rss ?? true,
      initiativeDiscoverySourceX: settings.initiative?.discovery?.sources?.x ?? false,
      initiativeDiscoveryPreferredTopics: formatList(settings.initiative?.discovery?.preferredTopics),
      initiativeDiscoveryRedditSubs: formatList(settings.initiative?.discovery?.redditSubreddits),
      initiativeDiscoveryYoutubeChannels: formatList(settings.initiative?.discovery?.youtubeChannelIds),
      initiativeDiscoveryRssFeeds: formatList(settings.initiative?.discovery?.rssFeeds),
      initiativeDiscoveryXHandles: formatList(settings.initiative?.discovery?.xHandles),
      initiativeDiscoveryXNitterBase:
        settings.initiative?.discovery?.xNitterBaseUrl ?? "https://nitter.net",
      initiativeChannels: formatList(settings.permissions?.initiativeChannelIds),
      allowedChannels: formatList(settings.permissions?.allowedChannelIds),
      blockedChannels: formatList(settings.permissions?.blockedChannelIds),
      blockedUsers: formatList(settings.permissions?.blockedUserIds)
    }));
  }, [settings]);

  if (!form) return null;

  function set(key) {
    return (e) => setForm((f) => ({ ...f, [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  }

  function submit(e) {
    e.preventDefault();
    onSave({
      botName: form.botName.trim(),
      persona: {
        flavor: form.personaFlavor.trim(),
        hardLimits: parseLineList(form.personaHardLimits)
      },
      activity: {
        replyLevel: Number(form.replyLevel),
        reactionLevel: Number(form.reactionLevel),
        minSecondsBetweenMessages: Number(form.minGap)
      },
      llm: {
        provider: form.provider,
        model: form.model.trim(),
        temperature: Number(form.temperature),
        maxOutputTokens: Number(form.maxTokens)
      },
      webSearch: {
        enabled: form.webSearchEnabled,
        maxSearchesPerHour: Number(form.webSearchPerHour),
        maxResults: Number(form.webSearchMaxResults),
        maxPagesToRead: Number(form.webSearchMaxPages),
        maxCharsPerPage: Number(form.webSearchMaxChars),
        safeSearch: form.webSearchSafeMode,
        providerOrder: parseList(form.webSearchProviderOrder),
        recencyDaysDefault: Number(form.webSearchRecencyDaysDefault),
        maxConcurrentFetches: Number(form.webSearchMaxConcurrentFetches)
      },
      videoContext: {
        enabled: form.videoContextEnabled,
        maxLookupsPerHour: Number(form.videoContextPerHour),
        maxVideosPerMessage: Number(form.videoContextMaxVideos),
        maxTranscriptChars: Number(form.videoContextMaxChars),
        keyframeIntervalSeconds: Number(form.videoContextKeyframeInterval),
        maxKeyframesPerVideo: Number(form.videoContextMaxKeyframes),
        allowAsrFallback: form.videoContextAsrFallback,
        maxAsrSeconds: Number(form.videoContextMaxAsrSeconds)
      },
      voice: {
        enabled: form.voiceEnabled,
        joinOnTextNL: form.voiceJoinOnTextNL,
        requireDirectMentionForJoin: form.voiceRequireDirectMention,
        intentConfidenceThreshold: Number(form.voiceIntentConfidenceThreshold),
        maxSessionMinutes: Number(form.voiceMaxSessionMinutes),
        inactivityLeaveSeconds: Number(form.voiceInactivityLeaveSeconds),
        maxSessionsPerDay: Number(form.voiceMaxSessionsPerDay),
        allowedVoiceChannelIds: parseList(form.voiceAllowedChannelIds),
        blockedVoiceChannelIds: parseList(form.voiceBlockedChannelIds),
        blockedVoiceUserIds: parseList(form.voiceBlockedUserIds),
        xai: {
          voice: String(form.voiceXaiVoice || "").trim(),
          audioFormat: String(form.voiceXaiAudioFormat || "").trim(),
          sampleRateHz: Number(form.voiceXaiSampleRateHz),
          region: String(form.voiceXaiRegion || "").trim()
        },
        soundboard: {
          enabled: form.voiceSoundboardEnabled,
          allowExternalSounds: form.voiceSoundboardAllowExternalSounds,
          preferredSoundIds: parseList(form.voiceSoundboardPreferredSoundIds),
          mappings: parseMappingList(form.voiceSoundboardMappings)
        }
      },
      startup: {
        catchupEnabled: form.catchupEnabled,
        catchupLookbackHours: Number(form.catchupLookbackHours),
        catchupMaxMessagesPerChannel: Number(form.catchupMaxMessages),
        maxCatchupRepliesPerChannel: Number(form.catchupMaxReplies)
      },
      permissions: {
        allowReplies: form.allowReplies,
        allowInitiativeReplies: form.allowInitiative,
        allowReactions: form.allowReactions,
        initiativeChannelIds: parseList(form.initiativeChannels),
        allowedChannelIds: parseList(form.allowedChannels),
        blockedChannelIds: parseList(form.blockedChannels),
        blockedUserIds: parseList(form.blockedUsers),
        maxMessagesPerHour: Number(form.maxMessages),
        maxReactionsPerHour: Number(form.maxReactions)
      },
      initiative: {
        enabled: form.autonomousInitiativeEnabled,
        maxPostsPerDay: Number(form.initiativePostsPerDay),
        minMinutesBetweenPosts: Number(form.initiativeMinMinutes),
        pacingMode: form.initiativePacingMode,
        spontaneity: Number(form.initiativeSpontaneity),
        postOnStartup: form.initiativeStartupPost,
        allowImagePosts: form.initiativeImageEnabled,
        allowVideoPosts: form.initiativeVideoEnabled,
        allowReplyImages: form.replyImageEnabled,
        allowReplyVideos: form.replyVideoEnabled,
        allowReplyGifs: form.replyGifEnabled,
        maxImagesPerDay: Number(form.maxImagesPerDay),
        maxVideosPerDay: Number(form.maxVideosPerDay),
        maxGifsPerDay: Number(form.maxGifsPerDay),
        simpleImageModel: form.initiativeSimpleImageModel.trim(),
        complexImageModel: form.initiativeComplexImageModel.trim(),
        videoModel: form.initiativeVideoModel.trim(),
        allowedImageModels: parseList(form.initiativeAllowedImageModels),
        allowedVideoModels: parseList(form.initiativeAllowedVideoModels),
        discovery: {
          enabled: form.initiativeDiscoveryEnabled,
          linkChancePercent: Number(form.initiativeDiscoveryLinkChance),
          maxLinksPerPost: Number(form.initiativeDiscoveryMaxLinks),
          maxCandidatesForPrompt: Number(form.initiativeDiscoveryMaxCandidates),
          freshnessHours: Number(form.initiativeDiscoveryFreshnessHours),
          dedupeHours: Number(form.initiativeDiscoveryDedupeHours),
          randomness: Number(form.initiativeDiscoveryRandomness),
          sourceFetchLimit: Number(form.initiativeDiscoveryFetchLimit),
          allowNsfw: form.initiativeDiscoveryAllowNsfw,
          preferredTopics: parseList(form.initiativeDiscoveryPreferredTopics),
          redditSubreddits: parseList(form.initiativeDiscoveryRedditSubs),
          youtubeChannelIds: parseList(form.initiativeDiscoveryYoutubeChannels),
          rssFeeds: parseList(form.initiativeDiscoveryRssFeeds),
          xHandles: parseList(form.initiativeDiscoveryXHandles),
          xNitterBaseUrl: form.initiativeDiscoveryXNitterBase.trim(),
          sources: {
            reddit: form.initiativeDiscoverySourceReddit,
            hackerNews: form.initiativeDiscoverySourceHackerNews,
            youtube: form.initiativeDiscoverySourceYoutube,
            rss: form.initiativeDiscoverySourceRss,
            x: form.initiativeDiscoverySourceX
          }
        }
      },
      memory: {
        enabled: form.memoryEnabled
      }
    });
  }

  return (
    <form className="panel settings-form" onSubmit={submit}>
      <h3>Behavior Settings</h3>

      <label htmlFor="bot-name">Bot display name</label>
      <input id="bot-name" type="text" value={form.botName} onChange={set("botName")} />

      <label htmlFor="persona-flavor">Persona flavor</label>
      <textarea
        id="persona-flavor"
        rows="3"
        value={form.personaFlavor}
        onChange={set("personaFlavor")}
      />

      <label htmlFor="persona-hard-limits">Persona hard limits (one per line)</label>
      <textarea
        id="persona-hard-limits"
        rows="4"
        value={form.personaHardLimits}
        onChange={set("personaHardLimits")}
      />

      <label htmlFor="reply-level">
        Unsolicited reply chance: <strong>{form.replyLevel}%</strong>
      </label>
      <input
        id="reply-level"
        type="range"
        min="0"
        max="100"
        step="1"
        value={form.replyLevel}
        onChange={set("replyLevel")}
      />

      <label htmlFor="reaction-level">
        Reaction eagerness: <strong>{form.reactionLevel}%</strong>
      </label>
      <input
        id="reaction-level"
        type="range"
        min="0"
        max="100"
        step="1"
        value={form.reactionLevel}
        onChange={set("reactionLevel")}
      />

      <div className="toggles">
        <label>
          <input type="checkbox" checked={form.allowReplies} onChange={set("allowReplies")} />
          Allow replies
        </label>
        <label>
          <input type="checkbox" checked={form.allowInitiative} onChange={set("allowInitiative")} />
          Allow initiative replies
        </label>
        <label>
          <input type="checkbox" checked={form.allowReactions} onChange={set("allowReactions")} />
          Allow reactions
        </label>
        <label>
          <input type="checkbox" checked={form.memoryEnabled} onChange={set("memoryEnabled")} />
          Memory enabled
        </label>
      </div>

      <label htmlFor="provider">LLM provider</label>
      <select id="provider" value={form.provider} onChange={set("provider")}>
        <option value="openai">openai</option>
        <option value="anthropic">anthropic</option>
      </select>

      <label htmlFor="model">Model</label>
      <input
        id="model"
        type="text"
        placeholder="gpt-4.1-mini / claude-3-5-haiku-latest"
        value={form.model}
        onChange={set("model")}
      />

      <div className="split">
        <div>
          <label htmlFor="temperature">Temperature</label>
          <input
            id="temperature"
            type="number"
            min="0"
            max="2"
            step="0.1"
            value={form.temperature}
            onChange={set("temperature")}
          />
        </div>
        <div>
          <label htmlFor="max-tokens">Max output tokens</label>
          <input
            id="max-tokens"
            type="number"
            min="32"
            max="1400"
            step="1"
            value={form.maxTokens}
            onChange={set("maxTokens")}
          />
        </div>
      </div>

      <h4>Live Web Search</h4>
      <div className="toggles">
        <label>
          <input
            type="checkbox"
            checked={form.webSearchEnabled}
            onChange={set("webSearchEnabled")}
          />
          Enable live web search for replies
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.webSearchSafeMode}
            onChange={set("webSearchSafeMode")}
          />
          SafeSearch enabled
        </label>
      </div>

      <div className="split">
        <div>
          <label htmlFor="web-search-per-hour">Max searches/hour</label>
          <input
            id="web-search-per-hour"
            type="number"
            min="1"
            max="120"
            value={form.webSearchPerHour}
            onChange={set("webSearchPerHour")}
          />
        </div>
        <div>
          <label htmlFor="web-search-results">Search results/query</label>
          <input
            id="web-search-results"
            type="number"
            min="1"
            max="10"
            value={form.webSearchMaxResults}
            onChange={set("webSearchMaxResults")}
          />
        </div>
      </div>

      <div className="split">
        <div>
          <label htmlFor="web-search-pages">Result pages to inspect</label>
          <input
            id="web-search-pages"
            type="number"
            min="0"
            max="5"
            value={form.webSearchMaxPages}
            onChange={set("webSearchMaxPages")}
          />
        </div>
        <div>
          <label htmlFor="web-search-chars">Max chars/page extract</label>
          <input
            id="web-search-chars"
            type="number"
            min="350"
            max="4000"
            value={form.webSearchMaxChars}
            onChange={set("webSearchMaxChars")}
          />
        </div>
      </div>

      <div className="split">
        <div>
          <label htmlFor="web-search-provider-order">Provider order (comma or newline list)</label>
          <input
            id="web-search-provider-order"
            type="text"
            value={form.webSearchProviderOrder}
            onChange={set("webSearchProviderOrder")}
            placeholder="brave,serpapi"
          />
        </div>
        <div>
          <label htmlFor="web-search-recency-days">Default recency days</label>
          <input
            id="web-search-recency-days"
            type="number"
            min="1"
            max="365"
            value={form.webSearchRecencyDaysDefault}
            onChange={set("webSearchRecencyDaysDefault")}
          />
        </div>
      </div>

      <div className="split">
        <div>
          <label htmlFor="web-search-concurrent-fetches">Max concurrent fetches</label>
          <input
            id="web-search-concurrent-fetches"
            type="number"
            min="1"
            max="10"
            value={form.webSearchMaxConcurrentFetches}
            onChange={set("webSearchMaxConcurrentFetches")}
          />
        </div>
      </div>

      <h4>Video Link Context</h4>
      <div className="toggles">
        <label>
          <input
            type="checkbox"
            checked={form.videoContextEnabled}
            onChange={set("videoContextEnabled")}
          />
          Enable video transcript/metadata context in replies
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.videoContextAsrFallback}
            onChange={set("videoContextAsrFallback")}
          />
          Fallback to ASR when captions are unavailable
        </label>
      </div>

      <div className="split">
        <div>
          <label htmlFor="video-context-per-hour">Max video lookups/hour</label>
          <input
            id="video-context-per-hour"
            type="number"
            min="0"
            max="120"
            value={form.videoContextPerHour}
            onChange={set("videoContextPerHour")}
          />
        </div>
        <div>
          <label htmlFor="video-context-max-videos">Max videos per message</label>
          <input
            id="video-context-max-videos"
            type="number"
            min="0"
            max="6"
            value={form.videoContextMaxVideos}
            onChange={set("videoContextMaxVideos")}
          />
        </div>
      </div>

      <div className="split">
        <div>
          <label htmlFor="video-context-max-chars">Max transcript chars per video</label>
          <input
            id="video-context-max-chars"
            type="number"
            min="200"
            max="4000"
            value={form.videoContextMaxChars}
            onChange={set("videoContextMaxChars")}
          />
        </div>
        <div>
          <label htmlFor="video-context-keyframe-interval">Keyframe interval (seconds)</label>
          <input
            id="video-context-keyframe-interval"
            type="number"
            min="0"
            max="120"
            value={form.videoContextKeyframeInterval}
            onChange={set("videoContextKeyframeInterval")}
          />
        </div>
      </div>

      <div className="split">
        <div>
          <label htmlFor="video-context-max-keyframes">Max keyframes per video</label>
          <input
            id="video-context-max-keyframes"
            type="number"
            min="0"
            max="8"
            value={form.videoContextMaxKeyframes}
            onChange={set("videoContextMaxKeyframes")}
          />
        </div>
        <div>
          <label htmlFor="video-context-max-asr-seconds">Max ASR seconds per video</label>
          <input
            id="video-context-max-asr-seconds"
            type="number"
            min="15"
            max="600"
            value={form.videoContextMaxAsrSeconds}
            onChange={set("videoContextMaxAsrSeconds")}
          />
        </div>
      </div>

      <h4>Voice Mode (NL-only)</h4>
      <div className="toggles">
        <label>
          <input type="checkbox" checked={form.voiceEnabled} onChange={set("voiceEnabled")} />
          Enable voice sessions
        </label>
        <label>
          <input type="checkbox" checked={form.voiceJoinOnTextNL} onChange={set("voiceJoinOnTextNL")} />
          Allow NL join/leave/status triggers
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.voiceRequireDirectMention}
            onChange={set("voiceRequireDirectMention")}
          />
          Require direct mention for join
        </label>
      </div>

      <div className="split">
        <div>
          <label htmlFor="voice-intent-threshold">Intent confidence threshold</label>
          <input
            id="voice-intent-threshold"
            type="number"
            min="0.4"
            max="0.99"
            step="0.01"
            value={form.voiceIntentConfidenceThreshold}
            onChange={set("voiceIntentConfidenceThreshold")}
          />
        </div>
        <div>
          <label htmlFor="voice-max-session-minutes">Max session minutes</label>
          <input
            id="voice-max-session-minutes"
            type="number"
            min="1"
            max="120"
            value={form.voiceMaxSessionMinutes}
            onChange={set("voiceMaxSessionMinutes")}
          />
        </div>
      </div>

      <div className="split">
        <div>
          <label htmlFor="voice-inactivity-seconds">Inactivity leave seconds</label>
          <input
            id="voice-inactivity-seconds"
            type="number"
            min="20"
            max="3600"
            value={form.voiceInactivityLeaveSeconds}
            onChange={set("voiceInactivityLeaveSeconds")}
          />
        </div>
        <div>
          <label htmlFor="voice-max-sessions-day">Max sessions/day</label>
          <input
            id="voice-max-sessions-day"
            type="number"
            min="0"
            max="120"
            value={form.voiceMaxSessionsPerDay}
            onChange={set("voiceMaxSessionsPerDay")}
          />
        </div>
      </div>

      <div className="split">
        <div>
          <label htmlFor="voice-xai-voice">xAI voice</label>
          <input id="voice-xai-voice" type="text" value={form.voiceXaiVoice} onChange={set("voiceXaiVoice")} />
        </div>
        <div>
          <label htmlFor="voice-xai-region">xAI region</label>
          <input id="voice-xai-region" type="text" value={form.voiceXaiRegion} onChange={set("voiceXaiRegion")} />
        </div>
      </div>

      <div className="split">
        <div>
          <label htmlFor="voice-xai-audio-format">xAI audio format</label>
          <input
            id="voice-xai-audio-format"
            type="text"
            value={form.voiceXaiAudioFormat}
            onChange={set("voiceXaiAudioFormat")}
          />
        </div>
        <div>
          <label htmlFor="voice-xai-sample-rate">xAI sample rate (Hz)</label>
          <input
            id="voice-xai-sample-rate"
            type="number"
            min="8000"
            max="48000"
            value={form.voiceXaiSampleRateHz}
            onChange={set("voiceXaiSampleRateHz")}
          />
        </div>
      </div>

      <div className="toggles">
        <label>
          <input
            type="checkbox"
            checked={form.voiceSoundboardEnabled}
            onChange={set("voiceSoundboardEnabled")}
          />
          Enable voice soundboard director
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.voiceSoundboardAllowExternalSounds}
            onChange={set("voiceSoundboardAllowExternalSounds")}
          />
          Allow external soundboard sounds
        </label>
      </div>

      <label htmlFor="voice-sb-preferred">Preferred sound IDs (one per line)</label>
      <textarea
        id="voice-sb-preferred"
        rows="3"
        value={form.voiceSoundboardPreferredSoundIds}
        onChange={set("voiceSoundboardPreferredSoundIds")}
      />

      <label htmlFor="voice-sb-mappings">Alias mappings (`alias=sound_id[@source_guild_id]`)</label>
      <textarea
        id="voice-sb-mappings"
        rows="4"
        value={form.voiceSoundboardMappings}
        onChange={set("voiceSoundboardMappings")}
      />

      <label htmlFor="voice-allowed-channels">Allowed voice channel IDs (optional)</label>
      <textarea
        id="voice-allowed-channels"
        rows="3"
        value={form.voiceAllowedChannelIds}
        onChange={set("voiceAllowedChannelIds")}
      />

      <label htmlFor="voice-blocked-channels">Blocked voice channel IDs</label>
      <textarea
        id="voice-blocked-channels"
        rows="3"
        value={form.voiceBlockedChannelIds}
        onChange={set("voiceBlockedChannelIds")}
      />

      <label htmlFor="voice-blocked-users">Blocked voice user IDs</label>
      <textarea
        id="voice-blocked-users"
        rows="3"
        value={form.voiceBlockedUserIds}
        onChange={set("voiceBlockedUserIds")}
      />

      <div className="split">
        <div>
          <label htmlFor="max-messages">Max bot messages/hour</label>
          <input
            id="max-messages"
            type="number"
            min="1"
            max="200"
            value={form.maxMessages}
            onChange={set("maxMessages")}
          />
        </div>
        <div>
          <label htmlFor="max-reactions">Max reactions/hour</label>
          <input
            id="max-reactions"
            type="number"
            min="1"
            max="300"
            value={form.maxReactions}
            onChange={set("maxReactions")}
          />
        </div>
      </div>

      <div className="split">
        <div>
          <label htmlFor="min-gap">Min seconds between bot msgs</label>
          <input
            id="min-gap"
            type="number"
            min="5"
            max="300"
            value={form.minGap}
            onChange={set("minGap")}
          />
        </div>
        <div />
      </div>

      <h4>Startup Catch-up</h4>
      <div className="toggles">
        <label>
          <input type="checkbox" checked={form.catchupEnabled} onChange={set("catchupEnabled")} />
          Catch up on recent messages at startup
        </label>
      </div>

      <div className="split">
        <div>
          <label htmlFor="catchup-lookback">Catch-up lookback (hours)</label>
          <input
            id="catchup-lookback"
            type="number"
            min="1"
            max="24"
            value={form.catchupLookbackHours}
            onChange={set("catchupLookbackHours")}
          />
        </div>
        <div>
          <label htmlFor="catchup-max-messages">Messages scanned per channel</label>
          <input
            id="catchup-max-messages"
            type="number"
            min="5"
            max="80"
            value={form.catchupMaxMessages}
            onChange={set("catchupMaxMessages")}
          />
        </div>
      </div>

      <div className="split">
        <div>
          <label htmlFor="catchup-max-replies">Max startup replies per channel</label>
          <input
            id="catchup-max-replies"
            type="number"
            min="1"
            max="12"
            value={form.catchupMaxReplies}
            onChange={set("catchupMaxReplies")}
          />
        </div>
        <div />
      </div>

      <h4>Autonomous Initiative Posts</h4>
      <div className="toggles">
        <label>
          <input
            type="checkbox"
            checked={form.autonomousInitiativeEnabled}
            onChange={set("autonomousInitiativeEnabled")}
          />
          Enable autonomous posting
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.initiativeStartupPost}
            onChange={set("initiativeStartupPost")}
          />
          Post on startup when due
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.initiativeImageEnabled}
            onChange={set("initiativeImageEnabled")}
          />
          Allow image posts
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.initiativeVideoEnabled}
            onChange={set("initiativeVideoEnabled")}
          />
          Allow video posts
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.replyImageEnabled}
            onChange={set("replyImageEnabled")}
          />
          Allow images in regular replies
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.replyVideoEnabled}
            onChange={set("replyVideoEnabled")}
          />
          Allow videos in regular replies
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.replyGifEnabled}
            onChange={set("replyGifEnabled")}
          />
          Allow GIFs in regular replies
        </label>
      </div>

      <div className="split">
        <div>
          <label htmlFor="initiative-posts-per-day">Max initiative posts/day</label>
          <input
            id="initiative-posts-per-day"
            type="number"
            min="0"
            max="100"
            value={form.initiativePostsPerDay}
            onChange={set("initiativePostsPerDay")}
          />
        </div>
        <div>
          <label htmlFor="initiative-min-minutes">Min minutes between initiative posts</label>
          <input
            id="initiative-min-minutes"
            type="number"
            min="5"
            max="1440"
            value={form.initiativeMinMinutes}
            onChange={set("initiativeMinMinutes")}
          />
        </div>
      </div>

      <div className="split">
        <div>
          <label htmlFor="initiative-pacing-mode">Initiative pacing mode</label>
          <select
            id="initiative-pacing-mode"
            value={form.initiativePacingMode}
            onChange={set("initiativePacingMode")}
          >
            <option value="even">Even pacing (strict)</option>
            <option value="spontaneous">Spontaneous (randomized)</option>
          </select>
        </div>
        <div>
          <label htmlFor="initiative-spontaneity">
            Spontaneity: <strong>{form.initiativeSpontaneity}%</strong>
          </label>
          <input
            id="initiative-spontaneity"
            type="range"
            min="0"
            max="100"
            step="1"
            value={form.initiativeSpontaneity}
            onChange={set("initiativeSpontaneity")}
          />
        </div>
      </div>

      <div className="split">
        <div>
          <label htmlFor="max-images-per-day">Max generated images/24h</label>
          <input
            id="max-images-per-day"
            type="number"
            min="0"
            max="200"
            value={form.maxImagesPerDay}
            onChange={set("maxImagesPerDay")}
          />
        </div>
        <div>
          <label htmlFor="max-videos-per-day">Max generated videos/24h</label>
          <input
            id="max-videos-per-day"
            type="number"
            min="0"
            max="120"
            value={form.maxVideosPerDay}
            onChange={set("maxVideosPerDay")}
          />
        </div>
      </div>

      <div className="split">
        <div>
          <label htmlFor="max-gifs-per-day">Max GIF lookups/24h</label>
          <input
            id="max-gifs-per-day"
            type="number"
            min="0"
            max="300"
            value={form.maxGifsPerDay}
            onChange={set("maxGifsPerDay")}
          />
        </div>
        <div>
          <label htmlFor="initiative-simple-image-model">Simple image model</label>
          <input
            id="initiative-simple-image-model"
            type="text"
            value={form.initiativeSimpleImageModel}
            onChange={set("initiativeSimpleImageModel")}
          />
        </div>
      </div>

      <div className="split">
        <div>
          <label htmlFor="initiative-complex-image-model">Complex image model</label>
          <input
            id="initiative-complex-image-model"
            type="text"
            value={form.initiativeComplexImageModel}
            onChange={set("initiativeComplexImageModel")}
          />
        </div>
        <div>
          <label htmlFor="initiative-video-model">Video model</label>
          <input
            id="initiative-video-model"
            type="text"
            value={form.initiativeVideoModel}
            onChange={set("initiativeVideoModel")}
          />
        </div>
      </div>

      <div className="split">
        <div>
          <label htmlFor="initiative-allowed-image-models">Allowed image models (comma/newline list)</label>
          <textarea
            id="initiative-allowed-image-models"
            rows="3"
            value={form.initiativeAllowedImageModels}
            onChange={set("initiativeAllowedImageModels")}
          />
        </div>
        <div>
          <label htmlFor="initiative-allowed-video-models">Allowed video models (comma/newline list)</label>
          <textarea
            id="initiative-allowed-video-models"
            rows="3"
            value={form.initiativeAllowedVideoModels}
            onChange={set("initiativeAllowedVideoModels")}
          />
        </div>
      </div>

      <h4>Creative Discovery</h4>
      <div className="toggles">
        <label>
          <input
            type="checkbox"
            checked={form.initiativeDiscoveryEnabled}
            onChange={set("initiativeDiscoveryEnabled")}
          />
          Enable external discovery for initiative posts
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.initiativeDiscoveryAllowNsfw}
            onChange={set("initiativeDiscoveryAllowNsfw")}
          />
          Allow NSFW discovery items
        </label>
      </div>

      <div className="split">
        <div>
          <label htmlFor="initiative-discovery-link-chance">Posts with links (%)</label>
          <input
            id="initiative-discovery-link-chance"
            type="number"
            min="0"
            max="100"
            value={form.initiativeDiscoveryLinkChance}
            onChange={set("initiativeDiscoveryLinkChance")}
          />
        </div>
        <div>
          <label htmlFor="initiative-discovery-max-links">Max links per post</label>
          <input
            id="initiative-discovery-max-links"
            type="number"
            min="1"
            max="4"
            value={form.initiativeDiscoveryMaxLinks}
            onChange={set("initiativeDiscoveryMaxLinks")}
          />
        </div>
      </div>

      <div className="split">
        <div>
          <label htmlFor="initiative-discovery-max-candidates">Candidates for prompt</label>
          <input
            id="initiative-discovery-max-candidates"
            type="number"
            min="1"
            max="12"
            value={form.initiativeDiscoveryMaxCandidates}
            onChange={set("initiativeDiscoveryMaxCandidates")}
          />
        </div>
        <div>
          <label htmlFor="initiative-discovery-fetch-limit">Fetch limit per source</label>
          <input
            id="initiative-discovery-fetch-limit"
            type="number"
            min="2"
            max="30"
            value={form.initiativeDiscoveryFetchLimit}
            onChange={set("initiativeDiscoveryFetchLimit")}
          />
        </div>
      </div>

      <div className="split">
        <div>
          <label htmlFor="initiative-discovery-freshness">Freshness window (hours)</label>
          <input
            id="initiative-discovery-freshness"
            type="number"
            min="1"
            max="336"
            value={form.initiativeDiscoveryFreshnessHours}
            onChange={set("initiativeDiscoveryFreshnessHours")}
          />
        </div>
        <div>
          <label htmlFor="initiative-discovery-dedupe">Avoid repost window (hours)</label>
          <input
            id="initiative-discovery-dedupe"
            type="number"
            min="1"
            max="1080"
            value={form.initiativeDiscoveryDedupeHours}
            onChange={set("initiativeDiscoveryDedupeHours")}
          />
        </div>
      </div>

      <label htmlFor="initiative-discovery-randomness">
        Discovery randomness: <strong>{form.initiativeDiscoveryRandomness}%</strong>
      </label>
      <input
        id="initiative-discovery-randomness"
        type="range"
        min="0"
        max="100"
        step="1"
        value={form.initiativeDiscoveryRandomness}
        onChange={set("initiativeDiscoveryRandomness")}
      />

      <div className="toggles">
        <label>
          <input
            type="checkbox"
            checked={form.initiativeDiscoverySourceReddit}
            onChange={set("initiativeDiscoverySourceReddit")}
          />
          Reddit
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.initiativeDiscoverySourceHackerNews}
            onChange={set("initiativeDiscoverySourceHackerNews")}
          />
          Hacker News
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.initiativeDiscoverySourceYoutube}
            onChange={set("initiativeDiscoverySourceYoutube")}
          />
          YouTube RSS
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.initiativeDiscoverySourceRss}
            onChange={set("initiativeDiscoverySourceRss")}
          />
          RSS feeds
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.initiativeDiscoverySourceX}
            onChange={set("initiativeDiscoverySourceX")}
          />
          X via Nitter RSS
        </label>
      </div>

      <label htmlFor="initiative-discovery-topics">Preferred topics (comma/newline)</label>
      <textarea
        id="initiative-discovery-topics"
        rows="2"
        value={form.initiativeDiscoveryPreferredTopics}
        onChange={set("initiativeDiscoveryPreferredTopics")}
      />

      <label htmlFor="initiative-discovery-reddit">Reddit subreddits</label>
      <textarea
        id="initiative-discovery-reddit"
        rows="2"
        value={form.initiativeDiscoveryRedditSubs}
        onChange={set("initiativeDiscoveryRedditSubs")}
      />

      <label htmlFor="initiative-discovery-youtube">YouTube channel IDs</label>
      <textarea
        id="initiative-discovery-youtube"
        rows="2"
        value={form.initiativeDiscoveryYoutubeChannels}
        onChange={set("initiativeDiscoveryYoutubeChannels")}
      />

      <label htmlFor="initiative-discovery-rss">RSS feed URLs</label>
      <textarea
        id="initiative-discovery-rss"
        rows="3"
        value={form.initiativeDiscoveryRssFeeds}
        onChange={set("initiativeDiscoveryRssFeeds")}
      />

      <label htmlFor="initiative-discovery-x-handles">X handles</label>
      <textarea
        id="initiative-discovery-x-handles"
        rows="2"
        value={form.initiativeDiscoveryXHandles}
        onChange={set("initiativeDiscoveryXHandles")}
      />

      <label htmlFor="initiative-discovery-nitter">Nitter base URL (for X RSS)</label>
      <input
        id="initiative-discovery-nitter"
        type="text"
        value={form.initiativeDiscoveryXNitterBase}
        onChange={set("initiativeDiscoveryXNitterBase")}
      />

      <label htmlFor="initiative-channels">Standalone post channel IDs (only these)</label>
      <textarea
        id="initiative-channels"
        rows="2"
        value={form.initiativeChannels}
        onChange={set("initiativeChannels")}
      />

      <label htmlFor="allowed-channels">Allowed channel IDs (comma/newline)</label>
      <textarea
        id="allowed-channels"
        rows="3"
        value={form.allowedChannels}
        onChange={set("allowedChannels")}
      />

      <label htmlFor="blocked-channels">Blocked channel IDs (comma/newline)</label>
      <textarea
        id="blocked-channels"
        rows="3"
        value={form.blockedChannels}
        onChange={set("blockedChannels")}
      />

      <label htmlFor="blocked-users">Blocked user IDs (comma/newline)</label>
      <textarea
        id="blocked-users"
        rows="3"
        value={form.blockedUsers}
        onChange={set("blockedUsers")}
      />

      <button type="submit" className="cta">Save settings</button>

      {toast.text && (
        <p className={`status-msg ${toast.type}`}>{toast.text}</p>
      )}
    </form>
  );
}
