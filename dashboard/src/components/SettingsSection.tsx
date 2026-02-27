import { useState } from "react";

export function SettingsSection({ title, active, defaultOpen = false, children }: {
  title: string;
  active?: boolean;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`settings-section${open ? " open" : ""}`}>
      <button type="button" className="section-toggle" onClick={() => setOpen((value) => !value)}>
        <span className="section-arrow">&#x25B8;</span>
        <span>{title}</span>
        {active !== undefined && <span className={`section-dot${active ? " on" : ""}`} />}
      </button>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}
