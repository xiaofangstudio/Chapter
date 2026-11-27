import { useEffect, useMemo, useRef, useState } from "react";
import type { BookMeta, Chapter, Outline } from "../types";
import { fmtWords } from "../lib/text";
import { fmtDateTime, t } from "../lib/i18n";
import { Icon } from "./Icon";
import { Logo } from "./Logo";
import { NovelCover } from "./NovelCover";

interface Props {
  meta: BookMeta;
  outline: Outline;
  coverUrl?: string;
  activeId: string | null;
  theme: "light" | "dark";
  comicPages?: number;
  comicPanels?: number;
  comicBalloons?: number;
  onBack: () => void;
  onSelectChapter: (id: string) => void;
  onBookSettings: () => void;
  onMatter: () => void;
  onPickCover: () => void;
  onToggleTheme: () => void;
  onSettings: () => void;
  onAddVolume: () => void;
  onAddChapter?: (volumeId: string) => void;
}

export function BookIntroPage(props: Props) {
  const { meta, outline, coverUrl, activeId, theme } = props;
  const flat = useMemo(
    () => outline.volumes.flatMap((v) => v.chapters.map((c) => ({ ...c, volumeId: v.id }))),
    [outline],
  );
  const total = useMemo(() => flat.reduce((n, c) => n + (c.words ?? 0), 0), [flat]);
  const indexedFlat = useMemo(() => {
    const rows: { ch: Chapter; volumeId: string; volumeTitle: string; volumeNo: number; no: number; localNo: number }[] = [];
    let no = 0;
    outline.volumes.forEach((vol, vi) => {
      vol.chapters.forEach((ch, ci) => {
        no += 1;
        rows.push({
          ch,
          volumeId: vol.id,
          volumeTitle: vol.title || `${t("第")}${vi + 1}${t("卷")}`,
          volumeNo: vi + 1,
          no,
          localNo: ci + 1,
        });
      });
    });
    return rows;
  }, [outline]);
  const comic = meta.kind === "comic";
  const volumeOfActive =
    outline.volumes.find((v) => v.chapters.some((c) => c.id === activeId))?.id ??
    outline.volumes[0]?.id ??
    null;
  const [openVolume, setOpenVolume] = useState<string | null>(volumeOfActive);
  const [mobileTab, setMobileTab] = useState<"chapters" | "info">("chapters");
  const [mobileVolume, setMobileVolume] = useState("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sortDesc, setSortDesc] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const [compactHead, setCompactHead] = useState(false);

  useEffect(() => {
    if (openVolume && !outline.volumes.some((v) => v.id === openVolume)) {
      setOpenVolume(outline.volumes[0]?.id ?? null);
    }
  }, [openVolume, outline.volumes]);

  const resumeId =
    (activeId && flat.some((c) => c.id === activeId) ? activeId : null) ??
    (meta.lastChapterId && flat.some((c) => c.id === meta.lastChapterId) ? meta.lastChapterId : null) ??
    flat[0]?.id ??
    null;

  useEffect(() => {
    if (mobileVolume !== "all" && !outline.volumes.some((v) => v.id === mobileVolume)) {
      setMobileVolume("all");
    }
  }, [mobileVolume, outline.volumes]);

  useEffect(() => {
    const root = pageRef.current;
    if (!root) return;
    const hero = root.querySelector<HTMLElement>(".intro-hero");
    if (!hero) return;
    let timer = 0;
    const update = () => {
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = 0;
        const top = root.getBoundingClientRect().top;
        const bar = root.querySelector<HTMLElement>(".intro-top");
        const barH = bar?.getBoundingClientRect().height ?? 52;
        setCompactHead(hero.getBoundingClientRect().bottom <= top + barH + 6);
      }, 24);
    };
    root.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      root.removeEventListener("scroll", update);
      if (timer) clearTimeout(timer);
    };
  }, []);

  const mobileRows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return indexedFlat
      .filter((row) => mobileVolume === "all" || row.volumeId === mobileVolume)
      .filter((row) => !needle || `${row.ch.title} ${row.ch.summary} ${row.volumeTitle}`.toLowerCase().includes(needle))
      .sort((a, b) => (sortDesc ? b.no - a.no : a.no - b.no));
  }, [indexedFlat, mobileVolume, q, sortDesc]);

  return (
    <div className={`book-intro${compactHead ? " has-compact-head" : ""}`} ref={pageRef}>
      <header className="intro-top">
        <button className="icon-btn intro-back" title={t("回到书架")} onClick={props.onBack}>
          <Icon name="chevron" size={17} />
        </button>
        <div className="intro-brand">
          <Logo size={22} className="logo" />
          <span>Chapter</span>
          <em>·</em>
          <b>{t("作品介绍")}</b>
        </div>
        <div className="spacer" />
        <button className="intro-more-btn" onClick={() => setMoreOpen(true)}>
          {t("更多")}
        </button>
        <button
          className="icon-btn"
          title={theme === "light" ? t("切到夜幕") : t("切到夕阳")}
          onClick={props.onToggleTheme}
        >
          <Icon name={theme === "light" ? "moon" : "sun"} size={17} />
        </button>
        <button className="icon-btn" title={t("偏好设置")} onClick={props.onSettings}>
          <Icon name="settings" size={17} />
        </button>
      </header>

      <main className="intro-main">
        <section className="intro-hero">
          <button
            className="intro-cover"
            title={t("更换封面")}
            onClick={props.onPickCover}
          >
            <NovelCover
              title={meta.title}
              author={meta.author}
              coverUrl={coverUrl}
              template={meta.coverStyle}
              loading="eager"
            />
            <span className="intro-cover-kind">
              {coverUrl ? t("自定义封面") : t("默认封面")}
            </span>
            <span className="intro-cover-shade">
              <Icon name="image" size={14} />
              {t("更换封面")}
            </span>
          </button>

          <div className="intro-info">
            <div className="intro-mobile-status">
              <span>{flat.length ? t("连载中") : t("未开始")}</span>
              <em>{t("上次更新")} {fmtDateTime(meta.updatedAt)}</em>
            </div>
            <div className="intro-kicker">
              <span>{comic ? "COMIC" : "NOVEL"}</span>
              <i />
              <span>{outline.volumes.length} {t("卷")}</span>
              <i />
              <span>{flat.length} {comic ? t("话") : t("章")}</span>
            </div>
            <h1>{meta.title || t("未命名")}</h1>
            <p className="intro-byline">
              <span>{t("笔名")} · <b>{meta.author || t("佚名")}</b></span>
              <span className="dot">·</span>
              <span>{t("上次更新")} {fmtDateTime(meta.updatedAt)}</span>
            </p>
            <p className={`intro-desc${meta.description ? "" : " empty"}`}>
              {meta.description || t("还没有简介，点「书籍设置」写一段。")}
            </p>
            <div className="intro-stats">
              {comic ? (
                <>
                  <span>
                    <b>{props.comicPages ?? 0}</b>
                    {t("页")}
                  </span>
                  <span>
                    <b>{flat.length}</b>
                    {t("话")}
                  </span>
                  <span>
                    <b>{props.comicPanels ?? 0}</b>
                    {t("格")}
                  </span>
                  <span>
                    <b>{props.comicBalloons ?? 0}</b>
                    {t("气泡")}
                  </span>
                </>
              ) : (
                <>
                  <span>
                    <b>{fmtWords(total)}</b>
                    {t("字")}
                  </span>
                  <span>
                    <b>{flat.length}</b>
                    {comic ? t("话") : t("章")}
                  </span>
                  <span>
                    <b>{outline.volumes.length}</b>
                    {t("卷")}
                  </span>
                  <span>
                    <b>{meta.targetWords ? `${Math.min(100, Math.round((total / meta.targetWords) * 100))}%` : "0%"}</b>
                    {t("目标")}
                  </span>
                </>
              )}
            </div>
            <div className="intro-actions">
              <button
                className="btn btn-primary btn-lg"
                disabled={!resumeId}
                onClick={() => resumeId && props.onSelectChapter(resumeId)}
              >
                <Icon name={comic ? "image" : "edit"} size={16} />
                {comic
                  ? activeId
                    ? t("继续画")
                    : t("开始画")
                  : activeId
                    ? t("继续写")
                    : t("开始写")}
              </button>
              <button className="btn btn-outline btn-lg" onClick={props.onBookSettings}>
                <Icon name="edit" size={15} />
                {t("书籍设置")}
              </button>
              <button className="btn btn-ghost btn-lg" onClick={props.onMatter}>
                <Icon name="file" size={15} />
                {t("副文本")}
              </button>
              <button className="btn btn-ghost btn-lg" onClick={props.onPickCover}>
                <Icon name="image" size={15} />
                {t("更换封面")}
              </button>
            </div>
          </div>
        </section>

        <section className="intro-mobile-sheet">
          <div className="intro-m-tabs">
            <div className="intro-m-tabgroup">
              <button className={mobileTab === "chapters" ? "on" : ""} onClick={() => setMobileTab("chapters")}>
                {t("章节管理")}
              </button>
              <button className={mobileTab === "info" ? "on" : ""} onClick={() => setMobileTab("info")}>
                {t("作品资料")}
              </button>
            </div>
            <button
              className={`intro-m-search-toggle${searchOpen ? " on" : ""}`}
              aria-label={t("搜索章节")}
              onClick={() => setSearchOpen((v) => !v)}
            >
              <Icon name={searchOpen ? "close" : "search"} size={18} />
            </button>
          </div>

          {mobileTab === "chapters" ? (
            <>
              <div className={`intro-m-sticky${compactHead ? " on" : ""}`}>
                <div className="intro-m-bookline">
                  <span className="intro-m-mini-cover">
                    <NovelCover
                      title={meta.title}
                      author={meta.author}
                      coverUrl={coverUrl}
                      template={meta.coverStyle}
                      compact
                      loading="lazy"
                    />
                  </span>
                  <span className="intro-m-booktext">
                    <b>{meta.title || t("未命名")}</b>
                    <span>{fmtWords(total)} {t("字")} · {meta.author || t("佚名")}</span>
                    <span>{t("上次更新")} {fmtDateTime(meta.updatedAt)}</span>
                  </span>
                </div>
                <div className="intro-m-tools">
                  <label className="intro-m-volume">
                    <select value={mobileVolume} onChange={(e) => setMobileVolume(e.target.value)}>
                      <option value="all">{t("全部卷")} · {flat.length}{comic ? t("话") : t("章")}</option>
                      {outline.volumes.map((vol, vi) => (
                        <option key={vol.id} value={vol.id}>
                          {vol.title || `${t("第")}${vi + 1}${t("卷")}`} · {vol.chapters.length}
                        </option>
                      ))}
                    </select>
                    <Icon name="chevron" size={13} />
                  </label>
                  <button className="intro-m-sort" onClick={() => setSortDesc((v) => !v)}>
                    {sortDesc ? t("倒序") : t("正序")}
                  </button>
                </div>
              </div>

              {searchOpen && (
                <label className="intro-m-search">
                  <Icon name="search" size={16} />
                  <input
                    autoFocus
                    value={q}
                    placeholder={t("搜章节或卷名")}
                    onChange={(e) => setQ(e.target.value)}
                  />
                  {q && (
                    <button type="button" aria-label={t("清空搜索")} onClick={() => setQ("")}>
                      <Icon name="close" size={14} />
                    </button>
                  )}
                </label>
              )}

              <div className="intro-m-list">
                {mobileRows.length === 0 ? (
                  <div className="intro-m-empty">
                    <b>{q ? t("没有匹配的章节") : t("这一卷还是空的")}</b>
                    <span>{q ? t("换个关键词试试。") : t("去写作页新建一章。")}</span>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => props.onAddChapter?.(mobileVolume === "all" ? outline.volumes[0]?.id ?? "" : mobileVolume)}
                    >
                      <Icon name="plus" size={14} />
                      {t("新建一章")}
                    </button>
                  </div>
                ) : (
                  mobileRows.map((row) => (
                    <button
                      key={row.ch.id}
                      className={`intro-m-chapter${row.ch.id === activeId ? " current" : ""}`}
                      onClick={() => props.onSelectChapter(row.ch.id)}
                    >
                      <span className="intro-m-chapter-main">
                        <b>{row.ch.title || t("未命名")}</b>
                        <em>{fmtWords(row.ch.words ?? 0)} {t("字")}</em>
                        <em className="intro-m-chapter-date">{t("上次更新")} {fmtDateTime(row.ch.updatedAt)}</em>
                      </span>
                      <span className={`intro-m-state${row.ch.words > 0 ? " saved" : ""}`}>
                        {row.ch.words > 0 ? t("已保存") : t("待写")}
                      </span>
                      <Icon name="chevron" size={14} />
                    </button>
                  ))
                )}
              </div>
              <button className="intro-m-add" onClick={props.onAddVolume}>
                <Icon name="plus" size={15} />
                {t("新建一卷")}
              </button>
            </>
          ) : (
            <div className="intro-m-info">
              <div className="intro-m-desc">
                <h3>{t("作品简介")}</h3>
                <p>{meta.description || t("还没有简介，去书籍设置写一段。")}</p>
              </div>
              <div className="intro-m-meta">
                <span><b>{outline.volumes.length}</b>{t("卷")}</span>
                <span><b>{flat.length}</b>{comic ? t("话") : t("章")}</span>
                <span><b>{meta.targetWords ? `${Math.min(100, Math.round((total / meta.targetWords) * 100))}%` : "0%"}</b>{t("目标")}</span>
              </div>
              <div className="intro-m-info-actions">
                <button className="btn btn-outline" onClick={props.onBookSettings}>
                  <Icon name="edit" size={15} />{t("书籍设置")}
                </button>
                <button className="btn btn-outline" onClick={props.onMatter}>
                  <Icon name="file" size={15} />{t("副文本")}
                </button>
                <button className="btn btn-outline" onClick={props.onPickCover}>
                  <Icon name="image" size={15} />{t("更换封面")}
                </button>
                <button className="btn btn-ghost" onClick={props.onSettings}>
                  <Icon name="settings" size={15} />{t("偏好设置")}
                </button>
              </div>
            </div>
          )}
        </section>

        <button
          className="intro-fab"
          disabled={!resumeId}
          title={comic ? t("继续画") : t("继续写")}
          aria-label={comic ? t("继续画") : t("继续写")}
          onClick={() => resumeId && props.onSelectChapter(resumeId)}
        >
          <Icon name={comic ? "image" : "edit"} size={22} />
        </button>

        <section className="intro-catalog">
          <div className="intro-catalog-head">
            <div>
              <h2>{t("目录")}</h2>
              <p>{t("展开一卷，只看见这一卷的章节。")}</p>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={props.onAddVolume}>
              <Icon name="plus" size={14} />
              {t("新建一卷")}
            </button>
          </div>

          {outline.volumes.length === 0 ? (
            <div className="intro-catalog-empty">
              <p>{t("这本书还没有卷。")}</p>
              <button className="btn btn-primary btn-sm" onClick={props.onAddVolume}>
                <Icon name="plus" size={14} />
                {t("新建第一卷")}
              </button>
            </div>
          ) : (
            <div className="volume-stack">
              {outline.volumes.map((vol, vi) => {
                const open = openVolume === vol.id;
                const firstIndex = outline.volumes
                  .slice(0, vi)
                  .reduce((n, v) => n + v.chapters.length, 0);
                return (
                  <article className={`intro-volume${open ? " open" : ""}`} key={vol.id}>
                    <button
                      className="intro-volume-head"
                      onClick={() => setOpenVolume(open ? null : vol.id)}
                      aria-expanded={open}
                    >
                      <span className="intro-volume-no">{String(vi + 1).padStart(2, "0")}</span>
                      <span className="intro-volume-name">
                        <b>{vol.title || `${t("第")}${vi + 1}${t("卷")}`}</b>
                        <em>
                          {vol.chapters.length} {comic ? t("话") : t("章")}
                        </em>
                      </span>
                      <span className="intro-volume-line" />
                      <Icon name="chevron" size={14} className="intro-volume-caret" />
                    </button>
                    <div className="intro-volume-fold" aria-hidden={!open}>
                      <div className="intro-volume-inner">
                        {vol.chapters.length === 0 ? (
                          <div className="intro-chapter-empty">{comic ? t("这一卷还没有画布，去作画页新建一话。") : t("这一卷还没有章节，去写作页新建一章。")}</div>
                        ) : (
                          vol.chapters.map((ch, ci) => (
                            <button
                              key={ch.id}
                              className={`intro-chapter${ch.id === activeId ? " current" : ""}`}
                              onClick={() => props.onSelectChapter(ch.id)}
                            >
                              <span className="intro-chapter-no">
                                {String(firstIndex + ci + 1).padStart(2, "0")}
                              </span>
                              <span className="intro-chapter-main">
                                <b>{ch.title || `${t("第")}${ci + 1}${t("章")}`}</b>
                                <em>{ch.summary || t("还没有摘要")}</em>
                              </span>
                              <span className="intro-chapter-words">
                                {comic ? t("打开画布") : `${fmtWords(ch.words ?? 0)} ${t("字")}`}
                              </span>
                              <Icon name="arrow" size={14} />
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </main>

      {moreOpen && (
        <div className="intro-sheet-layer">
          <button className="intro-sheet-scrim" aria-label={t("关闭")} onClick={() => setMoreOpen(false)} />
          <div className="intro-sheet" role="dialog" aria-modal="true">
            <div className="intro-sheet-head">
              <b>{t("更多")}</b>
              <button aria-label={t("关闭")} onClick={() => setMoreOpen(false)}>
                <Icon name="close" size={16} />
              </button>
            </div>
            <button onClick={() => { setMoreOpen(false); props.onBookSettings(); }}>
              <Icon name="edit" size={17} />{t("书籍设置")}
            </button>
            <button onClick={() => { setMoreOpen(false); props.onMatter(); }}>
              <Icon name="file" size={17} />{t("副文本")}
            </button>
            <button onClick={() => { setMoreOpen(false); props.onPickCover(); }}>
              <Icon name="image" size={17} />{t("更换封面")}
            </button>
            <button onClick={() => { setMoreOpen(false); props.onToggleTheme(); }}>
              <Icon name={theme === "dark" ? "sun" : "moon"} size={17} />
              {theme === "dark" ? t("切到浅色") : t("切到深色")}
            </button>
            <button onClick={() => { setMoreOpen(false); props.onSettings(); }}>
              <Icon name="settings" size={17} />{t("偏好设置")}
            </button>
            <button className="intro-sheet-cancel" onClick={() => setMoreOpen(false)}>{t("取消")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
