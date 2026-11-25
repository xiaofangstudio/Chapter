import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Project } from "../types";
import { api, errText } from "../lib/api";
import { mdToHtml } from "../lib/text";
import { t } from "../lib/i18n";
import { Icon } from "./Icon";

type Paper = "A4" | "A5" | "B5" | "16K";
type PrintTarget = "pdf" | "word";

interface PrintImage {
  id: string;
  src: string;
  name: string;
  width: number;
  height: number;
}

interface PrintBlock {
  kind: "title" | "author" | "heading" | "kicker" | "p" | "quote" | "image" | "pagebreak";
  text?: string;
  src?: string;
  width?: number;
  height?: number;
  pageBreak?: boolean;
}

export interface PrintOptions {
  paper: Paper;
  margin: "normal" | "narrow" | "wide";
  font: "serif" | "sans";
  fontSize: number;
  lineHeight: number;
  indent: number;
  chapterBreak: boolean;
  includeMatter: boolean;
  blankFirst: boolean;
  blankLast: boolean;
  titlePage: boolean;
  toc: boolean;
  pageNumbers: boolean;
}

const DEFAULT_OPTS: PrintOptions = {
  paper: "A4",
  margin: "normal",
  font: "serif",
  fontSize: 11,
  lineHeight: 1.75,
  indent: 2,
  chapterBreak: true,
  includeMatter: true,
  blankFirst: true,
  blankLast: true,
  titlePage: true,
  toc: true,
  pageNumbers: true,
};

const PRESETS: { id: string; label: string; opts: PrintOptions }[] = [
  {
    id: "book-a5",
    label: "成书 · A5",
    opts: { ...DEFAULT_OPTS, paper: "A5", fontSize: 10.5, lineHeight: 1.8 },
  },
  {
    id: "submit-a4",
    label: "投稿 · A4",
    opts: {
      ...DEFAULT_OPTS,
      paper: "A4",
      margin: "wide",
      fontSize: 12,
      lineHeight: 2,
      blankFirst: false,
      blankLast: false,
      toc: false,
    },
  },
  {
    id: "shop-a4",
    label: "打印店 · A4",
    opts: { ...DEFAULT_OPTS, paper: "A4", margin: "narrow", blankFirst: false, blankLast: false },
  },
];
const PAPER: Record<Paper, [number, number]> = {
  A4: [210, 297],
  A5: [148, 210],
  B5: [176, 250],
  "16K": [184, 260],
};

const MARGIN: Record<PrintOptions["margin"], [number, number]> = {
  normal: [22, 22],
  narrow: [14, 14],
  wide: [28, 28],
};

const PT = 1.3333;

function plain(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^>\s*/, "")
    .replace(/^[-*+]\s+/, "· ")
    .replace(/^\d+[.)]\s+/, (m) => m.trim() + " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|`|~~)/g, "")
    .trim();
}

