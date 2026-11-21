import { useEffect, useMemo, useRef, useState } from "react";
import type { ImportDoc } from "../types";
import { countWords, fmtWords } from "../lib/text";
import { t } from "../lib/i18n";
import { buildSections, detectDocMeta, detectMarkers, isVolumeTitle, readScanRules, type ImportMarker, type ScanRules } from "../lib/split";
import { Icon } from "./Icon";

interface Props {
  doc: ImportDoc;
  mode: "new" | "append";
  bookTitle?: string;
  onClose: () => void;
  onImport: (payload: {
    title: string;
    author: string;
    sections: ReturnType<typeof buildSections>;
  }) => Promise<void>;
}

function lineStartAt(text: string, pos: number): number {
  const nl = text.lastIndexOf("\n", Math.max(0, pos - 1));
  return nl + 1;
}

function lineAt(text: string, pos: number): string {
  const start = lineStartAt(text, pos);
  const nl = text.indexOf("\n", start);
  return text.slice(start, nl < 0 ? text.length : nl);
}

export function ImportDialog({ doc, mode, bookTitle, onClose, onImport }: Props) {
  const rules = useMemo<ScanRules>(() => readScanRules(), []);
  const guessed = useMemo(() => detectDocMeta(doc.text), [doc.text]);
  const draftKey = `chapter.importDraft.${doc.name}.${doc.format}.${doc.text.length}`;
  const initial = useMemo(() => detectMarkers(doc.text, rules), [doc.text, rules]);
  const [markers, setMarkers] = useState<ImportMarker[]>(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      const draft = raw ? JSON.parse(raw) : null;
      if (Array.isArray(draft?.markers) && draft.markers.length > 0) return draft.markers;
    } catch {
      /* 草稿坏了就用自动识别 */
    }
    return initial;
  });
  const [title, setTitle] = useState(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      const draft = raw ? JSON.parse(raw) : null;
      if (typeof draft?.title === "string" && draft.title.trim()) return draft.title;
    } catch {
      /* ignore */
    }
    return guessed.title || bookTitle || doc.name;
  });
  const [author, setAuthor] = useState(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      const draft = raw ? JSON.parse(raw) : null;
      if (typeof draft?.author === "string" && draft.author.trim()) return draft.author;
    } catch {
      /* ignore */
    }
    return guessed.author || "";
  });
  const [selection, setSelection] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const saveDraft = () => {
    try {
      localStorage.setItem(
        draftKey,
        JSON.stringify({ markers, title, author, savedAt: Date.now() }),
      );
    } catch {
      /* 本地存不下也不拦着导入 */
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(saveDraft, 280);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markers, title, author]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveDraft();
        setHint(t("已保存草稿"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markers, title, author]);

  const close = () => {
    saveDraft();
    onClose();
  };

  const sections = useMemo(() => buildSections(doc.text, markers), [doc.text, markers]);
  const words = useMemo(
    () => sections.reduce((n, s) => n + countWords(s.body), 0),
    [sections],
  );
  const volumes = useMemo(() => {
    const names = new Set(sections.map((s) => s.volumeTitle));
    return names.size;
  }, [sections]);

  const groups = useMemo(() => {
    const out: { title: string; volumeIndex: number; items: { marker: ImportMarker; index: number }[] }[] = [];
    let current = { title: t("卷前"), volumeIndex: -1, items: [] as { marker: ImportMarker; index: number }[] };
    markers.forEach((m, i) => {
      if (m.volume) {
        if (current.items.length > 0 || current.volumeIndex >= 0) out.push(current);
        current = { title: m.title, volumeIndex: i, items: [] };
      } else {
        current.items.push({ marker: m, index: i });
      }
    });
    if (current.items.length > 0 || current.volumeIndex >= 0) out.push(current);
    return out;
  }, [markers]);

  const chapterOrdinal = useMemo(() => {
    const map = new Map<number, number>();
    let n = 0;
    markers.forEach((m, i) => {
      if (!m.volume) {
        n += 1;
        map.set(i, n);
      }
    });
    return map;
  }, [markers]);

  const markAt = (pos: number, raw: string) => {
    const clean = raw.replace(/^#+\s*/, "").trim();
    if (!clean) {
      setHint("先框选一行标题，再按 Enter");
      return;
    }
    const start = lineStartAt(doc.text, pos);
    setMarkers((prev) => {
      const rest = prev.filter((m) => Math.abs(m.pos - start) > 1);
      return [...rest, { pos: start, title: clean, volume: isVolumeTitle(clean, rules) }].sort(
        (a, b) => a.pos - b.pos,
      );
    });
    setHint(`已标记「${clean}」`);
    setSelection("");
  };

  const onSelect = () => {
    const el = areaRef.current;
    if (!el) return;
    setSelection(doc.text.slice(el.selectionStart, el.selectionEnd));
  };

  const markSelection = () => {
    const el = areaRef.current;
    if (!el) return;
    const selected = doc.text.slice(el.selectionStart, el.selectionEnd).trim();
    if (selected && !selected.includes("\n")) {
      markAt(el.selectionStart, selected);
      return;
    }
    const line = lineAt(doc.text, el.selectionStart).trim();
    if (!line) return;
    if (line.length > 64) {
      setHint("这一行太长，先用鼠标框选标题文字");
      return;
    }
    markAt(el.selectionStart, line);
  };

  const undoMark = () => {
    setMarkers((prev) => prev.slice(0, -1));
    setHint("已撤销上一个标记");
  };

  const submit = async () => {
    if (busy) return;
    if (mode === "new" && !title.trim()) {
      setHint("给这本书起个名字");
      return;
    }
    setBusy(true);
    try {
      await onImport({ title: title.trim(), author: author.trim(), sections });
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="import-overlay">
      <div className="import-shell">
        <header className="import-head">
          <div className="import-head-title">
            <span className="import-ico">
              <Icon name="download" size={18} />
            </span>
            <div>
              <h2>{t("导入书稿")}</h2>
              <p>
                {doc.name}.{doc.format} · {fmtWords(words)} {t("字")} ·{" "}
                {sections.length > 0 ? `→ ${sections.length} ${t("章")}` : t("还没有分章")}
                {mode === "append" ? ` · ${t("追加到")}《${bookTitle}》` : ""}
              </p>
            </div>
          </div>
          <button className="icon-btn" title={t("关闭")} onClick={close}>
            <Icon name="close" size={16} />
          </button>
        </header>

        {mode === "new" && (
          <div className="import-meta">
            <label className="field">
              <span>{t("书名")}</span>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="field">
              <span>{t("作者")}</span>
              <input
                className="input"
                value={author}
                placeholder={t("可以留空")}
                onChange={(e) => setAuthor(e.target.value)}
              />
            </label>
            <div className="import-tip">
              <b>{t("怎么分章")}</b>
              <span>{t("在左边框选一行标题，按 Enter 就切一章；形如「第X卷」的标题会自动成为卷。")}</span>
            </div>
          </div>
        )}

        {mode === "append" && (
          <div className="import-tip import-tip-wide">
            <b>{t("怎么分章")}</b>
            <span>{t("框选标题按 Enter 标记；导入后会作为新卷追加到")}《{bookTitle}》，{t("不会覆盖原稿。")}</span>
          </div>
        )}

        <div className="import-split">
          <section className="import-paper-wrap">
            <div className="import-paper-bar">
              <span className={`import-status${hint ? " on" : ""}`}>{hint || t("框选标题，按 Enter")}</span>
              <div className="import-bar-actions">
                <button className="btn btn-ghost btn-xs" onClick={undoMark} disabled={!markers.length}>
                  {t("撤销标记")}
                </button>
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={() => {
                    setMarkers(detectMarkers(doc.text, rules));
                    setHint("已重新自动识别");
                  }}
                >
                  {t("自动识别")}
                </button>
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={() => {
                    setMarkers([]);
                    setHint("已清空，开始手动分章");
                  }}
                >
                  {t("清空")}
                </button>
              </div>
            </div>
            <textarea
              ref={areaRef}
              className="import-paper"
              value={doc.text}
              readOnly
              spellCheck={false}
              onSelect={onSelect}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.ctrlKey && !e.altKey) {
                  e.preventDefault();
                  markSelection();
                }
              }}
            />
            {selection && (
              <div className="import-selection">
                <span>{t("已选中")}</span>
                <b>{selection.trim().slice(0, 28) || t("空")}</b>
                <em>{t("Enter 即为章节标题")}</em>
              </div>
            )}
          </section>

          <aside className="import-side">
            <div className="import-side-head">
              <div>
                <h3>{t("章节顺序")}</h3>
                <p>
                  {sections.length} {t("章")} · {volumes} {t("卷")}
                </p>
              </div>
              <span className="import-count">{markers.length}</span>
            </div>
            <div className="import-list">
              {markers.length === 0 ? (
                <div className="import-empty">
                  <div className="import-empty-ico">
                    <Icon name="outline" size={22} />
                  </div>
                  <b>{t("还没有切点")}</b>
                  <p>{t("在左侧找一行标题，按住鼠标框住它，按 Enter。第一个标题到第二个标题之间，就是这一章的正文。")}</p>
                  <p className="muted">{t("也可以直接按「完成」，整篇会作为一章导入。")}</p>
                </div>
              ) : (
                groups.map((group, gi) => (
                  <div className={`import-group${group.volumeIndex >= 0 ? " with-volume" : ""}`} key={`g${gi}-${group.volumeIndex}`}>
                    {group.volumeIndex >= 0 ? (
                      <div className="import-group-head">
                        <span className="import-group-no">卷 {String(gi + 1).padStart(2, "0")}</span>
                        <input
                          className="import-row-title import-group-title"
                          value={group.title}
                          onChange={(e) =>
                            setMarkers((prev) =>
                              prev.map((x, xi) =>
                                xi === group.volumeIndex ? { ...x, title: e.target.value } : x,
                              ),
                            )
                          }
                        />
                        <span className="import-group-count">{group.items.length} 章</span>
                        <button
                          className="import-kind vol"
                          title={t("这是一卷")}
                          onClick={() =>
                            setMarkers((prev) =>
                              prev.map((x, xi) =>
                                xi === group.volumeIndex ? { ...x, volume: false } : x,
                              ),
                            )
                          }
                        >
                          {t("卷")}
                        </button>
                        <button
                          className="icon-btn import-del"
                          title={t("移除这个切点")}
                          onClick={() =>
                            setMarkers((prev) => prev.filter((_, xi) => xi !== group.volumeIndex))
                          }
                        >
                          <Icon name="close" size={12} />
                        </button>
                      </div>
                    ) : (
                      <div className="import-group-head unvol">
                        <span className="import-group-no">{t("卷前")}</span>
                        <span className="import-group-hint">{t("没有卷标题的章节")}</span>
                        <span className="import-group-count">{group.items.length} 章</span>
                      </div>
                    )}
                    <div className="import-group-chapters">
                      {group.items.map(({ marker: m, index: i }, ci) => {
                        const next = markers[i + 1]?.pos ?? doc.text.length;
                        const bodyStart = doc.text.indexOf("\n", m.pos) + 1 || doc.text.length;
                        const preview = doc.text
                          .slice(bodyStart, next)
                          .trim()
                          .replace(/\s+/g, " ")
                          .slice(0, 46);
                        return (
                          <div
                            className="import-row"
                            key={`${m.pos}-${i}`}
                            style={{ animationDelay: `${Math.min(ci, 24) * 20}ms` }}
                          >
                            <span className="import-num">
                              {String(chapterOrdinal.get(i) ?? i + 1).padStart(2, "0")}
                            </span>
                            <div className="import-row-main">
                              <input
                                className="import-row-title"
                                value={m.title}
                                onChange={(e) =>
                                  setMarkers((prev) =>
                                    prev.map((x, xi) =>
                                      xi === i ? { ...x, title: e.target.value } : x,
                                    ),
                                  )
                                }
                              />
                              <span className="import-row-preview">{preview || t("（空正文）")}</span>
                            </div>
                            <button
                              className="import-kind"
                              title={t("这是一章")}
                              onClick={() =>
                                setMarkers((prev) =>
                                  prev.map((x, xi) => (xi === i ? { ...x, volume: true } : x)),
                                )
                              }
                            >
                              {t("章")}
                            </button>
                            <button
                              className="icon-btn import-del"
                              title={t("移除这个切点")}
                              onClick={() =>
                                setMarkers((prev) => prev.filter((_, xi) => xi !== i))
                              }
                            >
                              <Icon name="close" size={12} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="import-sum">
              <span>{t("正文合计")}</span>
              <b>{fmtWords(words)} {t("字")}</b>
            </div>
          </aside>
        </div>

        <footer className="import-foot">
          <div className="import-foot-note">
            <kbd>Enter</kbd> {t("标记标题")}
            <span>·</span>
            <kbd>Ctrl</kbd>+<kbd>C</kbd>/<kbd>V</kbd>/<kbd>X</kbd> {t("复制粘贴")}
            <span>·</span>
            {t("关闭会自动保存")}
          </div>
          <div className="import-foot-actions">
            <button className="btn btn-ghost" onClick={close}>
              {t("取消")}
            </button>
            <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
              <Icon name="check" size={15} />
              {busy ? t("正在导入…") : `${t("完成导入")} · ${sections.length} ${t("章")}`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
