import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type {
  BookMeta,
  Chapter,
  LoreEntry,
  LoreKind,
  SnapshotInfo,
} from "../types";
import { LORE_KINDS } from "../types";
import { fmtNumber, fmtTime, fmtWords, mdToHtml } from "../lib/text";
import { t } from "../lib/i18n";
import { Icon } from "./Icon";

/* ───────────────── 基础弹窗 ───────────────── */

export function Modal({
  title,
  subtitle,
  children,
  actions,
  wide,
  wider,
  onClose,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
  wider?: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal glass${wide ? " wide" : ""}${wider ? " wider" : ""}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <h3>{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}

/* ───────────────── 副文本（前言 / 后记） ───────────────── */

export function MatterDialog({
  meta,
  onClose,
  onSave,
}: {
  meta: BookMeta;
  onClose: () => void;
  onSave: (patch: { frontMatter: string; backMatter: string }) => void;
}) {
  const [tab, setTab] = useState<"front" | "back">("front");
  const [front, setFront] = useState(meta.frontMatter ?? "");
  const [back, setBack] = useState(meta.backMatter ?? "");
  const value = tab === "front" ? front : back;
  const setValue = tab === "front" ? setFront : setBack;
  const words = value.replace(/\s/g, "").length;

  return (
    <Modal
      title={t("副文本")}
      subtitle={t("前言、后记、附录都可以写在这里；用 Markdown，导出 TXT 时会自动转成纯文本。")}
      onClose={onClose}
      wider
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {t("取消")}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              onSave({ frontMatter: front, backMatter: back });
              onClose();
            }}
          >
            <Icon name="check" size={14} />
            {t("保存副文本")}
          </button>
        </>
      }
    >
      <div className="matter-tabs" role="tablist">
        <button
          className={`matter-tab${tab === "front" ? " on" : ""}`}
          onClick={() => setTab("front")}
        >
          {t("前言 / 序言")}
          {(meta.frontMatter ?? "").trim() && <i />}
        </button>
        <button
          className={`matter-tab${tab === "back" ? " on" : ""}`}
          onClick={() => setTab("back")}
        >
          {t("后记 / 附录")}
          {(meta.backMatter ?? "").trim() && <i />}
        </button>
        <span className="grow" />
        <span className="matter-mark">MARKDOWN · {words} {t("字")}</span>
      </div>
      <div className="matter-panes">
        <div className="matter-editor">
          <div className="matter-pane-head">
            <span>{t("书写")}</span>
            <em>{t("支持标题、引用、列表、粗体与分隔线")}</em>
          </div>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
            placeholder={
              tab === "front"
                ? t("# 写在正文之前\n\n这段话会出现在所有章节前面。")
                : t("# 写在正文之后\n\n后记、附录、致谢都可以放在这里。")
            }
          />
        </div>
        <div className="matter-preview">
          <div className="matter-pane-head">
            <span>{t("预览")}</span>
            <em>{t("导出时保留 Markdown，转 TXT 自动清掉标记")}</em>
          </div>
          <div
            className="matter-preview-body"
            dangerouslySetInnerHTML={{ __html: mdToHtml(value) }}
          />
        </div>
      </div>
    </Modal>
  );
}

/* ───────────────── 新建书 ───────────────── */

