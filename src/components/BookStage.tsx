import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import type { BookSummary } from "../types";
import { coverTone, fmtWords } from "../lib/text";
import { t } from "../lib/i18n";
import { Icon } from "./Icon";

/** 书籍厚度跟字数走：10 万字约 1.8cm 的视觉比例，100 万字到上限。 */
export function spineDepth(words: number): number {
  const raw = 8 + Math.sqrt(Math.max(0, words) / 1000) * 1.15;
  return Math.round(Math.min(52, Math.max(8, raw)));
}

const COVER_PALETTES = [
  { a: "#1f3350", b: "#0e1a2c", foil: "#e7c07a" },
  { a: "#5a2530", b: "#2c1017", foil: "#eccb8d" },
  { a: "#2f4437", b: "#14241c", foil: "#dfc18b" },
  { a: "#43324f", b: "#1f1727", foil: "#e6c489" },
  { a: "#7a4a26", b: "#3a2010", foil: "#f0d39b" },
  { a: "#33312e", b: "#171614", foil: "#d8bd8a" },
];

function hashOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 9973;
  return h;
}

interface BookObjectProps {
  book: BookSummary;
  coverUrl?: string;
  className?: string;
}

/** 同一个封面在书架和 3D 舞台里复用同一个组件，不复制第二套素材。 */
export function BookObject({ book, coverUrl, className = "" }: BookObjectProps) {
  const h = hashOf(book.id || book.title);
  const palette = COVER_PALETTES[h % COVER_PALETTES.length];
  const tone = coverTone(book.title);
  const depth = spineDepth(book.words);
  const art = h % 6;
  const custom = Boolean(coverUrl);
  // 没有自定义封面时，3D 书与书架小封面共用同一套暖色，不再出现“卡片是橙色、书是深蓝”的割裂。
  const spine = book.spineColor || (custom ? palette.b : tone.to);

  const style = {
    "--book-w": "234px",
    "--book-h": "336px",
    "--book-depth": `${depth}px`,
    "--cover-a": tone.from,
    "--cover-b": tone.to,
    "--cover-foil": custom ? palette.foil : tone.ink,
    "--spine-color": spine,
  } as CSSProperties;

  return (
    <div className={`book3d ${custom ? "custom-cover" : "default-cover"} ${className}`.trim()} style={style}>
      <div className="book-shadow" />
      <div className="book-pages" />
      <div className="book-top" />
      <div className="book-bottom" />
      <div className="book-back" />
      <div className="book-spine">
        {!custom && (
          <>
            <span className="book-spine-rule" />
            <span className="book-spine-title">{book.title}</span>
            <span className="book-spine-mark">CHAPTER</span>
          </>
        )}
      </div>
      <div className="book-front">
        {custom ? (
          <img src={coverUrl} alt="" draggable={false} />
        ) : (
          <div className={`book-art art-${art}`}>
            <span className="book-art-rule" />
            <span className="book-art-orn" />
            <div className={`book-art-title ${/[\u4e00-\u9fff]/.test(book.title) ? "cjk" : "latin"}`}>
              {Array.from(book.title)
                .slice(0, 10)
                .map((ch, i) => (
                  <span key={i}>{ch === " " ? "\u00a0" : ch}</span>
                ))}
            </div>
            <div className="book-art-author">{book.author || t("佚名")}</div>
            <div className="book-art-imprint">CHAPTER · 小方工作室</div>
          </div>
        )}
        <span className="book-front-sheen" />
        <span className="book-front-edge" />
      </div>
    </div>
  );
}

interface BookStageProps {
  books: BookSummary[];
  covers: Record<string, string>;
  initialPath?: string;
  onClose: () => void;
  onEnter: (book: BookSummary) => void;
}

