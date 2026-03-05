import { useState } from "react";

export function CopyButton({ text, label }: { text: string; label?: boolean }) {
  const [copied, setCopied] = useState(false);

  function copy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <button type="button" className="copy-btn" onClick={copy} title="Copy to clipboard">
      {copied ? (label ? "\u2713 Copied" : "\u2713") : (label ? "Copy" : "\u2398")}
    </button>
  );
}
