const CANCEL_KEYWORDS = /^(?:stop|cancel|never\s?mind|nevermind|nvm|forget\s?it|abort|quit)$/i;

export function isCancelIntent(text: string | null | undefined): boolean {
  if (!text) return false;
  return CANCEL_KEYWORDS.test(String(text).trim());
}
