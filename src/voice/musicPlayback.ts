export type MusicPlaybackTrack = {
  id: string;
  title: string;
  artistNames: string[];
  externalUrl: string | null;
};

export type MusicPlaybackResult = {
  ok: boolean;
  provider: string;
  reason: string;
  message: string;
  status: number;
  track: MusicPlaybackTrack | null;
  query: string | null;
};

export type MusicPlaybackStatus = {
  ok: boolean;
  provider: string;
  reason: string;
  message: string;
  status: number;
  active: boolean;
  track: MusicPlaybackTrack | null;
};

export type MusicPlaybackProvider = {
  provider: string;
  isConfigured: () => boolean;
  startPlayback: (payload?: { query?: string; trackId?: string | null; deviceId?: string | null }) => Promise<MusicPlaybackResult>;
  stopPlayback: (payload?: { deviceId?: string | null }) => Promise<MusicPlaybackResult>;
  getPlaybackStatus: (payload?: { deviceId?: string | null }) => Promise<MusicPlaybackStatus>;
};

function emptyResult({
  provider,
  reason = "not_configured",
  message = "music playback provider not configured",
  status = 0,
  query = null
}: {
  provider: string;
  reason?: string;
  message?: string;
  status?: number;
  query?: string | null;
}): MusicPlaybackResult {
  return {
    ok: false,
    provider,
    reason,
    message,
    status,
    track: null,
    query
  };
}

class NullMusicPlaybackProvider implements MusicPlaybackProvider {
  provider;

  constructor(provider = "none") {
    this.provider = String(provider || "none");
  }

  isConfigured() {
    return false;
  }

  async startPlayback({ query = "" } = {}) {
    const normalizedQuery = String(query || "").replace(/\s+/g, " ").trim() || null;
    return emptyResult({
      provider: this.provider,
      query: normalizedQuery
    });
  }

  async stopPlayback() {
    return emptyResult({
      provider: this.provider
    });
  }

  async getPlaybackStatus() {
    return {
      ok: false,
      provider: this.provider,
      reason: "not_configured",
      message: "music playback provider not configured",
      status: 0,
      active: false,
      track: null
    };
  }
}

export function createMusicPlaybackProvider(_appConfig: Record<string, unknown> = {}): MusicPlaybackProvider {
  return new NullMusicPlaybackProvider("youtube");
}
