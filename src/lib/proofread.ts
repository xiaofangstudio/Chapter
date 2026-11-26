import { pinyin } from "pinyin-pro";
import type {
  ProofreadConfig,
  ProofreadIssue,
  ProofreadTerm,
} from "../types";

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const TERM_LIMIT = 300;
const ISSUE_LIMIT = 2000;

type CharKey = { none: string; tone: string } | null;

const charCache = new Map<string, CharKey>();

function charKey(ch: string): CharKey {
  if (!HAN.test(ch)) return null;
  const cached = charCache.get(ch);
  if (cached !== undefined) return cached;
  let key: CharKey = null;
  try {
    const none = pinyin(ch, { toneType: "none", type: "array", nonZh: "consecutive" })[0] ?? "";
    const tone = pinyin(ch, { toneType: "num", type: "array", nonZh: "consecutive" })[0] ?? "";
    key = none && tone ? { none, tone } : null;
  } catch {
    key = null;
  }
  charCache.set(ch, key);
  return key;
}

export function defaultProofread(): ProofreadConfig {
  return {
    version: 1,
    enabled: true,
    terms: [],
    punctuation: {
      enabled: true,
      rules: {
        halfWidth: true,
        quotes: true,
        ellipsis: true,
        duplicates: true,
      },
    },
    ignored: [],
  };
}

export function normalizeProofread(raw: unknown): ProofreadConfig {
  const base = defaultProofread();
  if (!raw || typeof raw !== "object") return base;
  const value = raw as Partial<ProofreadConfig>;
  const terms = Array.isArray(value.terms)
    ? value.terms
        .filter((t): t is ProofreadTerm => !!t && typeof t.text === "string" && t.text.trim().length > 0)
        .slice(0, TERM_LIMIT)
        .map((t, i) => ({
          id: typeof t.id === "string" && t.id ? t.id : `term_${i}_${Date.now()}`,
          text: t.text.trim(),
          enabled: t.enabled !== false,
          note: typeof t.note === "string" ? t.note : "",
          createdAt: Number(t.createdAt) || 0,
          updatedAt: Number(t.updatedAt) || 0,
        }))
    : [];
  const punctuation = value.punctuation;
  return {
    version: 1,
    enabled: value.enabled !== false,
    terms,
    punctuation: {
      enabled: punctuation?.enabled !== false,
      rules: {
        halfWidth: punctuation?.rules?.halfWidth !== false,
        quotes: punctuation?.rules?.quotes !== false,
        ellipsis: punctuation?.rules?.ellipsis !== false,
        duplicates: punctuation?.rules?.duplicates !== false,
      },
    },
    ignored: Array.isArray(value.ignored)
      ? value.ignored
          .filter((x) => !!x && typeof x.termId === "string" && typeof x.contextHash === "string")
          .map((x) => ({
            termId: x.termId,
            contextHash: x.contextHash,
            span: Array.isArray(x.span) ? [Number(x.span[0]) || 0, Number(x.span[1]) || 0] : [0, 0],
          }))
      : [],
  };
}

