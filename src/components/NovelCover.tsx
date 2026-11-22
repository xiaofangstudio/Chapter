import type { CSSProperties } from "react";
import { resolveCoverTemplate, type CoverArt } from "../lib/coverLibrary";
import { t } from "../lib/i18n";

interface Props {
  title: string;
  author?: string;
  coverUrl?: string | null;
  /** 默认封面模板 id；有自定义封面时只作为书脊颜色的兜底。 */
  template?: string | null;
  className?: string;
  /** 顶栏等极窄位置隐藏作者与印记，只保留同一张封面。 */
  compact?: boolean;
  loading?: "lazy" | "eager";
}

/** 纯 CSS 绘制的封面装饰；每个模板共用一套形状，只换构图。 */
function CoverDeco({ art }: { art: CoverArt }) {
  switch (art) {
    case "mountains":
      return (
        <>
          <span className="cv-sun" />
          <span className="cv-mountain m1" />
          <span className="cv-mountain m2" />
          <span className="cv-mountain m3" />
          <span className="cv-haze" />
        </>
      );
    case "orbs":
      return (
        <>
          <span className="cv-orb o1" />
          <span className="cv-orb o2" />
          <span className="cv-orb o3" />
          <span className="cv-squiggle" />
        </>
      );
    case "arcs":
      return (
        <>
          <span className="cv-arc a1" />
          <span className="cv-arc a2" />
          <span className="cv-arc a3" />
          <span className="cv-dot d1" />
        </>
      );
    case "circle":
      return (
        <>
          <span className="cv-vertical" />
          <span className="cv-ring" />
          <span className="cv-dot d2" />
        </>
      );
    case "frame":
      return (
        <>
          <span className="cv-corner" />
          <span className="cv-dot d3" />
          <span className="cv-hline" />
        </>
      );
    case "petals":
      return (
        <>
          <span className="cv-petal p1" />
          <span className="cv-petal p2" />
          <span className="cv-petal p3" />
          <span className="cv-petal p4" />
        </>
      );
    case "leaves":
      return (
        <>
          <span className="cv-branch" />
          <span className="cv-leaf l1" />
          <span className="cv-leaf l2" />
          <span className="cv-leaf l3" />
          <span className="cv-leaf l4" />
        </>
      );
    case "bird":
      return (
        <>
          <span className="cv-mist m1" />
          <span className="cv-mist m2" />
          <span className="cv-bird" />
        </>
      );
    case "city":
      return (
        <>
          <span className="cv-building b1" />
          <span className="cv-building b2" />
          <span className="cv-building b3" />
          <span className="cv-building b4" />
          <span className="cv-city-glow" />
        </>
      );
    case "planets":
      return (
        <>
          <span className="cv-orbit r1" />
          <span className="cv-orbit r2" />
          <span className="cv-planet p1" />
          <span className="cv-planet p2" />
          <span className="cv-planet p3" />
        </>
      );
    case "lines":
      return (
        <>
          <span className="cv-gold-line g1" />
          <span className="cv-gold-line g2" />
          <span className="cv-gold-line g3" />
          <span className="cv-gold-dot" />
        </>
      );
    default:
      return null;
  }
}

/**
 * 全站唯一的 2D 小说封面。
 *
 * 工作台、极简书架、介绍页、顶栏和切书页正面都渲染这一个组件；换封面后
 * 只需要换 coverUrl / template，不会再出现一套页面一种封面。
 */
export function NovelCover({
  title,
  author,
  coverUrl,
  template,
  className = "",
  compact = false,
  loading = "lazy",
}: Props) {
  const name = title.trim() || t("未命名");
  const style = resolveCoverTemplate(template, name);
  const cjk = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(name);
  const chars = Array.from(name).slice(0, compact ? 4 : 12);
  // 书名越长，字级越小；cqw 跟着组件宽度走，同一套排版在 34px 顶栏和 336px 书封上都成立。
  const titleSize = compact ? 26 : Math.min(16, 84 / Math.max(4, chars.length));

  const vars = {
    "--cover-a": style.from,
    "--cover-b": style.to,
    "--cover-ink": style.ink,
    "--cover-accent": style.accent,
    "--cover-title-size": `${titleSize}cqw`,
  } as CSSProperties;

  return (
    <div
      className={`novel-cover ${coverUrl ? "has-image" : "default-cover"} cover-style-${style.id}${style.authorSide ? " author-side" : ""}${compact ? " compact" : ""} ${className}`.trim()}
      style={vars}
    >
      {coverUrl ? (
        <img src={coverUrl} alt="" draggable={false} loading={loading} decoding="async" />
      ) : (
        <div className="novel-cover-art">
          <span className="novel-cover-deco" aria-hidden="true">
            <CoverDeco art={style.art} />
          </span>
          {cjk ? (
            <div className="novel-cover-title cjk">
              {chars.map((ch, i) => (
                <span key={i}>{ch === " " ? "\u00a0" : ch}</span>
              ))}
            </div>
          ) : (
            <div className="novel-cover-title latin">{name}</div>
          )}
          {!compact && <div className="novel-cover-author">{author || t("佚名")}</div>}
          {!compact && <div className="novel-cover-imprint">{t("CHAPTER · 小方工作室")}</div>}
        </div>
      )}
      <span className="novel-cover-sheen" aria-hidden="true" />
    </div>
  );
}
