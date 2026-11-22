export interface ImportMarker {
  pos: number;
  title: string;
  volume: boolean;
}

export interface ImportSection {
  title: string;
  body: string;
  volumeTitle: string;
}

export interface ScanRules {
  /** 数字后面的章节后缀，如 章 / 回 / 节 / 幕 */
  chapterWords: string[];
  /** 数字后面的卷后缀，如 卷 / 部 / 篇 */
  volumeWords: string[];
  /** 不带数字的独立标题，如 序章 / 楔子 / 尾声 */
  specialWords: string[];
}

export interface DocMetaGuess {
  title?: string;
  author?: string;
}

const RULES_KEY = "chapter.scanRules";

export const DEFAULT_SCAN_RULES: ScanRules = {
  chapterWords: ["章", "回", "节"],
  volumeWords: ["卷", "部", "篇"],
  specialWords: ["序章", "序言", "楔子", "引子", "尾声", "后记", "番外", "终章"],
};

const CN_NUM = "0-9０-９一二三四五六七八九十百千零〇两";

function normalizeWords(input: unknown, fallback: string[]): string[] {
  if (!Array.isArray(input)) return fallback;
  const out = input
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && x.length <= 12);
  return out.length ? Array.from(new Set(out)) : fallback;
}

export function readScanRules(): ScanRules {
  try {
    const raw = localStorage.getItem(RULES_KEY);
    const saved = raw ? JSON.parse(raw) : null;
    return {
      chapterWords: normalizeWords(saved?.chapterWords, DEFAULT_SCAN_RULES.chapterWords),
      volumeWords: normalizeWords(saved?.volumeWords, DEFAULT_SCAN_RULES.volumeWords),
      specialWords: normalizeWords(saved?.specialWords, DEFAULT_SCAN_RULES.specialWords),
    };
  } catch {
    return DEFAULT_SCAN_RULES;
  }
}

export function writeScanRules(rules: ScanRules): ScanRules {
  const clean: ScanRules = {
    chapterWords: normalizeWords(rules.chapterWords, DEFAULT_SCAN_RULES.chapterWords),
    volumeWords: normalizeWords(rules.volumeWords, DEFAULT_SCAN_RULES.volumeWords),
    specialWords: normalizeWords(rules.specialWords, DEFAULT_SCAN_RULES.specialWords),
  };
  try {
    localStorage.setItem(RULES_KEY, JSON.stringify(clean));
  } catch {
    /* 本地存不下时本次仍用内存规则 */
  }
  return clean;
}

function wordsRegex(words: string[]): string {
  return words
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length)
    .join("|");
}

function regexes(rules: ScanRules) {
  const chapter = wordsRegex(rules.chapterWords);
  const volume = wordsRegex(rules.volumeWords);
  const special = wordsRegex(rules.specialWords);
  return {
    volume: new RegExp(`^\\s*第[${CN_NUM}]+(?:${volume})\\s*[、：:.\\-—]?\\s*.*$`),
    chapter: new RegExp(`^\\s*第[${CN_NUM}]+(?:${chapter})\\s*[、：:.\\-—]?\\s*.*$`),
    special: special ? new RegExp(`^\\s*(?:${special})\\s*[、：:.\\-—]?\\s*.*$`) : null,
    enVolume: /^\s*(volume|book)\s+[0-9ivxlc]+.*$/i,
    enChapter: /^\s*(chapter|part)\s+[0-9ivxlc]+.*$/i,
  };
}

export function isVolumeTitle(title: string, rules: ScanRules = readScanRules()): boolean {
  const r = regexes(rules);
  return r.volume.test(title) || r.enVolume.test(title);
}

export function isChapterTitle(title: string, rules: ScanRules = readScanRules()): boolean {
  const r = regexes(rules);
  return r.chapter.test(title) || r.enChapter.test(title) || (r.special?.test(title) ?? false);
}