export function NewBookDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (
    title: string,
    author: string,
    target: number,
    goal: number,
    template: "blank" | "three",
    kind: "novel" | "comic",
  ) => void;
}) {
  const [kind, setKind] = useState<"novel" | "comic">("novel");
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [target, setTarget] = useState(200000);
  const [goal, setGoal] = useState(2000);
  const [template, setTemplate] = useState<"blank" | "three">("blank");

  const targetChips = [
    { v: 100000, l: "10 万" },
    { v: 200000, l: "20 万" },
    { v: 500000, l: "50 万" },
    { v: 1000000, l: "100 万" },
  ];
  const goalChips = [
    { v: 500, l: "500 字" },
    { v: 1000, l: "1000 字" },
    { v: 2000, l: "2000 字" },
    { v: 4000, l: "4000 字" },
  ];

  const create = () => {
    if (!title.trim()) return;
    onCreate(title.trim(), author.trim(), target, goal, template, kind);
  };

  return (
    <Modal
      title="新建一本书"
      subtitle="工程会落在本机书库目录里，一个 .chapter 文件夹就是一本。"
      onClose={onClose}
      wide
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {t("取消")}
          </button>
          <button className="btn btn-primary" onClick={create} disabled={!title.trim()}>
            <Icon name="plus" size={14} />
            {kind === "comic" ? t("创建并开始画") : t("创建并开始写")}
          </button>
        </>
      }
    >
      <div className="booktype-switch">
        <button className={`booktype-card${kind === "novel" ? " on" : ""}`} onClick={() => setKind("novel")}>
          <span className="booktype-art">
            <svg viewBox="0 0 220 130" aria-hidden="true">
              <path className="bt-paper" d="M12 24c34-9 62-9 98 4v88c-36-13-64-13-98-4z" />
              <path className="bt-paper" d="M208 24c-34-9-62-9-98 4v88c36-13 64-13 98-4z" />
              <path className="bt-spine" d="M110 28v88" />
              <path className="bt-line" d="M32 48c24-5 44-5 62 0M32 62c24-5 44-5 62 0M32 76c18-3 34-3 48 1M146 48c18-3 34-3 48 1M146 62c24-5 44-5 62 0M146 76c24-5 44-5 62 0" />
            </svg>
          </span>
          <span className="booktype-text">
            <strong>{t("文字书")}</strong>
            <em>{t("横线纸、章节、正文写作")}</em>
          </span>
          <i className="booktype-check">{kind === "novel" ? "✓" : ""}</i>
        </button>
        <button className={`booktype-card${kind === "comic" ? " on" : ""}`} onClick={() => setKind("comic")}>
          <span className="booktype-art comic">
            <svg viewBox="0 0 220 130" aria-hidden="true">
              <path className="bt-paper" d="M12 24c34-9 62-9 98 4v88c-36-13-64-13-98-4z" />
              <path className="bt-paper" d="M208 24c-34-9-62-9-98 4v88c36-13 64-13 98-4z" />
              <path className="bt-spine" d="M110 28v88" />
              <rect className="bt-frame" x="28" y="38" width="64" height="30" />
              <rect className="bt-frame" x="28" y="74" width="64" height="30" />
              <rect className="bt-frame" x="132" y="38" width="64" height="66" />
              <path className="bt-pencil" d="M38 56c12-10 24 3 40-5M36 88c18-13 30 4 48-6M142 54c18-14 28 8 44-5M144 82c12-6 24 0 38-9" />
              <path className="bt-pencil" d="M150 94c10-3 18-3 26 1" />
            </svg>
          </span>
          <span className="booktype-text">
            <strong>{t("漫画书")}</strong>
            <em>{t("分格、格内画、气泡与素材")}</em>
          </span>
          <i className="booktype-check">{kind === "comic" ? "✓" : ""}</i>
        </button>
      </div>

      <div className="form-section">
        <div className="field">
          <label>{t(kind === "comic" ? "书名 / 漫画名" : "书名")}</label>
          <input
            className="input"
            value={title}
            placeholder={t(kind === "comic" ? "例如：方岛夜航" : "例如：长夜将尽")}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
            }}
          />
        </div>
        <div className="field">
          <label>{t("作者")}</label>
          <input
            className="input"
            value={author}
            placeholder={t("笔名，可留空")}
            onChange={(e) => setAuthor(e.target.value)}
          />
        </div>
      </div>

      {kind === "comic" ? (
        <div className="form-section comic-spec-card">
          <div className="form-section-title">{t("页规格")}</div>
          <div className="comic-spec-row">
            <span>B5 单页</span>
            <span>1654 × 2339</span>
            <span>200 dpi</span>
          </div>
          <p>
            {t("默认六格底，打开即可画。页在左侧页面栏管理。")}
          </p>
        </div>
      ) : (
      <>
      <div className="form-section">
        <div className="form-section-title">{t("总目标")}</div>
        <div className="goal-chips">
          {targetChips.map((c) => (
            <button
              key={c.v}
              className={`chip${target === c.v ? " on" : ""}`}
              onClick={() => setTarget(c.v)}
            >
              {c.l}
            </button>
          ))}
          <input
            className="input"
            style={{ width: 112, height: 28, fontSize: 12 }}
            value={target}
            inputMode="numeric"
            onChange={(e) => setTarget(Math.max(0, Number(e.target.value.replace(/\D/g, "")) || 0))}
          />
        </div>
        <div className="form-section-title" style={{ marginTop: 4 }}>
          {t("每日目标")}
        </div>
        <div className="goal-chips">
          {goalChips.map((c) => (
            <button key={c.v} className={`chip${goal === c.v ? " on" : ""}`} onClick={() => setGoal(c.v)}>
              {c.l}
            </button>
          ))}
        </div>
      </div>

      <div className="form-section">
        <div className="form-section-title">{t("开头")}</div>
        <div className="goal-chips">
          <button className={`chip${template === "blank" ? " on" : ""}`} onClick={() => setTemplate("blank")}>
            {t("空白：第一卷 / 第一章")}
          </button>
          <button className={`chip${template === "three" ? " on" : ""}`} onClick={() => setTemplate("three")}>
            {t("三幕剧：三卷九章")}
          </button>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-3)", lineHeight: 1.7 }}>
          {template === "blank"
            ? t("给你一卷一章的空架子，立刻能写。")
            : t("按「建置 / 对抗 / 解决」铺好三卷九章，章名可随时改。")}
        </div>
      </div>
      </>
      )}
    </Modal>
  );
}