function mdBlocks(md: string): PrintBlock[] {
  const out: PrintBlock[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let quote: string[] = [];
  const flushQuote = () => {
    if (quote.length) {
      out.push({ kind: "quote", text: quote.join(" ") });
      quote = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushQuote();
      continue;
    }
    if (/^([-*_])\1{2,}$/.test(line)) {
      flushQuote();
      continue;
    }
    if (line.startsWith(">")) {
      quote.push(plain(line));
      continue;
    }
    flushQuote();
    if (/^#{1,6}\s/.test(line)) {
      out.push({ kind: "heading", text: plain(line) });
    } else if (/^!\[[^\]]*]\(/.test(line)) {
      continue;
    } else {
      out.push({ kind: "p", text: plain(line) });
    }
  }
  flushQuote();
  return out;
}

function safeName(name: string): string {
  return (name || "未命名").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
}

export function PrintStudio({
  project,
  target: initialTarget,
  initialChapter,
  onClose,
}: {
  project: Project;
  target: PrintTarget;
  initialChapter?: string;
  onClose: () => void;
}) {
  const [target, setTarget] = useState<PrintTarget>(initialTarget);
  const [opts, setOpts] = useState<PrintOptions>(() => {
    try {
      const raw = localStorage.getItem("chapter.printPreset");
      if (raw) return { ...DEFAULT_OPTS, ...(JSON.parse(raw) as Partial<PrintOptions>) };
    } catch {
      /* ignore */
    }
    return DEFAULT_OPTS;
  });
  const [zoom, setZoom] = useState(() => {
    if (typeof window !== "undefined" && window.innerWidth <= 820) {
      return Math.min(0.5, (window.innerWidth - 36) / 794);
    }
    return 0.82;
  });
  const [previewScope, setPreviewScope] = useState<"chapter" | "book">("chapter");
  const [bookLimit, setBookLimit] = useState(12);
  const [images, setImages] = useState<Record<string, PrintImage[]>>({});
  const [chapter, setChapter] = useState(
    initialChapter || project.outline.volumes[0]?.chapters[0]?.id || "",
  );
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [doneOk, setDoneOk] = useState(false);
  const [presetSaved, setPresetSaved] = useState(false);
  const [mobilePane, setMobilePane] = useState<"preview" | "settings">("preview");

  const chapters = useMemo(
    () =>
      project.outline.volumes.flatMap((v) =>
        v.chapters.map((c) => ({ id: c.id, title: c.title, volume: v.title, body: project.bodies[c.id] ?? "" })),
      ),
    [project],
  );

  const focused = chapters.find((c) => c.id === chapter) ?? chapters[0];

  /* 目录页码必须在排完正文后才知道。这里按与后端一致的字号/版心规则先估一遍，
     让预览里的目录和导出后的实际页码基本一致；导出时后端会再精确重算。 */
  const measurePagination = useCallback(() => {
    const [pw, ph] = PAPER[opts.paper];
    const [mt, ml] = MARGIN[opts.margin];
    const innerW = (pw - ml * 2) * 2.8346;
    const innerH = (ph - mt * 2) * 2.8346;
    const linesPerPage = Math.max(8, Math.floor(innerH / (opts.fontSize * opts.lineHeight)));
    const charsPerLine = Math.max(10, Math.floor(innerW / (opts.fontSize * 1.02)));
    const starts: Record<string, number> = {};
    let page = 1;
    let used = 0;
    let first = true;
    for (const c of chapters) {
      if (opts.chapterBreak && !first) {
        page += 1;
        used = 0;
      }
      first = false;
      starts[c.id] = page;
      used += 3.2;
      if (used >= linesPerPage) {
        page += 1;
        used = 0;
      }
      for (let k = 0; k < (images[c.id]?.length ?? 0); k += 1) {
        if (used + 7 > linesPerPage) {
          page += 1;
          used = 0;
        }
        used += 7;
      }
      const paras = c.body.replace(/\r\n/g, "\n").split(/\n+/).map(plain).filter(Boolean);
      for (const text of paras) {
        const need = Math.max(1, Math.ceil(text.length / charsPerLine)) + 0.45;
        if (used + need > linesPerPage) {
          page += 1;
          used = 0;
        }
        used += need;
      }
    }
    const tocPerPage = Math.max(12, Math.floor((ph - MARGIN[opts.margin][0] * 2 - 18) / 7.2));
    return { starts, tocPerPage, linesPerPage, charsPerLine, total: page };
  }, [chapters, opts, images]);

  /* 整本书可能几十万字：进工作台时先出界面，再把目录页码测算放到空闲时段，
     避免 i18n 懒加载和全文扫描一起堵住首帧。 */
  const [pagination, setPagination] = useState<{
    starts: Record<string, number>;
    tocPerPage: number;
    linesPerPage: number;
    charsPerLine: number;
    total: number;
  }>({ starts: {}, tocPerPage: 20, linesPerPage: 30, charsPerLine: 35, total: 1 });

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const idle =
        window.requestIdleCallback ??
        ((fn: IdleRequestCallback) => window.setTimeout(() => fn({} as IdleDeadline), 240));
      idle(() => {
        if (cancelled) return;
        setPagination(measurePagination());
      });
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [measurePagination]);

  const tocChunks = useMemo(() => {
    const rows = chapters.map((c) => ({ ...c, page: pagination.starts[c.id] ?? 1 }));
    const per = pagination.tocPerPage;
    const chunks: (typeof rows)[] = [];
    for (let i = 0; i < rows.length; i += per) chunks.push(rows.slice(i, i + per));
    return chunks.length ? chunks : [[]];
  }, [chapters, pagination]);

  const [pw, ph] = PAPER[opts.paper];  const [mt, ml] = MARGIN[opts.margin];
  const scale = 3.7795 * zoom;
  const sheetW = pw * scale;
  const padY = mt * scale;
  const padX = ml * scale;
  const previewFont = opts.fontSize * PT * zoom;
  const pageLabel = `${opts.paper} · ${pw}×${ph}mm · 版心 ${pw - ml * 2}×${ph - mt * 2}mm`;

  const addImage = async () => {
    if (!chapter) return;
    const picked = await openDialog({
      multiple: false,
      title: t("选一张插图"),
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif"] }],
    });
    if (!picked || Array.isArray(picked)) return;
    try {
      const src = await api.imageData(picked);
      const size = await new Promise<{ w: number; h: number }>((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve({ w: 1200, h: 800 });
        img.src = src;
      });
      setImages((prev) => ({
        ...prev,
        [chapter]: [
          ...(prev[chapter] ?? []),
          {
            id: `img_${Date.now().toString(36)}`,
            src,
            name: picked.split(/[\\/]/).pop() || "插图",
            width: size.w,
            height: size.h,
          },
        ],
      }));
    } catch (e) {
      setDoneOk(false);
      setDone(errText(e));
    }
  };

  const buildBlocks = (): PrintBlock[] => {
    const out: PrintBlock[] = [];
    out.push({ kind: "title", text: project.meta.title || "未命名" });
    out.push({ kind: "author", text: project.meta.author || "" });
    if (opts.includeMatter && project.meta.frontMatter?.trim()) {
      out.push({ kind: "heading", text: t("前言") });
      out.push(...mdBlocks(project.meta.frontMatter));
      out.push({ kind: "pagebreak" });
    }
    let firstChapter = true;
    project.outline.volumes.forEach((v) => {
      const list = v.chapters;
      if (!list.length) return;
      if (v.title && v.title !== t("正文")) {
        out.push({ kind: "kicker", text: v.title });
      }
      list.forEach((c) => {
        out.push({
          kind: "heading",
          text: c.title,
          pageBreak: opts.chapterBreak && !firstChapter,
        });
        firstChapter = false;
        for (const img of images[c.id] ?? []) {
          out.push({ kind: "image", src: img.src, width: img.width, height: img.height });
        }
        out.push(...mdBlocks(project.bodies[c.id] ?? ""));
      });
    });
    if (opts.includeMatter && project.meta.backMatter?.trim()) {
      out.push({ kind: "heading", text: t("后记"), pageBreak: true });
      out.push(...mdBlocks(project.meta.backMatter));
    }
    return out;
  };

  const exportNow = async () => {
    if (busy) return;
    setBusy(true);
    setDone("");
    try {
      const ext = target === "pdf" ? "pdf" : "docx";
      const dest = await saveDialog({
        defaultPath: `${safeName(project.meta.title)}.${ext}`,
        filters: [{ name: target === "pdf" ? "PDF" : "Word", extensions: [ext] }],
      });
      if (!dest) return;
      await api.printExport(
        {
          ...opts,
          title: project.meta.title || "未命名",
          author: project.meta.author || "",
          blocks: buildBlocks(),
        },
        dest,
        target,
      );
      setDoneOk(true);
      setDone(dest);
    } catch (e) {
      setDoneOk(false);
      setDone(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const pageStyle = {
    width: sheetW,
    minHeight: ph * scale,
    padding: `${padY}px ${padX}px`,
    fontFamily: opts.font === "serif" ? "var(--font-serif)" : "var(--font-sans)",
    fontSize: previewFont,
    lineHeight: opts.lineHeight,
  };

  const chapterNode = (c: (typeof chapters)[number], withBreak: boolean) => (
    <div
      key={c.id}
      className={`ps-page ps-chapter${withBreak && opts.chapterBreak ? " ps-break" : ""}`}
      style={pageStyle}
    >
      {c.volume && c.volume !== t("正文") && <h3>{c.volume}</h3>}
      <h2>{c.title}</h2>
      {(images[c.id] ?? []).map((img) => (
        <img key={img.id} className="ps-inline-img" src={img.src} alt="" />
      ))}
      <div dangerouslySetInnerHTML={{ __html: mdToHtml(c.body) }} />
    </div>
  );

  return (
    <div className="print-studio">
      <header className="ps-top">
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          <Icon name="arrow" size={14} />
          {t("返回写作")}
        </button>
        <div className="ps-top-title">
          <b>{t("自打印 · 排版工作台")}</b>
          <em>{project.meta.title || "未命名"} · {chapters.length} {t("章")}</em>
        </div>
        <div className="ps-mobile-tabs" role="tablist">
          <button className={mobilePane === "preview" ? "on" : ""} onClick={() => setMobilePane("preview")}>
            {t("预览")}
          </button>
          <button className={mobilePane === "settings" ? "on" : ""} onClick={() => setMobilePane("settings")}>
            {t("排版设置")}
          </button>
        </div>
        <div className="ps-top-actions">
          <div className="ps-target">
            <button className={target === "pdf" ? "on" : ""} onClick={() => setTarget("pdf")}>
              PDF
            </button>
            <button className={target === "word" ? "on" : ""} onClick={() => setTarget("word")}>
              Word
            </button>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => void exportNow()} disabled={busy}>
            <Icon name="download" size={14} />
            {busy ? t("正在排版导出…") : target === "pdf" ? t("导出 PDF") : t("导出 Word")}
          </button>
        </div>
      </header>

      <div className={`ps-body mobile-${mobilePane}`}>
        <aside className="ps-panel">
          <section className="ps-sec">
            <h3>{t("排版预设")}</h3>
            <div className="ps-presets">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  className={opts.paper === p.opts.paper && opts.blankFirst === p.opts.blankFirst && opts.toc === p.opts.toc ? "on" : ""}
                  onClick={() => {
                    setOpts(p.opts);
                    setPresetSaved(false);
                  }}
                >
                  {t(p.label)}
                </button>
              ))}
            </div>
            <div className="ps-preset-save">
              <button
                className="btn btn-ghost btn-xs"
                onClick={() => {
                  try {
                    localStorage.setItem("chapter.printPreset", JSON.stringify(opts));
                    setPresetSaved(true);
                    window.setTimeout(() => setPresetSaved(false), 1800);
                  } catch {
                    /* ignore */
                  }
                }}
              >
                <Icon name="check" size={12} />
                {presetSaved ? t("已保存为预设") : t("保存当前设置为预设")}
              </button>
              <button
                className="btn btn-ghost btn-xs"
                onClick={() => setOpts({ ...DEFAULT_OPTS })}
              >
                {t("恢复默认")}
              </button>
            </div>
          </section>

          <section className="ps-sec">
            <h3>{t("成品结构")}</h3>
            <label className="ps-check">
              <input
                type="checkbox"
                checked={opts.blankFirst}
                onChange={(e) => setOpts({ ...opts, blankFirst: e.target.checked })}
              />
              <span>{t("最前面加一张空白页")}</span>
            </label>
            <label className="ps-check">
              <input
                type="checkbox"
                checked={opts.titlePage}
                onChange={(e) => setOpts({ ...opts, titlePage: e.target.checked })}
              />
              <span>{t("加书名页：居中书名与作者")}</span>
            </label>
            <label className="ps-check">
              <input
                type="checkbox"
                checked={opts.toc}
                onChange={(e) => setOpts({ ...opts, toc: e.target.checked })}
              />
              <span>{t("自动生成目录与每章页码")}</span>
            </label>
            <label className="ps-check">
              <input
                type="checkbox"
                checked={opts.pageNumbers}
                onChange={(e) => setOpts({ ...opts, pageNumbers: e.target.checked })}
              />
              <span>{t("正文页脚显示页码")}</span>
            </label>
            <label className="ps-check">
              <input
                type="checkbox"
                checked={opts.blankLast}
                onChange={(e) => setOpts({ ...opts, blankLast: e.target.checked })}
              />
              <span>{t("最后面加一张空白页")}</span>
            </label>
            <p className="ps-hint">
              {t("空白页不会印页码；目录页码从正文第一页算起。")}
            </p>
          </section>

          <section className="ps-sec">
            <h3>{t("纸张与版心")}</h3>
            <label className="ps-row">
              <span>{t("纸张")}</span>
              <select value={opts.paper} onChange={(e) => setOpts({ ...opts, paper: e.target.value as Paper })}>
                <option value="A4">A4 · 210×297</option>
                <option value="A5">A5 · 148×210</option>
                <option value="B5">B5 · 176×250</option>
                <option value="16K">16K · 184×260</option>
              </select>
            </label>
            <label className="ps-row">
              <span>{t("页边距")}</span>
              <select
                value={opts.margin}
                onChange={(e) => setOpts({ ...opts, margin: e.target.value as PrintOptions["margin"] })}
              >
                <option value="normal">{t("常规 · 22mm")}</option>
                <option value="narrow">{t("紧凑 · 14mm")}</option>
                <option value="wide">{t("宽松 · 28mm")}</option>
              </select>
            </label>
            <p className="ps-hint">{pageLabel}</p>
          </section>

          <section className="ps-sec">
            <h3>{t("文字")}</h3>
            <label className="ps-row">
              <span>{t("字体")}</span>
              <select
                value={opts.font}
                onChange={(e) => setOpts({ ...opts, font: e.target.value as PrintOptions["font"] })}
              >
                <option value="serif">{t("宋体 · 正文")}</option>
                <option value="sans">{t("黑体 · 清爽")}</option>
              </select>
            </label>
            <label className="ps-range">
              <span>{t("字号")} <b>{opts.fontSize}pt</b></span>
              <input
                type="range"
                min={9}
                max={16}
                step={0.5}
                value={opts.fontSize}
                onChange={(e) => setOpts({ ...opts, fontSize: Number(e.target.value) })}
              />
            </label>
            <label className="ps-range">
              <span>{t("行距")} <b>{opts.lineHeight.toFixed(2)}</b></span>
              <input
                type="range"
                min={1.4}
                max={2.2}
                step={0.05}
                value={opts.lineHeight}
                onChange={(e) => setOpts({ ...opts, lineHeight: Number(e.target.value) })}
              />
            </label>
            <label className="ps-range">
              <span>{t("首行缩进")} <b>{opts.indent} {t("字")}</b></span>
              <input
                type="range"
                min={0}
                max={4}
                step={1}
                value={opts.indent}
                onChange={(e) => setOpts({ ...opts, indent: Number(e.target.value) })}
              />
            </label>
          </section>

          <section className="ps-sec">
            <h3>{t("分章")}</h3>
            <label className="ps-check">
              <input
                type="checkbox"
                checked={opts.chapterBreak}
                onChange={(e) => setOpts({ ...opts, chapterBreak: e.target.checked })}
              />
              <span>{t("每章从新的一页开始")}</span>
            </label>
            <label className="ps-check">
              <input
                type="checkbox"
                checked={opts.includeMatter}
                onChange={(e) => setOpts({ ...opts, includeMatter: e.target.checked })}
              />
              <span>{t("带上前言与后记")}</span>
            </label>
          </section>

          <section className="ps-sec">
            <h3>{t("插图")}</h3>
            <label className="ps-row">
              <span>{t("章节")}</span>
              <select value={chapter} onChange={(e) => setChapter(e.target.value)}>
                {chapters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn btn-outline btn-sm ps-add-img" onClick={() => void addImage()}>
              <Icon name="image" size={13} />
              {t("选择图片")}
            </button>
            {chapter && (images[chapter]?.length ?? 0) > 0 && (
              <div className="ps-img-list">
                {(images[chapter] ?? []).map((img) => (
                  <div key={img.id}>
                    <img src={img.src} alt="" />
                    <span>{img.name}</span>
                    <button
                      onClick={() =>
                        setImages((prev) => ({
                          ...prev,
                          [chapter]: (prev[chapter] ?? []).filter((i) => i.id !== img.id),
                        }))
                      }
                      title={t("移除")}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <p className="ps-hint">{t("插图会排在对应章节标题之后，PDF 与 Word 都会保留。")}</p>
          </section>

          <section className="ps-sec ps-sec-last">
            <h3>{t("预览")}</h3>
            <div className="ps-scope">
              <button
                className={previewScope === "chapter" ? "on" : ""}
                onClick={() => setPreviewScope("chapter")}
              >
                {t("当前章")}
              </button>
              <button
                className={previewScope === "book" ? "on" : ""}
                onClick={() => setPreviewScope("book")}
              >
                {t("全书")}
              </button>
            </div>
            {previewScope === "chapter" && focused && (
              <p className="ps-hint">{t("当前预览")}：{focused.title}</p>
            )}
            {previewScope === "book" && (
              <>
                <p className="ps-hint">
                  {t("已载入")} {Math.min(bookLimit, chapters.length)} / {chapters.length} {t("章")} · {t("导出时仍是整本")}
                </p>
                {bookLimit < chapters.length && (
                  <button
                    className="btn btn-outline btn-sm ps-more"
                    onClick={() => setBookLimit((n) => n + 12)}
                  >
                    <Icon name="plus" size={12} />
                    {t("再载入 12 章")}
                  </button>
                )}
              </>
            )}
            <div className="ps-zoom-row">
              <button onClick={() => setZoom((z) => Math.max(0.45, z - 0.1))}>−</button>
              <span>{Math.round(zoom * 100)}%</span>
              <button onClick={() => setZoom((z) => Math.min(1.2, z + 0.1))}>+</button>
              <button className="fit" onClick={() => setZoom(window.innerWidth <= 820 ? Math.min(0.5, (window.innerWidth - 36) / 794) : 0.82)}>
                {t("适合")}
              </button>
            </div>
          </section>
        </aside>

        <main className="ps-stage">
          <div className="ps-stack" style={{ width: sheetW }}>
            {previewScope === "book" && (
              <>
                {opts.blankFirst && (
                  <div className="ps-page ps-title-page ps-blank-page" style={pageStyle}>
                    <span className="ps-blank-mark">{t("空白页")}</span>
                  </div>
                )}
                {opts.titlePage && (
                  <div className="ps-page ps-title-page" style={pageStyle}>
                    <div className="ps-title-main">
                      <b>{project.meta.title || "未命名"}</b>
                      {project.meta.author && <em>{project.meta.author}</em>}
                    </div>
                    <span className="ps-title-foot">Chapter · {t("自打印")}</span>
                  </div>
                )}
                {opts.toc &&
                  tocChunks.map((rows, ti) => {
                    let lastVol = "";
                    return (
                      <div className="ps-page ps-chapter ps-toc-sheet" key={`toc-${ti}`} style={pageStyle}>
                        <h2>{ti === 0 ? t("目录") : `${t("目录")} · ${ti + 1}`}</h2>
                        <div className="ps-toc">
                          {rows.map((c) => {
                            const vol = c.volume !== t("正文") ? c.volume : "";
                            const showVol = Boolean(vol && vol !== lastVol);
                            lastVol = vol;
                            return (
                              <Fragment key={c.id}>
                                {showVol && <div className="ps-toc-vol">{vol}</div>}
                                <div className="ps-toc-row">
                                  <span className="ps-toc-name">{c.title}</span>
                                  <span className="ps-toc-dots" />
                                  <span className="ps-toc-page">{c.page}</span>
                                </div>
                              </Fragment>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                {opts.includeMatter && project.meta.frontMatter?.trim() && (
                  <div className="ps-page ps-chapter ps-matter" style={pageStyle}>
                    <h2>{t("前言")}</h2>
                    <div dangerouslySetInnerHTML={{ __html: mdToHtml(project.meta.frontMatter) }} />
                  </div>
                )}
                {chapters.slice(0, bookLimit).map((c) => chapterNode(c, true))}
                {opts.includeMatter && project.meta.backMatter?.trim() && (
                  <div className="ps-page ps-chapter ps-matter" style={pageStyle}>
                    <h2>{t("后记")}</h2>
                    <div dangerouslySetInnerHTML={{ __html: mdToHtml(project.meta.backMatter) }} />
                  </div>
                )}
                {opts.blankLast && (
                  <div className="ps-page ps-title-page ps-blank-page" style={pageStyle}>
                    <span className="ps-blank-mark">{t("空白页")}</span>
                  </div>
                )}
              </>
            )}
            {previewScope === "chapter" && focused && chapterNode(focused, false)}
          </div>
          <p className="ps-stage-hint">
            {previewScope === "chapter"
              ? t("当前是单章排版预览；切到「全书」可以看到标题页与每章的分页位置。")
              : t("全书连续预览；虚线是分页位置。左右栏与真实页面等宽，导出时按上面的纸张尺寸重排。")}
          </p>
        </main>
      </div>

      {done && (
        <div className={`ps-done${doneOk ? "" : " bad"}`}>
          <span>{doneOk ? t("已导出到") : t("导出失败")}</span>
          <b>{done}</b>
          {doneOk && (
            <button onClick={() => void revealItemInDir(done)}>{t("打开所在文件夹")}</button>
          )}
          <button className="close" onClick={() => setDone("")}>
            <Icon name="close" size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
