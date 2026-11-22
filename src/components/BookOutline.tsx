import { useEffect, useMemo, useRef, useState } from "react";
import type { BookMeta, Chapter, Outline } from "../types";
import { countWords, fmtWords, mdToHtml } from "../lib/text";
import { t } from "../lib/i18n";
import { recallScroll, rememberScroll } from "../lib/viewMemory";
import { Icon } from "./Icon";
import { StoryMap } from "./StoryMap";

interface Props {
  bookPath: string;
  meta: BookMeta;
  chapters: Chapter[];
  onChange: (md: string) => void;
  onSave: () => void;
  outline: Outline;
  onOpenChapter?: (id: string) => void;
}

type Block = {
  key: string;
  label: string;
  hint: string;
  icon: "type" | "bold" | "quote" | "hr" | "outline" | "plus";
  run: (ta: HTMLTextAreaElement, set: (v: string) => void) => void;
};

function replaceRange(
  ta: HTMLTextAreaElement,
  before: string,
  after = "",
  placeholder = "文字",
  linePrefix = false,
) {
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const value = ta.value;
  if (linePrefix) {
    const ls = value.lastIndexOf("\n", start - 1) + 1;
    const next = value.slice(0, ls) + before + value.slice(ls);
    return { value: next, caret: start + before.length };
  }
  const selected = value.slice(start, end) || placeholder;
  const next = value.slice(0, start) + before + selected + after + value.slice(end);
  return { value: next, caret: start + before.length + selected.length + after.length };
}