/* ───────────────── 单行输入 ───────────────── */

export function PromptDialog({
  title,
  subtitle,
  label,
  value,
  placeholder,
  confirmText = "确定",
  multiline,
  onClose,
  onOk,
}: {
  title: string;
  subtitle?: string;
  label: string;
  value: string;
  placeholder?: string;
  confirmText?: string;
  multiline?: boolean;
  onClose: () => void;
  onOk: (value: string) => void;
}) {
  const [v, setV] = useState(value);

  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {t("取消")}
          </button>
          <button className="btn btn-primary" onClick={() => onOk(v.trim())}>
            {confirmText}
          </button>
        </>
      }
    >
      <div className="field">
        <label>{label}</label>
        {multiline ? (
          <textarea
            className="input"
            autoFocus
            value={v}
            placeholder={placeholder}
            onChange={(e) => setV(e.target.value)}
          />
        ) : (
          <input
            className="input"
            autoFocus
            value={v}
            placeholder={placeholder}
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onOk(v.trim());
            }}
          />
        )}
      </div>
    </Modal>
  );
}

/* ───────────────── 确认 ───────────────── */

export function ConfirmDialog({
  title,
  message,
  confirmText = "确定",
  danger,
  onClose,
  onOk,
}: {
  title: string;
  message: ReactNode;
  confirmText?: string;
  danger?: boolean;
  onClose: () => void;
  onOk: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {t("取消")}
          </button>
          <button
            className={`btn ${danger ? "btn-primary" : "btn-primary"}`}
            style={danger ? { background: "var(--danger)" } : undefined}
            onClick={onOk}
          >
            {confirmText}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 13, lineHeight: 1.9, color: "var(--text-2)" }}>{message}</div>
    </Modal>
  );
}

/* ───────────────── 导出 ───────────────── */

const FORMATS = [
  {
    id: "epub",
    name: "EPUB 3",
    desc: "带目录、章节分页，封面会一起打包；阅读器里排版最完整。",
    icon: "book" as const,
  },
  {
    id: "md",
    name: "Markdown",
    desc: "按卷、章分好层级的 .md，方便继续用别的工具处理。",
    icon: "file" as const,
  },
  {
    id: "txt",
    name: "纯文本 TXT",
    desc: "去格式的干净正文，投稿、备份、发给别人看都省事。",
    icon: "type" as const,
  },
  {
    id: "print",
    name: "自打印",
    desc: "先排版再导出：纸张、字号、行距、分章、插图都自己定。",
    icon: "image" as const,
  },
];