export function BookStage({ books, covers, initialPath, onClose, onEnter }: BookStageProps) {
  const initial = Math.max(
    0,
    books.findIndex((b) => b.path === initialPath),
  );
  const [focus, setFocus] = useState(initial);
  const dragDx = useRef(0);
  const tiltRaf = useRef(0);
  const tiltPoint = useRef({ x: 0, y: -14 });
  const [flying, setFlying] = useState(false);
  const drag = useRef<{ x: number; y: number; active: boolean } | null>(null);
  const suppressClick = useRef(false);
  const wheelLock = useRef(0);
  const flowRef = useRef<HTMLDivElement | null>(null);

  const focused = books[focus];

  const go = (delta: number) => {
    setFocus((f) => Math.max(0, Math.min(books.length - 1, f + delta)));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft") {
        go(-1);
      } else if (e.key === "ArrowRight") {
        go(1);
      } else if (e.key === "Enter" && focused && !flying) {
        e.preventDefault();
        setFlying(true);
        window.setTimeout(() => onEnter(focused), 760);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focused, flying, onClose, onEnter]);

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    const now = Date.now();
    if (now - wheelLock.current < 380) return;
    const delta = e.deltaY || e.deltaX;
    if (Math.abs(delta) < 8) return;
    wheelLock.current = now;
    go(delta > 0 ? 1 : -1);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (flying) return;
    drag.current = { x: e.clientX, y: e.clientY, active: true };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (rect) {
      const cx = (e.clientX - rect.left) / rect.width - 0.5;
      const cy = (e.clientY - rect.top) / rect.height - 0.5;
      tiltPoint.current = { x: -cy * 5.5, y: cx * 10 };
      if (!tiltRaf.current) {
        tiltRaf.current = requestAnimationFrame(() => {
          tiltRaf.current = 0;
          const el = flowRef.current?.querySelector<HTMLElement>(".book-slot.is-focus .book-tilt");
          if (el) {
            el.style.transform = `rotateX(${tiltPoint.current.x.toFixed(2)}deg) rotateY(${tiltPoint.current.y.toFixed(2)}deg)`;
          }
        });
      }
    }
    if (drag.current?.active) {
      dragDx.current = e.clientX - drag.current.x;
      flowRef.current?.style.setProperty("--drag-shift", `${(dragDx.current * 0.35).toFixed(1)}px`);
    }
  };

  const resetFocusTilt = () => {
    tiltPoint.current = { x: 0, y: 0 };
    const el = flowRef.current?.querySelector<HTMLElement>(".book-slot.is-focus .book-tilt");
    if (el) el.style.transform = "rotateX(0deg) rotateY(0deg)";
  };

  const endDrag = () => {
    if (!drag.current?.active) return;
    const dx = dragDx.current;
    drag.current = null;
    dragDx.current = 0;
    flowRef.current?.style.setProperty("--drag-shift", "0px");
    if (Math.abs(dx) > 8) {
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 220);
    }
    if (Math.abs(dx) > 64) go(dx < 0 ? 1 : -1);
  };

  useEffect(() => {
    dragDx.current = 0;
    flowRef.current?.style.setProperty("--drag-shift", "0px");
    flowRef.current?.querySelectorAll<HTMLElement>(".book-tilt").forEach((el) => {
      el.style.transform = "";
    });
    resetFocusTilt();
    // 只在焦点书变化时恢复默认倾角，不跟鼠标移动重渲染。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const enter = () => {
    if (!focused || flying) return;
    setFlying(true);
    window.setTimeout(() => onEnter(focused), 760);
  };

  const slots = useMemo(
    () =>
      books.map((b, i) => {
        const off = i - focus;
        return { b, i, off, hidden: Math.abs(off) > 0 };
      }),
    [books, focus],
  );

  return (
    <div
      className={`book-focus${flying ? " flying" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={t("书架")}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={resetFocusTilt}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="book-focus-top">
        <div className="book-focus-brand">
          <span>{t("书架")}</span>
          <em>{books.length} {t("本")}</em>
        </div>
        <span className="book-focus-welcome">{t("拖拽、滚轮或方向键切换；再点一次封面进入写作")}</span>
        <button className="icon-btn" onClick={onClose} title={t("返回工作台")}>
          <Icon name="close" size={17} />
        </button>
      </div>

      <div className="book-stage-body">
      <div
        ref={flowRef}
        className="book-flow"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {slots.map(({ b, i, off, hidden }) => {
          if (hidden) return null;
          const isFocus = off === 0;
          const x = off * 196;
          const drag = isFocus ? "0px" : "var(--drag-shift, 0px)";
          const trans = `translate(-50%, -50%) translateX(calc(${x}px + ${drag})) translateZ(${-Math.abs(off) * 118}px) rotateY(${off * -26}deg) scale(${isFocus ? 1 : 0.84})`;
          return (
            <div
              key={b.path}
              data-stage-book={i}
              className={`book-slot${isFocus ? " is-focus" : ""}`}
              style={{
                transform: trans,
                opacity: Math.abs(off) > 2 ? 0.22 : 1,
                zIndex: 20 - Math.abs(off),
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (suppressClick.current) {
                  suppressClick.current = false;
                  return;
                }
                if (isFocus) enter();
                else setFocus(i);
              }}
            >
              <div
                className="book-tilt"
                style={
                  isFocus
                    ? undefined
                    : { transform: "rotateX(0deg) rotateY(0deg)" }
                }
              >
                <BookObject book={b} coverUrl={covers[b.path]} />
              </div>
            </div>
          );
        })}
      </div>

      {focused && (
        <div className="book-focus-info">
          <h2>{focused.title}</h2>
          <p>
            {focused.author || t("佚名")} · {focused.chapterCount} {t("章")} · {fmtWords(focused.words)} {t("字")}
          </p>
          <div className="book-focus-meta">
            <span>{t("书脊厚度")} {spineDepth(focused.words)}px</span>
            <span>{t("最近更新")} {new Date(focused.updatedAt).toLocaleDateString("zh-CN")}</span>
          </div>
          <button className="btn btn-primary book-focus-enter" onClick={enter} disabled={flying}>
            {t("进入这本书")}
            <Icon name="arrow" size={14} />
          </button>
        </div>
      )}
      </div>

      <div className="book-focus-dots" aria-label={t("书架")}>
        {books.map((b, i) => (
          <button
            key={b.path}
            type="button"
            className={i === focus ? "on" : ""}
            onClick={() => setFocus(i)}
            aria-label={b.title}
            title={b.title}
          />
        ))}
      </div>
    </div>
  );
}
