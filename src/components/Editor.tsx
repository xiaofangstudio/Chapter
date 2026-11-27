import { useEffect, useRef, useState } from "react";
import type { CSSProperties, MutableRefObject } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  checkPermission,
  installModel,
  isAvailable,
  listModels,
  onDownloadProgress,
  onError,
  onResult,
  onStateChange,
  setActiveModel,
  startListening,
  stopListening,
} from "tauri-plugin-stt-api";
import type {
  DownloadProgressEvent,
  RecognitionResult,
  SttError,
  WhisperModelInfo,
} from "tauri-plugin-stt-api";
import type { BookMeta, Chapter, ProofreadConfig, ProofreadIssue, SaveState } from "../types";
import { countWords, countWordsChunked, escapeHtml, fmtNumber, fmtTime, fmtWords, htmlToMd, mdToHtml } from "../lib/text";
import { fmtDateTime, t, tf } from "../lib/i18n";
import { api, errText } from "../lib/api";
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
  volumeTitle?: string;
  saveState?: SaveState;
  bookWords: number;
  todayAdded: number;
  focusMode: boolean;
  proofread: ProofreadConfig;
  onProofread: (config: ProofreadConfig) => void;
  voicePad: boolean;
  voiceMarks: string[];
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
  volumeTitle,
  saveState = "saved",
  bookWords,
  todayAdded,
  focusMode,
  proofread,
  onProofread,
  voicePad,
  voiceMarks,
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
  const [toolsOpen, setToolsOpen] = useState(false);
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

  const isPhone = typeof window !== "undefined" && window.matchMedia("(max-width: 820px)").matches;
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceStopping, setVoiceStopping] = useState(false);
  const [voiceSeconds, setVoiceSeconds] = useState(0);
  const [voiceNotice, setVoiceNotice] = useState<{ text: string; warn?: boolean } | null>(null);
  const [voiceSetup, setVoiceSetup] = useState<{ models: WhisperModelInfo[] } | null>(null);
  const [voiceDownload, setVoiceDownload] = useState<{ id: string; progress: number; status: string } | null>(null);
  const voiceActiveRef = useRef(false);
  const voiceBusyRef = useRef(false);
  const voiceStoppingRef = useRef(false);
  const voiceStartedAt = useRef(0);
  const voicePreviewRef = useRef<HTMLSpanElement | null>(null);
  const voiceAnchorRef = useRef<HTMLSpanElement | null>(null);
  const voiceRangeRef = useRef<Range | null>(null);
  const voiceNoticeTimer = useRef<number | undefined>(undefined);
  const voiceHandlerRef = useRef<(result: RecognitionResult) => void>(() => undefined);
  const voiceErrorRef = useRef<(error: SttError) => void>(() => undefined);
  const voiceStateRef = useRef<(state: "idle" | "listening" | "processing") => void>(() => undefined);

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
    // 语音的临时光标 / 预览只属于屏幕，绝不能写进正文存档。
    const clean = el.cloneNode(true) as HTMLElement;
    clean.querySelectorAll(".voice-anchor, .voice-ghost").forEach((node) => node.remove());
    // 语音多次落字可能留下相邻文本节点，合并后再转 Markdown，避免被拆成多个段落。
    clean.normalize();
    const md = htmlToMd(clean);
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
      if (sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        if (el.contains(range.startContainer)) voiceRangeRef.current = range.cloneRange();
      }
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

  const showVoiceNotice = (text: string, warn = false) => {
    window.clearTimeout(voiceNoticeTimer.current);
    setVoiceNotice({ text, warn });
    voiceNoticeTimer.current = window.setTimeout(() => setVoiceNotice(null), warn ? 5200 : 2800);
  };

  /** 语音落点：优先当前可见光标，其次点麦克风前的最后光标。 */
  const voiceCaretRange = (): Range | null => {
    const el = bodyRef.current;
    if (!el) return null;
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && sel.anchorNode && el.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      if (el.contains(range.startContainer)) return range.cloneRange();
    }
    const saved = voiceRangeRef.current;
    if (saved && el.contains(saved.startContainer) && el.contains(saved.endContainer)) {
      return saved.cloneRange();
    }
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    return range;
  };

  /** 手机听写时点正文换落点：只移动选区，不重新拉起输入法键盘。 */
  const voicePointRange = (x: number, y: number): Range | null => {
    const el = bodyRef.current;
    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    let range = doc.caretRangeFromPoint?.(x, y) ?? null;
    if (!range) {
      const pos = doc.caretPositionFromPoint?.(x, y);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
      }
    }
    if (!range || !el?.contains(range.startContainer)) return null;
    return range;
  };

  const clearVoiceAnchor = () => {
    const anchor = voiceAnchorRef.current;
    voiceAnchorRef.current = null;
    if (anchor?.isConnected) anchor.remove();
  };

  /** 手机收着键盘时也能看见“下一句从哪落”：一条不占字数的细光标。 */
  const moveVoiceAnchor = (range: Range) => {
    clearVoiceAnchor();
    const anchor = document.createElement("span");
    anchor.className = "voice-anchor";
    anchor.setAttribute("contenteditable", "false");
    anchor.setAttribute("aria-hidden", "true");
    const insert = range.cloneRange();
    insert.collapse(true);
    insert.insertNode(anchor);
    const after = document.createRange();
    after.setStartAfter(anchor);
    after.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(after);
    voiceRangeRef.current = after.cloneRange();
    voiceAnchorRef.current = anchor;
  };

  /** 把语音文字并进光标所在的文本节点，避免每次落字都新开一个段落。 */
  const insertVoiceText = (range: Range, text: string): Range => {
    const caret = document.createRange();
    const putIn = (node: Text, offset: number) => {
      node.insertData(offset, text);
      caret.setStart(node, offset + text.length);
      caret.collapse(true);
    };
    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      putIn(range.startContainer as Text, range.startOffset);
      return caret;
    }
    const host = range.startContainer as Element;
    const offset = range.startOffset;
    let next = offset < host.childNodes.length ? host.childNodes[offset] : null;
    let prev = offset > 0 ? host.childNodes[offset - 1] : null;
    if (next?.nodeType === Node.ELEMENT_NODE && (next as Element).classList.contains("voice-anchor")) {
      next = next.nextSibling;
    }
    if (prev?.nodeType === Node.ELEMENT_NODE && (prev as Element).classList.contains("voice-anchor")) {
      prev = prev.previousSibling;
    }
    if (next?.nodeType === Node.TEXT_NODE) {
      putIn(next as Text, 0);
      return caret;
    }
    if (prev?.nodeType === Node.TEXT_NODE) {
      const node = prev as Text;
      putIn(node, node.textContent?.length ?? 0);
      return caret;
    }
    if (prev) {
      const walker = document.createTreeWalker(prev, NodeFilter.SHOW_TEXT);
      let last: Text | null = null;
      while (walker.nextNode()) last = walker.currentNode as Text;
      if (last) {
        putIn(last, last.textContent?.length ?? 0);
        return caret;
      }
    }
    const node = document.createTextNode(text);
    range.insertNode(node);
    caret.setStartAfter(node);
    caret.collapse(true);
    return caret;
  };

  const setCaretAt = (range: Range) => {
    const sel = window.getSelection();
    if (!sel) return;
    const next = range.cloneRange();
    sel.removeAllRanges();
    sel.addRange(next);
    voiceRangeRef.current = next.cloneRange();
  };

  const reanchorAt = (range: Range) => {
    if (!isPhone || !voiceActiveRef.current) return;
    moveVoiceAnchor(range);
  };

  const setCaretAfter = (node: Node) => {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    voiceRangeRef.current = range.cloneRange();
  };

  /** 手机连续听写时，每次落字/标点后重新插回光标线，下一段仍看得见落点。 */
  const reanchorAfter = (node: Node) => {
    if (!isPhone || !voiceActiveRef.current) return;
    const range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    moveVoiceAnchor(range);
  };

  const dropVoicePreview = (withInput: boolean) => {
    const span = voicePreviewRef.current;
    voicePreviewRef.current = null;
    if (!span?.isConnected) {
      clearVoiceAnchor();
      return;
    }
    const text = span.textContent ?? "";
    if (text) {
      const node = document.createTextNode(text);
      span.replaceWith(node);
      clearVoiceAnchor();
      setCaretAfter(node);
    } else {
      span.remove();
      clearVoiceAnchor();
    }
    if (withInput) {
      setEmpty(false);
      handleInput();
    }
  };

  const updateVoicePreview = (text: string) => {
    const el = bodyRef.current;
    if (!el) return;
    const span = voicePreviewRef.current;
    if (span?.isConnected) {
      span.textContent = text;
      setEmpty(false);
      return;
    }
    const range = voiceCaretRange();
    if (!range) return;
    range.deleteContents();
    const next = document.createElement("span");
    next.className = "voice-ghost";
    next.setAttribute("contenteditable", "false");
    next.textContent = text;
    range.insertNode(next);
    voicePreviewRef.current = next;
    setCaretAfter(next);
    setEmpty(false);
  };

  const insertVoiceFinal = (text: string) => {
    const clean = text.trim();
    if (!clean) {
      dropVoicePreview(true);
      return;
    }
    const span = voicePreviewRef.current;
    if (span?.isConnected) {
      const node = document.createTextNode(clean);
      span.replaceWith(node);
      voicePreviewRef.current = null;
      clearVoiceAnchor();
      setCaretAfter(node);
      reanchorAfter(node);
      setEmpty(false);
      handleInput();
      return;
    }
    const range = voiceCaretRange();
    if (!range) return;
    range.deleteContents();
    const caret = insertVoiceText(range, clean);
    clearVoiceAnchor();
    setCaretAt(caret);
    reanchorAt(caret);
    setEmpty(false);
    handleInput();
  };

  const insertVoiceMark = (mark: string) => {
    dropVoicePreview(true);
    const range = voiceCaretRange();
    if (!range) return;
    range.deleteContents();
    const caret = insertVoiceText(range, mark);
    clearVoiceAnchor();
    setCaretAt(caret);
    reanchorAt(caret);
    setEmpty(false);
    handleInput();
  };

  const insertVoiceBreak = () => {
    dropVoicePreview(true);
    const range = voiceCaretRange();
    if (!range) return;
    range.deleteContents();
    const br = document.createElement("br");
    range.insertNode(br);
    setCaretAfter(br);
    reanchorAfter(br);
    setEmpty(false);
    handleInput();
    bodyRef.current?.blur();
  };

  const deleteVoiceBefore = () => {
    if (voicePreviewRef.current) dropVoicePreview(true);
    const anchor = voiceAnchorRef.current;
    const range = voiceCaretRange();
    if (!range) return;
    if (!range.collapsed) {
      range.deleteContents();
    } else {
      const node = range.startContainer;
      const offset = range.startOffset;
      let target: Text | null = null;
      let cut = 0;
      if (node.nodeType === Node.TEXT_NODE) {
        if (offset > 0) {
          target = node as Text;
          cut = offset - 1;
        } else {
          // 光标线插在文末时会留下一个空文本节点，往前跳过光标线再删。
          let prev: ChildNode | null = node.previousSibling;
          if (prev === anchor) prev = anchor?.previousSibling ?? null;
          if (prev?.nodeType === Node.TEXT_NODE && prev.textContent) {
            target = prev as Text;
            cut = prev.textContent.length - 1;
          }
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        let prev: ChildNode | null = (node as Element).childNodes[offset - 1] ?? null;
        if (prev === anchor) prev = anchor?.previousSibling ?? null;
        if (prev?.nodeType === Node.TEXT_NODE && prev.textContent) {
          target = prev as Text;
          cut = prev.textContent.length - 1;
        } else if (prev) {
          prev.remove();
        }
      }
      if (target) target.deleteData(cut, 1);
    }
    clearVoiceAnchor();
    if (isPhone && voiceActiveRef.current) {
      range.collapse(true);
      moveVoiceAnchor(range);
    }
    setEmpty(false);
    handleInput();
    bodyRef.current?.blur();
  };

  const beginVoice = async () => {
    if (voiceBusyRef.current || voiceActiveRef.current) return;
    voiceBusyRef.current = true;
    setVoiceBusy(true);
    try {
      const availability = await isAvailable();
      if (!availability.available) {
        const catalog = await listModels(false);
        const installed = catalog.models.filter((m) => m.installed);
        if (installed.length > 0) {
          // 已装多个模型时，沿用它当前选中的那个；没有标记才退到推荐/最小。
          const current = installed.find((m) => m.id === catalog.active);
          await setActiveModel((current ?? installed.find((m) => m.recommended) ?? installed[0]).id);
        } else if (catalog.models.length > 0) {
          const useful = catalog.models.filter(
            (m) => !m.advanced && !m.language && (m.id === "tiny" || m.id === "base" || m.id === "small"),
          );
          setVoiceSetup({ models: useful.length ? useful : catalog.models.filter((m) => !m.advanced) });
          showVoiceNotice("先装一个本地语音包，之后完全离线。");
          return;
        } else {
          showVoiceNotice(availability.reason || "这台设备的系统语音识别不可用。", true);
          return;
        }
      }

      const permission = await checkPermission();
      const listenConfig = {
        language: "zh-CN",
        interimResults: true,
        continuous: true,
        maxDuration: 180000,
      };
      if (permission.microphone !== "granted") {
        if (isPhone) {
          // 第一次先让系统弹授权；授权完成后用户再点一次麦克风即可。
          try {
            await startListening(listenConfig);
          } catch {
            /* Kotlin 在弹窗后立即 reject，这里只关心系统授权框已经出现 */
          }
          showVoiceNotice("第一次用要允许麦克风。点「允许」后，再点一次麦克风。", true);
          return;
        }
      }

      const saved = voiceCaretRange();
      if (saved) {
        voiceRangeRef.current = saved;
        moveVoiceAnchor(saved);
      }
      // 手机端先收键盘，避免输入法与语音转写抢同一个插入点。
      if (isPhone) (document.activeElement as HTMLElement | null)?.blur();
      await startListening(listenConfig);
      voiceStartedAt.current = Date.now();
      voiceActiveRef.current = true;
      voiceStoppingRef.current = false;
      setVoiceActive(true);
      setVoiceStopping(false);
      setVoiceSeconds(0);
      showVoiceNotice(isPhone ? "正在听。点正文换落点，再点麦克风结束。" : "正在录音，说完再点一次麦克风落字。");
    } catch (e) {
      dropVoicePreview(true);
      showVoiceNotice(`语音没开起来：${errText(e)}`, true);
    } finally {
      voiceBusyRef.current = false;
      setVoiceBusy(false);
    }
  };

  const endVoice = async () => {
    if (!voiceActiveRef.current || voiceStoppingRef.current) return;
    voiceStoppingRef.current = true;
    setVoiceStopping(true);
    try {
      await stopListening();
    } catch (e) {
      voiceActiveRef.current = false;
      voiceStoppingRef.current = false;
      setVoiceActive(false);
      setVoiceStopping(false);
      dropVoicePreview(true);
      showVoiceNotice(`没能收尾：${errText(e)}`, true);
    }
  };

  const toggleVoice = () => {
    if (voiceActiveRef.current) void endVoice();
    else void beginVoice();
  };

  const installVoicePack = async (id: string) => {
    setVoiceDownload({ id, progress: 0, status: "downloading" });
    try {
      await installModel(id);
      await setActiveModel(id);
      setVoiceDownload({ id, progress: 100, status: "complete" });
      setVoiceSetup(null);
      showVoiceNotice("语音包已装好，再点麦克风就能听写。");
    } catch (e) {
      setVoiceDownload({ id, progress: 0, status: "error" });
      showVoiceNotice(`语音包没装上：${errText(e)}`, true);
    }
  };

  voiceHandlerRef.current = (result: RecognitionResult) => {
    const text = (result.transcript ?? "").trim();
    if (!result.isFinal) {
      if (text) updateVoicePreview(text);
      return;
    }
    if (text) insertVoiceFinal(text);
    else dropVoicePreview(true);
    if (voiceStoppingRef.current) {
      voiceActiveRef.current = false;
      voiceStoppingRef.current = false;
      setVoiceActive(false);
      setVoiceStopping(false);
    }
  };

  voiceErrorRef.current = (error: SttError) => {
    const keep = error.code === "NO_SPEECH";
    if (!keep) {
      voiceActiveRef.current = false;
      voiceStoppingRef.current = false;
      setVoiceActive(false);
      setVoiceStopping(false);
      dropVoicePreview(true);
    }
    const map: Record<string, string> = {
      NO_SPEECH: "没听清，再说一遍。",
      NOT_AVAILABLE: "这台设备没有系统语音服务。",
      PERMISSION_DENIED: "没有麦克风权限，去系统设置里放行。",
      SPEECH_PERMISSION_DENIED: "语音识别权限被拒绝。",
      NETWORK_ERROR: "语音服务需要网络，当前连不上。",
      AUDIO_ERROR: "麦克风被别的程序占着。",
      ALREADY_LISTENING: "已经在听了。",
      CANCELLED: "这次收听已取消。",
      TIMEOUT: "长时间没听到声音，已停下。",
      BUSY: "语音服务正忙，稍后再试。",
    };
    showVoiceNotice(map[error.code] || error.message || "语音识别出错。", true);
  };

  voiceStateRef.current = (state) => {
    if (state === "listening") {
      voiceActiveRef.current = true;
      setVoiceActive(true);
      return;
    }
    if (state === "idle" && voiceActiveRef.current) {
      dropVoicePreview(true);
      voiceActiveRef.current = false;
      voiceStoppingRef.current = false;
      setVoiceActive(false);
      setVoiceStopping(false);
    }
  };

  useEffect(() => {
    let alive = true;
    const unlisteners: Array<() => void> = [];
    const keep = (p: Promise<() => void>) => {
      void p.then((fn) => {
        if (alive) unlisteners.push(fn);
        else fn();
      });
    };
    keep(onResult((result) => voiceHandlerRef.current(result)));
    keep(onError((error) => voiceErrorRef.current(error)));
    keep(onStateChange((event) => voiceStateRef.current(event.state)));
    return () => {
      alive = false;
      unlisteners.forEach((fn) => fn());
      window.clearTimeout(voiceNoticeTimer.current);
      if (voiceActiveRef.current) void stopListening().catch(() => undefined);
    };
    // 语音事件只注册一次，回调走 ref，避免每次输入重挂监听。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!voiceActive) return;
    const timer = window.setInterval(() => {
      setVoiceSeconds(Math.floor((Date.now() - voiceStartedAt.current) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [voiceActive]);

  useEffect(() => {
    if (!voiceSetup) return;
    let unlisten: (() => void) | undefined;
    void onDownloadProgress((event: DownloadProgressEvent) => {
      if (!event.modelId) return;
      setVoiceDownload((prev) => {
        if (!prev || prev.id !== event.modelId) return prev;
        return {
          id: prev.id,
          progress: event.status === "complete" ? 100 : Math.round(event.progress ?? prev.progress),
          status: event.status,
        };
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [voiceSetup]);

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
  const saveLabel =
    saveState === "saving" ? t("保存中") : saveState === "dirty" ? t("未保存") : t("已保存");

  return (
    <>
      <div className={`editor-toolbar${toolsOpen ? " mobile-open" : ""}`}>
        {isPhone && (
          <button className="tbtn editor-sheet-close" title={t("完成")} onClick={() => setToolsOpen(false)}>
            <Icon name="close" size={16} />
          </button>
        )}
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
          <button
            className={`tbtn voice-btn${voiceActive ? " on" : ""}${voiceStopping ? " is-stopping" : ""}`}
            title={voiceActive ? t("停止语音并落字") : t("语音输入")}
            aria-pressed={voiceActive}
            disabled={voiceBusy}
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => e.preventDefault()}
            onClick={toggleVoice}
          >
            <Icon name="mic" size={15} />
            <span>
              {voiceBusy
                ? t("准备…")
                : voiceStopping
                  ? t("转写…")
                  : voiceActive
                    ? `${Math.floor(voiceSeconds / 60)}:${String(voiceSeconds % 60).padStart(2, "0")}`
                    : t("语音")}
            </span>
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
          {isPhone && (
            <div className={`editor-mobile-meta save-${saveState}`}>
              <span className="editor-mobile-volume">
                {volumeTitle || tf("第 {index} / {total} 章", { index: index + 1, total })}
              </span>
              <span className="editor-mobile-facts">
                <i />
                <b>{saveLabel}</b>
                <em>|</em>
                <span>{fmtNumber(words)} {t("字")}</span>
              </span>
            </div>
          )}
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
            {!isPhone && (
              <>
                <span className="dot" />
                <span>{tf("{count} 个场景", { count: chapter.scenes.length })}</span>
              </>
            )}
            <span className="dot" />
            <span>{t("上次更新")} {fmtDateTime(chapter.updatedAt)}</span>
          </div>
          <div className="body-wrap">
            <div
              ref={bodyRef}
              className="body"
              contentEditable={!(isPhone && voiceActive)}
              role="textbox"
              aria-multiline="true"
              suppressContentEditableWarning
              spellCheck={false}
              style={{ fontFamily: fontStack }}
              onInput={handleInput}
              onPointerDown={(e) => {
                // 边听边换落点：把上一段预览落成正文，后面的字从新光标开始。
                if (voicePreviewRef.current) dropVoicePreview(true);
                if (voiceActiveRef.current && isPhone) {
                  e.preventDefault();
                  const range = voicePointRange(e.clientX, e.clientY);
                  if (range) {
                    moveVoiceAnchor(range);
                    (document.activeElement as HTMLElement | null)?.blur();
                  }
                }
              }}
              onClick={(e) => {
                if (voiceActiveRef.current) return;
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

      {isPhone && voicePad && voiceActive && (
        <div className={`voice-pad${voiceActive ? " is-listening" : ""}`} role="toolbar" aria-label={t("常用标点")}>
          {voiceMarks.map((mark) => (
            <button
              key={mark}
              type="button"
              className="voice-pad-key"
              onMouseDown={(e) => e.preventDefault()}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => insertVoiceMark(mark)}
            >
              {mark}
            </button>
          ))}
          <button
            type="button"
            className="voice-pad-key voice-pad-action"
            aria-label={t("换行")}
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => e.preventDefault()}
            onClick={insertVoiceBreak}
          >
            ↵
          </button>
          <button
            type="button"
            className="voice-pad-key voice-pad-action"
            aria-label={t("退格")}
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => e.preventDefault()}
            onClick={deleteVoiceBefore}
          >
            ⌫
          </button>
        </div>
      )}

      {voiceNotice && (
        <div className={`voice-notice${voiceNotice.warn ? " warn" : ""}`} role="status">
          <span className={voiceActive ? "voice-live-dot" : ""} />
          {voiceNotice.text}
        </div>
      )}

      {isPhone && (
        <button
          className={`editor-tools-fab${toolsOpen ? " on" : ""}`}
          title={t("写作")}
          aria-label={t("写作")}
          onClick={() => setToolsOpen((v) => !v)}
        >
          <Icon name="type" size={17} />
        </button>
      )}

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

      {voiceSetup && (
        <div className="voice-setup-layer" onMouseDown={(e) => e.target === e.currentTarget && !voiceDownload && setVoiceSetup(null)}>
          <div className="voice-setup-card" role="dialog" aria-modal="true" aria-label={t("本地语音包")}>
            <header>
              <div>
                <b>{t("先装一个本地语音包")}</b>
                <em>{t("桌面端本地转写，正文不出这台电脑。装好后再点麦克风。")}</em>
              </div>
              <button
                className="icon-btn"
                aria-label={t("关闭")}
                disabled={voiceDownload?.status === "downloading"}
                onClick={() => setVoiceSetup(null)}
              >
                <Icon name="close" size={15} />
              </button>
            </header>
            <div className="voice-model-list">
              {voiceSetup.models.map((model) => {
                const downloading = voiceDownload?.id === model.id && voiceDownload.status === "downloading";
                const done = voiceDownload?.id === model.id && voiceDownload.status === "complete";
                return (
                  <button
                    key={model.id}
                    className={`voice-model${model.id === "base" ? " recommended" : ""}`}
                    disabled={Boolean(voiceDownload && voiceDownload.status === "downloading")}
                    onClick={() => void installVoicePack(model.id)}
                  >
                    <span>
                      <b>
                        {model.id === "tiny" ? t("小号") : model.id === "base" ? t("标准") : t("高精度")}
                        <i>{model.sizeMb} MB</i>
                      </b>
                      <em>
                        {model.id === "tiny"
                          ? t("最快，适合旧电脑；中文精度一般。")
                          : model.id === "base"
                            ? t("中文听写够用，下载 142 MB。")
                            : t("更准，但更吃内存和等待时间。")}
                      </em>
                    </span>
                    <strong>{done ? t("已装好") : downloading ? `${voiceDownload?.progress ?? 0}%` : t("下载")}</strong>
                  </button>
                );
              })}
            </div>
            {voiceDownload?.status === "downloading" && (
              <div className="voice-progress" aria-label={t("下载进度")}>
                <i style={{ width: `${voiceDownload.progress}%` }} />
              </div>
            )}
            {voiceDownload?.status === "error" && (
              <p className="voice-setup-err">{t("下载失败，检查网络后再点一次。")}</p>
            )}
            <footer>
              <span>{t("只下一次；模型存在 App 数据目录，卸载 Chapter 才会清掉。")}</span>
              <button className="btn btn-ghost" disabled={voiceDownload?.status === "downloading"} onClick={() => setVoiceSetup(null)}>
                {t("先不装")}
              </button>
            </footer>
          </div>
        </div>
      )}

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