export function ExportDialog({
  meta,
  chapters,
  words,
  onClose,
  onExport,
  onPrint,
}: {
  meta: BookMeta;
  chapters: number;
  words: number;
  onClose: () => void;
  onExport: (format: string) => void;
  onPrint?: (format: "pdf" | "word") => void;
}) {
  const [format, setFormat] = useState("epub");
  const [printTarget, setPrintTarget] = useState<"pdf" | "word">("pdf");

  return (
    <Modal
      title="导出这本书"
      subtitle="全部在本机完成，不经过任何服务器。"
      onClose={onClose}
      wide
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {t("取消")}
          </button>
          <button className="btn btn-primary" onClick={() => {
            if (format === "print") onPrint?.(printTarget);
            else onExport(format);
          }}>
            <Icon name={format === "print" ? "edit" : "download"} size={15} />
            {format === "print"
              ? t("进入排版")
              : `导出 ${FORMATS.find((f) => f.id === format)?.name}`}
          </button>
        </>
      }
    >
      <div className="export-opts">
        {FORMATS.map((f) => (
          <button
            key={f.id}
            className={`fmt-card${format === f.id ? " on" : ""}`}
            onClick={() => setFormat(f.id)}
          >
            <span className="fmt-ico">
              <Icon name={f.icon} size={17} />
            </span>
            <span className="fmt-text">
              <b>{f.name}</b>
              <span>{f.desc}</span>
            </span>
            {format === f.id && <Icon name="check" size={16} />}
          </button>
        ))}
      </div>

      <div className="export-summary">
        <span>
          《{meta.title || "未命名"}》 · {chapters} 章 · {fmtWords(words)} 字
        </span>
        <span>{format === "epub" && meta.cover ? "含封面" : format === "epub" ? "无封面" : ""}</span>
      </div>
      {format === "epub" && !meta.cover && (
        <div style={{ fontSize: 11, color: "var(--text-3)", lineHeight: 1.7 }}>
          还没设封面。EPUB 会以标题页开头；在书籍菜单里设一张封面再导出会更完整。
        </div>
      )}

      {format === "print" && (
        <div className="print-target">
          <button
            className={`print-target-card${printTarget === "pdf" ? " on" : ""}`}
            onClick={() => setPrintTarget("pdf")}
          >
            <span className="fmt-ico"><Icon name="file" size={16} /></span>
            <span>
              <b>PDF</b>
              <em>{t("所见即所得，适合直接打印、投稿；插图会一起排进去。")}</em>
            </span>
            {printTarget === "pdf" && <Icon name="check" size={15} />}
          </button>
          <button
            className={`print-target-card${printTarget === "word" ? " on" : ""}`}
            onClick={() => setPrintTarget("word")}
          >
            <span className="fmt-ico"><Icon name="edit" size={16} /></span>
            <span>
              <b>Word</b>
              <em>{t("导出可继续编辑的 .docx，分页、字体、插图都保留。")}</em>
            </span>
            {printTarget === "word" && <Icon name="check" size={15} />}
          </button>
        </div>
      )}
    </Modal>
  );
}

/* ───────────────── 版本 ───────────────── */

