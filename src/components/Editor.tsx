import { useEffect, useRef, useState } from "react";
import type { CSSProperties, MutableRefObject } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { BookMeta, Chapter, ProofreadConfig, ProofreadIssue } from "../types";
import { countWords, countWordsChunked, escapeHtml, fmtNumber, fmtTime, fmtWords, htmlToMd, mdToHtml } from "../lib/text";
import { t, tf } from "../lib/i18n";
import { api } from "../lib/api";
import { recallScroll, rememberScroll } from "../lib/viewMemory";
import {
  addIgnore,
  buildIssueRanges,
  caretOffset,
  clearHighlights,
  issueAt,
  paintHighlights,
  rangeFromOffsets,
  replaceRange,
  scanProofread,
} from "../lib/proofread";
import { ProofreadDialog, ProofreadPopover } from "./ProofreadDialog";
import { FootnoteDialog } from "./FootnoteDialog";
import { Icon } from "./Icon";

interface Draft {
  id: string;
  title: string;
  text: string;
  at: number;
}

export interface EditorHandle {  flush: () => string;
  wordCount: () => number;
  insertText: (text: string) => void;
  focus: () => void;
}

type FontChoice = "song" | "hei" | "kai" | "fang" | "custom";

const FONT_OPTIONS: { id: FontChoice; label: string; stack: string; sample: string }[] = [
  { id: "song", label: "宋体", stack: 'var(--font-serif)', sample: "一页纸，一段故事" },
  { id: "hei", label: "黑体", stack: 'var(--font-sans)', sample: "一页纸，一段故事" },
  { id: "kai", label: "楷体", stack: '"KaiTi", "STKaiti", "Kaiti SC", serif', sample: "一页纸，一段故事" },
  { id: "fang", label: "仿宋", stack: '"FangSong", "STFangsong", "FangSong_GB2312", serif', sample: "一页纸，一段故事" },
];

const CUSTOM_FONT_FAMILY = "ChapterCustomFont";
const CUSTOM_FONT_STYLE = "chapter-custom-font-face";
const loadedFonts = new Map<string, string>();

function installCustomFont(dataUrl: string) {
  let style = document.getElementById(CUSTOM_FONT_STYLE) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = CUSTOM_FONT_STYLE;
    document.head.appendChild(style);
  }
  style.textContent = `@font-face{font-family:"${CUSTOM_FONT_FAMILY}";src:url("${dataUrl}");font-display:swap;}`;
  void document.fonts?.load(`1em "${CUSTOM_FONT_FAMILY}"`).catch(() => {});
}

function readFontChoice(): FontChoice {
  try {
    const raw = localStorage.getItem("chapter.editorFontFamily");
    if (raw === "hei" || raw === "kai" || raw === "fang" || raw === "custom") return raw;
  } catch {
    /* 本机存储不可用 */
  }
  return "song";
}

function fileStem(path: string) {
  return path.split(/[\\/]/).pop()?.replace(/\.(ttf|otf|woff2?)$/i, "") || "自定义字体";
}

interface Props {
  chapter: Chapter;
  body: string;
  meta: BookMeta;
  bookPath: string;
  index: number;
  total: number;
  bookWords: number;
  todayAdded: number;
  focusMode: boolean;
  proofread: ProofreadConfig;
  onProofread: (config: ProofreadConfig) => void;
  onFootnotes: (footnotes: import("../types").Footnote[]) => void;
  onBody: (md: string) => void;
  onTitle: (title: string) => void;
  onSave: () => void;
  onInsertLore: () => void;
  onToggleFocus: () => void;
  apiRef: MutableRefObject<EditorHandle | null>;
}

