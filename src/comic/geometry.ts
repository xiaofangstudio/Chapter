import type { ComicFrame } from "./types";

export interface Pt {
  x: number;
  y: number;
}

/** 分格在当前页面坐标里的四边形顶点。矩形也统一返回四个点。 */
export function framePolygon(frame: ComicFrame): Pt[] {
  if (frame.shape === "quad" && frame.points && frame.points.length >= 3) {
    return frame.points.map(([x, y]) => ({
      x: frame.x + x * frame.w,
      y: frame.y + y * frame.h,
    }));
  }
  return [
    { x: frame.x, y: frame.y },
    { x: frame.x + frame.w, y: frame.y },
    { x: frame.x + frame.w, y: frame.y + frame.h },
    { x: frame.x, y: frame.y + frame.h },
  ];
}

/** 射线法；凹四边形同样适用。 */
export function pointInPolygon(point: Pt, polygon: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const dy = b.y - a.y;
    if (
      a.y > point.y !== b.y > point.y &&
      Math.abs(dy) > 1e-9 &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / dy + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

export function pointInFrame(frame: ComicFrame, point: Pt): boolean {
  if (frame.shape !== "quad" || !frame.points) {
    return (
      point.x >= frame.x &&
      point.x <= frame.x + frame.w &&
      point.y >= frame.y &&
      point.y <= frame.y + frame.h
    );
  }
  return pointInPolygon(point, framePolygon(frame));
}

/** 把四边形放到 canvas 坐标系里，并按需要缩放/平移。 */
export function polygonPath(
  ctx: CanvasRenderingContext2D,
  frame: ComicFrame,
  scale = 1,
  ox = 0,
  oy = 0,
): void {
  const points = framePolygon(frame);
  ctx.beginPath();
  points.forEach((p, index) => {
    const x = p.x * scale + ox;
    const y = p.y * scale + oy;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
}

export function clipFrame(
  ctx: CanvasRenderingContext2D,
  frame: ComicFrame,
  scale = 1,
  ox = 0,
  oy = 0,
): void {
  if (frame.shape === "none") {
    ctx.beginPath();
    ctx.rect(
      frame.x * scale + ox,
      frame.y * scale + oy,
      frame.w * scale,
      frame.h * scale,
    );
    return;
  }
  if (frame.shape === "quad" && frame.points) {
    polygonPath(ctx, frame, scale, ox, oy);
    return;
  }
  const fx = frame.x * scale + ox;
  const fy = frame.y * scale + oy;
  const fw = frame.w * scale;
  const fh = frame.h * scale;
  const r = Math.min(12, fw / 2, fh / 2);
  ctx.beginPath();
  ctx.moveTo(fx + r, fy);
  ctx.arcTo(fx + fw, fy, fx + fw, fy + fh, r);
  ctx.arcTo(fx + fw, fy + fh, fx, fy + fh, r);
  ctx.arcTo(fx, fy + fh, fx, fy, r);
  ctx.arcTo(fx, fy, fx + fw, fy, r);
  ctx.closePath();
}

function segCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const cross = (p: Pt, q: Pt, r: Pt) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function normalizeQuad(points: Pt[]): {
  x: number;
  y: number;
  w: number;
  h: number;
  points: [number, number][];
} | null {
  if (points.length !== 4) return null;
  if (segCross(points[0], points[1], points[2], points[3]) || segCross(points[1], points[2], points[3], points[0])) {
    return null;
  }
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const w = Math.max(...xs) - x;
  const h = Math.max(...ys) - y;
  if (w < 80 || h < 80) return null;
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  if (Math.abs(area) / 2 < 4000) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(w),
    h: Math.round(h),
    points: points.map((p) => [
      Number(((p.x - x) / w).toFixed(4)),
      Number(((p.y - y) / h).toFixed(4)),
    ]),
  };
}

export function polygonCenter(frame: ComicFrame): Pt {
  const points = framePolygon(frame);
  return points.reduce(
    (acc, p) => ({ x: acc.x + p.x / points.length, y: acc.y + p.y / points.length }),
    { x: 0, y: 0 },
  );
}

/* ───────── 磁吸辅助 ───────── */

export interface SnapGuides {
  x: number[];
  y: number[];
}

function nearestDelta(value: number, targets: number[], threshold: number): number | null {
  let best: number | null = null;
  for (const target of targets) {
    const delta = target - value;
    if (Math.abs(delta) <= threshold && (best === null || Math.abs(delta) < Math.abs(best))) {
      best = delta;
    }
  }
  return best;
}

/** 矩形四边分别吸附到附近坐标；整格移动/缩放共用。 */
export function snapRect(
  rect: { x: number; y: number; w: number; h: number },
  targetXs: number[],
  targetYs: number[],
  threshold = 12,
): { rect: { x: number; y: number; w: number; h: number }; guides: SnapGuides } {
  const dxLeft = nearestDelta(rect.x, targetXs, threshold);
  const dxRight = nearestDelta(rect.x + rect.w, targetXs, threshold);
  let dx = 0;
  if (dxLeft !== null && (dxRight === null || Math.abs(dxLeft) <= Math.abs(dxRight))) dx = dxLeft;
  else if (dxRight !== null) dx = dxRight;
  const dyTop = nearestDelta(rect.y, targetYs, threshold);
  const dyBottom = nearestDelta(rect.y + rect.h, targetYs, threshold);
  let dy = 0;
  if (dyTop !== null && (dyBottom === null || Math.abs(dyTop) <= Math.abs(dyBottom))) dy = dyTop;
  else if (dyBottom !== null) dy = dyBottom;
  const nx = rect.x + dx;
  const ny = rect.y + dy;
  return {
    rect: { ...rect, x: nx, y: ny },
    guides: {
      x: [nx, nx + rect.w].filter((v) =>
        targetXs.some((t) => Math.abs(t - v) <= 0.5),
      ),
      y: [ny, ny + rect.h].filter((v) =>
        targetYs.some((t) => Math.abs(t - v) <= 0.5),
      ),
    },
  };
}

/** 点吸附到附近横纵坐标。 */
export function snapPoint(
  point: Pt,
  targetXs: number[],
  targetYs: number[],
  threshold = 12,
): { point: Pt; guides: SnapGuides } {
  const dx = nearestDelta(point.x, targetXs, threshold) ?? 0;
  const dy = nearestDelta(point.y, targetYs, threshold) ?? 0;
  return {
    point: { x: point.x + dx, y: point.y + dy },
    guides: {
      x: Math.abs(dx) > 0 ? [point.x + dx] : [],
      y: Math.abs(dy) > 0 ? [point.y + dy] : [],
    },
  };
}

/**
 * 让点落在过 pivot、与某条已有边平行的射线上。
 * 用于拖四边形角点：当新边接近另一格某条边或 0/45/90° 时吸附。
 */
export function snapPointToParallel(
  point: Pt,
  pivot: Pt,
  directions: Pt[],
  threshold = 10,
): { point: Pt; guide: Pt | null } {
  let best: { point: Pt; dir: Pt; dist: number } | null = null;
  for (const raw of directions) {
    const len = Math.hypot(raw.x, raw.y);
    if (len < 1e-6) continue;
    const dir = { x: raw.x / len, y: raw.y / len };
    const vx = point.x - pivot.x;
    const vy = point.y - pivot.y;
    const along = vx * dir.x + vy * dir.y;
    if (along <= 0) continue;
    const proj = { x: pivot.x + dir.x * along, y: pivot.y + dir.y * along };
    const dist = Math.hypot(point.x - proj.x, point.y - proj.y);
    if (dist <= threshold && (best === null || dist < best.dist)) {
      best = { point: proj, dir, dist };
    }
  }
  if (!best) return { point, guide: null };
  return {
    point: { x: best.point.x, y: best.point.y },
    guide: { x: best.dir.x * 400, y: best.dir.y * 400 },
  };
}

/** 页内常见参考线。 */
export function referenceTargets(
  page: { width: number; height: number },
  others: { x: number; y: number; w: number; h: number }[],
): { xs: number[]; ys: number[]; dirs: Pt[] } {
  const xs = [0, page.width / 2, page.width];
  const ys = [0, page.height / 2, page.height];
  const dirs: Pt[] = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
    { x: 1, y: -1 },
  ];
  for (const r of others) {
    xs.push(r.x, r.x + r.w / 2, r.x + r.w);
    ys.push(r.y, r.y + r.h / 2, r.y + r.h);
    dirs.push({ x: r.w, y: 0 }, { x: 0, y: r.h }, { x: r.w, y: r.h }, { x: r.w, y: -r.h });
  }
  return { xs, ys, dirs };
}
