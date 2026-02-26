import { PermissionFlagsBits } from "discord.js";
import { clamp } from "../utils.ts";

const API_BASE = "https://discord.com/api/v10";

export class SoundboardDirector {
  constructor({ client, store, appConfig }) {
    this.client = client;
    this.store = store;
    this.appConfig = appConfig;
  }

  async play({ session, settings, soundId, sourceGuildId = null, reason = "manual", triggerMessage = null }) {
    if (!session || !soundId) {
      return {
        ok: false,
        reason: "invalid_request",
        message: "missing session or sound id"
      };
    }

    const soundboardSettings = settings?.voice?.soundboard || {};
    if (!soundboardSettings.enabled) {
      return {
        ok: false,
        reason: "disabled",
        message: "voice soundboard is disabled"
      };
    }

    const maxPlaysPerSession = clamp(Number(soundboardSettings.maxPlaysPerSession) || 0, 0, 20);
    const minSecondsBetweenPlays = clamp(Number(soundboardSettings.minSecondsBetweenPlays) || 45, 5, 600);
    const allowExternalSounds = Boolean(soundboardSettings.allowExternalSounds);

    if (sourceGuildId && !allowExternalSounds) {
      return {
        ok: false,
        reason: "external_disabled",
        message: "external sounds are disabled in settings"
      };
    }

    session.soundboard = session.soundboard || {
      playCount: 0,
      lastPlayedAt: 0
    };

    if (maxPlaysPerSession > 0 && session.soundboard.playCount >= maxPlaysPerSession) {
      return {
        ok: false,
        reason: "session_cap",
        message: `soundboard cap reached (${maxPlaysPerSession} per session)`
      };
    }

    const elapsedSinceLastPlayMs = Date.now() - (session.soundboard.lastPlayedAt || 0);
    if (session.soundboard.lastPlayedAt && elapsedSinceLastPlayMs < minSecondsBetweenPlays * 1000) {
      const remaining = Math.ceil((minSecondsBetweenPlays * 1000 - elapsedSinceLastPlayMs) / 1000);
      return {
        ok: false,
        reason: "cooldown",
        message: `soundboard cooldown active (${remaining}s left)`
      };
    }

    const guild = this.client.guilds.cache.get(session.guildId);
    if (!guild) {
      return {
        ok: false,
        reason: "guild_missing",
        message: "guild not found"
      };
    }

    const voiceChannel = guild.channels.cache.get(session.voiceChannelId);
    if (!voiceChannel || !voiceChannel.isVoiceBased?.()) {
      return {
        ok: false,
        reason: "channel_missing",
        message: "voice channel not available"
      };
    }

    const me = guild.members.me;
    if (!me) {
      return {
        ok: false,
        reason: "bot_member_missing",
        message: "bot member state not available"
      };
    }

    const perms = voiceChannel.permissionsFor(me);
    if (!perms?.has(PermissionFlagsBits.Speak) || !perms.has(PermissionFlagsBits.UseSoundboard)) {
      return {
        ok: false,
        reason: "missing_permissions",
        message: "missing SPEAK or USE_SOUNDBOARD permission"
      };
    }

    if (sourceGuildId && !perms.has(PermissionFlagsBits.UseExternalSounds)) {
      return {
        ok: false,
        reason: "missing_external_permissions",
        message: "missing USE_EXTERNAL_SOUNDS permission"
      };
    }

    const myVoice = me.voice;
    if (!myVoice?.channelId || String(myVoice.channelId) !== String(session.voiceChannelId)) {
      return {
        ok: false,
        reason: "not_in_voice",
        message: "bot is not currently connected to target voice channel"
      };
    }

    if (myVoice.serverMute || myVoice.selfMute || myVoice.serverDeaf || myVoice.selfDeaf) {
      return {
        ok: false,
        reason: "muted_or_deaf",
        message: "bot voice state is muted/deaf"
      };
    }

    if (!this.appConfig?.discordToken) {
      return {
        ok: false,
        reason: "token_missing",
        message: "discord token unavailable"
      };
    }

    const body = {
      sound_id: String(soundId)
    };

    if (sourceGuildId) {
      body.source_guild_id = String(sourceGuildId);
    }

    let response = null;
    let errorText = null;

    try {
      response = await fetch(`${API_BASE}/channels/${session.voiceChannelId}/send-soundboard-sound`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bot ${this.appConfig.discordToken}`
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        errorText = `${response.status} ${response.statusText}`;
        let responseBody = "";
        try {
          responseBody = await response.text();
        } catch {
          // ignore
        }
        if (responseBody) errorText = `${errorText}: ${responseBody.slice(0, 240)}`;
      }
    } catch (error) {
      errorText = String(error?.message || error);
    }

    if (errorText) {
      this.store.logAction({
        kind: "voice_error",
        guildId: session.guildId,
        channelId: session.textChannelId,
        messageId: triggerMessage?.id || null,
        userId: triggerMessage?.author?.id || this.client.user?.id || null,
        content: `soundboard_play_failed: ${errorText}`,
        metadata: {
          reason,
          soundId,
          sourceGuildId,
          sessionId: session.id
        }
      });

      return {
        ok: false,
        reason: "api_error",
        message: errorText
      };
    }

    session.soundboard.playCount += 1;
    session.soundboard.lastPlayedAt = Date.now();

    this.store.logAction({
      kind: "voice_soundboard_play",
      guildId: session.guildId,
      channelId: session.textChannelId,
      messageId: triggerMessage?.id || null,
      userId: triggerMessage?.author?.id || this.client.user?.id || null,
      content: soundId,
      metadata: {
        reason,
        sourceGuildId,
        sessionId: session.id,
        playCount: session.soundboard.playCount
      }
    });

    return {
      ok: true,
      reason: "played",
      message: "played"
    };
  }

  resolveManualSoundRequest(text, settings) {
    const raw = String(text || "").trim().toLowerCase();
    if (!raw) return null;

    const explicit = raw.match(/\b(?:play|hit|drop|send)\s+soundboard\s+([a-z0-9:_-]{2,80})\b/i);
    if (explicit?.[1]) {
      const directId = String(explicit[1]).trim();
      return {
        soundId: directId,
        alias: directId,
        sourceGuildId: null,
        reason: "explicit_id"
      };
    }

    const mappings = normalizeMappingObject(settings?.voice?.soundboard?.mappings || {});
    const mappingEntries = Object.entries(mappings);
    if (!mappingEntries.length) return null;

    const hasPlayVerb = /\b(?:play|hit|drop|send|trigger)\b/i.test(raw);

    for (const [alias, mappedValue] of mappingEntries) {
      if (!raw.includes(alias.toLowerCase())) continue;
      if (!hasPlayVerb && !/\b(?:airhorn|bruh|sad\s*violin|vine\s*boom)\b/i.test(raw)) continue;

      const { soundId, sourceGuildId } = parseMappedValue(mappedValue);
      if (!soundId) continue;
      return {
        soundId,
        alias,
        sourceGuildId,
        reason: "mapped_alias"
      };
    }

    return null;
  }
}

function normalizeMappingObject(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};

  for (const [key, value] of Object.entries(raw)) {
    const alias = String(key || "").trim();
    const target = String(value || "").trim();
    if (!alias || !target) continue;
    out[alias.slice(0, 80)] = target.slice(0, 160);
  }

  return out;
}

function parseMappedValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return { soundId: null, sourceGuildId: null };

  const [soundIdPart, sourceGuildPart] = raw.split("@");
  const soundId = String(soundIdPart || "").trim();
  const sourceGuildId = String(sourceGuildPart || "").trim() || null;
  return {
    soundId: soundId || null,
    sourceGuildId
  };
}
