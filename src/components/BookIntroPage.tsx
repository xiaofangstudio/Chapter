import { useEffect, useMemo, useState } from "react";
import type { BookMeta, Outline } from "../types";
import { fmtWords, relTime } from "../lib/text";
import { t } from "../lib/i18n";
import { Icon } from "./Icon";
import { Logo } from "./Logo";
import { NovelCover } from "./NovelCover";

interface Props {
  meta: BookMeta;
  outline: Outline;
  coverUrl?: string;
  activeId: string | null;
  theme: "light" | "dark";
  onBack: () => void;
  onSelectChapter: (id: string) => void;
  onBookSettings: () => void;
  onPickCover: () => void;
  onToggleTheme: () => void;
  onSettings: () => void;
  onAddVolume: () => void;
}

export function BookIntroPage(props: Props) {
  const { meta, outline, coverUrl, activeId, theme } = props;
  const flat = useMemo(
    () => outline.volumes.flatMap((v) => v.chapters.map((c) => ({ ...c, volumeId: v.id }))),
    [outline],
  );
  const total = useMemo(() => flat.reduce((n, c) => n + (c.words ?? 0), 0), [flat]);
  const volumeOfActive =
    outline.volumes.find((v) => v.chapters.some((c) => c.id === activeId))?.id ??
    outline.volumes[0]?.id ??
    null;
  const [openVolume, setOpenVolume] = useState<string | null>(volumeOfActive);

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

  return (
    <div className="book-intro">
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
            <div className="intro-kicker">
              <span>NOVEL</span>
              <i />
              <span>{outline.volumes.length} {t("卷")}</span>
              <i />
              <span>{flat.length} {t("章")}</span>
            </div>
            <h1>{meta.title || t("未命名")}</h1>
            <p className="intro-byline">
              <span>{t("笔名")} · <b>{meta.author || t("佚名")}</b></span>
              <span className="dot">·</span>
              <span>{t("上次更新")} {relTime(meta.updatedAt)}</span>
            </p>
            <p className={`intro-desc${meta.description ? "" : " empty"}`}>
              {meta.description || t("还没有简介，点「书籍设置」写一段。")}
            </p>
            <div className="intro-stats">
              <span>
                <b>{fmtWords(total)}</b>
                {t("字")}
              </span>
              <span>
                <b>{flat.length}</b>
                {t("章")}
              </span>
              <span>
                <b>{outline.volumes.length}</b>
                {t("卷")}
              </span>
              <span>
                <b>{meta.targetWords ? `${Math.min(100, Math.round((total / meta.targetWords) * 100))}%` : "0%"}</b>
                {t("目标")}
              </span>
            </div>
            <div className="intro-actions">
              <button
                className="btn btn-primary btn-lg"
                disabled={!resumeId}
                onClick={() => resumeId && props.onSelectChapter(resumeId)}
              >
                <Icon name="edit" size={16} />
                {activeId ? t("继续写") : t("开始写")}
              </button>
              <button className="btn btn-outline btn-lg" onClick={props.onBookSettings}>
                <Icon name="edit" size={15} />
                {t("书籍设置")}
              </button>
              <button className="btn btn-ghost btn-lg" onClick={props.onPickCover}>
                <Icon name="image" size={15} />
                {t("更换封面")}
              </button>
            </div>
          </div>
        </section>

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
                          {vol.chapters.length} {t("章")}
                        </em>
                      </span>
                      <span className="intro-volume-line" />
                      <Icon name="chevron" size={14} className="intro-volume-caret" />
                    </button>
                    <div className="intro-volume-fold" aria-hidden={!open}>
                      <div className="intro-volume-inner">
                        {vol.chapters.length === 0 ? (
                          <div className="intro-chapter-empty">{t("这一卷还没有章节，去写作页新建一章。")}</div>
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
                                {fmtWords(ch.words ?? 0)} {t("字")}
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
    </div>
  );
}
