const SKIP_PREFIXES = ["chapter.draft.", "chapter.snapshot."];
const MAX_BYTES = 2 * 1024 * 1024;

export interface AppDataPack {
  version: 1;
  entries: Record<string, string>;
}

/** 打包本机的全站改动：打卡日历、主题、语言、编辑器与漫画偏好都在这里。
 *  只跳过体量大的正文草稿/快照，它们属于书稿本身，由书目录同步。 */
export function collectAppData(): string | null {
  if (typeof localStorage === "undefined") return null;
  const entries: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith("chapter.")) continue;
    if (SKIP_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    const value = localStorage.getItem(key);
    if (value == null) continue;
    entries[key] = value;
  }
  const pack: AppDataPack = { version: 1, entries };
  const text = JSON.stringify(pack);
  return text.length <= MAX_BYTES ? text : null;
}

export function applyAppData(raw?: string | null): AppDataPack | null {
  if (!raw) return null;
  try {
    const pack = JSON.parse(raw) as AppDataPack;
    if (!pack || pack.version !== 1 || !pack.entries || typeof pack.entries !== "object") {
      return null;
    }
    for (const [key, value] of Object.entries(pack.entries)) {
      if (!key.startsWith("chapter.") || typeof value !== "string") continue;
      localStorage.setItem(key, value);
    }
    window.dispatchEvent(new CustomEvent("chapter:appdata", { detail: pack.entries }));
    return pack;
  } catch {
    return null;
  }
}