export function pinyinPreview(text: string): string {
  try {
    return pinyin(text, { toneType: "symbol", type: "array", nonZh: "consecutive" })
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function hashContext(text: string, start: number, end: number): string {
  const left = text.slice(Math.max(0, start - 12), start);
  const right = text.slice(end, Math.min(text.length, end + 12));
  const raw = `${left}\u0001${text.slice(start, end)}\u0001${right}`;
  let h = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function termKeys(term: ProofreadTerm): (CharKey[] | null) {
  const chars = Array.from(term.text);
  const keys: CharKey[] = [];
  for (const ch of chars) {
    const key = charKey(ch);
    if (!key) return null;
    keys.push(key);
  }
  return keys;
}

function ignoredAt(config: ProofreadConfig, termId: string, hash: string) {
  return config.ignored.some((x) => x.termId === termId && x.contextHash === hash);
}

function pushIssue(list: ProofreadIssue[], issue: ProofreadIssue) {
  if (list.length >= ISSUE_LIMIT) return;
  // 一个位置只留一条，词语优先于标点；长规则（省略号）优先于短半角标点。
  const hit = list.find(
    (x) =>
      (x.start === issue.start && x.end === issue.end) ||
      (x.kind === "punctuation" && issue.kind === "punctuation" && x.start === issue.start && x.end > issue.end),
  );
  if (hit) {
    if (hit.kind === "punctuation" && issue.kind === "term") list[list.indexOf(hit)] = issue;
    return;
  }
  list.push(issue);
}

export interface ScanOptions {
  minTermLength?: number;
  allowSingle?: boolean;
  limit?: number;
}

/**
 * 本地扫描：先看本书词库的同音/近音，再看标点。
 * 纯函数，不联网；Wordbook 为空时词库检查完全跳过，避免通用词典乱报。
 */
export function scanProofread(text: string, config: ProofreadConfig, opts: ScanOptions = {}): ProofreadIssue[] {
  const issues: ProofreadIssue[] = [];
  const minLen = Math.max(1, opts.minTermLength ?? 2);
  const allowSingle = opts.allowSingle ?? false;
  const terms = config.terms.filter((t) => {
    if (!t.enabled) return false;
    const len = Array.from(t.text).length;
    if (len < minLen) return false;
    if (len === 1 && !allowSingle) return false;
    return true;
  });

  if (terms.length) {
    type Cached = { term: ProofreadTerm; keys: CharKey[] };
    const byFirst = new Map<string, Cached[]>();
    for (const term of terms) {
      const keys = termKeys(term);
      if (!keys) continue;
      const first = keys[0]?.none;
      if (!first) continue;
      const bucket = byFirst.get(first) ?? [];
      bucket.push({ term, keys });
      byFirst.set(first, bucket);
    }

    for (let i = 0; i < text.length; i += 1) {
      const k = charKey(text[i]);
      if (!k) continue;
      const bucket = byFirst.get(k.none);
      if (!bucket) continue;
      for (const item of bucket) {
        const chars = Array.from(item.term.text);
        const end = i + chars.length;
        if (end > text.length) continue;
        const window = text.slice(i, end);
        if (window === item.term.text) continue;
        let sameNone = true;
        let sameTone = true;
        for (let j = 0; j < chars.length; j += 1) {
          const tk = charKey(window[j]);
          if (!tk) {
            sameNone = false;
            break;
          }
          if (tk.none !== item.keys[j]!.none) {
            sameNone = false;
            break;
          }
          if (tk.tone !== item.keys[j]!.tone) sameTone = false;
        }
        if (!sameNone) continue;
        if (chars.length === 1 && !sameTone) continue;
        const hash = hashContext(text, i, end);
        if (ignoredAt(config, item.term.id, hash)) continue;
        pushIssue(issues, {
          id: `t_${i}_${item.term.id}`,
          kind: "term",
          start: i,
          end,
          text: window,
          message: sameTone ? "同音，可能是错字" : "近音，可能是错字",
          suggestions: [item.term.text],
          confidence: sameTone ? "high" : "normal",
          termId: item.term.id,
          rule: "term",
        });
      }
      if (issues.length >= ISSUE_LIMIT) break;
    }
  }

  const rules = config.punctuation;
  if (rules.enabled) {
    const add = (start: number, end: number, textNow: string, suggestions: string[], message: string, rule: string) => {
      pushIssue(issues, {
        id: `p_${rule}_${start}`,
        kind: "punctuation",
        start,
        end,
        text: textNow,
        message,
        suggestions,
        confidence: "high",
        rule,
      });
    };

    if (rules.rules.ellipsis) {
      const re = /\.{3,}|。{3,}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const s = m.index;
        const e = s + m[0].length;
        if (/[\u4e00-\u9fff]/.test(text.slice(Math.max(0, s - 1), s)) || /[\u4e00-\u9fff]/.test(text.slice(e, e + 1))) {
          add(s, e, m[0], ["……"], "中文省略号应写成 ……", "ellipsis");
        }
      }
    }

    if (rules.rules.duplicates) {
      const re = /([，。！？；：,.?!;:])\1+/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const s = m.index;
        const e = s + m[0].length;
        const ch = m[1];
        const full = ",.?!;:".includes(ch)
          ? ({ ",": "，", ".": "。", "?": "？", "!": "！", ";": "；", ":": "：" } as Record<string, string>)[ch]
          : ch;
        add(s, e, m[0], [full ?? ch], "连续重复标点，建议合并", "duplicates");
      }
    }

    if (rules.rules.halfWidth) {
      const map: Record<string, string> = {
        ",": "，",
        ".": "。",
        "?": "？",
        "!": "！",
        ";": "；",
        ":": "：",
        "(": "（",
        ")": "）",
      };
      const re = /[\u4e00-\u9fff][,\.\?\!\;\:\(\)]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const s = m.index + 1;
        const e = s + 1;
        const ch = text[s];
        // 小数点、网址、英文缩写不碰
        if (ch === "." && /\d/.test(text[s + 1] ?? "")) continue;
        const full = map[ch];
        if (!full) continue;
        add(s, e, ch, [full], "中文里的半角标点，建议改全角", "halfWidth");
      }
    }

    if (rules.rules.quotes) {
      // 每段单独配对，避免上一段遗留引号把下一段带偏。
      const paragraphs = text.split(/\n{2,}/);
      let base = 0;
      for (const para of paragraphs) {
        const openCurly = (para.match(/“/g) ?? []).length;
        const closeCurly = (para.match(/”/g) ?? []).length;
        if (openCurly !== closeCurly) {
          const at = openCurly > closeCurly ? para.lastIndexOf("“") : para.lastIndexOf("”");
          const abs = base + Math.max(0, at);
          add(abs, abs + 1, text.slice(abs, abs + 1), [], "中文引号没有配对", "quotes");
        }
        const openParen = (para.match(/（/g) ?? []).length;
        const closeParen = (para.match(/）/g) ?? []).length;
        if (openParen !== closeParen) {
          const at = openParen > closeParen ? para.lastIndexOf("（") : para.lastIndexOf("）");
          const abs = base + Math.max(0, at);
          add(abs, abs + 1, text.slice(abs, abs + 1), [], "括号没有配对", "quotes");
        }
        base += para.length + 2;
      }
    }
  }

  return issues.sort((a, b) => a.start - b.start).slice(0, opts.limit ?? ISSUE_LIMIT);
}

