import type { ReactNode } from "react";

export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={`collapse-wrap${open ? " open" : ""}`}>
      <div className="collapse-inner">{children}</div>
    </div>
  );
}