export function Editor({
  chapter,
  body,
  meta,
  bookPath,
  index,
  total,
  bookWords,
  todayAdded,
  focusMode,
  proofread,
  onProofread,
  onFootnotes,
  onBody,
  onTitle,
  onSave,
  onInsertLore,
  onToggleFocus,
  apiRef,
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const syncTimer = useRef<number | undefined>(undefined);
  const autoSaveTimer = useRef<number | undefined>(undefined);
  const titleTimer = useRef<number | undefined>(undefined);
  const recountTimer = useRef<number | undefined>(undefined);
  const recountGeneration = useRef(0);
  const lastMd = useRef(body);
  const lastWords = useRef(chapter.words || 0);
  const onBodyRef = useRef(onBody);
  onBodyRef.current = onBody;

  const [title, setTitle] = useState(chapter.title);
  const titleRef = useRef<HTMLInputElement>(null);
  const [empty, setEmpty] = useState(!body.trim());
  const [words, setWords] = useState(chapter.words || 0);
  const [fmt, setFmt] = useState({ bold: false, italic: false, quote: false });
  const [fontSize, setFontSize] = useState(() => {
    try {
      const saved = Number(localStorage.getItem("chapter.editorFont"));
      return saved >= 14 && saved <= 24 ? saved : 17;
    } catch {
      return 17;
    }
  });
  const [fontChoice, setFontChoice] = useState<FontChoice>(readFontChoice);
  const [fontOpen, setFontOpen] = useState(false);
  const [fontErr, setFontErr] = useState("");
  const [customName, setCustomName] = useState(() => {
    try {
      return localStorage.getItem("chapter.editorFontName") || "";
    } catch {
      return "";
    }
  });
  const fontPickRef = useRef<HTMLDivElement>(null);

  const [issues, setIssues] = useState<ProofreadIssue[]>([]);
  const [proofOpen, setProofOpen] = useState(false);
  const [proofIssue, setProofIssue] = useState<ProofreadIssue | null>(null);
  const [proofAnchor, setProofAnchor] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const [scanning, setScanning] = useState(false);
  const [fnOpen, setFnOpen] = useState(false);
  const fnCaret = useRef<number | null>(null);
  const proofTimer = useRef<number | undefined>(undefined);
  const proofConfigRef = useRef(proofread);
  const proofIssuesRef = useRef<ProofreadIssue[]>([]);
  const composingRef = useRef(false);
  proofConfigRef.current = proofread;
  proofIssuesRef.current = issues;

  const choice = FONT_OPTIONS.find((f) => f.id === fontChoice);
  const fontStack =
    fontChoice === "custom"
      ? `"${CUSTOM_FONT_FAMILY}", var(--font-serif)`
      : choice?.stack || "var(--font-serif)";
  const fontLabel = fontChoice === "custom" ? customName || t("自定义字体") : choice?.label || t("字体");

  useEffect(() => {
    try {
      localStorage.setItem("chapter.editorFontFamily", fontChoice);
    } catch {
      /* 本机存储不可用 */
    }
  }, [fontChoice]);

  // 每个章节重挂时都复用已读出的字体，避免几十兆的字体文件被反复 encode。
  useEffect(() => {
    if (fontChoice !== "custom") return;
    let cancelled = false;
    let path = "";
    try {
      path = localStorage.getItem("chapter.editorFontFile") || "";
    } catch {
      /* 本机存储不可用 */
    }
    if (!path) return;
    const cached = loadedFonts.get(path);
    if (cached) {
      installCustomFont(cached);
      return;
    }
    void api
      .fontData(path)
      .then((data) => {
        if (cancelled) return;
        loadedFonts.set(path, data);
        installCustomFont(data);
        setFontErr("");
      })
      .catch(() => {
        if (!cancelled) setFontErr(t("字体文件读不到了，已回退宋体"));
      });
    return () => {
      cancelled = true;
    };
  }, [fontChoice]);

  useEffect(() => {
    if (!fontOpen) return;
    const onDown = (event: PointerEvent) => {
      if (!fontPickRef.current?.contains(event.target as Node)) setFontOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [fontOpen]);

  const pickFont = (id: FontChoice) => {
    setFontErr("");
    setFontChoice(id);
    setFontOpen(false);
  };

  const uploadFont = async () => {
    setFontErr("");
    try {
      const picked = await openDialog({
        multiple: false,
        title: t("选一个字体文件"),
        filters: [{ name: t("字体"), extensions: ["ttf", "otf", "woff", "woff2"] }],
      });
      if (!picked || Array.isArray(picked)) return;
      const data = await api.fontData(picked);
      loadedFonts.set(picked, data);
      installCustomFont(data);
      const name = fileStem(picked);
      setCustomName(name);
      setFontChoice("custom");
      setFontOpen(false);
      try {
        localStorage.setItem("chapter.editorFontFile", picked);
        localStorage.setItem("chapter.editorFontName", name);
      } catch {
        /* 本机存储不可用 */
      }
    } catch (e) {
      setFontErr(String(e instanceof Error ? e.message : e));
    }
  };

  const draftKey = `chapter.drafts:${bookPath}`;
  const scrollKey = `editor:${bookPath}:${chapter.id}`;
  const [drafts, setDrafts] = useState<Draft[]>(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((d) => d && typeof d.text === "string") : [];
    } catch {
      return [];
    }
  });
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftText, setDraftText] = useState("");

  useEffect(() => {
    try {
      localStorage.setItem(draftKey, JSON.stringify(drafts.slice(0, 200)));
    } catch {
      /* 本机存储不可用时不影响正文 */
    }
  }, [drafts, draftKey]);

  // 去大纲看两眼再回来，正文还停在刚才那一行。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const saved = recallScroll(scrollKey);
    const restore = () => {
      if (saved > 0) el.scrollTop = Math.min(saved, Math.max(0, el.scrollHeight - el.clientHeight));
    };
    requestAnimationFrame(() => requestAnimationFrame(restore));
    const lateRestore = window.setTimeout(restore, 180);
    const onScroll = () => rememberScroll(scrollKey, el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.clearTimeout(lateRestore);
      // 卸载时 DOM 可能已经脱离布局，scrollTop 会读成 0；
      // 滚动事件已经实时保存过位置，这里只清理监听。
      el.removeEventListener("scroll", onScroll);
    };
  }, [scrollKey]);

  const addDraft = () => {
    const text = draftText.trim();
    if (!text) return;
    const first = text.split("\n").find((line) => line.trim())?.trim() || t("未命名草稿");
    const draft: Draft = {
      id: `d_${Date.now().toString(36)}`,
      title: first.replace(/^#+\s*/, "").slice(0, 32),
      text,
      at: Date.now(),
    };
    setDrafts((list) => [draft, ...list]);
    setDraftText("");
  };

  const insertDraft = (text: string) => {
    apiRef.current?.insertText(text);
    setDraftOpen(false);
    onSave();
  };

  useEffect(() => {
    try {
      localStorage.setItem("chapter.editorFont", String(fontSize));
    } catch {
      /* ignore */
    }
  }, [fontSize]);

  useEffect(() => {
    // 外部改名（书籍菜单 / 大纲墙）后同步回来；用户正在输入时不打扰光标
    if (document.activeElement !== titleRef.current) setTitle(chapter.title);
  }, [chapter.title]);

  // 进章节：灌入受限 Markdown，默认段落用 <p>
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.innerHTML = mdToHtml(body);
    lastMd.current = body;
    lastWords.current = chapter.words || 0;
    setEmpty(!body.trim());
    if (!chapter.words && body) {
      // 旧书没有字数缓存时，等首屏稳定后再补一次扫描，避免和章节渲染抢主线程。
      const idle = window.requestIdleCallback ?? ((fn: IdleRequestCallback) => window.setTimeout(() => fn({} as IdleDeadline), 1600));
      idle(() => {
        const n = countWords(el.textContent ?? "");
        lastWords.current = n;
        setWords(n);
      });
    }
    try {
      document.execCommand("defaultParagraphSeparator", false, "p");
    } catch {
      /* 某些 WebView 不支持，不影响编辑 */
    }
    // 只在挂载时执行；切章由上层 key 重挂
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const syncNow = (notify: boolean) => {
    const el = bodyRef.current;
    if (!el) return lastMd.current;
    const md = htmlToMd(el);
    lastMd.current = md;
    lastWords.current = countWords(md);
    if (notify) onBodyRef.current(md);
    return md;
  };

  /**
   * 自动保存按章节体量自适应：百万字章节全量落盘本身就是重活，
   * 不能每 1.4 秒做一次；小章节仍然保持原来的随手保存手感。
   */
  const scheduleAutoSave = () => {
    window.clearTimeout(autoSaveTimer.current);
    const size = lastMd.current.length || chapter.words || 0;
    const delay = size >= 600000 ? 12000 : size >= 250000 ? 8000 : size >= 80000 ? 3500 : 1400;
    autoSaveTimer.current = window.setTimeout(() => onSave(), delay);
  };

  useEffect(
    () => () => {
      window.clearTimeout(syncTimer.current);
      window.clearTimeout(autoSaveTimer.current);
      window.clearTimeout(titleTimer.current);
      window.clearTimeout(recountTimer.current);
    },
    [],
  );

  useEffect(() => {
    apiRef.current = {
      flush: () => {
        window.clearTimeout(syncTimer.current);
        return syncNow(true);
      },
      wordCount: () => lastWords.current,
      insertText: (text: string) => {
        const el = bodyRef.current;
        if (!el) return;
        el.focus();
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
        const blocks = text
          .trim()
          .split(/\n{2,}/)
          .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
          .join("");
        document.execCommand("insertHTML", false, blocks);
        setEmpty(false);
        scheduleAutoSave();
      },
      focus: () => bodyRef.current?.focus(),
    };
    return () => {
      apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 选区样式状态 + 专注模式打字机滚动
  useEffect(() => {
    const onSelection = () => {
      const sel = window.getSelection();
      const el = bodyRef.current;
      if (!sel || !el || !sel.anchorNode) return;
      const anchor =
        sel.anchorNode.nodeType === Node.TEXT_NODE
          ? sel.anchorNode.parentElement
          : (sel.anchorNode as Element);
      if (!anchor || !el.contains(anchor)) return;
      setFmt({
        bold: !!anchor.closest("strong,b"),
        italic: !!anchor.closest("em,i"),
        quote: !!anchor.closest("blockquote"),
      });
      if (focusMode && sel.isCollapsed) {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        const box = scrollRef.current;
        if (rect.height === 0 || !box) return;
        const cr = box.getBoundingClientRect();
        const target = cr.top + cr.height * 0.44;
        const delta = rect.top - target;
        if (Math.abs(delta) > cr.height * 0.14) {
          box.scrollBy({ top: delta, behavior: "smooth" });
        }
      }
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, [focusMode]);

  // 输入停顿 400ms 后扫描；输入法组合期间不打断。
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    window.clearTimeout(proofTimer.current);
    if (!proofread.enabled) {
      setIssues([]);
      setProofIssue(null);
      clearHighlights();
      return;
    }
    setScanning(true);
    proofTimer.current = window.setTimeout(() => {
      if (composingRef.current) {
        setScanning(false);
        return;
      }
      const text = el.textContent ?? "";
      const found = scanProofread(text, proofConfigRef.current);
      setIssues(found);
      const ranges = buildIssueRanges(el, found);
      paintHighlights(found, ranges);
      setScanning(false);
    }, 420);
    return () => window.clearTimeout(proofTimer.current);
  }, [body, proofread, chapter.id]);

  useEffect(() => {
    const onCompositionStart = () => {
      composingRef.current = true;
    };
    const onCompositionEnd = () => {
      composingRef.current = false;
      const el = bodyRef.current;
      if (!el || !proofConfigRef.current.enabled) return;
      window.clearTimeout(proofTimer.current);
      proofTimer.current = window.setTimeout(() => {
        const text = el.textContent ?? "";
        const found = scanProofread(text, proofConfigRef.current);
        setIssues(found);
        paintHighlights(found, buildIssueRanges(el, found));
      }, 420);
    };
    document.addEventListener("compositionstart", onCompositionStart, true);
    document.addEventListener("compositionend", onCompositionEnd, true);
    return () => {
      document.removeEventListener("compositionstart", onCompositionStart, true);
      document.removeEventListener("compositionend", onCompositionEnd, true);
      clearHighlights();
    };
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".proof-pop") || target?.closest(".proof-button")) return;
      setProofIssue(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const openProofAtCaret = () => {
    const el = bodyRef.current;
    if (!el) return;
    const offset = caretOffset(el);
    if (offset === null) return;
    const hit = issueAt(proofIssuesRef.current, offset);
    if (!hit) return;
    const range = rangeFromOffsets(el, hit.start, hit.end);
    if (!range) return;
    const rect = range.getBoundingClientRect();
    setProofAnchor({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });
    setProofIssue(hit);
  };

  const applyProofValue = (issue: ProofreadIssue, value: string) => {
    const el = bodyRef.current;
    if (!el) return;
    if (replaceRange(el, issue, value)) {
      setProofIssue(null);
      handleInput();
      window.setTimeout(() => {
        const text = el.textContent ?? "";
        const found = scanProofread(text, proofConfigRef.current);
        setIssues(found);
        paintHighlights(found, buildIssueRanges(el, found));
      }, 420);
    }
  };

  const ignoreProofIssue = (issue: ProofreadIssue) => {
    const el = bodyRef.current;
    if (!el) return;
    onProofread(addIgnore(proofread, issue, el.textContent ?? ""));
    setProofIssue(null);
  };

  const insertFootnoteMarker = (n: number) => {
    const el = bodyRef.current;
    if (!el) return;
    const offset = fnCaret.current ?? caretOffset(el);
    if (offset === null) return;
    const range = rangeFromOffsets(el, offset, offset);
    if (!range) return;
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    el.focus();
    document.execCommand("insertHTML", false, `<sup class="fn-ref" data-fn="${n}">${n}</sup>`);
    fnCaret.current = offset + 1;
    handleInput();
    setFnOpen(false);
  };

  const handleInput = () => {
    const el = bodyRef.current;
    if (!el) return;
    setEmpty(false);
    // 打字时绝不做全章 innerText / 正则扫描；停手 0.8 秒后再更新字数。
    window.clearTimeout(recountTimer.current);
    const generation = ++recountGeneration.current;
    const huge = lastMd.current.length > 120000 || chapter.words > 120000;
    recountTimer.current = window.setTimeout(() => {
      if (huge) {
        void countWordsChunked(el).then((n) => {
          if (generation !== recountGeneration.current) return;
          lastWords.current = n;
          setWords(n);
          setEmpty(false);
        });
        return;
      }
      const text = el.textContent ?? "";
      const n = countWords(text);
      if (generation !== recountGeneration.current) return;
      lastWords.current = n;
      setWords(n);
      setEmpty(!text.trim());
    }, 800);
    scheduleAutoSave();
  };

  const run = (cmd: string, value?: string) => {
    const el = bodyRef.current;
    if (!el) return;
    el.focus();
    document.execCommand(cmd, false, value);
    handleInput();
  };

  const toggleQuote = () => {
    if (fmt.quote) run("formatBlock", "p");
    else run("formatBlock", "blockquote");
  };

  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    const html =
      text
        .split(/\n{2,}/)
        .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
        .join("") || "<p><br></p>";
    document.execCommand("insertHTML", false, html);
    handleInput();
  };

  const commitTitle = (value: string) => {
    window.clearTimeout(titleTimer.current);
    titleTimer.current = window.setTimeout(() => onTitle(value.trim() || "未命名"), 380);
  };

  const goalPct =
    meta.targetWords > 0 ? Math.min(100, Math.round((bookWords / meta.targetWords) * 100)) : 0;

  return (
    <>
      <div className="editor-toolbar">
        <div className="tb-group">
          <button
            className={`tbtn${fmt.bold ? " on" : ""}`}
            title="加粗 Ctrl+B"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run("bold")}
          >
            <Icon name="bold" size={16} />
          </button>
          <button
            className={`tbtn${fmt.italic ? " on" : ""}`}
            title="斜体 Ctrl+I"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run("italic")}
          >
            <Icon name="italic" size={16} />
          </button>
          <button
            className={`tbtn${fmt.quote ? " on" : ""}`}
            title={t("引用段落")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleQuote}
          >
            <Icon name="quote" size={16} />
          </button>
          <button
            className="tbtn"
            title={t("插入分隔线")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run("insertHorizontalRule")}
          >
            <Icon name="hr" size={16} />
          </button>
        </div>
        <span className="divider-v" />
        <div className="tb-group">
          <button className="tbtn" title={t("插入设定引用")} onClick={onInsertLore}>
            <Icon name="users" size={16} />
            <span>{t("设定")}</span>
          </button>
          <button
            className={`tbtn${draftOpen ? " on" : ""}`}
            title={t("草稿箱")}
            onClick={() => setDraftOpen((v) => !v)}
          >
            <Icon name="file" size={16} />
            <span>{t("草稿箱")}</span>
            {drafts.length > 0 && <b className="draft-count">{drafts.length}</b>}
          </button>
          <button
            className={`tbtn proof-button${proofIssue ? " on" : ""}`}
            title={t("本书词库与校对")}
            onClick={() => setProofOpen(true)}
          >
            <Icon name="check" size={15} />
            <span>{t("校对")}</span>
            {(issues.length > 0 || scanning) && (
              <b className="proof-count">{scanning ? "…" : issues.length}</b>
            )}
          </button>
          <button
            className="tbtn"
            title={t("章内脚注")}
            onMouseDown={() => {
              fnCaret.current = caretOffset(bodyRef.current ?? document.body);
            }}
            onClick={() => setFnOpen(true)}
          >
            <Icon name="book" size={15} />
            <span>{t("脚注")}</span>
            {(chapter.footnotes?.length ?? 0) > 0 && <b className="proof-count">{chapter.footnotes!.length}</b>}
          </button>
        </div>
        <span className="grow" />
        <div className="font-picker" ref={fontPickRef}>
          <button
            className={`tbtn font-family-btn${fontOpen ? " on" : ""}`}
            title={t("正文字体")}
            onClick={() => setFontOpen((v) => !v)}
          >
            <Icon name="type" size={14} />
            <span>{fontLabel}</span>
            <Icon name="chevron" size={10} className="font-chevron" />
          </button>
          {fontOpen && (
            <div className="font-pop" role="dialog" aria-label={t("正文字体")}>
              <div className="font-pop-head">
                <b>{t("正文字体")}</b>
                <em>{t("只影响写作区，不改变导出排版")}</em>
              </div>
              {FONT_OPTIONS.map((f) => (
                <button
                  key={f.id}
                  className={`font-row${fontChoice === f.id ? " on" : ""}`}
                  onClick={() => pickFont(f.id)}
                >
                  <span className="font-row-name">{f.label}</span>
                  <span className="font-row-sample" style={{ fontFamily: f.stack }}>
                    {f.sample}
                  </span>
                  {fontChoice === f.id && <Icon name="check" size={13} />}
                </button>
              ))}
              <div className="font-pop-sep" />
              <button className={`font-row${fontChoice === "custom" ? " on" : ""}`} onClick={() => void uploadFont()}>
                <span className="font-row-name">{customName || t("上传字体")}</span>
                <span className="font-row-sample custom">
                  {customName ? t("已载入本地字体") : t("TTF / OTF / WOFF")}
                </span>
                {fontChoice === "custom" ? <Icon name="check" size={13} /> : <Icon name="file" size={13} />}
              </button>
              {fontErr && <p className="font-err">{fontErr}</p>}
            </div>
          )}
        </div>
        <span className="font-step" title={t("正文基准字号")}>
          <button
            className="tbtn font-btn"
            title={t("字号小一点")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setFontSize((n) => Math.max(14, n - 1))}
            disabled={fontSize <= 14}
          >
            A−
          </button>
          <span>{fontSize}</span>
          <button
            className="tbtn font-btn"
            title={t("字号大一点")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setFontSize((n) => Math.min(24, n + 1))}
            disabled={fontSize >= 24}
          >
            A+
          </button>
        </span>
        <span className="divider-v" />
        <button className="tbtn" title={t("专注模式（隐藏所有面板）")} onClick={onToggleFocus}>
          <Icon name="focus" size={16} />
          <span>{t("专注")}</span>
        </button>
      </div>

      <div className="paper-scroll" ref={scrollRef}>
        <article className="paper" style={{ "--editor-font": `${fontSize}px` } as CSSProperties}>
          <input
            className={`ch-title${title.length > 18 ? " is-long" : ""}`}
            ref={titleRef}
            value={title}
            spellCheck={false}
            placeholder={t("这一章叫什么")}
            onChange={(e) => {
              setTitle(e.target.value);
              commitTitle(e.target.value);
            }}
            onBlur={() => {
              window.clearTimeout(titleTimer.current);
              onTitle(title.trim() || "未命名");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                bodyRef.current?.focus();
              }
            }}
          />
          <div className="ch-subline">
            <span>
              {tf("第 {index} / {total} 章", { index: index + 1, total })}
            </span>
            <span className="dot" />
            <span>{tf("{count} 个场景", { count: chapter.scenes.length })}</span>
            <span className="dot" />
            <span>{tf("更新于 {time}", { time: fmtTime(chapter.updatedAt) })}</span>
          </div>
          <div className="body-wrap">
            <div
              ref={bodyRef}
              className="body"
              contentEditable
              role="textbox"
              aria-multiline="true"
              suppressContentEditableWarning
              spellCheck={false}
              style={{ fontFamily: fontStack }}
              onInput={handleInput}
              onClick={(e) => {
                const target = e.target as HTMLElement;
                if (target.closest(".fn-ref")) {
                  setFnOpen(true);
                  return;
                }
                window.setTimeout(openProofAtCaret, 0);
              }}
              onPaste={onPaste}
              onBlur={() => {
                onSave();
              }}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  onSave();
                }
              }}
            />
            {empty && <div className="body-placeholder" style={{ fontFamily: fontStack }}>{t("从这里开始写……")}</div>}
          </div>
          {proofIssue && (
            <ProofreadPopover
              issue={proofIssue}
              anchor={proofAnchor}
              onReplace={(value) => applyProofValue(proofIssue, value)}
              onIgnore={() => ignoreProofIssue(proofIssue)}
              onClose={() => setProofIssue(null)}
              onOpenDictionary={() => {
                setProofIssue(null);
                setProofOpen(true);
              }}
            />
          )}
        </article>
      </div>

      <footer className="statusbar">
        <span className="status-chip">
          {t("本章")} <b>{fmtNumber(words)}</b> {t("字")}
        </span>
        <span className="status-chip">
          {t("今日")} <b>+{fmtNumber(todayAdded)}</b> {t("字")}
        </span>
        <span className="status-chip">
          {t("全书")} <b>{fmtWords(bookWords)}</b> {t("字")}
        </span>
        <span className="status-chip">
          {t("目标")} <b>{goalPct}%</b>
        </span>
        <span className="grow" />
        <span style={{ color: "var(--text-4)" }}>Ctrl+S {t("保存")}</span>
      </footer>

      {draftOpen && (
        <aside className="draft-drawer" aria-label={t("草稿箱")}>
          <header>
            <div>
              <b>{t("草稿箱")}</b>
              <em>{tf("只存在这台电脑 · {count} 条", { count: drafts.length })}</em>
            </div>
            <button className="icon-btn" title={t("关闭")} onClick={() => setDraftOpen(false)}>
              <Icon name="close" size={15} />
            </button>
          </header>
          <div className="draft-new">
            <textarea
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              placeholder={t("把还没想好放哪儿的段落先丢进来……")}
              rows={5}
              spellCheck={false}
            />
            <div>
              <span>{t("不会自动进正文，确认后再放。")}</span>
              <button className="btn btn-primary btn-sm" onClick={addDraft} disabled={!draftText.trim()}>
                <Icon name="plus" size={12} />
                {t("存为草稿")}
              </button>
            </div>
          </div>
          <div className="draft-list">
            {drafts.length === 0 && <p className="draft-empty">{t("还没有草稿。写一段，先存着。")}</p>}
            {drafts.map((d) => (
              <article className="draft-card" key={d.id}>
                <header>
                  <b>{d.title}</b>
                  <span>{fmtTime(d.at)}</span>
                </header>
                <p>{d.text}</p>
                <footer>
                  <button className="btn btn-outline btn-sm" onClick={() => insertDraft(d.text)}>
                    <Icon name="arrow" size={12} />
                    {t("放进正文")}
                  </button>
                  <button
                    className="draft-del"
                    title={t("删除草稿")}
                    onClick={() => setDrafts((list) => list.filter((x) => x.id !== d.id))}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </footer>
              </article>
            ))}
          </div>
        </aside>
      )}
      {proofOpen && (
        <ProofreadDialog
          config={proofread}
          issues={issues}
          onClose={() => setProofOpen(false)}
          onSave={(next) => {
            onProofread(next);
            setProofOpen(false);
          }}
          onReplace={(issue, value) => {
            applyProofValue(issue, value);
            setProofOpen(false);
          }}
          onIgnore={(issue) => {
            ignoreProofIssue(issue);
            setProofOpen(false);
          }}
          onRescan={() => {
            const el = bodyRef.current;
            if (!el) return;
            const found = scanProofread(el.textContent ?? "", proofConfigRef.current);
            setIssues(found);
            paintHighlights(found, buildIssueRanges(el, found));
          }}
        />
      )}
      {fnOpen && (
        <FootnoteDialog
          footnotes={chapter.footnotes ?? []}
          onClose={() => setFnOpen(false)}
          onSave={(next) => {
            onFootnotes(next);
            setFnOpen(false);
          }}
          onInsert={insertFootnoteMarker}
        />
      )}
    </>
  );
}
