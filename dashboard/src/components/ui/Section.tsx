import { useState, type ReactNode } from "react";

export function Section({ title, badge, defaultOpen = false, children }: {
  title: string;
  badge?: string | number | null;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={`ui-section${open ? " ui-section-open" : ""}`}>
      <button
        type="button"
        className="ui-section-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`ui-section-arrow${open ? " ui-section-arrow-open" : ""}`}>&#x25B8;</span>
        <span className="ui-section-title">{title}</span>
        {badge != null && <span className="ui-section-badge">{badge}</span>}
      </button>
      {open && <div className="ui-section-body">{children}</div>}
    </div>
  );
}
