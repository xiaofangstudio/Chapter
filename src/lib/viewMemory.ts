/**
 * Lightweight scroll positions.
 *
 * Chapter switching, outline switching and reading a book outline all unmount
 * their scroll containers in this app. A user who peeks at the outline for one
 * second should come back to the exact same line, not the top of the chapter.
 *
 * sessionStorage is deliberate: it survives lazy-chunk boundaries and view
 * remounts, but resets when the app is closed, so reopening a book starts clean.
 */
const PREFIX = "chapter.scroll:";
const scrollPositions = new Map<string, number>();

export function rememberScroll(key: string, top: number) {
  if (!key) return;
  const value = Math.max(0, Math.round(top));
  scrollPositions.set(key, value);
  try {
    sessionStorage.setItem(PREFIX + key, String(value));
  } catch {
    /* 本机存储不可用时只保留内存值 */
  }
}

export function recallScroll(key: string): number {
  if (!key) return 0;
  try {
    const stored = sessionStorage.getItem(PREFIX + key);
    if (stored !== null) return Number(stored) || 0;
  } catch {
    /* 本机存储不可用 */
  }
  return scrollPositions.get(key) ?? 0;
}