export function BookOutline({ bookPath, meta, chapters, onChange, onSave, outline, onOpenChapter }: Props) {
  const value = meta.bookOutline ?? "";
  const [preview, setPreview] = useState(false);
  const [mapMode, setMapMode] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const scrollKey = `bookoutline:${bookPath}`;

  // 整书大纲通常很长，翻到一半去写正文，再回来不应该重新从头读。
  useEffect(() => {
    if (preview || mapMode) return;
    const el = taRef.current;
    if (!el) return;
    const saved = recallScroll(scrollKey);
    const restore = () => {
      if (saved > 0) el.scrollTop = Math.min(saved, Math.max(0, el.scrollHeight - el.clientHeight));
    };
    requestAnimationFrame(restore);
    const lateRestore = window.setTimeout(restore, 120);
    const onScroll = () => rememberScroll(scrollKey, el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.clearTimeout(lateRestore);
      // 与 Editor 同理：卸载时 scrollTop 不可靠，位置已由滚动事件保存。
      el.removeEventListener("scroll", onScroll);
    };
  }, [preview, mapMode, scrollKey]);

  const insertImage = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1100 / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL("image/jpeg", 0.86);
        const ta = taRef.current;
        if (!ta) return;
        const at = ta.selectionStart;
        const block = `\n\n![插图](${data})\n\n`;
        onChange(value.slice(0, at) + block + value.slice(at));
        requestAnimationFrame(() => {
          ta.focus();
          ta.setSelectionRange(at + block.length, at + block.length);
        });
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const blocks: Block[] = useMemo(
    () => [
      {
        key: "h1",
        label: "一级标题",
        hint: "卷 / 幕",
        icon: "type",
        run: (ta, set) => {
          const r = replaceRange(ta, "# ", "", "第一卷", true);
          set(r.value);
          requestAnimationFrame(() => ta.setSelectionRange(r.caret, r.caret));
        },
      },
      {
        key: "h2",
        label: "二级标题",
        hint: "章 / 段落",
        icon: "type",
        run: (ta, set) => {
          const r = replaceRange(ta, "## ", "", "这一段讲什么", true);
          set(r.value);
          requestAnimationFrame(() => ta.setSelectionRange(r.caret, r.caret));
        },
      },
      {
        key: "bold",
        label: "加粗",
        hint: "关键词",
        icon: "bold",
        run: (ta, set) => {
          const r = replaceRange(ta, "**", "**", "重点");
          set(r.value);
          requestAnimationFrame(() => ta.setSelectionRange(r.caret, r.caret));
        },
      },
      {
        key: "quote",
        label: "引用",
        hint: "线索 / 伏笔",
        icon: "quote",
        run: (ta, set) => {
          const r = replaceRange(ta, "> ", "", "一条要记住的线索", true);
          set(r.value);
          requestAnimationFrame(() => ta.setSelectionRange(r.caret, r.caret));
        },
      },
      {
        key: "list",
        label: "清单",
        hint: "事件 / 待办",
        icon: "outline",
        run: (ta, set) => {
          const r = replaceRange(ta, "- ", "", "一件事", true);
          set(r.value);
          requestAnimationFrame(() => ta.setSelectionRange(r.caret, r.caret));
        },
      },
      {
        key: "hr",
        label: "分隔线",
        hint: "分段",
        icon: "hr",
        run: (ta, set) => {
          const r = replaceRange(ta, "\n---\n\n", "", "", true);
          set(r.value);
          requestAnimationFrame(() => ta.setSelectionRange(r.caret, r.caret));
        },
      },
    ],
    [],
  );

  const html = useMemo(() => mdToHtml(value || ""), [value]);
  const words = useMemo(() => countWords(value), [value]);

  return (
    <div className="bookout">
      <header className="bookout-head">
        <div>
          <h2>{t("整书大纲")}</h2>
          <p>{t("只属于这本书：换章不换、切视图不丢。写故事骨架、主线、伏笔和结局。")}</p>
        </div>
        <div className="bookout-actions">
          <span className="bookout-stat">
            {chapters.length} {t("章")} · {fmtWords(words)} {t("字")}
          </span>
          <div className="segmini">
            <button
              className={!preview && !mapMode ? "on" : ""}
              onClick={() => {
                setPreview(false);
                setMapMode(false);
              }}
            >
              {t("编辑")}
            </button>
            <button
              className={preview && !mapMode ? "on" : ""}
              onClick={() => {
                setPreview(true);
                setMapMode(false);
              }}
            >
              {t("预览")}
            </button>
            <button
              className={mapMode ? "on" : ""}
              onClick={() => {
                setMapMode(true);
                setPreview(false);
              }}
            >
              {t("故事网")}
            </button>
          </div>
          <button className="btn btn-ghost btn-xs" onClick={onSave} title="Ctrl+S">
            <Icon name="check" size={13} />
            {t("保存")}
          </button>
        </div>
      </header>

      <div className={`bookout-body${preview ? " preview" : ""}${mapMode ? " map" : ""}`}>
        {mapMode ? (
          <StoryMap
            bookId={meta.id}
            chapters={chapters}
            outline={outline}
            onOpen={onOpenChapter}
          />
        ) : (
          <>
        {!preview && (
          <aside className="bookout-palette">
            <div className="palette-title">{t("点一下就插入")}</div>
            {blocks.map((b) => (
              <button
                key={b.key}
                className="palette-item"
                onClick={() => {
                  const ta = taRef.current;
                  if (!ta) return;
                  b.run(ta, onChange);
                  ta.focus();
                }}
              >
                <span className="palette-ico">
                  <Icon name={b.icon} size={14} />
                </span>
                <span className="palette-text">
                  <b>{t(b.label)}</b>
                  <em>{t(b.hint)}</em>
                </span>
              </button>
            ))}
            <div className="palette-divider" />
            <div className="palette-title">{t("整书骨架")}</div>
            <button className="palette-item" onClick={() => imageRef.current?.click()}>
              <span className="palette-ico">
                <Icon name="image" size={14} />
              </span>
              <span className="palette-text">
                <b>{t("插入插图")}</b>
                <em>{t("人物关系、地图、场景草稿")}</em>
              </span>
            </button>
            <input
              ref={imageRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                insertImage(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <button
              className="palette-item"
              onClick={() => {
                const ta = taRef.current;
                if (!ta) return;
                const tpl = `# 故事一句话\n\n> 主角想要什么，什么挡着他。\n\n## 第一幕 · 建置\n- 日常世界\n- 打破日常的事件\n\n## 第二幕 · 对抗\n- 第一次尝试与失败\n- 中点反转\n- 最低谷\n\n## 第三幕 · 解决\n- 最后的决断\n- 余波\n`;
                onChange(value ? `${value.trimEnd()}\n\n${tpl}` : tpl);
                requestAnimationFrame(() => ta.focus());
              }}
            >
              <span className="palette-ico">
                <Icon name="plus" size={14} />
              </span>
              <span className="palette-text">
                <b>{t("三幕骨架")}</b>
                <em>{t("一键铺开")}</em>
              </span>
            </button>
            <div className="palette-foot">
              {t("不会写 Markdown 也没关系：所有符号都由左边按钮替你写。")}
            </div>
          </aside>
        )}

        {!preview ? (
          <section className="bookout-editor">
            <textarea
              ref={taRef}
              className="bookout-input"
              value={value}
              spellCheck={false}
              placeholder={"从这里开始写整本书的骨架……\n\n比如：\n# 一句话故事\n一个在长夜中找灯的人，最后发现灯一直在自己手里。\n\n## 主线\n- 停电\n- 离站\n- 回城"}
              onChange={(e) => onChange(e.target.value)}
            />
          </section>
        ) : (
          <section className="bookout-preview paper">
            {value.trim() ? (
              <div className="bookout-rendered" dangerouslySetInnerHTML={{ __html: html }} />
            ) : (
              <div className="bookout-empty">
                <b>{t("还没有整书大纲")}</b>
                <p>{t("切回「编辑」，用左边的积木块搭一个骨架；或者直接写几行。")}</p>
              </div>
            )}
          </section>
        )}
          </>
        )}
      </div>
    </div>
  );
}
