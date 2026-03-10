export function loadStoredTab<T extends string>(
  storageKey: string,
  allowedTabs: readonly T[],
  fallback: T
): T {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw && allowedTabs.some((tab) => tab === raw)) {
      return raw as T;
    }
  } catch {
    // ignore localStorage failures and fall back to the default tab
  }
  return fallback;
}

export function saveStoredTab(storageKey: string, value: string) {
  try {
    localStorage.setItem(storageKey, value);
  } catch {
    // ignore localStorage failures
  }
}
