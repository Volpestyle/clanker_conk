import React, { useState, useRef } from "react";
import { parseUniqueList } from "../../../src/settings/listNormalization.ts";

type UserIdTagInputProps = {
  label: string;
  hint: string;
  value: string;
  onChange: (e: { target: { value: string } }) => void;
  id?: string;
};

export function UserIdTagInput({ label, hint, value, onChange, id }: UserIdTagInputProps) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const ids = parseUniqueList(value);

  function commit(raw: string) {
    const incoming = parseUniqueList(raw);
    if (incoming.length === 0) return;
    const existing = new Set(ids);
    for (const id of incoming) existing.add(id);
    onChange({ target: { value: [...existing].join("\n") } });
    setDraft("");
  }

  function remove(target: string) {
    const next = ids.filter((id) => id !== target);
    onChange({ target: { value: next.join("\n") } });
  }

  function removeAll() {
    onChange({ target: { value: "" } });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit(draft);
    }
    if (e.key === "Backspace" && draft === "" && ids.length > 0) {
      remove(ids[ids.length - 1]);
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    if (text.includes(",") || text.includes("\n") || text.includes(" ")) {
      e.preventDefault();
      commit(text);
    }
  }

  return (
    <div className="uid-tag-input">
      <label className="uid-tag-label">{label}</label>
      <p className="uid-tag-hint">{hint}</p>
      <div className="uid-tag-box" onClick={() => inputRef.current?.focus()}>
        {ids.map((uid) => (
          <span key={uid} className="uid-tag">
            <span className="uid-tag-text">{uid}</span>
            <button
              type="button"
              className="uid-tag-remove"
              onClick={(e) => { e.stopPropagation(); remove(uid); }}
              aria-label={`Remove ${uid}`}
            >
              &times;
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          type="text"
          className="uid-tag-draft"
          placeholder={ids.length === 0 ? "Paste or type user IDs..." : ""}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={() => { if (draft.trim()) commit(draft); }}
        />
      </div>
      {ids.length > 0 && (
        <div className="uid-tag-footer">
          <span className="uid-tag-count">{ids.length} user{ids.length !== 1 ? "s" : ""}</span>
          <button type="button" className="uid-tag-clear" onClick={removeAll}>Clear all</button>
        </div>
      )}
    </div>
  );
}
