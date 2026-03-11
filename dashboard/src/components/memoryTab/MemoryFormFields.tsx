interface ChannelIdFieldProps {
  channelId: string;
  onChannelIdChange: (channelId: string) => void;
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