/** 编辑器里取文字，跳过正在输入法组合的状态由调用方控制。 */
export function editorText(root: HTMLElement | null): string {
  return root?.textContent ?? "";
}

/** UTF-16 偏移 → DOM Range，供 CSS Highlight 和替换共用。 */
export function rangeFromOffsets(root: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let startNode: Node | null = null;
  let startOffset = 0;
  let endNode: Node | null = null;
  let endOffset = 0;
  let node = walker.nextNode();
  while (node) {
    const text = node.textContent ?? "";
    const next = offset + text.length;
    if (!startNode && start >= offset && start <= next) {
      startNode = node;
      startOffset = start - offset;
    }
    if (startNode && end >= offset && end <= next) {
      endNode = node;
      endOffset = end - offset;
      break;
    }
    offset = next;
    node = walker.nextNode();
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  try {
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  } catch {
    return null;
  }
}

/** 一次遍历建立所有 Range，避免 2000 条建议各自再走一遍 DOM。 */
export function buildIssueRanges(root: HTMLElement, issues: ProofreadIssue[]): Map<string, Range> {
  const out = new Map<string, Range>();
  const segments: { node: Text; start: number; end: number }[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let node = walker.nextNode();
  while (node) {
    const text = node.textContent ?? "";
    segments.push({ node: node as Text, start: offset, end: offset + text.length });
    offset += text.length;
    node = walker.nextNode();
  }
  let si = 0;
  for (const issue of issues) {
    while (si < segments.length && segments[si].end < issue.start) si += 1;
    const first = segments[si];
    if (!first || issue.start < first.start) continue;
    // 跨节点的问题很少见（编辑器换行可能拆节点），逐段取。
    let endSeg = si;
    while (endSeg < segments.length && segments[endSeg].end < issue.end) endSeg += 1;
    const last = segments[endSeg];
    if (!last) continue;
    const range = document.createRange();
    try {
      range.setStart(first.node, Math.max(0, issue.start - first.start));
      range.setEnd(last.node, Math.max(0, Math.min(last.end, issue.end) - last.start));
      out.set(issue.id, range);
    } catch {
      /* 跳过无法映射的问题 */
    }
  }
  return out;
}

export function caretOffset(root: HTMLElement): number | null {  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !root.contains(sel.anchorNode)) return null;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(sel.anchorNode, sel.anchorOffset);
  return range.toString().length;
}

export function issueAt(issues: ProofreadIssue[], offset: number): ProofreadIssue | null {
  return issues.find((x) => offset >= x.start && offset <= x.end) ?? null;
}

type HighlightCtor = new (...ranges: Range[]) => unknown;

/** CSS Custom Highlight API；不支持时静默退回列表模式，绝不改正文 DOM。 */
export function paintHighlights(issues: ProofreadIssue[], ranges: Map<string, Range>) {
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const Highlight = (window as unknown as { Highlight?: HighlightCtor }).Highlight;
  if (!registry || !Highlight) return false;
  const term: Range[] = [];
  const punct: Range[] = [];
  for (const issue of issues) {
    const r = ranges.get(issue.id);
    if (!r) continue;
    if (issue.kind === "term") term.push(r);
    else punct.push(r);
  }
  try {
    if (term.length) registry.set("chapter-proof-term", new Highlight(...term));
    else registry.delete("chapter-proof-term");
    if (punct.length) registry.set("chapter-proof-punct", new Highlight(...punct));
    else registry.delete("chapter-proof-punct");
    return true;
  } catch {
    return false;
  }
}

export function clearHighlights() {
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  registry?.delete("chapter-proof-term");
  registry?.delete("chapter-proof-punct");
}

export function replaceRange(root: HTMLElement, issue: ProofreadIssue, value: string): boolean {
  const range = rangeFromOffsets(root, issue.start, issue.end);
  if (!range) return false;
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  root.focus();
  try {
    document.execCommand("insertText", false, value);
    return true;
  } catch {
    return false;
  }
}

export function addIgnore(config: ProofreadConfig, issue: ProofreadIssue, text: string): ProofreadConfig {
  if (!issue.termId) return config;
  const hash = hashContext(text, issue.start, issue.end);
  if (config.ignored.some((x) => x.termId === issue.termId && x.contextHash === hash)) return config;
  return {
    ...config,
    ignored: [...config.ignored, { termId: issue.termId, contextHash: hash, span: [issue.start, issue.end] }],
  };
}