/** 一行字符串是否像标题（不是正文段落）。 */
function headingOf(line: string, rules: ScanRules): { title: string; volume: boolean } | null {
  const raw = line.trim();
  if (!raw) return null;
  const md = /^(#{1,6})\s+(.+)$/.exec(raw);
  if (md) {
    const title = md[2].trim();
    if (!title) return null;
    return { title, volume: isVolumeTitle(title, rules) };
  }
  if (raw.length > 64) return null;
  const r = regexes(rules);
  if (r.volume.test(raw) || r.enVolume.test(raw)) return { title: raw, volume: true };
  if (r.chapter.test(raw) || r.enChapter.test(raw) || (r.special?.test(raw) ?? false)) {
    return { title: raw, volume: false };
  }
  return null;
}

/** 自动扫描章节边界：Markdown 标题、第 X 章/回/节、Chapter N、序章/楔子/尾声。 */
export function detectMarkers(text: string, rules: ScanRules = readScanRules()): ImportMarker[] {
  const markers: ImportMarker[] = [];
  let offset = 0;
  let firstNonEmptySeen = false;
  for (const line of text.split("\n")) {
    const h = headingOf(line, rules);
    if (h) {
      const isMdH1 = /^#\s+/.test(line.trim());
      // 文档最开头的「# 书名」不当章节，留给正文标题。
      const looksLikeDocTitle =
        isMdH1 && !firstNonEmptySeen && markers.length === 0 && /^\s*#\s+/.test(line);
      if (!looksLikeDocTitle) {
        markers.push({ pos: offset, title: h.title.replace(/^#+\s*/, ""), volume: h.volume });
      }
    }
    if (line.trim()) firstNonEmptySeen = true;
    offset += line.length + 1;
  }
  return markers;
}

/** 从正文开头抓书名、作者，只在导入时作默认值，用户仍可手改。 */
export function detectDocMeta(text: string): DocMetaGuess {
  const head = text.slice(0, 4000);
  const lines = head.split("\n").slice(0, 60);
  let title: string | undefined;
  let author: string | undefined;

  for (const line of lines) {
    const value = line.replace(/\u3000/g, " ").trim();
    if (!value) continue;
    if (!title && /^(书名|作品名|小说名|title)\s*[：:]/i.test(value)) {
      const t = value.replace(/^(书名|作品名|小说名|title)\s*[：:]\s*/i, "").trim();
      if (t.length >= 1 && t.length <= 80) title = t;
    }
    if (!author && /^(作者|作\s*者|著者|author|by)\s*[：:]/i.test(value)) {
      const a = value.replace(/^(作者|作\s*者|著者|author|by)\s*[：:]\s*/i, "").trim();
      if (a.length >= 1 && a.length <= 60) author = a;
    }
  }

  // 第一行 Markdown 一级标题通常是书名，不参与章节扫描。
  if (!title) {
    for (const line of lines.slice(0, 8)) {
      const m = /^#\s+(.+)$/.exec(line.trim());
      if (m && m[1].trim().length >= 1 && m[1].trim().length <= 80) {
        title = m[1].trim();
        break;
      }
    }
  }

  // 「书名 · 某某 著」或「某某 著」这类常见写法，避免误吞正文。
  if (!author) {
    for (const line of lines.slice(0, 20)) {
      const value = line.trim();
      const m = /^(.{1,40})\s*(?:著|编著|原著)\s*$/.exec(value);
      if (m) {
        const a = m[1].replace(/^(作者|作\s*者)\s*[：:]\s*/, "").trim();
        if (a.length >= 1 && a.length <= 40 && !/^\s*(第|序|楔|引|尾|后|番)/.test(a)) {
          author = a;
          break;
        }
      }
    }
  }

  return { title, author };
}

function lineEnd(text: string, pos: number): number {
  const nl = text.indexOf("\n", pos);
  return nl < 0 ? text.length : nl;
}

/** 开头常是书名、作者、来源等抬头；这种文字不能自动变成「前言」章节。 */
function looksLikeDocHeader(text: string): boolean {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\u3000/g, " ").trim())
    .filter(Boolean);
  if (lines.length === 0) return true;
  if (lines.length > 4) return false;
  return lines.every(
    (l) =>
      /^(书名|作品名|小说名|title|作者|作\s*者|著者|author|by|来源|简介|简介：|字数|标签)\s*[：:]/i.test(l) ||
      /^#\s+/.test(l) ||
      /^(.{1,40})\s*(?:著|编著|原著)$/.test(l) ||
      l.length <= 18,
  );
}

export function buildSections(text: string, markers: ImportMarker[]): ImportSection[] {
  const sorted = [...markers]
    .filter((m) => m.pos >= 0 && m.pos <= text.length && m.title.trim())
    .sort((a, b) => a.pos - b.pos);
  const sections: ImportSection[] = [];
  let volume = "卷前";
  let chapterNo = 0;

  const push = (title: string, body: string, vol: string) => {
    const clean = body.trim();
    // 只有标题、没有正文的扫描结果不再变成空章节。
    if (!clean) return;
    sections.push({
      title: title.trim() || `第${chapterNo + 1}章`,
      body: clean,
      volumeTitle: vol,
    });
    chapterNo += 1;
  };

  // 第一个标题之前的文字：像书名的抬头直接丢弃，确有正文才收成「前言」。
  if (sorted.length > 0) {
    const preface = text.slice(0, sorted[0].pos).trim();
    if (preface.length > 40 && !looksLikeDocHeader(preface)) push("前言", preface, volume);
  }

  for (let i = 0; i < sorted.length; i += 1) {
    const m = sorted[i];
    if (m.volume) {
      volume = m.title.trim() || `第${sections.length + 1}卷`;
      continue;
    }
    const start = lineEnd(text, m.pos);
    const end = i + 1 < sorted.length ? sorted[i + 1].pos : text.length;
    const body = text.slice(Math.min(start + 1, text.length), end);
    push(m.title, body, volume);
  }

  if (sections.length === 0) push("全文", text, volume);
  return sections;
}

export function countChapters(sections: ImportSection[]): number {
  return sections.length;
}
