import type { BookMeta, NumberingRule, Outline } from "../types";

const CN_DIGITS = "零一二三四五六七八九";

export function chineseNumber(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  const num = Math.floor(n);
  if (num === 0) return "零";
  if (num > 9999) return String(num);
  const units = ["", "十", "百", "千"];
  const digits = String(num).split("").map((x) => Number(x));
  let out = "";
  let zero = false;
  digits.forEach((d, i) => {
    const pos = digits.length - i - 1;
    if (d === 0) {
      zero = true;
      return;
    }
    if (zero && out) out += "零";
    zero = false;
    // 10–19 习惯读“十一”，不读“一十一”
    if (!(d === 1 && pos === 1 && !out)) out += CN_DIGITS[d];
    out += units[pos];
  });
  return out;
}

export function defaultNumbering(meta?: Partial<BookMeta>): NumberingRule {
  return meta?.kind === "comic"
    ? { unit: "hui", style: "arabic", pattern: "第{n}话", startAt: 1, perVolumeRestart: false }
    : { unit: "chapter", style: "arabic", pattern: "第{n}章", startAt: 1, perVolumeRestart: false };
}

export function normalizeNumbering(rule: NumberingRule | undefined, meta?: Partial<BookMeta>): NumberingRule {
  const base = defaultNumbering(meta);
  if (!rule) return base;
  return {
    unit: rule.unit === "hui" || rule.unit === "volume" ? rule.unit : "chapter",
    style: rule.style === "chinese" ? "chinese" : "arabic",
    pattern: rule.pattern?.trim() || base.pattern,
    startAt: Math.max(0, Math.floor(Number(rule.startAt) || 1)),
    perVolumeRestart: !!rule.perVolumeRestart,
    specialPrefix: rule.specialPrefix?.trim() || undefined,
  };
}

export function formatChapterTitle(
  rule: NumberingRule,
  globalIndex: number,
  volumeIndex: number,
): string {
  const start = rule.startAt || 1;
  const n = start + (rule.perVolumeRestart ? volumeIndex : globalIndex);
  const shown = rule.style === "chinese" ? chineseNumber(n) : String(n);
  const pattern = rule.pattern || "第{n}章";
  const applied = pattern.includes("{n}") ? pattern.replace(/\{n\}/g, shown) : `${pattern}${shown}`;
  return rule.specialPrefix ? `${rule.specialPrefix}${applied}` : applied;
}

export function previewRenumber(outline: Outline, rule: NumberingRule): { id: string; from: string; to: string }[] {
  const out: { id: string; from: string; to: string }[] = [];
  let global = 0;
  outline.volumes.forEach((vol) => {
    vol.chapters.forEach((ch, vi) => {
      const to = formatChapterTitle(rule, global, vi);
      if (ch.title.trim() !== to) out.push({ id: ch.id, from: ch.title, to });
      global += 1;
    });
  });
  return out;
}

export function applyRenumber(outline: Outline, rule: NumberingRule): Outline {
  const targets = new Map(previewRenumber(outline, rule).map((x) => [x.id, x.to]));
  return {
    volumes: outline.volumes.map((vol) => ({
      ...vol,
      chapters: vol.chapters.map((ch) => (targets.has(ch.id) ? { ...ch, title: targets.get(ch.id)! } : ch)),
    })),
  };
}

export function nextChapterTitle(outline: Outline, rule: NumberingRule): string {
  const global = outline.volumes.reduce((n, v) => n + v.chapters.length, 0);
  const lastVol = outline.volumes[outline.volumes.length - 1];
  const volumeIndex = lastVol?.chapters.length ?? 0;
  return formatChapterTitle(rule, global, volumeIndex);
}

export function numberingUnitLabel(rule: NumberingRule): string {
  return rule.unit === "hui" ? "话" : rule.unit === "volume" ? "卷" : "章";
}

export function footnoteRef(n: number): string {
  return `[^${n}]`;
}
