import type { ReactNode } from "react";

export function PanelHead({ title, children }: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="panel-head">
      <h3>{title}</h3>
      {children}
    </div>
  );
}
