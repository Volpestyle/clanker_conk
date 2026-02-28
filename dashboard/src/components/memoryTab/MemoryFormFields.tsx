interface Guild {
  id: string;
  name: string;
}

interface GuildSelectFieldProps {
  guilds: Guild[];
  guildId: string;
  onGuildChange: (guildId: string) => void;
}

interface ChannelIdFieldProps {
  channelId: string;
  onChannelIdChange: (channelId: string) => void;
}

export function GuildSelectField({ guilds, guildId, onGuildChange }: GuildSelectFieldProps) {
  return (
    <label>
      Guild
      <select value={guildId} onChange={(event) => onGuildChange(event.target.value)}>
        <option value="">Select guild...</option>
        {guilds.map((guild) => (
          <option key={guild.id} value={guild.id}>
            {guild.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ChannelIdField({ channelId, onChannelIdChange }: ChannelIdFieldProps) {
  return (
    <label>
      Channel ID <span style={{ color: "var(--ink-3)" }}>(optional)</span>
      <input
        type="text"
        value={channelId}
        onChange={(event) => onChannelIdChange(event.target.value)}
        placeholder="Channel ID"
      />
    </label>
  );
}
