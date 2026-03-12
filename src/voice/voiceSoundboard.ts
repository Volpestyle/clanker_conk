import { getVoiceSoundboardSettings } from "../settings/agentStack.ts";
import {
  SOUNDBOARD_MAX_CANDIDATES,
  dedupeSoundboardCandidates,
  findMentionedSoundboardReference,
  matchSoundboardReference,
  normalizeVoiceText,
  parsePreferredSoundboardReferences,
  shortError
} from "./voiceSessionHelpers.ts";
import { SOUNDBOARD_CATALOG_REFRESH_MS, SOUNDBOARD_DECISION_TRANSCRIPT_MAX_CHARS } from "./voiceSessionManager.constants.ts";
import type {
  SoundboardCandidate,
  VoiceSession,
  VoiceSessionSoundboardState
} from "./voiceSessionTypes.ts";

type VoiceSoundboardSettings = Record<string, unknown> | null;

type VoiceSoundboardStoreLike = {
  logAction: (entry: {
    kind: string;
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    content: string;
    metadata?: Record<string, unknown>;
  }) => void;
};

type GuildSoundLike = {
  available?: boolean;
  soundId?: string | null;
  name?: string | null;
};

type GuildSoundboardCollectionLike = {
  forEach: (callback: (sound: GuildSoundLike) => void) => void;
};

type GuildSoundboardLike = {
  soundboardSounds?: {
    fetch?: () => Promise<GuildSoundboardCollectionLike>;
  };
} | null;

type VoiceSoundboardSessionLike = Pick<
  VoiceSession,
  "ending" | "guildId" | "textChannelId" | "id" | "mode" | "settingsSnapshot"
> & {
  soundboard?: VoiceSessionSoundboardState | null;
};

type SoundboardPlayResult = {
  ok: boolean;
  reason?: string | null;
  message?: string | null;
};

interface VoiceSoundboardHost {
  client: {
    user?: {
      id?: string | null;
    } | null;
    guilds: {
      cache: {
        get: (guildId: string) => GuildSoundboardLike;
      };
    };
  };
  store: VoiceSoundboardStoreLike;
  soundboardDirector: {
    play: (args: {
      session: VoiceSoundboardSessionLike;
      settings: VoiceSoundboardSettings;
      soundId: string;
      sourceGuildId?: string | null;
      reason?: string;
    }) => Promise<SoundboardPlayResult>;
  };
}

function ensureSoundboardState(session: VoiceSoundboardSessionLike | null | undefined) {
  if (!session) return null;
  session.soundboard = session.soundboard || {
    playCount: 0,
    lastPlayedAt: 0,
    catalogCandidates: [],
    catalogFetchedAt: 0,
    lastDirectiveKey: "",
    lastDirectiveAt: 0
  };
  return session.soundboard;
}

export function normalizeSoundboardRefs(soundboardRefs: unknown[] = []) {
  return (Array.isArray(soundboardRefs) ? soundboardRefs : [])
    .map((entry) =>
      String(entry || "")
        .trim()
        .slice(0, 180)
    )
    .filter(Boolean)
    .slice(0, 12);
}

export async function maybeTriggerAssistantDirectedSoundboard(
  host: VoiceSoundboardHost,
  {
    session,
    settings,
    userId = null,
    transcript = "",
    requestedRef = "",
    source = "voice_transcript"
  }: {
    session?: VoiceSoundboardSessionLike | null;
    settings?: VoiceSoundboardSettings;
    userId?: string | null;
    transcript?: string;
    requestedRef?: string;
    source?: string;
  }
) {
  if (!session || session.ending) return;

  const resolvedSettings = settings || session.settingsSnapshot || null;
  if (!getVoiceSoundboardSettings(resolvedSettings).enabled) return;
  const normalizedRef = String(requestedRef || "").trim().slice(0, 180);
  if (!normalizedRef) return;

  const normalizedTranscript = normalizeVoiceText(transcript, SOUNDBOARD_DECISION_TRANSCRIPT_MAX_CHARS);
  const soundboardState = ensureSoundboardState(session);
  if (!soundboardState) return;

  const directiveKey = [
    String(source || "voice_transcript").trim().toLowerCase(),
    normalizedRef.toLowerCase(),
    String(normalizedTranscript || "").trim().toLowerCase()
  ].join("|");
  const now = Date.now();
  if (
    directiveKey &&
    directiveKey === String(soundboardState.lastDirectiveKey || "") &&
    now - Number(soundboardState.lastDirectiveAt || 0) < 6_000
  ) {
    return;
  }
  soundboardState.lastDirectiveKey = directiveKey;
  soundboardState.lastDirectiveAt = now;

  const candidateInfo = await resolveSoundboardCandidates(host, {
    session,
    settings: resolvedSettings
  });
  const candidates = Array.isArray(candidateInfo?.candidates) ? candidateInfo.candidates : [];
  const candidateSource = String(candidateInfo?.source || "none");
  const byReference = matchSoundboardReference(candidates, normalizedRef);
  const byMention = byReference ? null : findMentionedSoundboardReference(candidates, normalizedRef);
  const byName =
    byReference || byMention
      ? null
      : candidates.find((entry) => String(entry?.name || "").trim().toLowerCase() === normalizedRef.toLowerCase()) ||
      candidates.find((entry) =>
        String(entry?.name || "")
          .trim()
          .toLowerCase()
          .includes(normalizedRef.toLowerCase())
      );
  const matched = byReference || byMention || byName || null;

  host.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: userId || host.client.user?.id || null,
    content: "voice_soundboard_directive_decision",
    metadata: {
      sessionId: session.id,
      mode: session.mode,
      source: String(source || "voice_transcript"),
      transcript: normalizedTranscript || null,
      requestedRef: normalizedRef,
      candidateCount: candidates.length,
      candidateSource,
      matchedReference: matched?.reference || null
    }
  });

  if (!matched) return;

  const result = await host.soundboardDirector.play({
    session,
    settings: resolvedSettings,
    soundId: matched.soundId,
    sourceGuildId: matched.sourceGuildId,
    reason: `assistant_directive_${String(source || "voice_transcript").slice(0, 50)}`
  });

  host.store.logAction({
    kind: result.ok ? "voice_runtime" : "voice_error",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: userId || host.client.user?.id || null,
    content: result.ok ? "voice_soundboard_directive_played" : "voice_soundboard_directive_failed",
    metadata: {
      sessionId: session.id,
      mode: session.mode,
      source: String(source || "voice_transcript"),
      transcript: normalizedTranscript || null,
      requestedRef: normalizedRef,
      soundId: matched.soundId,
      sourceGuildId: matched.sourceGuildId,
      reason: result.reason || null,
      error: result.ok ? null : shortError(result.message || "")
    }
  });
}