export function SnapshotDialog({
  snapshots,
  onClose,
  onCreate,
  onRestore,
}: {
  snapshots: SnapshotInfo[];
  onClose: () => void;
  onCreate: () => void;
  onRestore: (name: string) => void;
}) {
  return (
    <Modal
      title="版本历史"
      subtitle="每次打开书与手动存版都会留一份；最多保留最近 20 个。恢复前会自动备份当前状态。"
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
          <button className="btn btn-primary" onClick={onCreate}>
            <Icon name="clock" size={14} />
            现在存一版
          </button>
        </>
      }
    >
      {snapshots.length === 0 ? (
        <div className="lore-empty" style={{ padding: 24 }}>
          还没有版本。打开书时会自动留一版，也可以随时手动存。
        </div>
      ) : (
        <div className="snap-list">
          {snapshots.map((s, i) => (
            <div className="snap-item" key={s.name}>
              <span className="fmt-ico" style={{ width: 30, height: 30 }}>
                <Icon name="clock" size={14} />
              </span>
              <div className="when">
                <b>{fmtTime(s.createdAt)}</b>
                <span>
                  {fmtNumber(s.words)} 字
                  {s.label ? ` · ${s.label}` : ""}
                  {i === 0 ? " · 最新" : ""}
                </span>
              </div>
              <button className="btn btn-outline" style={{ height: 28, fontSize: 12 }} onClick={() => onRestore(s.name)}>
                恢复
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/* ───────────────── 书籍信息 ───────────────── */

interface BookMetaDialogProps {
  meta: BookMeta;
  onClose: () => void;
  onSave: (patch: {
    title: string;
    author: string;
    description: string;
    spineColor?: string;
  }) => Promise<void> | void;
}

const SPINE_SWATCHES = ["#6d4a2a", "#8a2f2a", "#26456b", "#2f5a44", "#4a3a63", "#1f1d1b"];

export function BookMetaDialog({ meta, onClose, onSave }: BookMetaDialogProps) {
  const [title, setTitle] = useState(meta.title);
  const [author, setAuthor] = useState(meta.author);
  const [description, setDescription] = useState(meta.description ?? "");
  const [spineColor, setSpineColor] = useState(meta.spineColor ?? "#6d4a2a");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy || !title.trim()) return;
    setBusy(true);
    try {
      await onSave({
        title: title.trim(),
        author: author.trim(),
        description: description.trim(),
        spineColor,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("书籍设置")}
      subtitle={t("书名、笔名和简介，会同步到书架和介绍页。")}
      wide
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {t("取消")}
          </button>
          <button className="btn btn-primary" disabled={busy || !title.trim()} onClick={() => void submit()}>
            {t("保存")}
          </button>
        </>
      }
    >
      <div className="form-section">
        <label className="field">
          <span>{t("书名")}</span>
          <input
            className="input"
            value={title}
            maxLength={80}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </label>
        <label className="field">
          <span>{t("笔名")}</span>
          <input
            className="input"
            value={author}
            maxLength={40}
            placeholder={t("可以留空")}
            onChange={(e) => setAuthor(e.target.value)}
          />
        </label>
        <label className="field">
          <span>{t("小说简介")}</span>
          <textarea
            className="input bookmeta-desc"
            value={description}
            maxLength={600}
            placeholder={t("一段话讲清这个故事，读者先看到这里。")}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <div className="settings-note">{t("简介只用于介绍页，不会进入正文。")}</div>
        <div className="field" style={{ marginTop: 12 }}>
          <span>{t("书脊颜色")}</span>
          <div className="spine-swatches">
            {SPINE_SWATCHES.map((c) => (
              <button
                key={c}
                className={`spine-swatch${spineColor === c ? " on" : ""}`}
                style={{ background: c }}
                title={c}
                onClick={() => setSpineColor(c)}
              />
            ))}
            <label className="spine-swatch custom" title={t("自定义颜色")}>
              <input
                type="color"
                value={spineColor}
                onChange={(e) => setSpineColor(e.target.value)}
              />
            </label>
          </div>
          <div className="settings-note">
            {t("默认封面和自定义封面都可以单独改书脊颜色；切书页会立刻使用这个颜色。")}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ───────────────── 设定编辑 ───────────────── */

export function LoreEditorDialog({
  entry,
  kind,
  onClose,
  onSave,
}: {
  entry: LoreEntry | null;
  kind: LoreKind;
  onClose: () => void;
  onSave: (entry: LoreEntry) => void;
}) {
  const [name, setName] = useState(entry?.name ?? "");
  const [k, setK] = useState<LoreKind>(entry?.kind ?? kind);
  const [fields, setFields] = useState<{ k: string; v: string }[]>(
    entry?.fields?.length ? entry.fields.map((f) => ({ ...f })) : [{ k: "身份", v: "" }],
  );
  const [note, setNote] = useState(entry?.note ?? "");

  const save = () => {
    if (!name.trim()) return;
    onSave({
      ...(entry ?? {}),
      id: entry?.id ?? `e_${Date.now()}`,
      kind: k,
      name: name.trim(),
      fields: fields.filter((f) => f.k.trim() || f.v.trim()),
      note: note.trim(),
    });
  };

  return (
    <Modal
      title={entry ? "编辑设定" : "新增设定"}
      subtitle="字段名随你定：身份、外貌、口头禅、第一次出场……"
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {t("取消")}
          </button>
          <button className="btn btn-primary" onClick={save} disabled={!name.trim()}>
            {t("保存")}
          </button>
        </>
      }
    >
      <div style={{ display: "flex", gap: 8 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>{t("名称")}</label>
          <input
            className="input"
            autoFocus
            value={name}
            placeholder={t("姓名 / 地名 / 物件名")}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field" style={{ width: 118 }}>
          <label>{t("类型")}</label>
          <select
            className="input"
            value={k}
            onChange={(e) => setK(e.target.value as LoreKind)}
          >
            {LORE_KINDS.map((x) => (
              <option key={x.key} value={x.key}>
                {t(x.label)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <label>{t("字段")}</label>
        <div className="lore-form-fields">
          {fields.map((f, i) => (
            <div className="lore-field-row" key={i}>
              <input
                className="input k"
                value={f.k}
                placeholder={t("字段名")}
                onChange={(e) => {
                  const next = fields.slice();
                  next[i] = { ...next[i], k: e.target.value };
                  setFields(next);
                }}
              />
              <input
                className="input"
                value={f.v}
                placeholder={t("内容")}
                onChange={(e) => {
                  const next = fields.slice();
                  next[i] = { ...next[i], v: e.target.value };
                  setFields(next);
                }}
              />
              <button
                className="icon-btn"
                style={{ width: 28, height: 32 }}
                title={t("删除这一行")}
                onClick={() => setFields(fields.filter((_, fi) => fi !== i))}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          ))}
          <button
            className="btn btn-ghost"
            style={{ height: 28, alignSelf: "flex-start", fontSize: 11.5, padding: "0 8px" }}
            onClick={() => setFields([...fields, { k: "", v: "" }])}
          >
            <Icon name="plus" size={12} />
            {t("加一个字段")}
          </button>
        </div>
      </div>

      <div className="field">
        <label>{t("备注")}</label>
        <textarea
          className="input"
          value={note}
          placeholder={t("任何不想拆成字段的碎碎念")}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
    </Modal>
  );
}

/* ───────────────── 场景编辑 ───────────────── */

export function SceneEditorDialog({
  chapter,
  sceneId,
  onClose,
  onSave,
}: {
  chapter: Chapter | null;
  sceneId: string | null;
  onClose: () => void;
  onSave: (scene: { id: string; title: string; summary: string }) => void;
}) {
  const scene = chapter?.scenes.find((s) => s.id === sceneId) ?? null;
  const [title, setTitle] = useState(scene?.title ?? "");
  const [summary, setSummary] = useState(scene?.summary ?? "");

  return (
    <Modal
      title={scene ? t("编辑场景") : t("新增场景")}
      subtitle={t("场景是这一章里的一段戏：谁在哪里做了什么，最后局面怎么变了。")}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {t("取消")}
          </button>
          <button
            className="btn btn-primary"
            onClick={() =>
              onSave({
                id: scene?.id ?? `s_${Date.now()}`,
                title: title.trim() || t("未命名场景"),
                summary: summary.trim(),
              })
            }
          >
            {t("保存场景")}
          </button>
        </>
      }
    >
      <div className="field">
        <label>{t("场景名")}</label>
        <input
          className="input"
          autoFocus
          value={title}
          placeholder={t("例如：雨夜追车")}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="field">
        <label>{t("这一段发生什么")}</label>
        <textarea
          className="input"
          value={summary}
          placeholder={t("一两句话就够，写正文时不必照着它写。")}
          onChange={(e) => setSummary(e.target.value)}
        />
      </div>
    </Modal>
  );
}

/* ───────────────── 设定插入 ───────────────── */
export function LorePickerDialog({
  entries,
  onClose,
  onPick,
}: {
  entries: LoreEntry[];
  onClose: () => void;
  onPick: (entry: LoreEntry) => void;
}) {
  const [q, setQ] = useState("");
  const filtered = useMemo(
    () => entries.filter((e) => !q.trim() || e.name.includes(q.trim())),
    [entries, q],
  );

  return (
    <Modal
      title="插入设定"
      subtitle="选一个名字，插入到光标处。不会生成链接，只是一段普通文字。"
      onClose={onClose}
      actions={
        <button className="btn btn-ghost" onClick={onClose}>
          关闭
        </button>
      }
    >
      <input
        className="input"
        autoFocus
        placeholder="搜索名字…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="lore-picker">
        {filtered.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--text-3)", padding: 12 }}>
            没有匹配的设定，先去「设定」页建一条。
          </div>
        ) : (
          filtered.map((e) => (
            <button key={e.id} className="picker-item" onClick={() => onPick(e)}>
              <span className="lavatar" style={{ width: 26, height: 26, fontSize: 12 }}>
                {Array.from(e.name)[0] ?? "？"}
              </span>
              <span className="n">{e.name}</span>
              <span className="k">{LORE_KINDS.find((x) => x.key === e.kind)?.label}</span>
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}
