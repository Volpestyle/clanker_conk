export default function MetricsBar({ stats }) {
  const runtime = stats?.runtime;
  const s = stats?.stats;
  const isOnline = runtime?.isReady;

  const cards = [
    {
      label: "Runtime",
      value: isOnline ? `online (${runtime.guildCount} guilds)` : "connecting",
      online: isOnline
    },
    {
      label: "Total API Cost",
      value: `$${Number(s?.totalCostUsd || 0).toFixed(6)}`
    },
    {
      label: "Replies (24h)",
      value: String(s?.last24h?.sent_reply || 0)
    },
    {
      label: "Drop-ins (24h)",
      value: String(
        Number(s?.last24h?.sent_message || 0) + Number(s?.last24h?.initiative_post || 0)
      )
    },
    {
      label: "Reactions (24h)",
      value: String(s?.last24h?.reacted || 0)
    },
    {
      label: "Searches (24h)",
      value: String(s?.last24h?.search_call || 0)
    },
    {
      label: "Video Ctx (24h)",
      value: String(s?.last24h?.video_context_call || 0)
    },
    {
      label: "GIFs (24h)",
      value: String(s?.last24h?.gif_call || 0)
    },
    {
      label: "Voice Sessions (24h)",
      value: String(s?.last24h?.voice_session_start || 0)
    },
    {
      label: "Voice Sounds (24h)",
      value: String(s?.last24h?.voice_soundboard_play || 0)
    },
    {
      label: "Voice Errors (24h)",
      value: String(s?.last24h?.voice_error || 0)
    }
  ];

  return (
    <section className="metrics">
      {cards.map((c) => (
        <article key={c.label} className={`metric panel${c.online ? " online" : ""}`}>
          <p className="label">{c.label}</p>
          <p className="value">{c.value}</p>
        </article>
      ))}
    </section>
  );
}