export async function resolveSoundboardCandidates(
  host: VoiceSoundboardHost,
  {
    session = null,
    settings,
    guild = null
  }: {
    session?: VoiceSoundboardSessionLike | null;
    settings: VoiceSoundboardSettings;
    guild?: GuildSoundboardLike;
  }
) {
  const preferred = parsePreferredSoundboardReferences(getVoiceSoundboardSettings(settings).preferredSoundIds);
  if (preferred.length) {
    return {
      source: "preferred",
      candidates: preferred.slice(0, SOUNDBOARD_MAX_CANDIDATES)
    };
  }

  const guildCandidates = await fetchGuildSoundboardCandidates(host, {
    session,
    guild
  });
  if (guildCandidates.length) {
    return {
      source: "guild_catalog",
      candidates: guildCandidates.slice(0, SOUNDBOARD_MAX_CANDIDATES)
    };
  }

  return {
    source: "none",
    candidates: []
  };
}

export async function fetchGuildSoundboardCandidates(
  host: VoiceSoundboardHost,
  {
    session = null,
    guild = null
  }: {
    session?: VoiceSoundboardSessionLike | null;
    guild?: GuildSoundboardLike;
  } = {}
) {
  if (session && session.ending) return [];
  const now = Date.now();

  let cached: SoundboardCandidate[] = [];
  const soundboardState = ensureSoundboardState(session);
  if (soundboardState) {
    cached = Array.isArray(soundboardState.catalogCandidates)
      ? soundboardState.catalogCandidates.filter(Boolean)
      : [];
    const lastFetchedAt = Number(soundboardState.catalogFetchedAt || 0);
    if (lastFetchedAt > 0 && now - lastFetchedAt < SOUNDBOARD_CATALOG_REFRESH_MS) {
      return cached;
    }
  }

  const resolvedGuild = guild || host.client.guilds.cache.get(String(session?.guildId || ""));
  if (!resolvedGuild?.soundboardSounds?.fetch) {
    return cached;
  }

  try {
    const fetched = await resolvedGuild.soundboardSounds.fetch();
    const candidates: SoundboardCandidate[] = [];
    fetched.forEach((sound) => {
      if (!sound || sound.available === false) return;
      const soundId = String(sound.soundId || "").trim();
      if (!soundId) return;
      const name = String(sound.name || "").trim();
      candidates.push({
        soundId,
        sourceGuildId: null,
        reference: soundId,
        name: name || null,
        origin: "guild_catalog"
      });
    });

    const deduped = dedupeSoundboardCandidates(candidates).slice(0, SOUNDBOARD_MAX_CANDIDATES);
    if (soundboardState) {
      soundboardState.catalogCandidates = deduped;
      soundboardState.catalogFetchedAt = now;
    }
    return deduped;
  } catch (error) {
    if (session && soundboardState) {
      host.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: host.client.user?.id || null,
        content: `voice_soundboard_catalog_fetch_failed: ${String((error as Error)?.message || error)}`,
        metadata: {
          sessionId: session.id
        }
      });
      soundboardState.catalogFetchedAt = now;
    }
    return cached;
  }
}
