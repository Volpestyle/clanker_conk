import { test } from "bun:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsForm from "./SettingsForm.tsx";

function renderForm(props) {
  return renderToStaticMarkup(
    React.createElement(SettingsForm, props)
  );
}

test("SettingsForm renders nothing when settings are unavailable", () => {
  const html = renderForm({
    settings: null,
    modelCatalog: {},
    onSave() {},
    toast: { text: "", type: "ok" }
  });
  assert.equal(html, "");
});

test("SettingsForm renders sectioned settings layout when settings are provided", () => {
  const html = renderForm({
    settings: {
      botName: "clanker conk"
    },
    modelCatalog: {
      openai: ["gpt-4.1-mini"]
    },
    onSave() {},
    toast: { text: "saved", type: "ok" }
  });

  assert.equal(html.includes("settings-title"), true);
  assert.equal(html.includes(">Settings<"), true);
  assert.equal(html.includes("settings-sidebar"), true);
  assert.equal(html.includes("Core Behavior"), true);
  assert.equal(html.includes("Save settings"), true);
});
