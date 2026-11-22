/** 字数：中文按字，拉丁按词，标点空白不计（与 Rust 侧口径一致）。 */
import { t } from "./i18n";

export function countWords(text: string): number {
  // 长章节热路径：不分配 100 万个 match 结果数组，逐码点扫描。
  let count = 0;
  let inLatin = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    const isCjk =
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0x3040 && c <= 0x30ff) ||
      (c >= 0xac00 && c <= 0xd7af);
    const isLatin =
      (c >= 48 && c <= 57) ||
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122);
    if (isCjk) {
      count += 1;
      inLatin = false;
    } else if (isLatin) {
      if (!inLatin) count += 1;
      inLatin = true;
    } else {
      inLatin = false;
    }
  }
  return count;
}

/**
 * 超长章节的分片字数统计：按块取 textContent，每 6ms 让出一次主线程。
 * 既避免一次 60ms 长任务，也避免 content-visibility 导致 innerText 只返回视口内文字。
 */
export async function countWordsChunked(root: HTMLElement): Promise<number> {
  let total = 0;
  let last = performance.now();
  const yieldIfNeeded = async () => {
    if (performance.now() - last > 6) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      last = performance.now();
    }
  };
  for (const node of editorBlocks(root)) {
    if (node.nodeType === Node.TEXT_NODE) {
      total += countWords(node.textContent ?? "");
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const text = (node as HTMLElement).textContent ?? "";
    if (text.length > 24000) {
      for (let i = 0; i < text.length; i += 24000) {
        total += countWords(text.slice(i, i + 24000));
        await yieldIfNeeded();
      }
    } else {
      total += countWords(text);
    }
    await yieldIfNeeded();
  }
  return total;
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
  const html = mdToHtmlRaw(md);
  // 百万字章节若把 15,000 个段落直接铺在 contenteditable 里，每次输入
  // 浏览器都会为整章重排，出现 60ms 级长任务。按 50 段分块后，
  // content-visibility 只需维护约 300 个块，输入时不再整章重排。
  if (html.length < 150000) return html;
  return groupBlocks(html);
}

function groupBlocks(html: string): string {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  const blocks: Node[] = [];
  for (const node of Array.from(tmp.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && !(node.textContent ?? "").trim()) continue;
    blocks.push(node);
  }
  if (blocks.length <= 60) return html;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < blocks.length; i += 50) {
    const chunk = document.createElement("div");
    chunk.className = "cv-chunk";
    for (const node of blocks.slice(i, i + 50)) chunk.appendChild(node);
    frag.appendChild(chunk);
  }
  tmp.textContent = "";
  tmp.appendChild(frag);
  return tmp.innerHTML;
}

function mdToHtmlRaw(md: string): string {
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

function editorBlocks(root: HTMLElement): Node[] {
  const list: Node[] = [];
  const walk = (parent: HTMLElement) => {
    for (const node of Array.from(parent.childNodes)) {
      if (
        node.nodeType === Node.ELEMENT_NODE &&
        (node as HTMLElement).classList?.contains("cv-chunk")
      ) {
        walk(node as HTMLElement);
      } else {
        list.push(node);
      }
    }
  };
  walk(root);
  return list;
}

/** 编辑器 HTML → 受限 Markdown（存盘与导出的正文格式）。 */
export function htmlToMd(root: HTMLElement): string {
  // 纯文字长章节：逐块取 textContent，不递归内联节点。
  // 注意不能把 innerText 当快捷路径——content-visibility:auto 会跳过视口外段落，
  // 那样保存会把长章“截断”成当前屏幕附近的内容。
  const plainBlocks = editorBlocks(root);
  const rich = root.querySelector(
    "strong,b,em,i,blockquote,h1,h2,h3,h4,h5,h6,ul,ol,hr,br",
  );
  if (!rich) {
    const plain: string[] = [];
    for (const node of plainBlocks) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = (node.textContent ?? "").trim();
        if (text) plain.push(text);
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const el = node as Element;
      if (el.tagName === "BR") continue;
      const text = (el.textContent ?? "").replace(/\u00a0/g, " ").trim();
      if (text) plain.push(text);
    }
    return plain.join("\n\n").replace(/\u00a0/g, " ");
  }
  const blocks: string[] = [];
  plainBlocks.forEach((node) => {
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
