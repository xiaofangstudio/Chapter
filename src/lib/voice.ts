/** 手机语音输入标点条：只负责一排短键，不铺满空白区。 */
export const VOICE_MARKS = ["，", "。", "？", "！", "、", "：", "；", "…", "“", "”", "（", "）"];
export const DEFAULT_VOICE_MARKS = ["，", "。", "？", "！", "、", "…"];

export function normalizeVoiceMarks(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [];
  const clean = list.filter((x): x is string => typeof x === "string" && VOICE_MARKS.includes(x));
  return Array.from(new Set(clean)).slice(0, 7);
}

export function readVoiceMarks(raw: string | null): string[] {
  if (!raw) return DEFAULT_VOICE_MARKS;
  try {
    const marks = normalizeVoiceMarks(JSON.parse(raw));
    return marks.length >= 2 ? marks : DEFAULT_VOICE_MARKS;
  } catch {
    return DEFAULT_VOICE_MARKS;
  }
}
