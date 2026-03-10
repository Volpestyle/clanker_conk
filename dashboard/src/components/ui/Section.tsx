import { useState, useEffect, type ReactNode } from "react";

export function Section({ title, badge, defaultOpen = false, disabled = false, children }: {
  title: string;
  badge?: string | number | null;
  defaultOpen?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);

  return (
    <div className={`ui-section${open && !disabled ? " ui-section-open" : ""}${disabled ? " ui-section-disabled" : ""}`}>
      <button
        type="button"
        className="ui-section-toggle"
        onClick={disabled ? undefined : () => setOpen((v) => !v)}
        aria-expanded={open && !disabled}
        aria-disabled={disabled}
        style={disabled ? { cursor: "default" } : undefined}
      >
        <span className={`ui-section-arrow${open && !disabled ? " ui-section-arrow-open" : ""}`}>&#x25B8;</span>
        <span className="ui-section-title">{title}</span>
        {badge != null && <span className="ui-section-badge">{badge}</span>}
      </button>
      {open && !disabled && <div className="ui-section-body">{children}</div>}
    </div>
  );
}
