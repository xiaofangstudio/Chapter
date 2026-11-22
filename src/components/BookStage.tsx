import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { BookSummary } from "../types";
import { fmtWords } from "../lib/text";
import { resolveCoverTemplate } from "../lib/coverLibrary";
import { t } from "../lib/i18n";
import { Icon } from "./Icon";
import { NovelCover } from "./NovelCover";

/** 书籍厚度跟字数走：10 万字约 1.8cm 的视觉比例，100 万字到上限。 */
export function spineDepth(words: number): number {
  const raw = 8 + Math.sqrt(Math.max(0, words) / 1000) * 1.15;
  return Math.round(Math.min(52, Math.max(8, raw)));
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * 只渲染封面 + 两条侧边的平面书。
 *
 * 之前用六个 3D 面拼一本厚书，WebView2 在背面剔除、阴影和遮罩共同作用时会
 * 裁切、上下翻面，而且每本书都要多画四层。这里改成一张平面封面，侧面用两条
 * 跟角度收放的纸边来表现厚度；视觉上仍是书，合成成本却接近一张图片。
 */
const SLOT_VISIBLE = 4.6;

interface BookObjectProps {
  book: BookSummary;
  coverUrl?: string;
  className?: string;
}

export function BookObject({ book, coverUrl, className = "" }: BookObjectProps) {
  const depth = spineDepth(book.words);
  const template = resolveCoverTemplate(book.coverStyle, book.title);
  const custom = Boolean(coverUrl);
  // 自定义封面没有模板可借书脊色，默认给一条暖棕皮革脊，避免整条发黑。
  const spine = book.spineColor || (custom ? "#6d4a33" : template.spine);
  const thin = depth < 12;

  const style = {
    "--book-w": "var(--stage-book-w, 234px)",
    "--book-h": "var(--stage-book-h, 336px)",
    "--book-depth": `${depth}px`,
    "--spine-color": spine,
    "--cover-foil": template.ink,
  } as CSSProperties;

  return (
    <div
      className={`book3d flat-book ${custom ? "custom-cover" : "default-cover"}${thin ? " thin-book" : ""} ${className}`.trim()}
      style={style}
    >
      <span className="bc-shadow" aria-hidden="true" />
      <span className="bc-spine" aria-hidden="true" />
      <span className="bc-pages" aria-hidden="true" />
      <div className="bc-face">
        <NovelCover
          title={book.title}
          author={book.author}
          coverUrl={coverUrl}
          template={book.coverStyle}
          className="bc-cover"
          loading="eager"
        />
        <span className="bc-sheen" aria-hidden="true" />
        <span className="bc-edge" aria-hidden="true" />
      </div>
    </div>
  );
}

interface BookStageProps {
  books: BookSummary[];
  covers: Record<string, string>;
  initialPath?: string;
  originRect?: DOMRect | null;
  onClose: () => void;
  onEnter: (book: BookSummary) => void;
}

interface FlightState {
  phase: "in" | "out";
  rect: DOMRect;
}

interface DragState {
  x: number;
  startPos: number;
  active: boolean;
  moved: boolean;
  captured: boolean;
  pointerId: number;
  lastX: number;
  lastT: number;
  vx: number;
}

function coverFor(book: BookSummary, covers: Record<string, string>): string | undefined {
  if (book.coverMode === "default") return undefined;
  return covers[book.path];
}

export function BookStage({ books, covers, initialPath, originRect, onClose, onEnter }: BookStageProps) {
  const initial = Math.max(
    0,
    books.findIndex((b) => b.path === initialPath),
  );
  const count = books.length;
  const maxPos = Math.max(0, count - 1);
  const [focus, setFocus] = useState(initial);
  const [closing, setClosing] = useState(false);
  const [entering, setEntering] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [flight, setFlight] = useState<FlightState | null>(
    originRect ? { phase: "in", rect: originRect } : null,
  );

  const focusRef = useRef(initial);
  const posRef = useRef(initial);
  const targetRef = useRef(initial);
  const velRef = useRef(0);
  const tiltRef = useRef(new Map<number, { x: number; y: number }>());
  const slotRefs = useRef(new Map<number, HTMLDivElement>());
  const tiltEls = useRef(new Map<number, HTMLDivElement>());
  const flowRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const flightRef = useRef<HTMLDivElement | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const pointerRef = useRef({ x: 0, y: 0, active: false });
  const dragRef = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const rafRef = useRef(0);
  const lastTs = useRef(0);
  const wheelIdle = useRef(0);
  const revealedRef = useRef(false);
  const revealedAt = useRef(0);
  const dotThumbRef = useRef<HTMLElement | null>(null);
  const enteringRef = useRef(false);
  const enterRef = useRef<() => void>(() => undefined);

  const focused = books[focus];

  const visible = useMemo(() => {
    const from = Math.max(0, focus - 5);
    const to = Math.min(count, focus + 6);
    return books.slice(from, to).map((b, idx) => ({ b, i: from + idx }));
  }, [books, count, focus]);

  /**
   * 一帧内只改 DOM 的 transform/opacity，不让 React 跟着滚动重渲染。
   * 侧面书保持竖立，只有最前面的焦点书跟随鼠标；这是 Apple Music 式
   * Cover Flow 的手感，也把每帧要写的属性压到最低。
   */
  const paint = useCallback(() => {
    const flow = flowRef.current;
    if (!flow || !count || enteringRef.current) return false;
    const w = sizeRef.current.w || flow.clientWidth || 1360;
    const h = sizeRef.current.h || flow.clientHeight || 336;
    const p = posRef.current;
    const now = performance.now();
    const since = revealedAt.current;
    const active = pointerRef.current.active;
    const px = pointerRef.current.x;
    const py = pointerRef.current.y;
    const spacing = w < 900 ? 150 : w < 1200 ? 168 : Math.min(196, Math.max(176, w * 0.122));
    const focusNow = focusRef.current;
    let tiltMoving = false;

    for (let i = 0; i < count; i += 1) {
      const slot = slotRefs.current.get(i);
      if (!slot) continue;
      const off = i - p;
      const abs = Math.abs(off);

      if (abs > SLOT_VISIBLE) {
        slot.style.opacity = "0";
        slot.style.pointerEvents = "none";
        continue;
      }

      /* 远处的书向焦点收拢并压住转角，像 Cover Flow 一样层层叠在后面；
         不是排成一条等距直线。 */
      const distance =
        abs <= 1 ? abs * spacing : spacing + Math.max(0, abs - 1) * (spacing * 0.72);
      const x = Math.sign(off) * distance;
      const y = Math.min(8, abs * 2);
      const z = -abs * 108;
      const rot = clamp(-off * 46, -68, 68);
      const scale = 1 / (1 + abs * 0.16);
      slot.style.transform = `translate(-50%, -50%) translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, ${z.toFixed(2)}px) rotateY(${rot.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
      slot.style.zIndex = String(70 - Math.round(abs * 8));
      slot.style.pointerEvents = revealedRef.current && abs < 2.6 ? "auto" : "none";

      let opacity = 1 - Math.min(0.58, abs * 0.11);
      if (revealedRef.current) {
        const wait = 90 + abs * 70;
        const k = clamp((now - since - wait) / 380, 0, 1);
        opacity *= 1 - Math.pow(1 - k, 3);
      } else {
        opacity = 0;
      }
      slot.style.opacity = opacity.toFixed(3);

      const tilt = tiltEls.current.get(i);
      if (tilt) {
        const isFocus = i === focusNow;
        const nx = clamp((px - (w / 2 + x)) / Math.max(230, w * 0.25), -1.15, 1.15);
        // 上下方向与鼠标一致：鼠标在上，书的上沿向观察者抬起。
        const ny = clamp((py - (h / 2 + y)) / Math.max(150, h * 0.38), -1.15, 1.15);
        const targetX = isFocus && active ? clamp(-ny * 9.2, -13, 12) : 0;
        const targetY = isFocus && active ? clamp(nx * 12.4, -17, 17) : 0;
        const cur = tiltRef.current.get(i) ?? { x: 0, y: 0 };
        const ease = 1 - Math.pow(0.8, 1.15);
        cur.x += (targetX - cur.x) * ease;
        cur.y += (targetY - cur.y) * ease;
        if (Math.abs(targetX - cur.x) > 0.035 || Math.abs(targetY - cur.y) > 0.035) tiltMoving = true;
        tiltRef.current.set(i, cur);
        tilt.style.transform = `rotateX(${cur.x.toFixed(2)}deg) rotateY(${cur.y.toFixed(2)}deg)`;

        /* 总角度决定哪一条纸边朝向观察者；两条边互斥，避免同时贴在封面上。 */
        const totalY = rot + cur.y;
        const pageK = Math.min(1, Math.abs(Math.sin((totalY * Math.PI) / 180)));
        tilt.style.setProperty("--page-k", pageK.toFixed(3));
        const side = totalY > 3 ? "spine" : totalY < -3 ? "pages" : "";
        if (tilt.dataset.side !== side) {
          tilt.dataset.side = side;
          tilt.classList.toggle("spine-on", side === "spine");
          tilt.classList.toggle("pages-on", side === "pages");
        }
      }
    }

    const thumb = dotThumbRef.current;
    if (thumb) {
      const ratio = maxPos ? p / maxPos : 0;
      const width = Math.max(10, 100 / Math.max(2, count));
      thumb.style.width = `${width.toFixed(2)}%`;
      thumb.style.left = `${(ratio * (100 - width)).toFixed(2)}%`;
    }
    return tiltMoving;
  }, [count, maxPos]);

  const kick = useCallback(() => {
    if (rafRef.current) return;
    const tick = (ts: number) => {
      if (enteringRef.current) {
        rafRef.current = 0;
        lastTs.current = 0;
        return;
      }
      const last = lastTs.current || ts - 16.67;
      lastTs.current = ts;
      const dt = clamp((ts - last) / 16.67, 0.25, 3);
      const target = targetRef.current;
      const dx = target - posRef.current;
      velRef.current += dx * 0.1 * dt;
      velRef.current *= Math.pow(0.72, dt);
      posRef.current += velRef.current * dt;
      if (posRef.current < 0) {
        posRef.current = 0;
        velRef.current *= 0.7;
      } else if (posRef.current > maxPos) {
        posRef.current = maxPos;
        velRef.current *= 0.7;
      }
      const nearest = Math.round(posRef.current);
      if (nearest !== focusRef.current && nearest >= 0 && nearest <= maxPos) {
        focusRef.current = nearest;
        setFocus(nearest);
      }
      const tiltMoving = paint();
      const moving =
        Math.abs(targetRef.current - posRef.current) > 0.0016 || Math.abs(velRef.current) > 0.0016;
      const revealing = ts < revealedAt.current + 1050;
      if (moving || tiltMoving || revealing) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        posRef.current = targetRef.current;
        paint();
        rafRef.current = 0;
        lastTs.current = 0;
      }
    };
    lastTs.current = 0;
    rafRef.current = requestAnimationFrame(tick);
  }, [maxPos, paint]);

  const glideTo = useCallback(
    (idx: number) => {
      targetRef.current = clamp(idx, 0, maxPos);
      kick();
    },
    [kick, maxPos],
  );

  const jumpTo = useCallback(
    (idx: number) => {
      const next = clamp(idx, 0, maxPos);
      targetRef.current = next;
      posRef.current = next;
      velRef.current = 0;
      focusRef.current = next;
      setFocus(next);
      paint();
      kick();
    },
    [kick, maxPos, paint],
  );

  const requestClose = useCallback(() => {
    if (closing || entering) return;
    if (!originRect) {
      onClose();
      return;
    }
    const bookEl = flowRef.current?.querySelector<HTMLElement>(".book-slot.is-focus .book3d");
    if (!bookEl) {
      onClose();
      return;
    }
    setClosing(true);
    setFlight({ phase: "out", rect: bookEl.getBoundingClientRect() });
  }, [closing, entering, onClose, originRect]);

  // 原生滚轮监听：React 的 onWheel 在部分 WebView 下会被动化，这里显式 preventDefault。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      if (closing || entering) return;
      e.preventDefault();
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!delta) return;
      const mult = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const step = clamp((delta * mult) / 140, -2.2, 2.2);
      targetRef.current = clamp(targetRef.current + step, 0, maxPos);
      window.clearTimeout(wheelIdle.current);
      wheelIdle.current = window.setTimeout(() => {
        targetRef.current = clamp(Math.round(targetRef.current), 0, maxPos);
        kick();
      }, 145);
      kick();
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [closing, entering, kick, maxPos]);

  useEffect(() => {
    const onResize = () => {
      const flow = flowRef.current;
      if (!flow || enteringRef.current) return;
      sizeRef.current = { w: flow.clientWidth, h: flow.clientHeight };
      paint();
      kick();
    };
    const flow = flowRef.current;
    if (flow) sizeRef.current = { w: flow.clientWidth, h: flow.clientHeight };
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
    if (flow && ro) ro.observe(flow);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
    };
  }, [kick, paint]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (!enteringRef.current) {
          targetRef.current = clamp(targetRef.current - 1, 0, maxPos);
          kick();
        }
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (!enteringRef.current) {
          targetRef.current = clamp(targetRef.current + 1, 0, maxPos);
          kick();
        }
      } else if (e.key === "Enter" && focused && !entering && !closing && revealed) {
        e.preventDefault();
        enterRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closing, entering, focused, kick, maxPos, requestClose, revealed]);

  // 首次进入：从工作台那张 2D 封面所在矩形飞到 3D 书的位置，落位后再显影。
  useLayoutEffect(() => {
    if (!flight || !flightRef.current) return;
    const flow = flowRef.current;
    if (flow) sizeRef.current = { w: flow.clientWidth, h: flow.clientHeight };
    paint();
    let target: DOMRect | null = null;
    if (flight.phase === "in") {
      const slot = flowRef.current?.querySelector<HTMLElement>(".book-slot.is-focus .book3d");
      target = slot?.getBoundingClientRect() ?? null;
    } else {
      target = originRect ?? null;
    }
    if (!target) {
      if (flight.phase === "in") setFlight(null);
      else onClose();
      return;
    }
    const from = flight.rect;
    const dx = target.left - from.left;
    const dy = target.top - from.top;
    const sx = target.width / Math.max(1, from.width);
    const sy = target.height / Math.max(1, from.height);
    const el = flightRef.current;
    const anim = el.animate(
      [
        { transform: "translate3d(0, 0, 0) scale(1)", opacity: 1 },
        { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${sx}, ${sy})`, opacity: 1 },
      ],
      {
        duration: flight.phase === "in" ? 520 : 440,
        easing: "cubic-bezier(0.22, 0.8, 0.24, 1)",
        fill: "forwards",
      },
    );
    anim.onfinish = () => {
      if (flight.phase === "in") {
        revealedRef.current = true;
        revealedAt.current = performance.now();
        setRevealed(true);
        window.setTimeout(() => setFlight(null), 120);
        kick();
      } else {
        onClose();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flight?.phase]);

  useEffect(() => {
    if (revealed || flight || closing) return;
    revealedRef.current = true;
    revealedAt.current = performance.now();
    setRevealed(true);
    kick();
  }, [closing, flight, kick, revealed]);

  useEffect(() => {
    if (flight?.phase !== "in") return;
    const id = window.setTimeout(() => {
      revealedRef.current = true;
      revealedAt.current = performance.now();
      setRevealed(true);
      window.setTimeout(() => setFlight(null), 120);
      kick();
    }, 860);
    return () => window.clearTimeout(id);
  }, [flight?.phase, kick]);

  // 舞台尺寸量好后再画第一帧，避免飞行目标落在未布局的位置。
  useLayoutEffect(() => {
    const flow = flowRef.current;
    if (flow) sizeRef.current = { w: flow.clientWidth, h: flow.clientHeight };
    paint();
    kick();
  }, [visible, paint, kick]);

  useEffect(() => {
    document.body.classList.add("stage-live");
    const onVisibility = () => {
      if (document.hidden && rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.body.classList.remove("stage-live");
      document.removeEventListener("visibilitychange", onVisibility);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.clearTimeout(wheelIdle.current);
    };
  }, []);

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (closing || entering) return;
    const flow = flowRef.current;
    if (!flow) return;
    const rect = flow.getBoundingClientRect();
    pointerRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top, active: true };
    const drag = dragRef.current;
    if (drag?.active) {
      const now = performance.now();
      const dt = Math.max(4, now - drag.lastT);
      const inst = (e.clientX - drag.lastX) / dt;
      drag.vx = drag.vx * 0.55 + inst * 0.45;
      drag.lastX = e.clientX;
      drag.lastT = now;
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 6) {
        drag.moved = true;
        if (!drag.captured) {
          drag.captured = true;
          try {
            flow.setPointerCapture(drag.pointerId);
          } catch {
            /* 指针捕获失败时仍然可以在舞台内拖动 */
          }
        }
      }
      targetRef.current = clamp(drag.startPos - dx / 196, 0, maxPos);
    }
    kick();
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || entering || closing) return;
    dragRef.current = {
      x: e.clientX,
      startPos: posRef.current,
      active: true,
      moved: false,
      captured: false,
      pointerId: e.pointerId,
      lastX: e.clientX,
      lastT: performance.now(),
      vx: 0,
    };
  };

  const endDrag = () => {
    const drag = dragRef.current;
    if (!drag?.active) return;
    dragRef.current = null;
    if (drag.captured) flowRef.current?.releasePointerCapture?.(drag.pointerId);
    if (drag.moved) {
      suppressClick.current = true;
      /* 松手时带一点投影：快速甩动会多滑半本到一本，慢拖则吸附到最近一本。 */
      const projected = posRef.current + (-drag.vx * 72) / 196;
      targetRef.current = clamp(Math.round(projected), 0, maxPos);
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 240);
      kick();
    }
  };

  const resetTilt = () => {
    pointerRef.current.active = false;
    kick();
  };

  useEffect(() => {
    const up = () => endDrag();
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 点击封面不是直接切页面：先把当前这枚被倾斜、被转到一边的封面转正，
   * 再用同一份封面素材向观察者推近，随后页面从它后面展开。
   */
  const enter = useCallback(() => {
    if (!focused || enteringRef.current || closing) return;
    const slot = slotRefs.current.get(focusRef.current);
    const el = slot?.querySelector<HTMLElement>(".book3d");
    if (!slot || !el) return;

    const rect = el.getBoundingClientRect();
    const state = tiltRef.current.get(focusRef.current) ?? { x: 0, y: 0 };
    const rot = 0; // 焦点位置的槽位转角为 0，倾斜来自 tilt 层
    const bw = el.offsetWidth || 234;
    const bh = el.offsetHeight || 336;
    const totalY = rot + state.y;

    enteringRef.current = true;
    setEntering(true);

    const ghost = document.createElement("div");
    ghost.className = "book-enter-ghost";
    ghost.style.width = `${bw}px`;
    ghost.style.height = `${bh}px`;
    ghost.style.left = `${rect.left + rect.width / 2}px`;
    ghost.style.top = `${rect.top + rect.height / 2}px`;

    const clone = el.cloneNode(true) as HTMLElement;
    clone.style.width = `${bw}px`;
    clone.style.height = `${bh}px`;
    clone.style.setProperty("--page-k", Math.min(1, Math.abs(Math.sin((totalY * Math.PI) / 180))).toFixed(3));
    clone.classList.toggle("spine-on", totalY > 3);
    clone.classList.toggle("pages-on", totalY < -3);
    ghost.appendChild(clone);
    document.body.appendChild(ghost);

    const sx = clamp(rect.width / Math.max(1, bw), 0.74, 1.18);
    const cx = window.innerWidth / 2 - (rect.left + rect.width / 2);
    const cy = window.innerHeight * 0.5 - (rect.top + rect.height / 2);
    const anim = ghost.animate(
      [
        {
          transform: `translate(-50%, -50%) rotateX(${state.x.toFixed(2)}deg) rotateY(${totalY.toFixed(2)}deg) scale(${sx.toFixed(3)})`,
          opacity: 1,
          offset: 0,
          easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
        },
        {
          transform: `translate(-50%, -50%) translate3d(${cx.toFixed(1)}px, ${cy.toFixed(1)}px, 0) rotateX(0deg) rotateY(0deg) scale(1.08)`,
          opacity: 1,
          offset: 0.36,
        },
        {
          transform: `translate(-50%, -50%) translate3d(${cx.toFixed(1)}px, ${cy.toFixed(1)}px, 0) rotateX(0deg) rotateY(0deg) scale(1.08)`,
          opacity: 1,
          offset: 0.68,
        },
        {
          transform: `translate(-50%, -50%) translate3d(${cx.toFixed(1)}px, ${cy.toFixed(1)}px, 0) rotateX(0deg) rotateY(0deg) scale(1.34)`,
          opacity: 0,
          offset: 1,
          easing: "cubic-bezier(0.55, 0.06, 0.68, 0.19)",
        },
      ],
      { duration: 720, easing: "linear", fill: "forwards" },
    );

    window.setTimeout(() => onEnter(focused), 280);
    window.setTimeout(() => {
      anim.cancel();
      ghost.remove();
    }, 900);
  }, [closing, focused, onEnter]);
  enterRef.current = enter;

  return (
    <div
      ref={stageRef}
      className={`book-focus${entering ? " entering" : ""}${closing ? " closing" : ""}${revealed ? "" : " is-revealing"}`}
      role="dialog"
      aria-modal="true"
      aria-label={t("书架")}
      onPointerLeave={resetTilt}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div className="book-focus-top">
        <div className="book-focus-brand">
          <span>{t("书架")}</span>
          <em>
            {books.length} {t("本")}
          </em>
        </div>
        <span className="book-focus-welcome">{t("拖拽、滚轮或方向键切换；再点一次封面进入写作")}</span>
        <button className="icon-btn" onClick={requestClose} title={t("返回工作台")}>
          <Icon name="close" size={17} />
        </button>
      </div>

      <div
        className="book-stage-body"
        onPointerMove={onPointerMove}
        onPointerLeave={resetTilt}
      >
        <div className="book-stage-floor" aria-hidden="true" />
        {count > 1 && (
          <button
            className="book-step is-prev"
            type="button"
            disabled={focus <= 0}
            onClick={() => glideTo(focusRef.current - 1)}
            aria-label={t("上一本")}
            title={t("上一本")}
          >
            <Icon name="arrow" size={16} />
          </button>
        )}

        <div
          ref={flowRef}
          className="book-flow"
          onPointerDown={onPointerDown}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {visible.map(({ b, i }) => {
            const isFocus = i === focus;
            return (
              <div
                key={b.path}
                ref={(el) => {
                  if (el) slotRefs.current.set(i, el);
                  else slotRefs.current.delete(i);
                }}
                data-stage-book={i}
                className={`book-slot${isFocus ? " is-focus" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    return;
                  }
                  if (enteringRef.current || closing) return;
                  if (i === focusRef.current) void enter();
                  else glideTo(i);
                }}
              >
                <div
                  ref={(el) => {
                    if (el) tiltEls.current.set(i, el);
                    else tiltEls.current.delete(i);
                  }}
                  className="book-tilt"
                >
                  <BookObject book={b} coverUrl={coverFor(b, covers)} />
                </div>
              </div>
            );
          })}
        </div>

        {count > 1 && (
          <button
            className="book-step is-next"
            type="button"
            disabled={focus >= maxPos}
            onClick={() => glideTo(focusRef.current + 1)}
            aria-label={t("下一本")}
            title={t("下一本")}
          >
            <Icon name="arrow" size={16} />
          </button>
        )}

        {focused && (
          <div className="book-focus-info" key={focused.path}>
            <h2>{focused.title}</h2>
            <p>
              {focused.author || t("佚名")} · {focused.chapterCount} {t("章")} · {fmtWords(focused.words)}{" "}
              {t("字")}
            </p>
            <div className="book-focus-meta">
              <span>
                {t("书脊厚度")} {spineDepth(focused.words)}px
              </span>
              <span>
                {t("最近更新")} {new Date(focused.updatedAt).toLocaleDateString("zh-CN")}
              </span>
            </div>
            <button
              className="btn btn-primary book-focus-enter"
              onClick={() => void enter()}
              disabled={entering}
            >
              {t("进入这本书")}
              <Icon name="arrow" size={14} />
            </button>
          </div>
        )}
      </div>

      <div className={`book-focus-dots${count > 12 ? " is-rail" : ""}`} aria-label={t("书架")}>
        {count <= 12 ? (
          books.map((b, i) => (
            <button
              key={b.path}
              type="button"
              className={i === focus ? "on" : ""}
              onClick={() => jumpTo(i)}
              aria-label={b.title}
              title={b.title}
            />
          ))
        ) : (
          <>
            <span className="book-dot-count">
              <b>{pad2(focus + 1)}</b>
              <em>/ {count}</em>
            </span>
            <span className="book-dot-rail">
              <i ref={dotThumbRef} />
            </span>
          </>
        )}
      </div>

      {flight && focused && (
        <div
          ref={flightRef}
          className="book-flight-cover"
          style={{
            left: flight.rect.left,
            top: flight.rect.top,
            width: flight.rect.width,
            height: flight.rect.height,
          }}
          aria-hidden="true"
        >
          <NovelCover
            title={focused.title}
            author={focused.author}
            coverUrl={coverFor(focused, covers)}
            template={focused.coverStyle}
            loading="eager"
          />
        </div>
      )}
    </div>
  );
}
