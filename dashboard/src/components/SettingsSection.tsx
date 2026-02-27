import React from "react";
export function SettingsSection({ id, title, active, children }: {
  id?: string;
  title: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div id={id} className="settings-section open">
      <div className="section-header">
        <span className="section-header-title">{title}</span>
        {active !== undefined && <span className={`section-dot${active ? " on" : ""}`} />}
      </div>
      <div className="section-body">{children}</div>
    </div>
  );
}
