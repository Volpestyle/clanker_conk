import type {
  VoiceMusicQueueState,
  VoiceSessionMusicState
} from "./voiceSessionTypes.ts";

type MusicResumeSessionLike = {
  music?: VoiceSessionMusicState | null;
  musicQueueState?: VoiceMusicQueueState | Record<string, unknown> | null;
};

type MusicResumeStateSnapshot = {
  hasKnownState: boolean;
  hasQueuedTrack: boolean;
  hasRememberedTrack: boolean;
  queueNowPlayingIndex: number | null;
  queueTrackId: string | null;
  queueTrackTitle: string | null;
  rememberedTrackId: string | null;
  rememberedTrackTitle: string | null;
  rememberedTrackUrl: string | null;
};

function normalizeNonEmptyString(value: unknown) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

export function getMusicResumeStateSnapshot(
  session: MusicResumeSessionLike | null | undefined
): MusicResumeStateSnapshot {
  const queueState =
    session?.musicQueueState && typeof session.musicQueueState === "object"
      ? session.musicQueueState
      : null;
  const tracks = Array.isArray(queueState?.tracks) ? queueState.tracks : [];
  const rawNowPlayingIndex =
    typeof queueState?.nowPlayingIndex === "number" && Number.isInteger(queueState.nowPlayingIndex)
      ? queueState.nowPlayingIndex
      : null;
  const queueNowPlayingIndex =
    rawNowPlayingIndex != null && rawNowPlayingIndex >= 0 && rawNowPlayingIndex < tracks.length
      ? rawNowPlayingIndex
      : null;
  const queueTrack =
    queueNowPlayingIndex != null && tracks[queueNowPlayingIndex] && typeof tracks[queueNowPlayingIndex] === "object"
      ? tracks[queueNowPlayingIndex]
      : null;
  const queueTrackId = normalizeNonEmptyString(queueTrack?.id);
  const queueTrackTitle = normalizeNonEmptyString(queueTrack?.title);
  const hasQueuedTrack = Boolean(queueTrackId && queueTrackTitle);

  const music = session?.music && typeof session.music === "object" ? session.music : null;
  const rememberedTrackId = normalizeNonEmptyString(music?.lastTrackId);
  const rememberedTrackTitle = normalizeNonEmptyString(music?.lastTrackTitle);
  const rememberedTrackUrl = normalizeNonEmptyString(music?.lastTrackUrl);
  const hasRememberedTrack = Boolean(
    rememberedTrackUrl || (rememberedTrackId && rememberedTrackTitle)
  );

  return {
    hasKnownState: hasQueuedTrack || hasRememberedTrack,
    hasQueuedTrack,
    hasRememberedTrack,
    queueNowPlayingIndex,
    queueTrackId,
    queueTrackTitle,
    rememberedTrackId,
    rememberedTrackTitle,
    rememberedTrackUrl
  };
}

export function hasKnownMusicResumeState(session: MusicResumeSessionLike | null | undefined) {
  return getMusicResumeStateSnapshot(session).hasKnownState;
}

export function noteMusicResumeRequest(
  session: MusicResumeSessionLike | null | undefined,
  reason: string
) {
  const music = session?.music && typeof session.music === "object" ? session.music : null;
  if (!music) return null;
  music.lastCommandAt = Date.now();
  music.lastCommandReason = String(reason || "music_resumed");
  return music;
}

export function setKnownMusicQueuePausedState(
  session: MusicResumeSessionLike | null | undefined,
  isPaused: boolean
) {
  const queueState =
    session?.musicQueueState && typeof session.musicQueueState === "object"
      ? session.musicQueueState
      : null;
  if (!queueState) return null;
  queueState.isPaused = Boolean(isPaused);
  return queueState;
}
