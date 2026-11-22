import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { BookMeta, Chapter } from "../types";
import { countWords, countWordsChunked, escapeHtml, fmtNumber, fmtTime, fmtWords, htmlToMd, mdToHtml } from "../lib/text";
import { t, tf } from "../lib/i18n";
import { Icon } from "./Icon";

export interface EditorHandle {
  flush: () => string;
  wordCount: () => number;
  insertText: (text: string) => void;
  focus: () => void;
}

interface Props {
  chapter: Chapter;
  body: string;
  meta: BookMeta;
  index: number;
  total: number;
  bookWords: number;
  todayAdded: number;
  focusMode: boolean;
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
  index,
  total,
  bookWords,
  todayAdded,
  focusMode,
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
        document.execCommand("insertText", false, text);
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
          title="引用段落"
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleQuote}
        >
          <Icon name="quote" size={16} />
        </button>
        <button
          className="tbtn"
          title="插入分隔线"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => run("insertHorizontalRule")}
        >
          <Icon name="hr" size={16} />
        </button>
        <span className="divider-v" />
        <button className="tbtn" title={t("插入设定引用")} onClick={onInsertLore}>
          <Icon name="users" size={16} />
          <span>{t("设定")}</span>
        </button>
        <span className="divider-v" />
        <button className="tbtn" title="撤销 Ctrl+Z" onClick={() => run("undo")}>
          <Icon name="undo" size={16} />
        </button>
        <button className="tbtn" title="重做 Ctrl+Y" onClick={() => run("redo")}>
          <Icon name="redo" size={16} />
        </button>
        <span className="grow" />
        <button className="tbtn" title={t("专注模式（隐藏所有面板）")} onClick={onToggleFocus}>
          <Icon name="focus" size={16} />
          <span>{t("专注")}</span>
        </button>
      </div>

      <div className="paper-scroll" ref={scrollRef}>
        <article className="paper">
          <input
            className="ch-title"
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
              onInput={handleInput}
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
            {empty && <div className="body-placeholder">{t("从这里开始写……")}</div>}
          </div>
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
        <span style={{ color: "var(--text-4)" }}>
          Ctrl+S 保存 · Ctrl+B 加粗 · Ctrl+I 斜体
        </span>
      </footer>
    </>
  );
}
