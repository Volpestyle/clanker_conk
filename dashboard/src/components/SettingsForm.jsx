import { useState, useEffect } from "react";

function parseList(val) {
  return [...new Set(String(val || "").split(/[\n,]/g).map((x) => x.trim()).filter(Boolean))];
}

function parseIdList(val) {
  return parseList(val);
}

function formatIdList(items) {
  return (items || []).join("\n");
}

function formatList(items) {
  return (items || []).join("\n");
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
      maxMessages: settings.permissions?.maxMessagesPerHour ?? settings.permissions?.maxRepliesPerHour ?? 20,
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
      initiativeImageChance: settings.initiative?.imagePostChancePercent ?? 25,
      initiativeImageModel: settings.initiative?.imageModel ?? "gpt-image-1",
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
      initiativeChannels: formatIdList(settings.permissions?.initiativeChannelIds),
      allowedChannels: formatIdList(settings.permissions?.allowedChannelIds),
      blockedChannels: formatIdList(settings.permissions?.blockedChannelIds),
      blockedUsers: formatIdList(settings.permissions?.blockedUserIds)
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
        flavor: form.personaFlavor.trim()
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
        initiativeChannelIds: parseIdList(form.initiativeChannels),
        allowedChannelIds: parseIdList(form.allowedChannels),
        blockedChannelIds: parseIdList(form.blockedChannels),
        blockedUserIds: parseIdList(form.blockedUsers),
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
        imagePostChancePercent: Number(form.initiativeImageChance),
        imageModel: form.initiativeImageModel.trim(),
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
          <label htmlFor="initiative-image-chance">Image post chance (%)</label>
          <input
            id="initiative-image-chance"
            type="number"
            min="0"
            max="100"
            value={form.initiativeImageChance}
            onChange={set("initiativeImageChance")}
          />
        </div>
        <div>
          <label htmlFor="initiative-image-model">Image model</label>
          <input
            id="initiative-image-model"
            type="text"
            value={form.initiativeImageModel}
            onChange={set("initiativeImageModel")}
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
