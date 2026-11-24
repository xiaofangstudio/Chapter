import { useEffect, useState } from "react";
import type { BookMeta, SaveState, ViewKind } from "../types";
import { t } from "../lib/i18n";
import { Icon } from "./Icon";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { NovelCover } from "./NovelCover";

interface Props {
  meta: BookMeta;
  coverUrl?: string;
  saveState: SaveState;
  view: ViewKind;
  loreMode: "cards" | "graph" | "map";
  panel: boolean;
  theme: "light" | "dark";
  onView: (v: ViewKind) => void;
  onWorldMap: () => void;
  onTogglePanel: () => void;
  onToggleTheme: () => void;
  onSettings: () => void;
  onExport: () => void;
  onSnapshots: () => void;
  onVersions: () => void;
  onImport: () => void;
  onTransfer: () => void;
  onBack: () => void;
  onBookSettings: () => void;
  onMatter: () => void;
  onPickCover: () => void;
  onDeleteBook: () => void;
}

export function TopBar(props: Props) {
  const {
    meta,
    coverUrl,
    saveState,
    view,
    loreMode,
    panel,
    theme,
    onView,
    onWorldMap,
    onTogglePanel,
    onToggleTheme,
    onSettings,
    onExport,
    onSnapshots,
    onVersions,
    onImport,
    onTransfer,
    onBack,
    onBookSettings,
    onMatter,
    onPickCover,
    onDeleteBook,
  } = props;

  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  const [outlineMenu, setOutlineMenu] = useState<{ x: number; y: number } | null>(null);

  // 切到别的视图后，挂在按钮下面的“章节/整书大纲”菜单应当收起来，
  // 否则它会和编辑器里的字体面板、正文叠在一起，看起来像两个弹窗打架。
  useEffect(() => {
    // 从“大纲”进入章节/整书大纲时菜单可以继续存在；
    // 一旦离开大纲类视图（写作/设定/世界观），就把菜单收掉。
    if (view !== "outline" && view !== "bookOutline") setOutlineMenu(null);
    setMore(null);
  }, [view]);

  const items: MenuItem[] = [
    { label: t("设置封面…"), icon: "image", onClick: onPickCover },
    { label: t("书籍设置…"), icon: "edit", onClick: onBookSettings },
    { label: t("副文本 · Markdown…"), icon: "file", onClick: onMatter },
    { label: t("导入书稿…"), icon: "download", onClick: onImport },
    { label: t("手机互传…"), icon: "arrow", onClick: onTransfer },
    { label: t("版本与回档"), icon: "clock", onClick: onVersions },
    { label: t("版本历史"), icon: "file", onClick: onSnapshots },
    { label: t("回到书架"), icon: "book", onClick: onBack },
    { label: t("移到回收站"), icon: "trash", danger: true, onClick: onDeleteBook },
  ];

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="icon-btn" title={t("回到书架")} onClick={onBack}>
          <Icon name="book" size={17} />
        </button>
        <div className="book-chip">
          <NovelCover
            title={meta.title}
            author={meta.author}
            coverUrl={coverUrl}
            template={meta.coverStyle}
            compact
            loading="eager"
          />
        </div>
        <span className="topbar-title">{meta.title || "未命名"}</span>
        <span className={`save-dot ${saveState}`}>
          <i />
          {saveState === "saving"
            ? t("保存中")
            : saveState === "dirty"
              ? t("未保存")
              : t("已保存")}
        </span>
        <button
          className="icon-btn"
          title={t("书籍菜单")}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setMore({ x: r.left, y: r.bottom + 4 });
          }}
        >
          <Icon name="more" size={16} />
        </button>
      </div>

      <div className="topbar-center">
        <button className={`seg-btn${view === "write" ? " on" : ""}`} onClick={() => onView("write")}>
          <Icon name={meta.kind === "comic" ? "image" : "book"} size={14} />
          {meta.kind === "comic" ? t("作画") : t("写作")}
        </button>
        <button
          className={`seg-btn${view === "outline" || view === "bookOutline" ? " on" : ""}`}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setOutlineMenu({ x: r.left, y: r.bottom + 6 });
            if (view !== "outline" && view !== "bookOutline") onView("outline");
          }}
        >
          <Icon name="outline" size={14} />
          {t("大纲")}
          <Icon name="chevron" size={11} className="seg-caret" />
        </button>
        <button
          className={`seg-btn${view === "lore" && loreMode !== "map" ? " on" : ""}`}
          onClick={() => onView("lore")}
        >
          <Icon name="users" size={14} />
          {t("设定")}
        </button>
        <button
          className={`seg-btn${view === "lore" && loreMode === "map" ? " on" : ""}`}
          onClick={onWorldMap}
        >
          <Icon name="pin" size={14} />
          {t("世界观")}
        </button>
      </div>

      <div className="topbar-right">
        <button className="icon-btn" title={t("手机互传")} onClick={onTransfer}>
          <Icon name="arrow" size={17} />
        </button>
        <button
          className={`icon-btn${panel ? " on" : ""}`}
          title={panel ? t("收起信息栏") : t("展开信息栏")}
          onClick={onTogglePanel}
        >
          <Icon name="panel" size={17} />
        </button>
        <button className="btn btn-primary btn-sm" onClick={onExport} style={{ margin: "0 4px" }}>
          <Icon name="export" size={14} />
          {t("导出")}
        </button>
        <button
          className="icon-btn"
          title={theme === "light" ? t("切到夜幕") : t("切到夕阳")}
          onClick={onToggleTheme}
        >
          <Icon name={theme === "light" ? "moon" : "sun"} size={17} />
        </button>
        <button
          className="icon-btn"
          title={t("偏好设置")}
          onClick={onSettings}
        >
          <Icon name="settings" size={17} />
        </button>
      </div>

      {outlineMenu && (
        <ContextMenu
          x={outlineMenu.x}
          y={outlineMenu.y}
          minWidth={196}
          onClose={() => setOutlineMenu(null)}
          items={[
            {
              label: t("章节大纲"),
              icon: "outline",
              onClick: () => onView("outline"),
            },
            {
              label: t("整书大纲"),
              icon: "file",
              onClick: () => onView("bookOutline"),
            },
          ]}
        />
      )}

      {more && (
        <ContextMenu x={more.x} y={more.y} items={items} onClose={() => setMore(null)} minWidth={186} />
      )}
    </header>
  );
}
