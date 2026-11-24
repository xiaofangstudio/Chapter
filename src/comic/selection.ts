/**
 * 漫画选区：与格同尺寸的 alpha 遮罩。
 *
 * 0 未选中，255 全选中。画笔、橡皮和填充都按同一张遮罩裁切，
 * 所以“框选后只在框里画”不需要各工具各写一套判断。
 */
import { cloneSurface, createSurface, mustCtx, readPixels } from "../lib/paint/surface";

export interface Point {
  x: number;
  y: number;
}

export interface SelectionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SelectionMode = "new" | "add" | "subtract";

export function createSelectionMask(width: number, height: number): HTMLCanvasElement {
  return createSurface(width, height);
}

export function rectMask(
  width: number,
  height: number,
  a: Point,
  b: Point,
): HTMLCanvasElement {
  const mask = createSelectionMask(width, height);
  const ctx = mustCtx(mask);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(
    Math.min(a.x, b.x),
    Math.min(a.y, b.y),
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
  );
  return mask;
}

export function lassoMask(
  width: number,
  height: number,
  points: Point[],
): HTMLCanvasElement {
  const mask = createSelectionMask(width, height);
  if (points.length < 3) return mask;
  const ctx = mustCtx(mask);
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
  ctx.fill();
  return mask;
}

/** 魔棒：按四通道色差容差取连通区；与填充使用同一套判定。 */
export function wandMask(
  surface: HTMLCanvasElement,
  seed: Point,
  tolerance: number,
  contiguous = true,
): HTMLCanvasElement | null {
  const w = surface.width;
  const h = surface.height;
  const x0 = Math.floor(seed.x);
  const y0 = Math.floor(seed.y);
  if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return null;

  const src = readPixels(surface).data;
  const at = (x: number, y: number) => (y * w + x) * 4;
  const s = at(x0, y0);
  const sr = src[s];
  const sg = src[s + 1];
  const sb = src[s + 2];
  const sa = src[s + 3];
  const tol = Math.max(0, tolerance) * tolerance * 4;
  const near = (i: number) => {
    const dr = src[i] - sr;
    const dg = src[i + 1] - sg;
    const db = src[i + 2] - sb;
    const da = src[i + 3] - sa;
    return dr * dr + dg * dg + db * db + da * da <= tol;
  };

  const mask = createSelectionMask(w, h);
  const out = readPixels(mask);
  const od = out.data;

  if (!contiguous) {
    for (let p = 0; p < w * h; p += 1) {
      if (!near(p * 4)) continue;
      const i = p * 4;
      od[i] = 255;
      od[i + 1] = 255;
      od[i + 2] = 255;
      od[i + 3] = 255;
    }
    mustCtx(mask).putImageData(out, 0, 0);
    return mask;
  }

  const visited = new Uint8Array(w * h);
  const stack: number[] = [x0, y0];
  while (stack.length > 0) {
    const y = stack.pop() as number;
    const x = stack.pop() as number;
    let left = x;
    while (left >= 0 && !visited[y * w + left] && near(at(left, y))) left -= 1;
    left += 1;
    let right = x;
    while (right < w && !visited[y * w + right] && near(at(right, y))) right += 1;
    right -= 1;
    for (let i = left; i <= right; i += 1) {
      visited[y * w + i] = 1;
      const p = (y * w + i) * 4;
      od[p] = 255;
      od[p + 1] = 255;
      od[p + 2] = 255;
      od[p + 3] = 255;
      if (y > 0 && !visited[(y - 1) * w + i] && near(at(i, y - 1))) stack.push(i, y - 1);
      if (y < h - 1 && !visited[(y + 1) * w + i] && near(at(i, y + 1))) stack.push(i, y + 1);
    }
  }
  mustCtx(mask).putImageData(out, 0, 0);
  return mask;
}

export function combineSelection(
  base: HTMLCanvasElement | null,
  shape: HTMLCanvasElement,
  mode: SelectionMode,
): HTMLCanvasElement {
  if (!base || mode === "new" || base.width !== shape.width || base.height !== shape.height) {
    return cloneSurface(shape);
  }
  const out = cloneSurface(base);
  const ctx = mustCtx(out);
  ctx.globalCompositeOperation = mode === "add" ? "source-over" : "destination-out";
  ctx.drawImage(shape, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  return out;
}

/** 形态学膨胀：选区向外扩 radius 像素。 */
export function expandSelection(mask: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  if (radius <= 0) return cloneSurface(mask);
  const out = createSelectionMask(mask.width, mask.height);
  const ctx = mustCtx(out);
  const steps = Math.max(8, Math.ceil(radius * 4));
  ctx.globalCompositeOperation = "lighter";
  ctx.drawImage(mask, 0, 0);
  for (let i = 0; i < steps; i += 1) {
    const a = (i / steps) * Math.PI * 2;
    ctx.drawImage(mask, Math.round(Math.cos(a) * radius), Math.round(Math.sin(a) * radius));
  }
  ctx.globalCompositeOperation = "source-over";
  return out;
}

export function isSelectionEmpty(mask: HTMLCanvasElement | null): boolean {
  if (!mask) return true;
  const { data } = readPixels(mask);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) return false;
  }
  return true;
}

export function selectionBounds(mask: HTMLCanvasElement | null): SelectionBounds | null {
  if (!mask) return null;
  const w = mask.width;
  const h = mask.height;
  const { data } = readPixels(mask);
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (data[(y * w + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** 选区范围色块：给画布叠一层很淡的橙色，用户一眼能看出选中的是哪块。 */
export function selectionTint(mask: HTMLCanvasElement, color = "#d15a2f"): HTMLCanvasElement {
  const tint = createSurface(mask.width, mask.height);
  const ctx = mustCtx(tint);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, tint.width, tint.height);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(mask, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  return tint;
}
