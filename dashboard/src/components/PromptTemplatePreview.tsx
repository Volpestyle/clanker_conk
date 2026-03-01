import React from "react";
import {
  collectPromptTemplateVariables,
  collectUnsupportedPromptTemplateVariables,
  interpolatePromptTemplate
} from "../promptTemplate";

export function PromptTemplatePreview({ value, botName }) {
  const template = String(value || "");
  const tokens = collectPromptTemplateVariables(template);
  if (!tokens.length) return null;

  const unknownTokens = collectUnsupportedPromptTemplateVariables(template);
  const resolvedBotName = String(botName || "").trim() || "clanker conk";
  const preview = interpolatePromptTemplate(template, {
    botName: resolvedBotName
  });
  const unknownList = unknownTokens.map((token) => `{{${token}}}`).join(", ");

  return (
    <div className="prompt-template-preview-wrap">
      <p className="prompt-template-preview-meta">
        Preview
      </p>
      {unknownTokens.length > 0 && (
        <p className="prompt-template-preview-warning">
          Unknown variables are left unchanged: <code>{unknownList}</code>
        </p>
      )}
      <pre className="prompt-template-preview">{preview || "(empty)"}</pre>
    </div>
  );
}
