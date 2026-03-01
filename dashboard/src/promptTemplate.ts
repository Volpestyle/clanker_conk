const PROMPT_TEMPLATE_TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
export const SUPPORTED_PROMPT_TEMPLATE_VARIABLES = Object.freeze(["botName"]);

export function interpolatePromptTemplate(template, variables = {}) {
  const input = String(template || "");
  if (!input) return "";
  const normalizedVariables = normalizeTemplateVariables(variables);

  return input.replace(PROMPT_TEMPLATE_TOKEN_RE, (match, key) => {
    const normalizedKey = normalizeTemplateVariableName(key);
    if (!normalizedKey || !Object.prototype.hasOwnProperty.call(normalizedVariables, normalizedKey)) {
      return match;
    }
    return normalizedVariables[normalizedKey];
  });
}

export function collectPromptTemplateVariables(template) {
  const text = String(template || "");
  if (!text) return [];

  const seen = new Set();
  const out = [];
  for (const match of text.matchAll(PROMPT_TEMPLATE_TOKEN_RE)) {
    const key = normalizeTemplateVariableName(match?.[1]);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function collectUnsupportedPromptTemplateVariables(template) {
  const tokens = collectPromptTemplateVariables(template);
  const supported = new Set(
    SUPPORTED_PROMPT_TEMPLATE_VARIABLES.map((name) => normalizeTemplateVariableName(name))
  );
  return tokens.filter((token) => !supported.has(token));
}

function normalizeTemplateVariables(variables = {}) {
  const out = Object.create(null);
  if (!variables || typeof variables !== "object") return out;

  for (const [rawKey, rawValue] of Object.entries(variables)) {
    const key = normalizeTemplateVariableName(rawKey);
    if (!key) continue;
    out[key] = String(rawValue || "");
  }
  return out;
}

function normalizeTemplateVariableName(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}
