import type { ComicBlendMode } from "../../comic/types";
import { cloneSurface, createSurface, mustCtx, readPixels } from "./surface";

/** 画世界 Pro 式滤镜入口；全部在本地 Canvas 上跑，不联网。 */
export type ComicFilterId =
  | "adjust"
  | "hue"
  | "blur"
  | "invert"
  | "edges"
  | "luma-alpha";

export interface ComicFilterOptions {
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number;
  blur: number;
}

export const DEFAULT_FILTER_OPTIONS: ComicFilterOptions = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  hue: 0,
  blur: 6,
};

function cssFilter(id: ComicFilterId, opts: ComicFilterOptions): string {
  if (id === "blur") return `blur(${Math.max(0, opts.blur)}px)`;
  if (id === "invert") return "invert(1)";
  if (id === "hue") return `hue-rotate(${Math.round(opts.hue)}deg)`;
  return `brightness(${100 + opts.brightness}%) contrast(${100 + opts.contrast}%) saturate(${100 + opts.saturation}%)`;
}

/** 返回一张新画布；mask 非空时只改选区里的像素。 */
export function applyComicFilter(
  source: HTMLCanvasElement,
  id: ComicFilterId,
  opts: ComicFilterOptions,
  mask?: HTMLCanvasElement | null,
): HTMLCanvasElement {
  const out = createSurface(source.width, source.height);
  const ctx = mustCtx(out);

  if (id === "edges") {
    drawEdges(source, out);
  } else if (id === "luma-alpha") {
    drawLumaAlpha(source, out);
  } else {
    ctx.filter = cssFilter(id, opts);
    ctx.drawImage(source, 0, 0);
    ctx.filter = "none";
  }

  if (!mask) return out;

  // 只改选区：先把原图在选区内挖空，再把「滤镜结果 ∩ 选区」贴回去。
  const result = cloneSurface(source);
  const rctx = mustCtx(result);
  rctx.globalCompositeOperation = "destination-out";
  rctx.drawImage(mask, 0, 0);
  const masked = createSurface(source.width, source.height);
  const mctx = mustCtx(masked);
  mctx.drawImage(out, 0, 0);
  mctx.globalCompositeOperation = "destination-in";
  mctx.drawImage(mask, 0, 0);
  rctx.globalCompositeOperation = "source-over";
  rctx.drawImage(masked, 0, 0);
  return result;
}

/** 用滤镜结果整体替换目标图层内容，保持同一张 canvas（历史/缓存都认它）。 */
export function replaceSurface(target: HTMLCanvasElement, source: HTMLCanvasElement): void {
  const ctx = mustCtx(target);
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.drawImage(source, 0, 0, target.width, target.height);
  ctx.restore();
}

function drawEdges(source: HTMLCanvasElement, out: HTMLCanvasElement): void {
  const w = source.width;
  const h = source.height;
  const src = readPixels(source).data;
  const dst = readPixels(out);
  const d = dst.data;
  const lum = (i: number) => {
    const a = src[i + 3] / 255;
    // 透明区按白纸算，避免整块透明层被当成一条边。
    return (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) * a + 255 * (1 - a);
  };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const xl = x > 0 ? (y * w + x - 1) * 4 : i;
      const xr = x < w - 1 ? (y * w + x + 1) * 4 : i;
      const yt = y > 0 ? ((y - 1) * w + x) * 4 : i;
      const yb = y < h - 1 ? ((y + 1) * w + x) * 4 : i;
      const dx = lum(xr) - lum(xl);
      const dy = lum(yb) - lum(yt);
      const strength = Math.min(255, Math.round(Math.hypot(dx, dy) * 1.7));
      if (strength < 10) continue;
      d[i] = 20;
      d[i + 1] = 20;
      d[i + 2] = 24;
      d[i + 3] = strength;
    }
  }
  mustCtx(out).putImageData(dst, 0, 0);
}

function drawLumaAlpha(source: HTMLCanvasElement, out: HTMLCanvasElement): void {
  const src = readPixels(source);
  const d = src.data;
  for (let i = 0; i < d.length; i += 4) {
    const alpha = d[i + 3];
    if (alpha === 0) continue;
    const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    d[i + 3] = Math.round((alpha * (255 - lum)) / 255);
  }
  mustCtx(out).putImageData(src, 0, 0);
}

/** 图层混合模式 → Canvas 2D 合成算子。不支持的少数模式用最接近的算子。 */
export function blendOperation(mode?: ComicBlendMode): GlobalCompositeOperation {
  switch (mode) {
    case "multiply":
      return "multiply";
    case "screen":
      return "screen";
    case "overlay":
      return "overlay";
    case "darken":
      return "darken";
    case "lighten":
      return "lighten";
    case "color-dodge":
      return "color-dodge";
    case "color-burn":
      return "color-burn";
    case "hard-light":
      return "hard-light";
    case "soft-light":
      return "soft-light";
    case "difference":
      return "difference";
    case "hue":
      return "hue";
    case "saturation":
      return "saturation";
    case "color":
      return "color";
    case "luminosity":
      return "luminosity";
    case "linear-burn":
    case "pin-light":
      return "color-burn";
    case "linear-dodge":
      return "color-dodge";
    case "linear-light":
    case "hard-mix":
      return "hard-light";
    default:
      return "source-over";
  }
}
