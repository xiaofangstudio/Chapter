/** 字数：中文按字，拉丁按词，标点空白不计（与 Rust 侧口径一致）。 */
import { t } from "./i18n";

export function countWords(text: string): number {
  const cjk = text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g);
  const latin = text.match(/[A-Za-z0-9]+/g);
  return (cjk ? cjk.length : 0) + (latin ? latin.length : 0);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(s: string): string {
  // 先转义再上标记，避免正文里的尖括号被当成标签
  return escapeHtml(s.trim())
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
}

/** 受限 Markdown → 编辑器 HTML（只支持正文会用到的几种语法）。 */
export function mdToHtml(md: string): string {
  if (!md.trim()) return "<p><br></p>";
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let quote: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(inline).join("<br>")}</p>`);
      para = [];
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote><p>${quote.map(inline).join("<br>")}</p></blockquote>`);
      quote = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (!t) {
      flushPara();
      flushQuote();
      continue;
    }
    if (t === "---" || t === "***") {
      flushPara();
      flushQuote();
      out.push("<hr>");
      continue;
    }
    if (line.startsWith("> ")) {
      flushPara();
      quote.push(line.slice(2));
      continue;
    }
    if (/^- /.test(line)) {
      flushPara();
      flushQuote();
      out.push(`<ul><li>${inline(line.slice(2))}</li></ul>`);
      continue;
    }
    const h = /^(#{1,6}) (.*)$/.exec(t);
    if (h) {
      flushPara();
      flushQuote();
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    flushQuote();
    para.push(line);
  }
  flushPara();
  flushQuote();
  return out.join("\n") || "<p><br></p>";
}

function inlineToMd(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\u00a0/g, " ");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName;
  if (tag === "BR") return "\n";
  const inner = Array.from(el.childNodes).map(inlineToMd).join("");
  if (tag === "STRONG" || tag === "B") return `**${inner}**`;
  if (tag === "EM" || tag === "I") return `*${inner}*`;
  return inner;
}

function blockToMd(el: Element): string {
  const tag = el.tagName;
  if (tag === "P" || tag === "DIV" || tag === "SECTION" || tag === "ARTICLE") {
    return Array.from(el.childNodes).map(inlineToMd).join("").trim();
  }
  if (tag === "HR") return "---";
  if (tag === "BLOCKQUOTE") {
    const text = Array.from(el.childNodes)
      .map((n) => (n.nodeType === Node.ELEMENT_NODE ? blockToMd(n as Element) : inlineToMd(n)))
      .join("\n")
      .trim();
    return text
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
  }
  if (/^H[1-6]$/.test(tag)) {
    return `${"#".repeat(Number(tag[1]))} ${Array.from(el.childNodes).map(inlineToMd).join("").trim()}`;
  }
  if (tag === "UL" || tag === "OL") {
    const items = Array.from(el.children).map((li, i) => {
      const text = Array.from(li.childNodes).map(inlineToMd).join("").trim();
      return tag === "OL" ? `${i + 1}. ${text}` : `- ${text}`;
    });
    return items.join("\n");
  }
  return Array.from(el.childNodes).map(inlineToMd).join("").trim();
}

/** 编辑器 HTML → 受限 Markdown（存盘与导出的正文格式）。 */
export function htmlToMd(root: HTMLElement): string {
  const blocks: string[] = [];
  Array.from(root.childNodes).forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? "").trim();
      if (t) blocks.push(t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    // 浏览器有时会把块级元素塞成 div 包 div，这里拍平一层
    if (el.tagName === "DIV" && el.children.length === 1 && el.firstElementChild) {
      const only = el.firstElementChild;
      if (/^(P|DIV|BLOCKQUOTE|UL|OL|HR|H[1-6])$/.test(only.tagName)) {
        const md = blockToMd(only);
        if (md.trim()) blocks.push(md.trim());
        return;
      }
    }
    const md = blockToMd(el);
    if (md.trim()) blocks.push(md.trim());
  });
  return blocks.join("\n\n").replace(/\u00a0/g, " ");
}

export function plainText(md: string): string {
  return md
    .replace(/^#{1,6} /gm, "")
    .replace(/^> /gm, "")
    .replace(/^[-*] /gm, "")
    .replace(/^\d+\. /gm, "")
    .replace(/[*_`]/g, "")
    .replace(/^---$/gm, "");
}

export function fmtNumber(n: number): string {
  const locale = document.documentElement.lang || "zh-CN";
  return n.toLocaleString(locale);
}

export function fmtWords(n: number): string {
  const locale = document.documentElement.lang || "zh-CN";
  if (locale.startsWith("zh")) {
    if (n >= 10000) {
      const w = n / 10000;
      return `${w >= 100 ? Math.round(w) : w.toFixed(1).replace(/\.0$/, "")} 万`;
    }
    return `${n}`;
  }
  // 其他语言用各自的紧凑数字单位（K/M、万、천等），避免界面里突然出现中文“万”。
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}

export function dateKey(d = new Date()): string {
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fmtTime(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const locale = document.documentElement.lang || "zh-CN";
  const now = new Date();
  const sameDay = dateKey(d) === dateKey(now);
  const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `${t("今天")} ${time}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear
    ? `${d.toLocaleDateString(locale, { month: "short", day: "numeric" })} ${time}`
    : d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

export function relTime(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return t("刚刚");
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} ${t("分钟前")}`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ${t("小时前")}`;
  return fmtTime(ms);
}

/** 由书名稳定派生一个暖色，用在没上传封面的书上。 */
export function coverTone(seed: string): { from: string; to: string; ink: string } {
  const palettes = [
    { from: "#e8a35c", to: "#c96a1f", ink: "#fff8ec" },
    { from: "#dcaf6b", to: "#a4661f", ink: "#fffaf0" },
    { from: "#e59b7a", to: "#b8562b", ink: "#fff7f1" },
    { from: "#d9a95a", to: "#8f5a1b", ink: "#fff9ee" },
    { from: "#e9b874", to: "#c07a2a", ink: "#fffdf6" },
  ];
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 9973;
  return palettes[h % palettes.length];
}

export function bookInitial(title: string): string {
  const t = title.trim();
  if (!t) return "书";
  // 取第一个汉字/字母，去掉「第」「的」这类高频虚字会更像封面
  return Array.from(t).find((c) => /[\u4e00-\u9fffA-Za-z0-9]/.test(c)) ?? "书";
}
