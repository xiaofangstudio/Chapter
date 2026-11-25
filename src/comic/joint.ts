import { clipFrame, framePolygon, pointInFrame } from "./geometry";
import type { ComicFrame, ComicJointLayer } from "./types";
import { createSurface, mustCtx } from "../lib/paint/surface";

/** 多格并集的外接矩形，页面坐标。 */
export function jointRect(frames: ComicFrame[]): { x: number; y: number; w: number; h: number } | null {
  if (!frames.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const frame of frames) {
    for (const point of framePolygon(frame)) {
      x0 = Math.min(x0, point.x);
      y0 = Math.min(y0, point.y);
      x1 = Math.max(x1, point.x);
      y1 = Math.max(y1, point.y);
    }
  }
  if (!Number.isFinite(x0) || x1 <= x0 || y1 <= y0) return null;
  return {
    x: Math.floor(x0),
    y: Math.floor(y0),
    w: Math.ceil(x1 - x0),
    h: Math.ceil(y1 - y0),
  };
}

/** 给现有绘制流程用的虚拟格；不对应 page.frames 里的真实格。 */
export function jointFrameOf(layer: ComicJointLayer): ComicFrame {
  return {
    id: layer.id,
    x: layer.rect.x,
    y: layer.rect.y,
    w: layer.rect.w,
    h: layer.rect.h,
    shape: "rect",
    rotation: 0,
    overflow: true,
    layers: [
      {
        id: layer.id,
        name: layer.name,
        kind: "raster",
        visible: layer.visible,
        opacity: layer.opacity,
        locked: layer.locked,
        blendMode: layer.blendMode,
      },
    ],
  };
}

/** 在并集包围盒内建一张遮罩：关=只保留各格并集；开=并集+相邻格缝桥。 */
export function buildJointMask(
  frames: ComicFrame[],
  rect: { x: number; y: number; w: number; h: number },
  crossPanel: boolean,
  maxGap = 160,
): HTMLCanvasElement {
  const mask = createSurface(rect.w, rect.h);
  const ctx = mustCtx(mask);
  ctx.fillStyle = "#fff";

  for (const frame of frames) {
    ctx.save();
    clipFrame(ctx, frame, 1, -rect.x, -rect.y);
    ctx.fill();
    ctx.restore();
  }

  if (!crossPanel || frames.length < 2) return mask;

  // 用“膨胀后相交”找格缝桥：比按外接矩形补洞可靠，四边形斜边也能连上。
  // 只在两格之间生成交集，不会把整张画布外圈也扩大。
  // 只连接最近格距在 maxGap 以内的格对，再按 maxGap 膨胀，斜缝两侧也一起铺白。
  const pad = maxGap;
  for (let i = 0; i < frames.length; i += 1) {
    for (let k = i + 1; k < frames.length; k += 1) {
      if (polygonGap(frames[i], frames[k]) > maxGap) continue;
      const a = frameDilation(frames[i], rect, pad);
      const b = frameDilation(frames[k], rect, pad);
      const actx = mustCtx(a);
      actx.globalCompositeOperation = "destination-in";
      actx.drawImage(b, 0, 0);
      actx.globalCompositeOperation = "source-over";
      ctx.drawImage(a, 0, 0);
    }
  }
  return mask;
}

function polygonGap(a: ComicFrame, b: ComicFrame): number {
  const pa = framePolygon(a);
  const pb = framePolygon(b);
  if (pa.some((point) => pointInFrame(b, point))) return 0;
  if (pb.some((point) => pointInFrame(a, point))) return 0;
  let best = Infinity;
  for (let i = 0; i < pa.length; i += 1) {
    const a1 = pa[i];
    const a2 = pa[(i + 1) % pa.length];
    for (let k = 0; k < pb.length; k += 1) {
      const b1 = pb[k];
      const b2 = pb[(k + 1) % pb.length];
      best = Math.min(
        best,
        pointSegmentDistance(a1, b1, b2),
        pointSegmentDistance(a2, b1, b2),
        pointSegmentDistance(b1, a1, a2),
        pointSegmentDistance(b2, a1, a2),
      );
    }
  }
  return best;
}

function pointSegmentDistance(
  point: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  if (!len) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / len));
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

function frameDilation(
  frame: ComicFrame,
  rect: { x: number; y: number; w: number; h: number },
  pad: number,
): HTMLCanvasElement {
  const mask = createSurface(rect.w, rect.h);
  const ctx = mustCtx(mask);
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#fff";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = pad * 2;
  const points = framePolygon(frame);
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = point.x - rect.x;
    const y = point.y - rect.y;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  return mask;
}

/** 打开跨格后，遮罩里是否真的多出了“格缝桥”（落在所有格之外的像素）。 */
export function jointGapBridged(
  frames: ComicFrame[],
  rect: { x: number; y: number; w: number; h: number },
  maxGap = 160,
): boolean {
  if (frames.length < 2) return false;
  const mask = buildJointMask(frames, rect, true, maxGap);
  const data = mustCtx(mask).getImageData(0, 0, mask.width, mask.height).data;
  const step = 8;
  for (let y = 0; y < mask.height; y += step) {
    for (let x = 0; x < mask.width; x += step) {
      if (data[(y * mask.width + x) * 4 + 3] === 0) continue;
      const point = { x: rect.x + x, y: rect.y + y };
      if (!frames.some((frame) => pointInFrame(frame, point))) return true;
    }
  }
  return false;
}

/** 只读一个像素，判断点是否落在并集/格缝可画区。 */
export function maskHasPoint(mask: HTMLCanvasElement, x: number, y: number): boolean {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) return false;
  return mustCtx(mask).getImageData(px, py, 1, 1).data[3] > 0;
}
