import { useEffect, useState } from "react";
import type { BookSummary, UiLanguage } from "../types";
import { fmtWords, relTime } from "../lib/text";
import { t } from "../lib/i18n";
import { pickWelcome, greetingLine } from "../lib/welcome";
import { Icon } from "./Icon";
import { Logo } from "./Logo";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { NovelCover } from "./NovelCover";

interface Props {
  books: BookSummary[];
  covers: Record<string, string>;
  theme: "light" | "dark";
  onOpen: (book: BookSummary) => void;
  onNew: () => void;
  onImport: () => void;
  onWorkspace: () => void;
  onTransfer: () => void;
  onOpenFolder: () => void;
  onRename: (book: BookSummary) => void;
  onDelete: (book: BookSummary) => void;
  onReveal: (book: BookSummary) => void;
  onToggleTheme: () => void;
  onSettings: () => void;
  totalWords: number;
  language: UiLanguage;
}

export function Welcome({
  books,
  covers,
  theme,
  onOpen,
  onNew,
  onImport,
  onWorkspace,
  onTransfer,
  onOpenFolder,
  onRename,
  onDelete,
  onReveal,
  onToggleTheme,
  onSettings,
  totalWords,
  language,
}: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; book: BookSummary } | null>(null);
  const [welcome, setWelcome] = useState(pickWelcome);
  const welcomeText = t(welcome);
  // 问候语后面接的是同一句话；拉丁/西里尔文首字母改小写，避免出现“Bonsoir, Aujourd’hui…”这种断句。
  const inlineWelcome =
    ["zh", "ja", "ko"].includes(language) || /^[^A-Za-zÀ-ÿ\u0400-\u04FF]/.test(welcomeText)
      ? welcomeText
      : welcomeText.charAt(0).toLowerCase() + welcomeText.slice(1);

  useEffect(() => {
    setWelcome(pickWelcome());
  }, [language]);

  const menuItems = (book: BookSummary): MenuItem[] => [
    { label: t("打开这本书"), icon: "book", onClick: () => onOpen(book) },
    { label: t("重命名这本书"), icon: "edit", onClick: () => onRename(book) },
    { label: t("在文件夹中显示"), icon: "folder", onClick: () => onReveal(book) },
    { label: t("移到回收站"), icon: "trash", danger: true, onClick: () => onDelete(book) },
  ];

  return (
    <div className="welcome">
      <header className="welcome-top">
        <div className="brand">
          <Logo size={26} className="logo" />
          <span className="brand-word">Chapter</span>
          <span className="brand-sub">{t("小方工作室 · 小说写作工作台")}</span>
        </div>
        <div className="spacer" />
        <button className="home-mode-btn" onClick={onTransfer} title={t("手机互传")}>
          <Icon name="arrow" size={14} />
          {t("手机互传")}
        </button>
        <button className="home-mode-btn" onClick={onWorkspace} title={t("切到工作台模式")}>
          <Icon name="panel" size={14} />
          {t("工作台模式")}
        </button>
        <button
          className="icon-btn"
          title={theme === "light" ? t("切到夜幕") : t("切到夕阳")}
          onClick={onToggleTheme}
        >
          <Icon name={theme === "light" ? "moon" : "sun"} size={17} />
        </button>
        <button className="icon-btn" title={t("偏好设置")} onClick={onSettings}>
          <Icon name="settings" size={17} />
        </button>
      </header>

      <main className="welcome-main">
        <section className="hero">
          <p className="hero-welcome">
            <span className="hero-hello">{greetingLine()}</span>
            {inlineWelcome}
          </p>
          <h1>
            {t("一章一章，")}
            <br />
            <em>{t("写下去。")}</em>
          </h1>
          <p>
            {t("卷、章、场景，人物与设定，字数目标与专注模式——写长篇小说要用的东西，都收在这一张书桌上。写完，直接导出 EPUB。")}
          </p>
          <div className="hero-actions">
            <button className="btn btn-primary btn-lg" onClick={onNew}>
              <Icon name="plus" size={17} />
              {t("新建一本书")}
            </button>
            <button className="btn btn-outline btn-lg" onClick={onOpenFolder}>
              <Icon name="folder" size={16} />
              {t("打开工程…")}
            </button>
            <button className="btn btn-ghost btn-lg" onClick={onImport}>
              <Icon name="download" size={16} />
              {t("导入书稿")}
            </button>
          </div>
          <div className="hero-foot">
            <span>
              {t("书架")} <b>{books.length}</b> {language === "en" ? (books.length === 1 ? "book" : "books") : t("本")}
            </span>
            <span className="divider-v" />
            <span>
              {t("累计")} <b>{fmtWords(totalWords)}</b>&nbsp;{t("字")}
            </span>
            <span className="divider-v" />
            <span>{t("本地存储 · 零账号 · 不上传")}</span>
          </div>
        </section>

        <section className="shelf">
          <div className="shelf-head">
            <h2>{t("书架")}</h2>
            {books.length > 0 && <span>{t("最近打开")}</span>}
          </div>
          <div className="shelf-scroll">
            {books.length === 0 ? (
              <div className="empty-shelf">
                <h3>{t("还没有书。从第一行开始。")}</h3>
                <ul>
                  <li>{t("先想一个能一句话讲完的故事，再拆成卷与章。")}</li>
                  <li>{t("别急着写漂亮句子，先把今天这一章写完。")}</li>
                  <li>{t("人物设定先立主角与对手，其余边写边补。")}</li>
                </ul>
                <div className="tip">{t("新建后会得到「第一卷 / 第一章」，直接就能写。")}</div>
                <div>
                  <button className="btn btn-primary" onClick={onNew}>
                    <Icon name="plus" size={15} />
                    {t("新建一本书")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="shelf-grid stagger">
                {books.map((b, i) => {
                  const cover = covers[b.path];
                  const pct = b.targetWords > 0 ? Math.min(100, (b.words / b.targetWords) * 100) : 0;
                  return (
                    <article
                      key={b.path}
                      className="book-card"
                      style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
                      onClick={() => onOpen(b)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({ x: e.clientX, y: e.clientY, book: b });
                      }}
                    >
                      <div className="book-thumb">
                        <NovelCover
                          title={b.title}
                          author={b.author}
                          coverUrl={b.coverMode === "default" ? undefined : cover}
                          template={b.coverStyle}
                          loading="lazy"
                        />
                      </div>
                      <div className="book-info">
                        <div className="book-title">{b.title || t("未命名")}</div>
                        <div className="book-author">{b.author || t("佚名")}</div>
                        <div className="book-meta">
                          <span className="book-words"><b>{fmtWords(b.words)}</b> {t("字")}</span>
                          <span>·</span>
                          <span>{b.chapterCount} {t("章")}</span>
                          <span>·</span>
                          <span>{relTime(b.updatedAt)}</span>
                        </div>
                        <div className="book-progress">
                          <i style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                      <button
                        className="icon-btn card-menu"
                        title={t("更多")}
                        onClick={(e) => {
                          e.stopPropagation();
                          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setMenu({ x: r.left - 130, y: r.bottom + 4, book: b });
                        }}
                      >
                        <Icon name="more" size={16} />
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </main>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.book)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
