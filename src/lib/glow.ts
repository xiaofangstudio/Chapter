import { useEffect } from "react";

const GLOW_SELECTOR = [
  ".glow-card",
  ".book-card",
  ".panel-card",
  ".ocard",
  ".lcard",
  ".fmt-card",
  ".empty-shelf",
  ".ch-row",
  ".vol-row",
  ".recent-row",
  ".import-row",
  ".intro-chapter",
  ".intro-volume-head",
  ".wb-book-card",
  ".wb-calendar",
  ".wb-today",
  ".wb-book-stage",
  ".dash-hero",
  ".dash-current",
  ".dash-calendar",
  ".dash-habit",
  ".dash-recent",
  ".lore-card",
  ".outline-card",
  ".scene-card",
  ".snapshot-row",
  ".paper-pick",
  ".accent-pick",
  ".spine-swatch",
  ".set-nav-item",
  ".set-tool-card",
].join(",");

interface GlowItem {
  el: HTMLElement;
  rect: DOMRect;
  lit: boolean;
  aura: HTMLElement | null;
}

/**
 * 光标是一盏藏在界面里的灯：卡片离它越近，外圈越亮。
 *
 * 性能约定：pointermove 不触发 React 渲染；矩形只在滚动、尺寸变化或界面结构
 * 变化时批量重算。常驻/流动模式不写丝带坐标，避免每帧让整棵背景重算样式。
 */
export function useProximityGlow() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const root = document.documentElement;
    let stopped = false;
    let raf = 0;
    let paintTimer = 0;
    let scanTimer = 0;
    let scrollTimer = 0;
    let scrolling = false;
    let lastPaint = -1000;
    let tx = window.innerWidth / 2;
    let ty = window.innerHeight / 2;
    let cx = tx;
    let cy = ty;
    let items: GlowItem[] = [];

    const aura = document.createElement("div");
    aura.className = "cursor-aura";
    aura.setAttribute("aria-hidden", "true");
    document.body.appendChild(aura);

    const spot = document.querySelector<HTMLElement>(".spot-glow");
    const setSpot = (x: number, y: number) => {
      if (!spot || root.dataset.lightEffect !== "spot") return;
      const dx = x - window.innerWidth / 2;
      const dy = y - window.innerHeight / 2;
      spot.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0)`;
      root.style.setProperty("--light-x", `${x.toFixed(0)}px`);
      root.style.setProperty("--light-y", `${y.toFixed(0)}px`);
    };
    setSpot(cx, cy);

    const motionAllows = () => root.dataset.motion !== "off";

    const scan = () => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(GLOW_SELECTOR)).slice(0, 260);
      items = nodes
        .filter((el) => !el.closest(".book-focus"))
        .map((el) => ({
          el,
          rect: el.getBoundingClientRect(),
          lit: el.dataset.nearOn === "1",
          aura: el.querySelector<HTMLElement>(".near-aura"),
        }));
    };

    const scheduleScan = () => {
      if (scanTimer) return;
      scanTimer = window.setTimeout(() => {
        scanTimer = 0;
        if (!stopped) scan();
      }, 180);
    };

    const paint = (time: number) => {
      paintTimer = 0;
      if (stopped || scrolling || time - lastPaint < 90 || !motionAllows()) return;
      lastPaint = time;
      for (const item of items) {
        const { el, rect } = item;
        if (rect.width < 20 || rect.height < 16) continue;
        if (rect.bottom < -80 || rect.top > window.innerHeight + 80) {
          if (item.lit) {
            el.style.setProperty("--near", "0");
            el.dataset.nearOn = "0";
            item.lit = false;
          }
          continue;
        }
        const dx = Math.max(rect.left - tx, 0, tx - rect.right);
        const dy = Math.max(rect.top - ty, 0, ty - rect.bottom);
        const dist = Math.hypot(dx, dy);
        const near = Math.max(0, 1 - dist / 170);
        if (near < 0.02) {
          if (item.lit) {
            el.style.setProperty("--near", "0");
            el.dataset.nearOn = "0";
            item.lit = false;
          }
          continue;
        }
        if (!item.aura) {
          if (getComputedStyle(el).position === "static") el.style.position = "relative";
          item.aura = document.createElement("span");
          item.aura.className = "near-aura";
          item.aura.setAttribute("aria-hidden", "true");
          el.appendChild(item.aura);
        }
        item.lit = true;
        el.dataset.nearOn = "1";
        el.style.setProperty("--near", near.toFixed(3));
        el.style.setProperty("--gx", `${Math.round(tx - rect.left)}px`);
        el.style.setProperty("--gy", `${Math.round(ty - rect.top)}px`);
      }
    };

    const schedulePaint = () => {
      if (paintTimer || !motionAllows()) return;
      paintTimer = window.setTimeout(() => paint(performance.now()), 16);
    };

    const loop = () => {
      raf = 0;
      if (stopped) return;
      const ease = reduce ? 1 : 0.34;
      cx += (tx - cx) * ease;
      cy += (ty - cy) * ease;
      aura.style.transform = `translate3d(${(cx - 260).toFixed(1)}px, ${(cy - 260).toFixed(1)}px, 0)`;
      setSpot(cx, cy);
      if (Math.abs(tx - cx) > 0.4 || Math.abs(ty - cy) > 0.4) raf = requestAnimationFrame(loop);
    };

    const onMove = (e: PointerEvent) => {
      tx = e.clientX;
      ty = e.clientY;
      if (!raf && !reduce) raf = requestAnimationFrame(loop);
      if (reduce) {
        cx = tx;
        cy = ty;
        aura.style.transform = `translate3d(${(cx - 260).toFixed(1)}px, ${(cy - 260).toFixed(1)}px, 0)`;
        setSpot(cx, cy);
      }
      schedulePaint();
    };
    const onScroll = () => {
      // 滚动期间不做矩形扫描和卡片重绘；长文滚动最怕每一帧被强制布局打断。
      scrolling = true;
      window.clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(() => {
        scrolling = false;
        scheduleScan();
        schedulePaint();
      }, 240);
    };
    const onLeave = () => {
      aura.style.opacity = "0";
      tx = -1000;
      ty = -1000;
      if (spot) spot.style.transform = "translate3d(-120vw, -120vh, 0)";
      root.style.setProperty("--light-x", "-100vw");
      root.style.setProperty("--light-y", "-100vh");
      schedulePaint();
    };
    const onEnter = () => {
      aura.style.opacity = reduce ? "0.3" : "0.52";
    };
    const onResize = () => {
      if (tx > 0 && ty > 0) {
        tx = Math.min(tx, window.innerWidth);
        ty = Math.min(ty, window.innerHeight);
      }
      scheduleScan();
      schedulePaint();
      setSpot(cx, cy);
    };
    const onVisibility = () => {
      if (document.hidden && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    aura.style.opacity = "0.52";
    scan();
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    window.addEventListener("resize", onResize, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    document.addEventListener("pointerenter", onEnter);
    document.addEventListener("visibilitychange", onVisibility);
    const observer = new MutationObserver((records) => {
      const structural = records.some((r) => {
        for (const n of r.addedNodes) {
          if (n instanceof HTMLElement && n.classList.contains("near-aura")) return false;
        }
        return true;
      });
      if (structural) scheduleScan();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      stopped = true;
      window.clearTimeout(paintTimer);
      window.clearTimeout(scanTimer);
      window.clearTimeout(scrollTimer);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("pointerenter", onEnter);
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
      aura.remove();
    };
  }, []);
}
