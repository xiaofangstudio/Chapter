import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type * as React from "react";
import { createPortal } from "react-dom";
import type { BookMeta } from "../types";
import { api } from "../lib/api";
import {
  DEFAULT_BRUSH,
  drawBrushTipSample,
  Stroke,
  type BrushSettings,
} from "../lib/paint/paint";
import { BrushStudio } from "./BrushStudio";
import { penPressureOf, penSampleOf } from "../lib/paint/pen";
import { cloneSurface, createSurface, mustCtx, readPixels } from "../lib/paint/surface";
import {
  applyComicFilter,
  blendOperation,
  DEFAULT_FILTER_OPTIONS,
  replaceSurface,
  type ComicFilterId,
  type ComicFilterOptions,
} from "../lib/paint/effects";
import {
  combineSelection,
  expandSelection,
  intersectMasks,
  isSelectionEmpty,
  lassoMask,
  offsetMask,
  rectMask,
  selectionBounds,
  selectionTint,
  wandMask,
  type SelectionBounds,
  type SelectionMode,
} from "../comic/selection";
import type {
  ComicBalloon,
  ComicBlendMode,
  ComicFrame,
  ComicImageItem,
  ComicJointLayer,
  ComicLayerMeta,
  ComicPage,
  ComicPageFrame,
  ComicPagePayload,
  ComicPreset,
  ComicPresetFrame,
  ComicProjectMeta,
} from "../comic/types";
import {
  buildTemplateFrames,
  FRAME_TEMPLATES,
  makeAddFrame,
  makeDrawnFrame,
  type TemplateFrameDef,
} from "../comic/templates";
import { buildJointMask, jointFrameOf, jointGapBridged, jointRect, maskHasPoint } from "../comic/joint";
import {
  clipFrame,
  framePolygon,
  normalizeQuad,
  pointInFrame,
  polygonCenter,
  polygonPath,
  referenceTargets,
  snapPoint,
  snapPointToParallel,
  snapRect,
} from "../comic/geometry";

/* ══════════════════════════════════════════════════════════
   Chapter · 漫画工作台
   页面 → 格 → 格内聚焦 → 图层 / 画笔 → 气泡 / 素材
   真实落盘：comic/project.json + pages/<id>/page.json + layers/*.png
   ══════════════════════════════════════════════════════════ */

type Tool =
  | "select"
  | "selection"
  | "brush"
  | "eraser"
  | "fill"
  | "eyedropper"
  | "balloon"
  | "panel"
  | "frame"
  | "pageframe"
  | "shape"
  | "move"
  | "liquify";
type SelectionShape = "rect" | "lasso" | "wand";
type ShapeKind = "rect" | "ellipse" | "line";
type FocusMode = string | null;
type SaveState = "saved" | "saving" | "dirty" | "error";

type Point = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };

const BLEND_MODE_ITEMS: { id: ComicBlendMode; label: string }[] = [
  { id: "normal", label: "正常" },
  { id: "multiply", label: "正片叠底" },
  { id: "screen", label: "滤色" },
  { id: "overlay", label: "叠加" },
  { id: "darken", label: "变暗" },
  { id: "lighten", label: "变亮" },
  { id: "color-dodge", label: "颜色减淡" },
  { id: "color-burn", label: "颜色加深" },
  { id: "hard-light", label: "强光" },
  { id: "soft-light", label: "柔光" },
  { id: "difference", label: "差值" },
  { id: "linear-burn", label: "线性加深" },
  { id: "linear-dodge", label: "线性减淡" },
  { id: "linear-light", label: "线性光" },
  { id: "pin-light", label: "点光" },
  { id: "hard-mix", label: "实色混合" },
  { id: "hue", label: "色相" },
  { id: "saturation", label: "饱和度" },
  { id: "color", label: "颜色" },
  { id: "luminosity", label: "明度" },
];

const FILTER_ITEMS: { id: ComicFilterId; label: string }[] = [
  { id: "adjust", label: "亮度对比度" },
  { id: "hue", label: "色相" },
  { id: "blur", label: "高斯模糊" },
  { id: "invert", label: "反相" },
  { id: "edges", label: "查找边缘" },
  { id: "luma-alpha", label: "亮度转透明" },
];

type SelectionDraft =
  | { shape: "rect"; a: Point; b: Point; mode: SelectionMode }
  | { shape: "lasso"; points: Point[]; mode: SelectionMode }
  | null;

type DragMode =
  | "moveFrames"
  | "resizeFrame"
  | "moveVertex"
  | "marquee"
  | "moveBalloon"
  | "resizeBalloon"
  | "tail"
  | "createRect"
  | "movePageFrame"
  | "resizePageFrame";

interface DragState {
  mode: DragMode;
  start: Point;
  pageBefore: ComicPage;
  moved: boolean;
  frameId?: string;
  handle?: string;
  origRect?: { x: number; y: number; w: number; h: number };
  vertexIndex?: number;
  origPoints?: Point[];
  frames?: { id: string; x: number; y: number; w: number; h: number }[];
  balloonId?: string;
  balloonBefore?: ComicBalloon;
  pageFrameBefore?: ComicPageFrame;
}

interface StrokeSession {
  stroke: Stroke;
  frameId: string;
  layerId: string;
  erase: boolean;
  before: HTMLCanvasElement;
}

interface ShapeSession {
  kind: ShapeKind;
  start: Point;
  current: Point;
  constrain: boolean;
  frameId: string;
  layerId: string;
  before: HTMLCanvasElement;
  preview: HTMLCanvasElement;
  dirty: Rect | null;
  lastRect: Rect | null;
}

interface MoveSession {
  frameId: string;
  layerId: string;
  before: HTMLCanvasElement;
  base: HTMLCanvasElement;
  moving: HTMLCanvasElement;
  start: Point;
  dx: number;
  dy: number;
  selection: boolean;
}

interface FilterSession {
  frameId: string;
  layerId: string;
  before: HTMLCanvasElement;
}

interface SelectionClipboard {
  image: HTMLCanvasElement;
  x: number;
  y: number;
  fromCut: boolean;
}

type UndoEntry =
  | {
      kind: "stroke";
      frameId: string;
      layerId: string;
      before: HTMLCanvasElement;
      after: HTMLCanvasElement;
    }
  | {
      kind: "page";
      before: ComicPage;
      after: ComicPage;
      beforeLayers?: LayerSnapshot[];
      afterLayers?: LayerSnapshot[];
    }
  | {
      kind: "resize";
      frameId: string;
      beforePage: ComicPage;
      afterPage: ComicPage;
      beforeLayers: { layerId: string; canvas: HTMLCanvasElement }[];
    };

const PRESETS: { id: string; name: string; note: string; patch: Partial<BrushSettings> }[] = [
  {
    id: "gpen",
    name: "G 笔",
    note: "主线条，边缘干净",
    patch: { size: 12, hardness: 88, opacity: 100, flow: 100, tip: "round", texture: "none", spacing: 7 },
  },
  {
    id: "willow",
    name: "柳叶笔",
    note: "两头尖、中间宽，勾发丝与衣纹",
    patch: {
      size: 18,
      hardness: 84,
      opacity: 100,
      flow: 94,
      tip: "willow",
      texture: "none",
      spacing: 4,
      roundness: 100,
      angle: 0,
      alignToStroke: true,
      smoothing: 10,
    },
  },
  {
    id: "fine",
    name: "细线",
    note: "睫毛、发丝、排线",
    patch: { size: 5, hardness: 92, opacity: 100, flow: 100, tip: "round", texture: "none", spacing: 6 },
  },
  {
    id: "brush",
    name: "毛笔",
    note: "起收有肉，适合衣褶",
    patch: { size: 28, hardness: 52, opacity: 92, flow: 82, tip: "bristle", texture: "paper", spacing: 9 },
  },
  {
    id: "pencil",
    name: "铅笔",
    note: "草稿和网点过渡",
    patch: { size: 11, hardness: 48, opacity: 62, flow: 72, tip: "pencil", texture: "grain", spacing: 6 },
  },
  {
    id: "ink",
    name: "墨块",
    note: "大面积涂黑、阴影",
    patch: { size: 46, hardness: 96, opacity: 100, flow: 100, tip: "round", texture: "none", spacing: 5 },
  },
  {
    id: "gel",
    name: "圆珠",
    note: "均匀细线，画小物",
    patch: { size: 8, hardness: 84, opacity: 100, flow: 100, tip: "round", texture: "none", spacing: 4, smoothing: 24 },
  },
  {
    id: "screentone",
    name: "网点",
    note: "网点过渡，排线不糊",
    patch: { size: 18, hardness: 72, opacity: 78, flow: 66, tip: "spray", texture: "grain", spacing: 11 },
  },
  {
    id: "marker",
    name: "马克",
    note: "平涂色块，边缘略软",
    patch: { size: 38, hardness: 66, opacity: 88, flow: 90, tip: "round", texture: "none", spacing: 6, angle: 28 },
  },
  {
    id: "dry",
    name: "干刷",
    note: "飞白和粗糙阴影",
    patch: { size: 24, hardness: 34, opacity: 84, flow: 58, tip: "bristle", texture: "paper", spacing: 13 },
  },
  {
    id: "soft",
    name: "软圆",
    note: "大面积柔和过渡",
    patch: { size: 64, hardness: 24, opacity: 100, flow: 45, tip: "round", texture: "none", spacing: 6, smoothing: 0 },
  },
  {
    id: "charcoal",
    name: "炭笔",
    note: "速写、暗部和粗颗粒",
    patch: { size: 30, hardness: 55, opacity: 88, flow: 55, tip: "chalk", texture: "paper", spacing: 8, jitter: 12, roundness: 80, angle: 15, smoothing: 0 },
  },
  {
    id: "chalk",
    name: "粉笔",
    note: "黑板感，颗粒边缘",
    patch: { size: 22, hardness: 70, opacity: 85, flow: 50, tip: "chalk", texture: "grain", spacing: 10, jitter: 8, smoothing: 0 },
  },
  {
    id: "airbrush",
    name: "喷枪",
    note: "低流量柔雾，铺底色",
    patch: { size: 120, hardness: 0, opacity: 55, flow: 16, tip: "spray", texture: "none", spacing: 5, jitter: 8, smoothing: 0 },
  },
  {
    id: "watercolor",
    name: "水彩",
    note: "低流量叠染，边缘柔",
    patch: { size: 90, hardness: 10, opacity: 90, flow: 10, tip: "round", texture: "paper", spacing: 8, jitter: 12, smoothing: 0 },
  },
  {
    id: "crayon",
    name: "蜡笔",
    note: "断续颗粒，儿童画质感",
    patch: { size: 18, hardness: 88, opacity: 70, flow: 38, tip: "chalk", texture: "grain", spacing: 14, jitter: 30, roundness: 92, smoothing: 0 },
  },
  {
    id: "calligraphy",
    name: "书法",
    note: "扁锋侧扫，起收有角",
    patch: { size: 26, hardness: 100, opacity: 100, flow: 100, tip: "round", texture: "none", spacing: 20, roundness: 32, angle: 45, smoothing: 0 },
  },
  {
    id: "flat",
    name: "平笔",
    note: "扁头平涂，块面清楚",
    patch: { size: 40, hardness: 92, opacity: 100, flow: 100, tip: "round", texture: "none", spacing: 6, roundness: 28, angle: 45, smoothing: 0 },
  },
  {
    id: "oil",
    name: "油画",
    note: "鬃毛厚涂，带丝状笔触",
    patch: { size: 54, hardness: 70, opacity: 82, flow: 42, tip: "bristle", texture: "canvas", spacing: 10, jitter: 26, roundness: 86, angle: 20, smoothing: 0 },
  },
  {
    id: "grain",
    name: "颗粒",
    note: "彩色颗粒，做噪点肌理",
    patch: { size: 36, hardness: 40, opacity: 70, flow: 35, tip: "spray", texture: "grain", spacing: 6, jitter: 35, hueJitter: 25, smoothing: 0 },
  },
];

const HANDLE_POINTS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;

/** 画漫画够用的一组中性色 + 肤色 + 常用纯色；侧栏 8 列排开，不再挤成一条。 */
const COLOR_SWATCHES = [
  "#17171c", "#2e2e36", "#5a5a63", "#8b8b93", "#c2c2c7", "#ffffff",
  "#f3eadb", "#e7d6bd", "#7a2f2a", "#c94f3d", "#e06a5a", "#ef9a88",
  "#c47a1f", "#e0a63a", "#f2ce74", "#2f5d46", "#3f7d62", "#75b39a",
  "#274a78", "#3d68b0", "#6f9bd4", "#4a3168", "#735196", "#a583c2",
] as const;

const RECENT_COLORS_KEY = "chapter.comic.recentColors";
const PALETTE_COLORS_KEY = "chapter.comic.paletteColors";

function hexToRgba(hex: string): [number, number, number, number] {
  let value = hex.trim().replace("#", "");
  if (value.length === 3) value = value.split("").map((c) => c + c).join("");
  if (value.length !== 6) return [23, 23, 28, 255];
  const n = Number.parseInt(value, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

function normalizeHex(value: string): string | null {
  let hex = value.trim().replace("#", "");
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return `#${hex.toLowerCase()}`;
}

/** RGB → HSV，给自绘色盘定位。 */
function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const [r, g, b] = hexToRgba(hex).slice(0, 3).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function hsvToHex(h: number, s: number, v: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 1);
  const val = clamp(v, 0, 1);
  const c = val * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return `#${[r, g, b]
    .map((n) => Math.round((n + m) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** 只填与落点颜色接近的连通区，抗锯齿边缘留一圈线稿，不会把整格糊成一块。 */
function fillRegion(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  hex: string,
  clip?: HTMLCanvasElement | null,
  preserveAlpha = false,
) {
  const w = canvas.width;
  const h = canvas.height;
  if (w < 1 || h < 1) return false;
  const sx = Math.max(0, Math.min(w - 1, Math.round(x)));
  const sy = Math.max(0, Math.min(h - 1, Math.round(y)));
  const ctx = mustCtx(canvas);
  const clipData = clip ? readPixels(clip).data : null;
  if (clipData && clipData[(sy * w + sx) * 4 + 3] === 0) return false;
  const image = ctx.getImageData(0, 0, w, h);
  const data = image.data;
  const target = [(sy * w + sx) * 4, (sy * w + sx) * 4 + 1, (sy * w + sx) * 4 + 2, (sy * w + sx) * 4 + 3].map(
    (i) => data[i],
  );
  if (target[3] === 0 && hexToRgba(hex)[3] === 255) {
    /* 透明区可以填 */
  }
  const [fr, fg, fb, fa] = hexToRgba(hex);
  const tolerance = 26;
  const visited = new Uint8Array(w * h);
  const stack = new Uint32Array(w * h);
  let top = 0;
  visited[sy * w + sx] = 1;
  stack[top++] = sy * w + sx;
  let changed = false;
  while (top > 0) {
    const idx = stack[--top];
    const p = idx * 4;
    if (clipData && clipData[p + 3] === 0) continue;
    const d =
      Math.abs(data[p] - target[0]) +
      Math.abs(data[p + 1] - target[1]) +
      Math.abs(data[p + 2] - target[2]) +
      Math.abs(data[p + 3] - target[3]);
    if (d > tolerance * 4) continue;
    const nextAlpha = preserveAlpha ? data[p + 3] : fa;
    if (data[p] !== fr || data[p + 1] !== fg || data[p + 2] !== fb || data[p + 3] !== nextAlpha) {
      data[p] = fr;
      data[p + 1] = fg;
      data[p + 2] = fb;
      if (!preserveAlpha) data[p + 3] = fa;
      changed = true;
    }
    const px = idx % w;
    const push = (next: number) => {
      if (visited[next]) return;
      visited[next] = 1;
      stack[top++] = next;
    };
    if (px > 0) push(idx - 1);
    if (px < w - 1) push(idx + 1);
    if (idx >= w) push(idx - w);
    if (idx < w * (h - 1)) push(idx + w);
  }
  if (changed) ctx.putImageData(image, 0, 0);
  return changed;
}


type LayerSnapshot = { frameId: string; layerId: string; canvas: HTMLCanvasElement };

function withLayerSnapshots(
  map: Map<string, HTMLCanvasElement>,
  snaps: LayerSnapshot[],
): Map<string, HTMLCanvasElement> {
  const next = new Map(map);
  for (const item of snaps) next.set(keyOf(item.frameId, item.layerId), item.canvas);
  return next;
}

function snapshotPageLayers(
  page: ComicPage,
  map: Map<string, HTMLCanvasElement>,
): LayerSnapshot[] {
  const out: LayerSnapshot[] = [];
  for (const frame of page.frames) {
    for (const layer of frame.layers) {
      const canvas = map.get(keyOf(frame.id, layer.id));
      if (canvas) out.push({ frameId: frame.id, layerId: layer.id, canvas: cloneSurface(canvas) });
    }
  }
  for (const joint of page.jointLayers ?? []) {
    const canvas = map.get(keyOf(joint.id, joint.id));
    if (canvas) out.push({ frameId: joint.id, layerId: joint.id, canvas: cloneSurface(canvas) });
  }
  return out;
}

function keyOf(frameId: string, layerId: string): string {
  return `${frameId}::${layerId}`;
}

function frameById(page: ComicPage, id: string): ComicFrame | null {
  const frame = page.frames.find((item) => item.id === id);
  if (frame) return frame;
  const joint = page.jointLayers?.find((item) => item.id === id);
  return joint ? jointFrameOf(joint) : null;
}

function clonePage(p: ComicPage): ComicPage {
  return JSON.parse(JSON.stringify(p)) as ComicPage;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 900 + 100)}`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片载入失败"));
    img.src = src;
  });
}

function readFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function framesForPoint(p: ComicPage, point: Point): ComicFrame | null {
  for (let i = p.frames.length - 1; i >= 0; i -= 1) {
    if (pointInFrame(p.frames[i], point)) return p.frames[i];
  }
  return null;
}

function balloonForPoint(p: ComicPage, point: Point): ComicBalloon | null {
  for (let i = p.balloons.length - 1; i >= 0; i -= 1) {
    const b = p.balloons[i];
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const nx = (point.x - cx) / (b.w / 2);
    const ny = (point.y - cy) / (b.h / 2);
    if (nx * nx + ny * ny <= 1.05) return b;
  }
  return null;
}

function handleAt(f: ComicFrame, point: Point): string | null {
  const size = 26;
  if (f.shape === "quad" && f.points) {
    const corners = framePolygon(f);
    for (let i = 0; i < corners.length; i += 1) {
      const q = corners[i];
      if (Math.abs(point.x - q.x) <= size && Math.abs(point.y - q.y) <= size) {
        return `v${i}`;
      }
    }
    return null;
  }
  const nw = { x: f.x, y: f.y };
  const ne = { x: f.x + f.w, y: f.y };
  const se = { x: f.x + f.w, y: f.y + f.h };
  const sw = { x: f.x, y: f.y + f.h };
  const points: Record<string, Point> = {
    nw,
    n: { x: f.x + f.w / 2, y: f.y },
    ne,
    e: { x: f.x + f.w, y: f.y + f.h / 2 },
    se,
    s: { x: f.x + f.w / 2, y: f.y + f.h },
    sw,
    w: { x: f.x, y: f.y + f.h / 2 },
  };
  for (const name of HANDLE_POINTS) {
    const q = points[name];
    if (Math.abs(point.x - q.x) <= size && Math.abs(point.y - q.y) <= size) return name;
  }
  return null;
}

function pageFrameOf(page: ComicPage): ComicPageFrame {
  if (page.pageFrame && page.pageFrame.w > 0 && page.pageFrame.h > 0) return page.pageFrame;
  const ix = Math.round(page.width * 0.035);
  const iy = Math.round(page.height * 0.03);
  return {
    x: ix,
    y: iy,
    w: page.width - ix * 2,
    h: page.height - iy * 2,
    stroke: 8,
  };
}

function ensurePageFrame(page: ComicPage): ComicPage {
  if (!page.pageFrame) page.pageFrame = pageFrameOf(page);
  if (!page.jointLayers) page.jointLayers = [];
  return page;
}

function pageFrameHandleAt(frame: ComicPageFrame, point: Point): string | null {
  const size = 28;
  const spots: Record<string, Point> = {
    nw: { x: frame.x, y: frame.y },
    n: { x: frame.x + frame.w / 2, y: frame.y },
    ne: { x: frame.x + frame.w, y: frame.y },
    e: { x: frame.x + frame.w, y: frame.y + frame.h / 2 },
    se: { x: frame.x + frame.w, y: frame.y + frame.h },
    s: { x: frame.x + frame.w / 2, y: frame.y + frame.h },
    sw: { x: frame.x, y: frame.y + frame.h },
    w: { x: frame.x, y: frame.y + frame.h / 2 },
  };
  for (const name of HANDLE_POINTS) {
    const q = spots[name];
    if (Math.abs(point.x - q.x) <= size && Math.abs(point.y - q.y) <= size) return name;
  }
  return null;
}

function resizeByHandle(
  rect: { x: number; y: number; w: number; h: number },
  handle: string,
  dx: number,
  dy: number,
  pageW: number,
  pageH: number,
): { x: number; y: number; w: number; h: number } {
  let { x, y, w, h } = rect;
  const min = 80;
  if (handle.includes("w")) {
    const nx = clamp(x + dx, 0, x + w - min);
    w += x - nx;
    x = nx;
  }
  if (handle.includes("e")) {
    w = clamp(w + dx, min, pageW - x);
  }
  if (handle.includes("n")) {
    const ny = clamp(y + dy, 0, y + h - min);
    h += y - ny;
    y = ny;
  }
  if (handle.includes("s")) {
    h = clamp(h + dy, min, pageH - y);
  }
  return { x, y, w, h };
}

function drawImageInRect(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  fit: "contain" | "cover" | "stretch",
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  if (fit === "stretch") {
    ctx.drawImage(img, x, y, w, h);
    return;
  }
  const ir = img.width / Math.max(1, img.height);
  const rr = w / Math.max(1, h);
  if (fit === "contain") {
    if (ir > rr) {
      const nh = w / ir;
      ctx.drawImage(img, x, y + (h - nh) / 2, w, nh);
    } else {
      const nw = h * ir;
      ctx.drawImage(img, x + (w - nw) / 2, y, nw, h);
    }
  } else if (ir > rr) {
    const nw = h * ir;
    ctx.drawImage(img, x + (w - nw) / 2, y, nw, h);
  } else {
    const nh = w / ir;
    ctx.drawImage(img, x, y + (h - nh) / 2, w, nh);
  }
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const ch of raw) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = ch;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/* ───────── 渲染：纯 Canvas 2D，视口按需缩放 ───────── */

function paintFrameContent(
  ctx: CanvasRenderingContext2D,
  page: ComicPage,
  frame: ComicFrame,
  layerMap: Map<string, HTMLCanvasElement>,
  assetMap: Map<string, HTMLImageElement>,
  ox: number,
  oy: number,
  scale: number,
): void {
  ctx.save();
  const fx = frame.x * scale + ox;
  const fy = frame.y * scale + oy;
  const fw = frame.w * scale;
  const fh = frame.h * scale;
  clipFrame(ctx, frame, scale, ox, oy);
  ctx.clip();

  for (const imgItem of page.images) {
    if (imgItem.frameId !== frame.id) continue;
    const img = assetMap.get(imgItem.asset);
    if (!img) continue;
    ctx.globalAlpha = clamp(imgItem.opacity, 0, 1) * (imgItem.role === "reference" ? 0.45 : 1);
    drawImageInRect(
      ctx,
      img,
      imgItem.fit,
      fx + imgItem.x * scale,
      fy + imgItem.y * scale,
      imgItem.w * scale,
      imgItem.h * scale,
    );
    ctx.globalAlpha = 1;
  }

  let below: HTMLCanvasElement | null = null;
  for (const layer of frame.layers) {
    if (!layer.visible) continue;
    const canvas = layerMap.get(keyOf(frame.id, layer.id));
    if (!canvas) continue;
    // 剪贴蒙版：当前层只保留下一层的不透明像素。先算一张临时图，避免
    // 直接改图层像素，撤销/继续画时原始内容仍是干净的。
    if (layer.clipping) {
      if (!below) continue;
      const clipped = createSurface(frame.w, frame.h);
      const cctx = mustCtx(clipped);
      cctx.drawImage(canvas, 0, 0);
      cctx.globalCompositeOperation = "destination-in";
      cctx.drawImage(below, 0, 0);
      ctx.globalAlpha = clamp(layer.opacity, 0, 1);
      ctx.globalCompositeOperation = blendOperation(layer.blendMode);
      ctx.drawImage(clipped, fx, fy, fw, fh);
    } else {
      ctx.globalAlpha = clamp(layer.opacity, 0, 1);
      ctx.globalCompositeOperation = blendOperation(layer.blendMode);
      ctx.drawImage(canvas, fx, fy, fw, fh);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    below = canvas;
  }
  ctx.restore();
}

function drawBalloon(
  ctx: CanvasRenderingContext2D,
  b: ComicBalloon,
  ox: number,
  oy: number,
  scale: number,
): void {
  const x = b.x * scale + ox;
  const y = b.y * scale + oy;
  const w = b.w * scale;
  const h = b.h * scale;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const tx = b.tailX * scale + ox;
  const ty = b.tailY * scale + oy;

  ctx.save();
  ctx.lineJoin = "round";
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#17171c";
  ctx.lineWidth = Math.max(1.4, 3 * scale);

  const baseY = y + h * 0.86;
  const baseX = cx + w * 0.08;
  ctx.beginPath();
  ctx.moveTo(baseX - w * 0.1, baseY);
  ctx.lineTo(tx, ty);
  ctx.lineTo(baseX + w * 0.12, baseY - h * 0.04);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  if (b.shape === "rect") {
    ctx.rect(x, y, w, h);
  } else if (b.shape === "thought") {
    const r = Math.min(w, h) * 0.22;
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  } else {
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.stroke();

  if (b.text) {
    ctx.fillStyle = "#17171c";
    const fs = Math.max(7, b.fontSize * scale);
    ctx.font = `500 ${fs}px "Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif`;
    const maxW = (b.shape === "ellipse" ? w * 0.72 : w * 0.82);
    const lines = wrapText(ctx, b.text, maxW);
    const lineH = fs * 1.35;
    const total = lines.length * lineH;
    const startY = cy - total / 2 + fs;
    lines.forEach((line, i) => {
      if (b.align === "left") {
        ctx.textAlign = "left";
        ctx.fillText(line, cx - maxW / 2, startY + i * lineH);
      } else {
        ctx.textAlign = "center";
        ctx.fillText(line, cx, startY + i * lineH);
      }
    });
    ctx.textAlign = "start";
  }
  ctx.restore();
}

function drawPage(
  ctx: CanvasRenderingContext2D,
  page: ComicPage,
  layerMap: Map<string, HTMLCanvasElement>,
  assetMap: Map<string, HTMLImageElement>,
  opts: {
    scale?: number;
    selectedFrames?: string[];
    selectedBalloon?: string | null;
    marquee?: { x: number; y: number; w: number; h: number } | null;
    draft?: Point[] | null;
    draftRect?: { x: number; y: number; w: number; h: number } | null;
    pageFrameSelected?: boolean;
    guides?: { x: number[]; y: number[] } | null;
    thumb?: boolean;
  } = {},
): void {
  const scale = opts.scale ?? 1;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.fillStyle = page.backgroundColor || "#ffffff";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  const pf = pageFrameOf(page);
  // 分格的外圈直接贴纸边，不再额外画一圈装饰页框。
  void pf;

  for (const frame of page.frames) {
    paintFrameContent(ctx, page, frame, layerMap, assetMap, 0, 0, scale);
  }

  for (const joint of page.jointLayers ?? []) {
    const frames = page.frames.filter((frame) => joint.frameIds.includes(frame.id));
    if (!frames.length) continue;
    const mask = buildJointMask(frames, joint.rect, joint.crossPanel);
    const canvas = layerMap.get(keyOf(joint.id, joint.id));
    drawJointLayerInRect(
      ctx,
      joint,
      canvas,
      mask,
      joint.rect.x * scale,
      joint.rect.y * scale,
      joint.rect.w * scale,
      joint.rect.h * scale,
    );
  }

  // 格线最后画：跨格笔迹从线框底下穿过去，线始终压在笔迹上。
  for (const frame of page.frames) {
    ctx.save();
    ctx.strokeStyle = "#17171c";
    ctx.lineWidth = Math.max(1, 5 * scale);
    if (frame.shape === "quad") {
      polygonPath(ctx, frame, scale, 0, 0);
      ctx.stroke();
    } else if (frame.shape === "rect") {
      ctx.strokeRect(
        frame.x * scale,
        frame.y * scale,
        frame.w * scale,
        frame.h * scale,
      );
    }
    ctx.restore();
  }

  for (const b of page.balloons) {
    drawBalloon(ctx, b, 0, 0, scale);
  }

  if (opts.selectedFrames && !opts.thumb) {
    for (const id of opts.selectedFrames) {
      const f = page.frames.find((x) => x.id === id);
      if (!f) continue;
      const fx = f.x * scale;
      const fy = f.y * scale;
      const fw = f.w * scale;
      const fh = f.h * scale;
      ctx.save();
      ctx.strokeStyle = "#c96a1f";
      ctx.lineWidth = Math.max(2, 4 * scale);
      ctx.setLineDash([10 * scale, 5 * scale]);
      if (f.shape === "quad") {
        polygonPath(ctx, f, scale, 0, 0);
        ctx.stroke();
      } else {
        ctx.strokeRect(fx, fy, fw, fh);
      }
      ctx.setLineDash([]);
      if (opts.selectedFrames.length === 1) {
        const hs = Math.max(6, 16 * scale);
        const points =
          f.shape === "quad" && f.points
            ? framePolygon(f).map((q) => [q.x * scale, q.y * scale])
            : [
                [fx, fy],
                [fx + fw / 2, fy],
                [fx + fw, fy],
                [fx + fw, fy + fh / 2],
                [fx + fw, fy + fh],
                [fx + fw / 2, fy + fh],
                [fx, fy + fh],
                [fx, fy + fh / 2],
              ];
        for (const [hx, hy] of points) {
          ctx.fillStyle = "#fff8ee";
          ctx.strokeStyle = "#c96a1f";
          ctx.lineWidth = Math.max(1, 2 * scale);
          ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
          ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
        }
      }
      ctx.restore();
    }
  }

  if (opts.selectedBalloon) {
    const b = page.balloons.find((x) => x.id === opts.selectedBalloon);
    if (b) {
      const x = b.x * scale;
      const y = b.y * scale;
      const w = b.w * scale;
      const h = b.h * scale;
      ctx.save();
      ctx.strokeStyle = "#c96a1f";
      ctx.lineWidth = Math.max(1.4, 3 * scale);
      ctx.setLineDash([8 * scale, 4 * scale]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      const hs = Math.max(6, 14 * scale);
      const tx = b.tailX * scale;
      const ty = b.tailY * scale;
      ctx.beginPath();
      ctx.fillStyle = "#fff8ee";
      ctx.strokeStyle = "#c96a1f";
      ctx.arc(tx, ty, hs, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  if (opts.draftRect) {
    const d = opts.draftRect;
    ctx.save();
    ctx.fillStyle = "rgba(201,106,31,.10)";
    ctx.strokeStyle = "#c96a1f";
    ctx.lineWidth = Math.max(1.5, 3 * scale);
    ctx.setLineDash([10 * scale, 5 * scale]);
    ctx.fillRect(d.x * scale, d.y * scale, d.w * scale, d.h * scale);
    ctx.strokeRect(d.x * scale, d.y * scale, d.w * scale, d.h * scale);
    ctx.restore();
  }

  if (opts.guides && (opts.guides.x.length || opts.guides.y.length)) {
    ctx.save();
    ctx.strokeStyle = "rgba(201,106,31,.85)";
    ctx.lineWidth = Math.max(1, 1.6 * scale);
    ctx.setLineDash([7 * scale, 6 * scale]);
    for (const x of opts.guides.x) {
      ctx.beginPath();
      ctx.moveTo(x * scale, 0);
      ctx.lineTo(x * scale, page.height * scale);
      ctx.stroke();
    }
    for (const y of opts.guides.y) {
      ctx.beginPath();
      ctx.moveTo(0, y * scale);
      ctx.lineTo(page.width * scale, y * scale);
      ctx.stroke();
    }
    ctx.restore();
  }

  if (pf && opts.pageFrameSelected && !opts.thumb) {
    // 页框工具已移除，旧工程里遗留的 pageFrame 不再画成第二圈边框。
  }

  if (opts.draft && opts.draft.length) {
    const pts = opts.draft;
    ctx.save();
    ctx.strokeStyle = "#c96a1f";
    ctx.lineWidth = Math.max(1.5, 4 * scale);
    ctx.setLineDash([8 * scale, 5 * scale]);
    ctx.beginPath();
    pts.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x * scale, p.y * scale);
      else ctx.lineTo(p.x * scale, p.y * scale);
    });
    if (pts.length === 4) ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of pts) {
      ctx.beginPath();
      ctx.fillStyle = "#fff8ee";
      ctx.arc(p.x * scale, p.y * scale, Math.max(4, 10 * scale), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#c96a1f";
      ctx.lineWidth = Math.max(1, 2 * scale);
      ctx.stroke();
    }
    ctx.restore();
  }

  if (opts.marquee) {
    const m = opts.marquee;
    ctx.save();
    ctx.fillStyle = "rgba(201,106,31,.12)";
    ctx.strokeStyle = "#c96a1f";
    ctx.lineWidth = Math.max(1, 2 * scale);
    ctx.fillRect(m.x * scale, m.y * scale, m.w * scale, m.h * scale);
    ctx.strokeRect(m.x * scale, m.y * scale, m.w * scale, m.h * scale);
    ctx.restore();
  }
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function normalizeDirty(dirty: Rect | null, width: number, height: number): Rect | null {
  if (!dirty) return null;
  const x0 = Math.max(0, Math.floor(dirty.x));
  const y0 = Math.max(0, Math.floor(dirty.y));
  const x1 = Math.min(width, Math.ceil(dirty.x + dirty.w));
  const y1 = Math.min(height, Math.ceil(dirty.y + dirty.h));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function drawJointLayerInRect(
  ctx: CanvasRenderingContext2D,
  layer: ComicJointLayer,
  layerCanvas: HTMLCanvasElement | undefined,
  mask: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  if (!layerCanvas || !layer.visible) return;
  const clipped = createSurface(mask.width, mask.height);
  const cctx = mustCtx(clipped);
  cctx.drawImage(layerCanvas, 0, 0);
  cctx.globalCompositeOperation = "destination-in";
  cctx.drawImage(mask, 0, 0);
  cctx.globalCompositeOperation = "source-over";
  ctx.save();
  ctx.globalAlpha = clamp(layer.opacity, 0, 1);
  ctx.globalCompositeOperation = blendOperation(layer.blendMode);
  ctx.drawImage(clipped, x, y, w, h);
  ctx.restore();
}

function drawJointFocus(
  ctx: CanvasRenderingContext2D,
  page: ComicPage,
  joint: { layer: ComicJointLayer; frames: ComicFrame[]; mask: HTMLCanvasElement },
  layerMap: Map<string, HTMLCanvasElement>,
  assetMap: Map<string, HTMLImageElement>,
  preview: Stroke | null,
  base: HTMLCanvasElement | null,
  shapePreview: HTMLCanvasElement | null,
  dirty: Rect | null,
  erasePreview: Stroke | null,
): void {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const area = normalizeDirty(dirty, width, height);
  if (area) ctx.clearRect(area.x, area.y, area.w, area.h);
  else ctx.clearRect(0, 0, width, height);
  const rect = joint.layer.rect;

  ctx.save();
  if (area) {
    ctx.beginPath();
    ctx.rect(area.x, area.y, area.w, area.h);
    ctx.clip();
  }
  if (base) {
    ctx.drawImage(base, 0, 0);
  } else {
    ctx.fillStyle = "#e9e3d8";
    ctx.fillRect(0, 0, width, height);
    const content = createSurface(width, height, "#ffffff");
    const cctx = mustCtx(content);
    for (const frame of joint.frames) {
      paintFrameContent(cctx, page, frame, layerMap, assetMap, -rect.x, -rect.y, 1);
    }
    cctx.globalCompositeOperation = "destination-in";
    cctx.drawImage(joint.mask, 0, 0);
    cctx.globalCompositeOperation = "source-over";
    ctx.drawImage(content, 0, 0);
    drawJointLayerInRect(
      ctx,
      joint.layer,
      layerMap.get(keyOf(joint.layer.id, joint.layer.id)),
      joint.mask,
      0,
      0,
      rect.w,
      rect.h,
    );
  }

  if (preview || shapePreview) {
    ctx.save();
    if (shapePreview) {
      const clipped = createSurface(width, height);
      const sctx = mustCtx(clipped);
      sctx.drawImage(shapePreview, 0, 0);
      sctx.globalCompositeOperation = "destination-in";
      sctx.drawImage(joint.mask, 0, 0);
      sctx.globalCompositeOperation = "source-over";
      ctx.drawImage(clipped, 0, 0);
    }
    if (preview) ctx.drawImage(preview.buffer, 0, 0);
    ctx.restore();
  }
  if (erasePreview) {
    // 笔迹本身已经按 mask 裁过；这里只把缓冲从底图上擦掉。
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(erasePreview.buffer, 0, 0);
    ctx.restore();
  }

  for (const frame of joint.frames) {
    ctx.save();
    polygonPath(ctx, frame, 1, -rect.x, -rect.y);
    ctx.strokeStyle = "rgba(23,23,28,.55)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  for (const balloon of page.balloons) {
    const br: Rect = { x: balloon.x - rect.x, y: balloon.y - rect.y, w: balloon.w, h: balloon.h };
    if (!rectsIntersect(br, { x: 0, y: 0, w: width, h: height })) continue;
    if (area && !rectsIntersect(area, br)) continue;
    drawBalloon(ctx, balloon, -rect.x, -rect.y, 1);
  }
  ctx.restore();
}

function drawFocus(
  ctx: CanvasRenderingContext2D,
  page: ComicPage,
  frame: ComicFrame,
  layerMap: Map<string, HTMLCanvasElement>,
  assetMap: Map<string, HTMLImageElement>,
  preview: Stroke | null,
  base: HTMLCanvasElement | null,
  shapePreview: HTMLCanvasElement | null = null,
  dirty: Rect | null = null,
  erasePreview: Stroke | null = null,
  joint?: { layer: ComicJointLayer; frames: ComicFrame[]; mask: HTMLCanvasElement },
): void {
  if (joint) {
    drawJointFocus(
      ctx,
      page,
      joint,
      layerMap,
      assetMap,
      preview,
      base,
      shapePreview,
      dirty,
      erasePreview,
    );
    return;
  }
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const area = normalizeDirty(dirty, width, height);
  if (area) ctx.clearRect(area.x, area.y, area.w, area.h);
  else ctx.clearRect(0, 0, width, height);

  ctx.save();
  if (area) {
    ctx.beginPath();
    ctx.rect(area.x, area.y, area.w, area.h);
    ctx.clip();
  }
  if (base) {
    // 落笔中只把缓存的底图铺一次，不再逐帧重画所有图层。
    ctx.drawImage(base, 0, 0);
  } else {
    ctx.fillStyle = "#e9e3d8";
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    clipFrame(ctx, frame, 1, -frame.x, -frame.y);
    ctx.clip();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    paintFrameContent(ctx, page, frame, layerMap, assetMap, -frame.x, -frame.y, 1);
    ctx.restore();
  }
  if (shapePreview || preview) {
    ctx.save();
    clipFrame(ctx, frame, 1, -frame.x, -frame.y);
    ctx.clip();
    if (shapePreview) {
      ctx.globalAlpha = 1;
      ctx.drawImage(shapePreview, 0, 0);
    }
    if (preview) {
      ctx.globalAlpha = 1;
      ctx.drawImage(preview.buffer, 0, 0);
    }
    ctx.restore();
  }
  if (erasePreview) {
    // 橡皮拖动时在缓存的底图上直接抠掉笔画缓冲，看到的就是实时擦除，
    // 而不是等抬笔才突然消失。
    ctx.save();
    clipFrame(ctx, frame, 1, -frame.x, -frame.y);
    ctx.clip();
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(erasePreview.buffer, 0, 0);
    ctx.restore();
  }
  const center = polygonCenter(frame);
  for (const b of page.balloons) {
    const bx = b.x + b.w / 2;
    const by = b.y + b.h / 2;
    const inFrame =
      b.frameId === frame.id ||
      pointInFrame(frame, { x: bx, y: by }) ||
      Math.hypot(bx - center.x, by - center.y) < Math.max(frame.w, frame.h) * 0.35;
    if (!inFrame) continue;
    if (area) {
      const br: Rect = { x: b.x - frame.x, y: b.y - frame.y, w: b.w, h: b.h };
      if (!rectsIntersect(area, br)) continue;
    }
    drawBalloon(ctx, b, -frame.x, -frame.y, 1);
  }
  ctx.save();
  polygonPath(ctx, frame, 1, -frame.x, -frame.y);
  ctx.strokeStyle = "rgba(23,23,28,.55)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
  ctx.restore();
}

function drawSelectionHint(
  ctx: CanvasRenderingContext2D,
  tint: HTMLCanvasElement | null,
  bounds: SelectionBounds | null,
  area: Rect | null = null,
): void {
  ctx.save();
  if (area) {
    ctx.beginPath();
    ctx.rect(area.x, area.y, area.w, area.h);
    ctx.clip();
  }
  if (tint) {
    ctx.globalAlpha = 0.2;
    ctx.drawImage(tint, 0, 0);
    ctx.globalAlpha = 1;
  }
  if (bounds) {
    if (area) {
      const br: Rect = { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height };
      if (!rectsIntersect(area, br)) {
        ctx.restore();
        return;
      }
    }
    // 白色虚线打底、橙色虚线压上：无论底下是黑线、红块还是纸白，边界都看得见。
    const x = bounds.x + 1;
    const y = bounds.y + 1;
    const w = Math.max(1, bounds.width - 2);
    const h = Math.max(1, bounds.height - 2);
    ctx.setLineDash([8, 5]);
    ctx.lineWidth = 5;
    ctx.strokeStyle = "rgba(255,255,255,.92)";
    ctx.strokeRect(x, y, w, h);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#d75b2c";
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    const corners: [number, number][] = [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h],
    ];
    for (const [cx, cy] of corners) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(cx - 3, cy - 3, 6, 6);
      ctx.strokeStyle = "#d75b2c";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(cx - 3, cy - 3, 6, 6);
    }
  }
  ctx.restore();
}

function drawSelectionDraft(ctx: CanvasRenderingContext2D, draft: SelectionDraft): void {
  if (!draft) return;
  ctx.save();
  ctx.strokeStyle = "#d75b2c";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  if (draft.shape === "rect") {
    const x = Math.min(draft.a.x, draft.b.x);
    const y = Math.min(draft.a.y, draft.b.y);
    const w = Math.abs(draft.a.x - draft.b.x);
    const h = Math.abs(draft.a.y - draft.b.y);
    ctx.fillStyle = "rgba(215,91,44,.08)";
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  } else if (draft.points.length > 2) {
    ctx.beginPath();
    ctx.moveTo(draft.points[0].x, draft.points[0].y);
    for (let i = 1; i < draft.points.length; i += 1) {
      ctx.lineTo(draft.points[i].x, draft.points[i].y);
    }
    ctx.stroke();
    ctx.lineTo(draft.points[0].x, draft.points[0].y);
    ctx.fillStyle = "rgba(215,91,44,.08)";
    ctx.fill();
  }
  ctx.setLineDash([]);
  ctx.restore();
}

/** 图形工具：矩形 / 椭圆 / 直线，按住 Shift 约束成正方形、正圆或 45° 线。 */
function drawShapePath(
  ctx: CanvasRenderingContext2D,
  kind: ShapeKind,
  a: Point,
  b: Point,
  color: string,
  size: number,
  opacity: number,
  constrain: boolean,
): void {
  let end = b;
  if (constrain) {
    if (kind === "line") {
      const angle = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      end = { x: a.x + Math.cos(angle) * len, y: a.y + Math.sin(angle) * len };
    } else {
      const side = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      end = {
        x: a.x + Math.sign(b.x - a.x || 1) * side,
        y: a.y + Math.sign(b.y - a.y || 1) * side,
      };
    }
  }
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.globalAlpha = clamp(opacity, 0, 1);
  ctx.lineWidth = Math.max(1, size);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (kind === "line") {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  } else if (kind === "rect") {
    ctx.beginPath();
    ctx.rect(
      Math.min(a.x, end.x),
      Math.min(a.y, end.y),
      Math.abs(end.x - a.x),
      Math.abs(end.y - a.y),
    );
    ctx.stroke();
  } else {
    const cx = (a.x + end.x) / 2;
    const cy = (a.y + end.y) / 2;
    const rx = Math.abs(end.x - a.x) / 2;
    const ry = Math.abs(end.y - a.y) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** 落笔期间的主笔底图：背景 + 当前全部图层，一次性缓存。 */
function buildFocusBase(
  page: ComicPage,
  frame: ComicFrame,
  layerMap: Map<string, HTMLCanvasElement>,
  assetMap: Map<string, HTMLImageElement>,
  joint?: { layer: ComicJointLayer; frames: ComicFrame[]; mask: HTMLCanvasElement },
): HTMLCanvasElement {
  const canvas = createSurface(frame.w, frame.h, "#e9e3d8");
  const ctx = mustCtx(canvas);
  if (joint) {
    const content = createSurface(frame.w, frame.h, "#ffffff");
    const cctx = mustCtx(content);
    for (const item of joint.frames) {
      paintFrameContent(cctx, page, item, layerMap, assetMap, -frame.x, -frame.y, 1);
    }
    cctx.globalCompositeOperation = "destination-in";
    cctx.drawImage(joint.mask, 0, 0);
    cctx.globalCompositeOperation = "source-over";
    ctx.drawImage(content, 0, 0);
    const jointCanvas = layerMap.get(keyOf(joint.layer.id, joint.layer.id));
    if (jointCanvas && joint.layer.visible) {
      const clipped = createSurface(frame.w, frame.h);
      const lctx = mustCtx(clipped);
      lctx.drawImage(jointCanvas, 0, 0);
      lctx.globalCompositeOperation = "destination-in";
      lctx.drawImage(joint.mask, 0, 0);
      lctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = clamp(joint.layer.opacity, 0, 1);
      ctx.globalCompositeOperation = blendOperation(joint.layer.blendMode);
      ctx.drawImage(clipped, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
    return canvas;
  }
  ctx.save();
  clipFrame(ctx, frame, 1, -frame.x, -frame.y);
  ctx.clip();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  paintFrameContent(ctx, page, frame, layerMap, assetMap, -frame.x, -frame.y, 1);
  ctx.restore();
  return canvas;
}

/* ───────── 主组件 ───────── */

export function ComicWorkspace({
  path,
  meta,
  onBack,
  chapterId,
  firstChapterId,
  embedded = false,
}: {
  path: string;
  meta: BookMeta;
  onBack?: () => void;
  /** 漫画书进入某一章时，只呈现这一章的页面。 */
  chapterId?: string;
  /** 旧漫画工程没有 chapterId 的页面统一归到这本书的第一章。 */
  firstChapterId?: string;
  /** 嵌进小说同款工作台时隐藏漫画自带顶栏。 */
  embedded?: boolean;
}) {
  const [project, setProject] = useState<ComicProjectMeta | null>(null);
  const [page, setPage] = useState<ComicPage | null>(null);
  const [selectedFrames, setSelectedFramesState] = useState<string[]>([]);
  const [selectedBalloon, setSelectedBalloonState] = useState<string | null>(null);
  const [focusId, setFocusIdState] = useState<FocusMode>(null);
  const [focusGroup, setFocusGroupState] = useState<string[]>([]);
  const [activeLayerId, setActiveLayerIdState] = useState<string | null>(null);
  const [tool, setToolState] = useState<Tool>("select");
  const [brush, setBrushState] = useState<BrushSettings>({
    ...DEFAULT_BRUSH,
    size: 12,
    hardness: 88,
    opacity: 100,
    flow: 100,
    tip: "round",
    texture: "none",
    spacing: 7,
    smoothing: 0,
  });
  const [preset, setPreset] = useState("gpen");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [status, setStatus] = useState("正在打开漫画工程…");
  const [busy, setBusy] = useState(true);
  const [panelTab, setPanelTab] = useState<"layers" | "page" | "assets">("layers");
  const [brushSectionOpen, setBrushSectionOpen] = useState(false);
  const [mobileInspector, setMobileInspector] = useState(false);
  const [mobilePages, setMobilePages] = useState(false);
  const [mobileMulti, setMobileMulti] = useState(false);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [draftPoints, setDraftPoints] = useState<Point[]>([]);
  const [textEdit, setTextEdit] = useState<{
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    text: string;
  } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pageZoom, setPageZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateConfirm, setTemplateConfirm] = useState<string | null>(null);
  const [confirmDeletePage, setConfirmDeletePage] = useState<string | null>(null);
  const [, setPageFrameSelectedState] = useState(false);
  const [draftRect, setDraftRectState] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [guides, setGuidesState] = useState<{ x: number[]; y: number[] } | null>(null);
  const [magnet, setMagnetState] = useState(true);
  const [presetSaveOpen, setPresetSaveOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presetConfirm, setPresetConfirm] = useState<string | null>(null);
  const [presetMenu, setPresetMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [brushPanelOpen, setBrushPanelOpen] = useState(false);
  const [selectionShape, setSelectionShape] = useState<SelectionShape>("rect");
  const [selectionMenuOpen, setSelectionMenuOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [shapeKind, setShapeKindState] = useState<ShapeKind>("rect");
  const [shapeConstrain, setShapeConstrain] = useState(false);
  const [liquifyRadius, setLiquifyRadius] = useState(58);
  const [liquifyStrength, setLiquifyStrength] = useState(55);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterId, setFilterId] = useState<ComicFilterId>("adjust");
  const [filterOptions, setFilterOptions] = useState<ComicFilterOptions>(DEFAULT_FILTER_OPTIONS);
  const [hasClipboard, setHasClipboard] = useState(false);
  const [selection, setSelectionState] = useState<HTMLCanvasElement | null>(null);
  const [selectionTolerance, setSelectionTolerance] = useState(28);
  const [selectionExpand, setSelectionExpand] = useState(0);
  const [selectionContiguous, setSelectionContiguous] = useState(true);
  const [selectionCombine, setSelectionCombine] = useState<SelectionMode>("new");
  const [paletteColors, setPaletteColors] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PALETTE_COLORS_KEY) ?? "[]");
      return Array.isArray(saved) ? saved.filter((c) => typeof c === "string").slice(0, 16) : [];
    } catch {
      return [];
    }
  });
  const [customColorOpen, setCustomColorOpen] = useState(false);
  const [hsv, setHsv] = useState(() => hexToHsv("#17171c"));
  const [hexDraft, setHexDraft] = useState("#17171c");
  const [recentColors, setRecentColors] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(RECENT_COLORS_KEY) ?? "[]");
      return Array.isArray(saved) ? saved.filter((c) => typeof c === "string").slice(0, 8) : [];
    } catch {
      return [];
    }
  });
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [fitScale, setFitScale] = useState(1);
  const [focusFit, setFocusFit] = useState(1);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia("(max-width: 820px)").matches,
  );
  const [mobileZoomOpen, setMobileZoomOpen] = useState(false);
  const pagePressRef = useRef<{ id: string; timer: number } | null>(null);
  const pagePressFiredRef = useRef(false);
  const palettePressRef = useRef<{ id: string; timer: number } | null>(null);
  const palettePressFiredRef = useRef(false);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 820px)");
    const sync = () => setIsMobile(query.matches);
    sync();
    query.addEventListener?.("change", sync);
    return () => query.removeEventListener?.("change", sync);
  }, []);

  const visiblePages = useMemo(
    () =>
      project
        ? project.pages.filter((p) => (chapterId ? p.chapterId === chapterId : true))
        : [],
    [project, chapterId],
  );
  const pageRef = useRef<ComicPage | null>(null);
  const draftRef = useRef<Point[]>([]);
  const projectRef = useRef<ComicProjectMeta | null>(null);
  const layerMap = useRef(new Map<string, HTMLCanvasElement>());
  const assetMap = useRef(new Map<string, HTMLImageElement>());
  const pageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const focusCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const focusBaseRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const paperRef = useRef<HTMLDivElement | null>(null);
  const paperFitRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const strokeRef = useRef<StrokeSession | null>(null);
  const strokeDirtyRef = useRef<Rect | null>(null);
  const strokeLastPointRef = useRef<Point | null>(null);
  const liquifySessionRef = useRef<{
    frameId: string;
    layerId: string;
    before: HTMLCanvasElement;
    canvas: HTMLCanvasElement;
    last: Point;
    moved: boolean;
    mask: HTMLCanvasElement | null;
  } | null>(null);
  const shapeSessionRef = useRef<ShapeSession | null>(null);
  const moveSessionRef = useRef<MoveSession | null>(null);
  const filterSessionRef = useRef<FilterSession | null>(null);
  const clipboardRef = useRef<SelectionClipboard | null>(null);
  const renderPerfRef = useRef({ renders: 0, total: 0, max: 0, last: 0 });
  const selectionRef = useRef<HTMLCanvasElement | null>(null);
  const selectionCoreRef = useRef<HTMLCanvasElement | null>(null);
  const selectionTintRef = useRef<HTMLCanvasElement | null>(null);
  const selectionBoundsRef = useRef<SelectionBounds | null>(null);
  const selectionDraftRef = useRef<SelectionDraft>(null);
  const dragRef = useRef<DragState | null>(null);
  const undoRef = useRef<UndoEntry[]>([]);
  const redoRef = useRef<UndoEntry[]>([]);
  const selectedFramesRef = useRef<string[]>([]);
  const selectedBalloonRef = useRef<string | null>(null);
  const focusRef = useRef<string | null>(null);
  const focusGroupRef = useRef<string[]>([]);
  const focusFrameRef = useRef<ComicFrame | null>(null);
  const jointMaskRef = useRef<HTMLCanvasElement | null>(null);
  const activeLayerRef = useRef<string | null>(null);
  const toolRef = useRef<Tool>("select");
  const marqueeRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const pageFrameSelectedRef = useRef(false);
  const draftRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const guidesRef = useRef<{ x: number[]; y: number[] } | null>(null);
  const magnetRef = useRef(true);
  const saveTimer = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const textEditRef = useRef(textEdit);
  const brushRef = useRef(brush);
  const shapeKindRef = useRef<ShapeKind>(shapeKind);
  const pathRef = useRef(path);
  const pageIdRef = useRef<string | null>(null);
  const textBeforeRef = useRef<ComicPage | null>(null);

  textEditRef.current = textEdit;
  brushRef.current = brush;
  shapeKindRef.current = shapeKind;
  pathRef.current = path;
  (window as unknown as { __comicDebug?: unknown }).__comicDebug = {
    layerMap,
    pageRef,
    perf: renderPerfRef,
  };

  const setSelectedFrames = useCallback((ids: string[]) => {
    selectedFramesRef.current = ids;
    setSelectedFramesState(ids);
  }, []);

  const setSelectedBalloon = useCallback((id: string | null) => {
    selectedBalloonRef.current = id;
    setSelectedBalloonState(id);
  }, []);

  const setFocus = useCallback((id: FocusMode, group?: string[]) => {
    const ids = group ?? (id ? [id] : []);
    focusRef.current = id;
    focusGroupRef.current = ids;
    setFocusIdState(id);
    setFocusGroupState(ids);
    selectionRef.current = null;
    selectionCoreRef.current = null;
    selectionTintRef.current = null;
    selectionBoundsRef.current = null;
    selectionDraftRef.current = null;
    setSelectionState(null);
    setSelectionMenuOpen(false);
    if (id) {
      setToolState("brush");
      toolRef.current = "brush";
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
  }, []);

  const setTool = useCallback((next: Tool) => {
    toolRef.current = next;
    setToolState(next);
  }, []);

  const updateBrush = useCallback((patch: Partial<BrushSettings>) => {
    setBrushState((b) => {
      const next = { ...b, ...patch };
      brushRef.current = next;
      return next;
    });
  }, []);

  const chooseColor = useCallback(
    (color: string) => {
      updateBrush({ color });
      setHsv(hexToHsv(color));
      setHexDraft(color.toUpperCase());
      setTool("brush");
      setSelectionMenuOpen(false);
      setRecentColors((prev) => {
        const next = [color, ...prev.filter((c) => c.toLowerCase() !== color.toLowerCase())].slice(0, 8);
        try {
          localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(next));
        } catch {
          /* 本地存储不可用不影响画画 */
        }
        return next;
      });
    },
    [setTool, updateBrush],
  );

  const setActiveLayer = useCallback((id: string | null) => {
    activeLayerRef.current = id;
    setActiveLayerIdState(id);
  }, []);

  const commitPage = useCallback((next: ComicPage) => {
    pageRef.current = next;
    setPage(next);
    pageIdRef.current = next.id;
  }, []);

  const getLayer = useCallback((frame: ComicFrame, layerId: string): HTMLCanvasElement => {
    const key = keyOf(frame.id, layerId);
    let canvas = layerMap.current.get(key);
    if (!canvas) {
      canvas = createSurface(frame.w, frame.h);
      layerMap.current.set(key, canvas);
    }
    return canvas;
  }, []);

  const ensurePageLayers = useCallback(
    (p: ComicPage) => {
      for (const f of p.frames) {
        for (const l of f.layers) getLayer(f, l.id);
      }
      for (const joint of p.jointLayers ?? []) {
        getLayer(jointFrameOf(joint), joint.id);
      }
    },
    [getLayer],
  );

  const renderNow = useCallback(() => {
    const p = pageRef.current;
    if (!p) return;
    const started = performance.now();
    const focus = focusRef.current;
    if (focus) {
      const jointLayer = p.jointLayers?.find((item) => item.id === focus) ?? null;
      if (jointLayer && !jointMaskRef.current) {
        jointMaskRef.current = buildJointMask(
          p.frames.filter((item) => jointLayer.frameIds.includes(item.id)),
          jointLayer.rect,
          jointLayer.crossPanel,
        );
      }
      const joint =
        jointLayer && jointMaskRef.current
          ? {
              layer: jointLayer,
              frames: p.frames.filter((item) => jointLayer.frameIds.includes(item.id)),
              mask: jointMaskRef.current,
            }
          : undefined;
      const frame = joint ? jointFrameOf(joint.layer) : p.frames.find((f) => f.id === focus);
      const canvas = focusCanvasRef.current;
      if (!frame || !canvas) return;
      if (canvas.width !== Math.round(frame.w) || canvas.height !== Math.round(frame.h)) {
        canvas.width = Math.round(frame.w);
        canvas.height = Math.round(frame.h);
      }
      const strokeSession = strokeRef.current;
      const shapeSession = shapeSessionRef.current;
      // 只有「底图已经缓存」的连续落笔才走脏矩形；点下去的第一帧、收笔
      // 之后的合成都走全量，保证边界和气泡不会被切掉。
      const area = strokeSession
        ? strokeDirtyRef.current
        : shapeSession
          ? shapeSession.dirty
          : null;
      drawFocus(
        mustCtx(canvas),
        p,
        frame,
        layerMap.current,
        assetMap.current,
        strokeSession && !strokeSession.erase ? strokeSession.stroke : null,
        strokeSession ? focusBaseRef.current : shapeSession ? focusBaseRef.current : null,
        shapeSession?.preview ?? null,
        area,
        strokeSession?.erase ? strokeSession.stroke : null,
        joint,
      );
      drawSelectionHint(
        mustCtx(canvas),
        selectionTintRef.current,
        selectionBoundsRef.current,
        area,
      );
      drawSelectionDraft(mustCtx(canvas), selectionDraftRef.current);
      if (strokeSession) strokeDirtyRef.current = null;
      if (shapeSession) shapeSession.dirty = null;
    } else {
      const canvas = pageCanvasRef.current;
      if (!canvas) return;
      if (canvas.width !== Math.round(p.width) || canvas.height !== Math.round(p.height)) {
        canvas.width = Math.round(p.width);
        canvas.height = Math.round(p.height);
      }
      drawPage(mustCtx(canvas), p, layerMap.current, assetMap.current, {
        selectedFrames: selectedFramesRef.current,
        selectedBalloon: selectedBalloonRef.current,
        marquee: marqueeRef.current,
        draft: draftRef.current,
        draftRect: draftRectRef.current,
        pageFrameSelected: pageFrameSelectedRef.current,
        guides: guidesRef.current,
      });
    }
    const elapsed = performance.now() - started;
    const perf = renderPerfRef.current;
    perf.renders += 1;
    perf.last = elapsed;
    perf.total += elapsed;
    if (elapsed > perf.max) perf.max = elapsed;
  }, []);

  const scheduleRender = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      renderNow();
    });
  }, [renderNow]);

  useEffect(() => {
    if (tool !== "selection") setSelectionMenuOpen(false);
  }, [tool]);

  const clearSelection = useCallback(() => {
    selectionRef.current = null;
    selectionCoreRef.current = null;
    selectionTintRef.current = null;
    selectionBoundsRef.current = null;
    selectionDraftRef.current = null;
    setSelectionState(null);
    scheduleRender();
  }, [scheduleRender]);

  const commitSelection = useCallback(
    (shapeMask: HTMLCanvasElement, mode: SelectionMode) => {
      const core = combineSelection(selectionCoreRef.current, shapeMask, mode);
      const adjusted = selectionExpand > 0 ? expandSelection(shapeMask, selectionExpand) : shapeMask;
      const out = combineSelection(selectionRef.current, adjusted, mode);
      if (isSelectionEmpty(out)) {
        clearSelection();
        setStatus("没有选中任何像素");
        return;
      }
      selectionCoreRef.current = core;
      selectionRef.current = out;
      selectionTintRef.current = selectionTint(out);
      selectionBoundsRef.current = selectionBounds(out);
      setSelectionState(out);
      selectionDraftRef.current = null;
      setStatus(
        `${mode === "add" ? "加选" : mode === "subtract" ? "减选" : "框选"}完成 · 画笔和填充都会限制在选区里`,
      );
      scheduleRender();
    },
    [clearSelection, scheduleRender, selectionExpand],
  );

  // 拖动「扩展」时当前选区也跟着长，不用再重画一次。
  useEffect(() => {
    const core = selectionCoreRef.current;
    if (!core) return;
    const out = selectionExpand > 0 ? expandSelection(core, selectionExpand) : cloneSurface(core);
    selectionRef.current = out;
    selectionTintRef.current = selectionTint(out);
    selectionBoundsRef.current = selectionBounds(out);
    setSelectionState(out);
    scheduleRender();
  }, [scheduleRender, selectionExpand]);

  const invertSelection = useCallback(() => {
    const frame = focusFrameRef.current;
    if (!frame) return;
    const whole = rectMask(frame.w, frame.h, { x: 0, y: 0 }, { x: frame.w, y: frame.h });
    const out = selectionRef.current
      ? combineSelection(whole, selectionRef.current, "subtract")
      : whole;
    if (isSelectionEmpty(out)) {
      clearSelection();
      setStatus("反选后没有剩下像素");
      return;
    }
    selectionCoreRef.current = out;
    selectionRef.current = out;
    selectionTintRef.current = selectionTint(out);
    selectionBoundsRef.current = selectionBounds(out);
    setSelectionState(out);
    setStatus("已反选 · 画笔和填充都会限制在选区里");
    scheduleRender();
  }, [clearSelection, scheduleRender]);

  const selectAll = useCallback(() => {
    const frame = focusFrameRef.current;
    if (!frame) return;
    commitSelection(rectMask(frame.w, frame.h, { x: 0, y: 0 }, { x: frame.w, y: frame.h }), "new");
  }, [commitSelection]);

  const addPaletteColor = useCallback((color: string) => {
      setPaletteColors((prev) => {
        const next = [color, ...prev.filter((c) => c.toLowerCase() !== color.toLowerCase())].slice(0, 16);
        try {
          localStorage.setItem(PALETTE_COLORS_KEY, JSON.stringify(next));
        } catch {
          /* 本地存储不可用不影响画画 */
        }
        return next;
      });
    },
    [],
  );

  const removePaletteColor = useCallback((color: string) => {
    setPaletteColors((prev) => {
      const next = prev.filter((c) => c.toLowerCase() !== color.toLowerCase());
      try {
        localStorage.setItem(PALETTE_COLORS_KEY, JSON.stringify(next));
      } catch {
        /* 本地存储不可用不影响画画 */
      }
      return next;
    });
  }, []);

  const pickColorFromSV = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const s = clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
      const v = 1 - clamp((e.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
      const color = hsvToHex(hsv.h, s, v);
      setHsv((prev) => ({ ...prev, s, v }));
      setHexDraft(color.toUpperCase());
      updateBrush({ color });
      return color;
    },
    [hsv.h, updateBrush],
  );

  const clearDraft = useCallback(() => {
    draftRef.current = [];
    setDraftPoints([]);
    scheduleRender();
  }, [scheduleRender]);

  useEffect(() => {
    if (tool !== "panel" && draftRef.current.length) clearDraft();
  }, [clearDraft, tool]);

  const setPageFrameSelected = useCallback((value: boolean) => {
    pageFrameSelectedRef.current = value;
    setPageFrameSelectedState(value);
    scheduleRender();
  }, [scheduleRender]);

  const setDraftRect = useCallback((value: { x: number; y: number; w: number; h: number } | null) => {
    draftRectRef.current = value;
    setDraftRectState(value);
  }, []);

  const setGuides = useCallback((value: { x: number[]; y: number[] } | null) => {
    guidesRef.current = value;
    setGuidesState(value);
  }, []);

  const setMagnet = useCallback((value: boolean) => {
    magnetRef.current = value;
    setMagnetState(value);
  }, []);

  useEffect(() => {
    if (draftRef.current.length) {
      draftRef.current = [];
      setDraftPoints([]);
    }
  }, [page?.id]);

  const makeThumb = useCallback((p: ComicPage): string => {
    const w = 260;
    const h = Math.round((w * p.height) / Math.max(1, p.width));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    drawPage(mustCtx(canvas), p, layerMap.current, assetMap.current, {
      scale: w / p.width,
      thumb: true,
    });
    return canvas.toDataURL("image/png");
  }, []);

  const savePage = useCallback(async () => {
    const p = pageRef.current;
    if (!p) return;
    setSaveState("saving");
    try {
      const layers: { id: string; dataUrl: string }[] = [];
      for (const f of p.frames) {
        for (const l of f.layers) {
          const canvas = layerMap.current.get(keyOf(f.id, l.id));
          if (canvas) {
            layers.push({ id: l.id, dataUrl: canvas.toDataURL("image/png") });
          }
        }
      }
      for (const joint of p.jointLayers ?? []) {
        const canvas = layerMap.current.get(keyOf(joint.id, joint.id));
        if (canvas) {
          layers.push({ id: joint.id, dataUrl: canvas.toDataURL("image/png") });
        }
      }
      const next = { ...p, updatedAt: Date.now() };
      pageRef.current = next;
      await api.comicSavePage(pathRef.current, p.id, JSON.stringify(next), layers);
      const current = projectRef.current;
      if (current) {
        const pages = current.pages.map((x) =>
          x.id === p.id ? { ...x, title: next.title } : x,
        );
        const nextProject = {
          ...current,
          pages,
          currentPageId: p.id,
          updatedAt: Date.now(),
        };
        projectRef.current = nextProject;
        setProject(nextProject);
        await api.comicSaveProject(pathRef.current, JSON.stringify(nextProject));
      }
      const thumb = makeThumb(next);
      setThumbs((prev) => ({ ...prev, [p.id]: thumb }));
      await api.comicSaveThumbnail(pathRef.current, p.id, thumb).catch(() => undefined);
      setSaveState("saved");
      setStatus("已保存到本机");
    } catch (e) {
      setSaveState("error");
      setStatus(`保存失败：${String(e)}`);
    }
  }, [makeThumb]);

  const scheduleSave = useCallback(() => {
    setSaveState("dirty");
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void savePage();
    }, 1800);
  }, [savePage]);

  const openJointFocus = useCallback(
    (frameIds: string[]) => {
      const p = pageRef.current;
      const ids = Array.from(new Set(frameIds));
      if (!p || ids.length < 2) return;
      const frames = p.frames.filter((frame) => ids.includes(frame.id));
      if (frames.length < 2) return;
      const rect = jointRect(frames);
      if (!rect) return;
      const same = (joint: ComicJointLayer) =>
        joint.frameIds.length === ids.length && ids.every((id) => joint.frameIds.includes(id));
      let joint = p.jointLayers?.find(same) ?? null;
      if (!joint) {
        joint = {
          id: uid("j"),
          name: "跨格线稿",
          frameIds: ids,
          rect,
          crossPanel: false,
          visible: true,
          opacity: 1,
          locked: false,
          createdAt: Date.now(),
        };
        const next = clonePage(p);
        next.jointLayers = [...(next.jointLayers ?? []), joint];
        getLayer(jointFrameOf(joint), joint.id);
        commitPage(next);
      }
      setFocus(joint.id, ids);
      setActiveLayer(joint.id);
      setSelectedBalloon(null);
      setSelectedFrames(ids);
      setTool("brush");
      setMobileMulti(false);
      setStatus(`已进入 ${ids.length} 格并集 · 打开「跨格连画」可画进格缝`);
      scheduleRender();
      scheduleSave();
    },
    [
      commitPage,
      getLayer,
      scheduleRender,
      scheduleSave,
      setActiveLayer,
      setFocus,
      setSelectedBalloon,
      setSelectedFrames,
      setTool,
    ],
  );

  const toggleCrossPanel = useCallback(() => {
    const p = pageRef.current;
    const joint = p?.jointLayers?.find((item) => item.id === focusRef.current);
    if (!p || !joint) return;
    const next = clonePage(p);
    const target = next.jointLayers?.find((item) => item.id === joint.id);
    if (!target) return;
    target.crossPanel = !target.crossPanel;
    const jointFrames = target.frameIds
      .map((id) => p.frames.find((frame) => frame.id === id))
      .filter((frame): frame is NonNullable<typeof frame> => Boolean(frame));
    jointMaskRef.current = buildJointMask(jointFrames, target.rect, target.crossPanel);
    commitPage(next);
    const bridged =
      target.crossPanel &&
      (() => {
        const frames = target.frameIds
          .map((id) => p.frames.find((frame) => frame.id === id))
          .filter((frame): frame is NonNullable<typeof frame> => Boolean(frame));
        return jointGapBridged(frames, target.rect);
      })();
    if (target.crossPanel && !bridged) {
      setStatus("已打开跨格连画，但格间距超过 160px，格缝暂未桥接；把格拉近些再试");
    } else {
      setStatus(target.crossPanel ? "跨格连画已打开：笔迹可以穿过格缝" : "跨格连画已关闭：格缝不可画");
    }
    scheduleSave();
    scheduleRender();
  }, [commitPage, scheduleRender, scheduleSave]);

  const adoptPage = useCallback(
    async (payload: ComicPagePayload, resetHistory = true) => {
      const parsed = ensurePageFrame(JSON.parse(payload.json) as ComicPage);
      pageRef.current = parsed;
      setPage(parsed);
      pageIdRef.current = parsed.id;
      layerMap.current = new Map();
      assetMap.current = new Map();
      ensurePageLayers(parsed);
      setSelectedFrames(parsed.frames[0] ? [parsed.frames[0].id] : []);
      setSelectedBalloon(null);
      setFocus(null);
      setActiveLayer(parsed.frames[0]?.layers[0]?.id ?? null);
      setMarquee(null);
      marqueeRef.current = null;
      setZoom(1);
      setPageZoom(1);
      setPan({ x: 0, y: 0 });
      if (resetHistory) {
        undoRef.current = [];
        redoRef.current = [];
      }
      await Promise.all(
        payload.layers.map(async (layer) => {
          const frame = parsed.frames.find((f) => f.layers.some((l) => l.id === layer.id));
          const joint = parsed.jointLayers?.find((item) => item.id === layer.id);
          const target = frame ?? (joint ? jointFrameOf(joint) : null);
          if (!target) return;
          try {
            const img = await loadImage(layer.dataUrl);
            const canvas = getLayer(target, layer.id);
            mustCtx(canvas).drawImage(img, 0, 0, target.w, target.h);
          } catch {
            // 单张图层坏了不拖垮整页，空图层继续可画。
          }
        }),
      );
      await Promise.all(
        payload.assets.map(async (asset) => {
          try {
            assetMap.current.set(asset.path, await loadImage(asset.dataUrl));
          } catch {
            // 素材坏了，页面仍可打开。
          }
        }),
      );
      scheduleRender();
    },
    [ensurePageLayers, getLayer, scheduleRender, setActiveLayer, setFocus, setSelectedBalloon, setSelectedFrames],
  );

  const loadPage = useCallback(
    async (pageId: string, resetHistory = true) => {
      setBusy(true);
      setStatus("正在载入页面…");
      try {
        const payload = await api.comicReadPage(pathRef.current, pageId);
        await adoptPage(payload, resetHistory);
        setStatus("就绪");
      } catch (e) {
        setStatus(`载入失败：${String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [adoptPage],
  );

  /* 启动：读 project.json，再读当前页 */
  useEffect(() => {
    let live = true;
    const boot = async () => {
      setBusy(true);
      try {
        let proj = JSON.parse(await api.comicProject(path)) as ComicProjectMeta;
        if (chapterId) {
          const first = firstChapterId || chapterId;
          let migrated = false;
          for (const p of proj.pages) {
            if (!p.chapterId) {
              p.chapterId = first;
              migrated = true;
            }
          }
          if (migrated) {
            await api.comicSaveProject(path, JSON.stringify(proj));
          }
          let mine = proj.pages.filter((p) => p.chapterId === chapterId);
          if (!mine.length) {
            await api.comicNewPage(path, "第 1 页", chapterId);
            proj = JSON.parse(await api.comicProject(path)) as ComicProjectMeta;
            mine = proj.pages.filter((p) => p.chapterId === chapterId);
          }
          if (!live) return;
          projectRef.current = proj;
          setProject(proj);
          const current = mine.find((p) => p.id === proj.currentPageId) ?? mine[0];
          if (current) await loadPage(current.id, true);
        } else {
          if (!live) return;
          projectRef.current = proj;
          setProject(proj);
          await loadPage(proj.currentPageId || proj.pages[0]?.id, true);
        }
      } catch (e) {
        if (live) setStatus(`打开失败：${String(e)}`);
      } finally {
        if (live) setBusy(false);
      }
    };
    void boot();
    return () => {
      live = false;
    };
  }, [chapterId, firstChapterId, loadPage, path]);

  /* 尺寸：页面适配窗口 */
  useEffect(() => {
    const calc = () => {
      const stage = stageRef.current;
      const p = pageRef.current;
      if (!stage || !p) return;
      const compact = window.matchMedia("(max-width: 820px)").matches;
      const w = Math.max(120, stage.clientWidth - (compact ? 20 : 110));
      const h = Math.max(120, stage.clientHeight - (compact ? 150 : 158));
      setFitScale(Math.min(w / p.width, h / p.height, 1.35));
      const frame = focusFrameRef.current;
      if (frame) {
        const fw = Math.max(120, stage.clientWidth - (compact ? 24 : 120));
        const fh = Math.max(120, stage.clientHeight - (compact ? 150 : 188));
        setFocusFit(Math.min(fw / frame.w, fh / frame.h, 3.2));
      }
    };
    calc();
    const ro = new ResizeObserver(calc);
    if (stageRef.current) ro.observe(stageRef.current);
    window.addEventListener("resize", calc);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", calc);
    };
  }, [page?.id, focusId]);

  useEffect(() => {
    scheduleRender();
  }, [selectedFrames, selectedBalloon, page, focusId, marquee, busy, scheduleRender]);

  const focusJoint = useMemo(() => {
    if (!page || !focusId) return null;
    return page.jointLayers?.find((joint) => joint.id === focusId) ?? null;
  }, [page, focusId]);

  const focusFrames = useMemo(() => {
    if (!page || !focusId) return [];
    const ids = focusJoint?.frameIds ?? focusGroup;
    return page.frames.filter((frame) => ids.includes(frame.id));
  }, [focusGroup, focusId, focusJoint, page]);

  const focusFrame = useMemo(() => {
    if (focusJoint) return jointFrameOf(focusJoint);
    if (!page || !focusId) return null;
    return page.frames.find((frame) => frame.id === focusId) ?? null;
  }, [focusId, focusJoint, page]);

  const focusMask = useMemo(() => {
    if (!focusJoint) return null;
    return buildJointMask(focusFrames, focusJoint.rect, focusJoint.crossPanel);
  }, [focusFrames, focusJoint]);

  focusFrameRef.current = focusFrame;
  jointMaskRef.current = focusMask;

  const activeFrame = useMemo(() => {
    if (focusFrame) return focusFrame;
    if (!page) return null;
    const id = selectedFrames[0];
    return id ? page.frames.find((frame) => frame.id === id) ?? null : null;
  }, [focusFrame, page, selectedFrames]);

  const activeLayer = useMemo(() => {
    if (!activeFrame) return null;
    return activeFrame.layers.find((l) => l.id === activeLayerId) ?? activeFrame.layers[0] ?? null;
  }, [activeFrame, activeLayerId]);

  useEffect(() => {
    if (activeFrame && !activeFrame.layers.some((l) => l.id === activeLayerRef.current)) {
      setActiveLayer(activeFrame.layers[0]?.id ?? null);
    }
  }, [activeFrame, setActiveLayer]);

  const pushUndo = useCallback((entry: UndoEntry) => {
    undoRef.current.push(entry);
    if (undoRef.current.length > 60) undoRef.current.shift();
    redoRef.current = [];
  }, []);

  const applyPageChange = useCallback(
    (next: ComicPage, before: ComicPage) => {
      commitPage(next);
      pushUndo({ kind: "page", before, after: clonePage(next) });
      scheduleSave();
      scheduleRender();
    },
    [commitPage, pushUndo, scheduleRender, scheduleSave],
  );

  const undo = useCallback(() => {
    const entry = undoRef.current.pop();
    if (!entry) {
      setStatus("没有可撤销的操作");
      return;
    }
    if (entry.kind === "stroke") {
      const frame = pageRef.current?.frames.find((f) => f.id === entry.frameId);
      if (frame) {
        const canvas = getLayer(frame, entry.layerId);
        mustCtx(canvas).clearRect(0, 0, canvas.width, canvas.height);
        mustCtx(canvas).drawImage(entry.before, 0, 0);
        redoRef.current.push(entry);
      }
    } else if (entry.kind === "page") {
      commitPage(clonePage(entry.before));
      if (entry.beforeLayers?.length) {
        layerMap.current = withLayerSnapshots(layerMap.current, entry.beforeLayers);
      }
      redoRef.current.push(entry);
    } else {
      commitPage(clonePage(entry.beforePage));
      const frame = entry.beforePage.frames.find((f) => f.id === entry.frameId);
      if (frame) {
        for (const item of entry.beforeLayers) {
          layerMap.current.set(keyOf(frame.id, item.layerId), item.canvas);
        }
      }
      redoRef.current.push(entry);
    }
    const restored = pageRef.current;
    if (restored) setThumbs((prev) => ({ ...prev, [restored.id]: makeThumb(restored) }));
    setStatus("已撤销");
    scheduleSave();
    scheduleRender();
  }, [commitPage, getLayer, makeThumb, scheduleRender, scheduleSave]);

  const redo = useCallback(() => {
    const entry = redoRef.current.pop();
    if (!entry) {
      setStatus("没有可重做的操作");
      return;
    }
    if (entry.kind === "stroke") {
      const frame = pageRef.current?.frames.find((f) => f.id === entry.frameId);
      if (frame) {
        const canvas = getLayer(frame, entry.layerId);
        mustCtx(canvas).clearRect(0, 0, canvas.width, canvas.height);
        mustCtx(canvas).drawImage(entry.after, 0, 0);
        undoRef.current.push(entry);
      }
    } else if (entry.kind === "page") {
      commitPage(clonePage(entry.after));
      if (entry.afterLayers?.length) {
        layerMap.current = withLayerSnapshots(layerMap.current, entry.afterLayers);
      }
      undoRef.current.push(entry);
    } else {
      commitPage(clonePage(entry.afterPage));
      const frame = entry.afterPage.frames.find((f) => f.id === entry.frameId);
      if (frame) {
        for (const layer of frame.layers) {
          const key = keyOf(frame.id, layer.id);
          const old = layerMap.current.get(key);
          if (!old) continue;
          const next = createSurface(frame.w, frame.h);
          mustCtx(next).drawImage(old, 0, 0, frame.w, frame.h);
          layerMap.current.set(key, next);
        }
      }
      undoRef.current.push(entry);
    }
    const restored = pageRef.current;
    if (restored) setThumbs((prev) => ({ ...prev, [restored.id]: makeThumb(restored) }));
    setStatus("已重做");
    scheduleSave();
    scheduleRender();
  }, [commitPage, getLayer, makeThumb, scheduleRender, scheduleSave]);

  /* ───────── 画世界 Pro 式高级工具 ───────── */

  const paintMaskForLayer = useCallback(
    (
      frame: ComicFrame,
      meta: ComicLayerMeta,
      canvas: HTMLCanvasElement,
    ): HTMLCanvasElement | null => {
      let mask = selectionRef.current;
      if (frame.id === meta.id && jointMaskRef.current) {
        mask = mask ? intersectMasks(mask, jointMaskRef.current) : jointMaskRef.current;
        if (meta.alphaLocked) mask = intersectMasks(mask, cloneSurface(canvas));
        return mask;
      }
      if (meta.alphaLocked) {
        // 锁定透明：用画布 alpha 当遮罩，必须先 clone，否则会拿正在变的画布
        // 反过来裁自己。
        mask = intersectMasks(mask, cloneSurface(canvas));
      }
      if (meta.clipping) {
        const idx = frame.layers.findIndex((l) => l.id === meta.id);
        for (let i = idx - 1; i >= 0; i -= 1) {
          const below = frame.layers[i];
          if (!below.visible) continue;
          const belowCanvas = layerMap.current.get(keyOf(frame.id, below.id));
          if (belowCanvas) {
            mask = intersectMasks(mask, cloneSurface(belowCanvas));
            break;
          }
        }
        if (!mask || isSelectionEmpty(mask)) {
          // 没有下层像素时剪贴层什么也不显示。
          return createSurface(frame.w, frame.h);
        }
      }
      return mask;
    },
    [],
  );

  const copyActiveSelection = useCallback(
    (cut: boolean) => {
      const p = pageRef.current;
      const frame = focusFrameRef.current;
      const meta = frame?.layers.find((l) => l.id === activeLayerRef.current) ?? frame?.layers[0];
      if (!p || !frame || !meta) {
        setStatus("先双击一个格进入聚焦，再复制选区");
        return;
      }
      if (cut && meta.locked) {
        setStatus("当前图层已锁定");
        return;
      }
      const canvas = getLayer(frame, meta.id);
      const mask = selectionRef.current;
      const bounds = mask
        ? selectionBounds(mask)
        : { x: 0, y: 0, width: frame.w, height: frame.h };
      if (!bounds) {
        setStatus("选区是空的");
        return;
      }
      const clip = createSurface(bounds.width, bounds.height);
      const cctx = mustCtx(clip);
      cctx.drawImage(canvas, -bounds.x, -bounds.y);
      if (mask) {
        cctx.globalCompositeOperation = "destination-in";
        cctx.drawImage(mask, -bounds.x, -bounds.y);
        cctx.globalCompositeOperation = "source-over";
      }
      clipboardRef.current = { image: clip, x: bounds.x, y: bounds.y, fromCut: cut };
      setHasClipboard(true);
      if (cut) {
        const before = cloneSurface(canvas);
        const ctx = mustCtx(canvas);
        if (mask) {
          ctx.globalCompositeOperation = "destination-out";
          ctx.drawImage(mask, 0, 0);
          ctx.globalCompositeOperation = "source-over";
        } else {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        pushUndo({
          kind: "stroke",
          frameId: frame.id,
          layerId: meta.id,
          before,
          after: cloneSurface(canvas),
        });
        scheduleSave();
        scheduleRender();
        setStatus("已剪切选区内容");
      } else {
        setStatus("已复制选区内容，可从汉堡菜单粘贴成新图层");
      }
    },
    [getLayer, pushUndo, scheduleRender, scheduleSave],
  );

  const copySelection = useCallback(() => copyActiveSelection(false), [copyActiveSelection]);
  const cutActiveSelection = useCallback(() => copyActiveSelection(true), [copyActiveSelection]);

  const pasteClipboard = useCallback(() => {
    const clip = clipboardRef.current;
    const p = pageRef.current;
    const frame = focusFrameRef.current;
    if (!clip || !p || !frame) {
      setStatus("剪切板是空的，先复制一个选区");
      return;
    }
    if (p.jointLayers?.some((joint) => joint.id === frame.id)) {
      setStatus("跨格线稿暂不支持粘贴；退出多格后可在单格图层粘贴");
      return;
    }
    const before = clonePage(p);
    const beforeLayers = snapshotPageLayers(p, layerMap.current);
    const meta: ComicLayerMeta = {
      id: uid("l"),
      name: "粘贴",
      kind: "raster",
      visible: true,
      opacity: 1,
      locked: false,
    };
    const target = getLayer(frame, meta.id);
    mustCtx(target).drawImage(clip.image, clip.x, clip.y);
    const next = clonePage(p);
    const nextFrame = next.frames.find((f) => f.id === frame.id);
    nextFrame?.layers.push(meta);
    setActiveLayer(meta.id);
    commitPage(next);
    const afterLayers = snapshotPageLayers(next, layerMap.current);
    pushUndo({
      kind: "page",
      before,
      after: clonePage(next),
      beforeLayers,
      afterLayers,
    });
    scheduleSave();
    scheduleRender();
    setStatus("已粘贴到新图层；要挪位置就切到移动工具");
  }, [commitPage, getLayer, pushUndo, scheduleRender, scheduleSave, setActiveLayer]);

  const flipActiveLayer = useCallback(
    (axis: "h" | "v") => {
      const frame = focusFrameRef.current;
      const meta = frame?.layers.find((l) => l.id === activeLayerRef.current) ?? frame?.layers[0];
      if (!frame || !meta) return;
      if (meta.locked) {
        setStatus("当前图层已锁定");
        return;
      }
      const canvas = getLayer(frame, meta.id);
      const before = cloneSurface(canvas);
      const after = createSurface(canvas.width, canvas.height);
      const ctx = mustCtx(after);
      if (axis === "h") {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
      } else {
        ctx.translate(0, canvas.height);
        ctx.scale(1, -1);
      }
      ctx.drawImage(before, 0, 0);
      replaceSurface(canvas, after);
      pushUndo({
        kind: "stroke",
        frameId: frame.id,
        layerId: meta.id,
        before,
        after: cloneSurface(canvas),
      });
      scheduleSave();
      scheduleRender();
      setStatus(axis === "h" ? "当前图层已水平翻转" : "当前图层已垂直翻转");
    },
    [getLayer, pushUndo, scheduleRender, scheduleSave],
  );

  const clearActiveLayer = useCallback(() => {
    const frame = focusFrameRef.current;
    const meta = frame?.layers.find((l) => l.id === activeLayerRef.current) ?? frame?.layers[0];
    if (!frame || !meta) return;
    if (meta.locked) {
      setStatus("当前图层已锁定");
      return;
    }
    const canvas = getLayer(frame, meta.id);
    const before = cloneSurface(canvas);
    mustCtx(canvas).clearRect(0, 0, canvas.width, canvas.height);
    pushUndo({
      kind: "stroke",
      frameId: frame.id,
      layerId: meta.id,
      before,
      after: cloneSurface(canvas),
    });
    scheduleSave();
    scheduleRender();
    setStatus("当前图层已清空");
  }, [getLayer, pushUndo, scheduleRender, scheduleSave]);

  const openFilter = useCallback(
    (id: ComicFilterId) => {
      const frame = focusFrameRef.current;
      const meta = frame?.layers.find((l) => l.id === activeLayerRef.current) ?? frame?.layers[0];
      if (!frame || !meta) {
        setStatus("先双击一个格进入聚焦，再用滤镜");
        return;
      }
      if (meta.locked) {
        setStatus("当前图层已锁定");
        return;
      }
      const canvas = getLayer(frame, meta.id);
      filterSessionRef.current = {
        frameId: frame.id,
        layerId: meta.id,
        before: cloneSurface(canvas),
      };
      setFilterOptions({ ...DEFAULT_FILTER_OPTIONS });
      setFilterId(id);
      setFilterOpen(true);
      setAdvancedOpen(false);
      setStatus("滤镜预览中，拖动参数可实时看效果");
    },
    [getLayer],
  );

  const applyFilterDraft = useCallback(
    (id: ComicFilterId, opts: ComicFilterOptions) => {
      const session = filterSessionRef.current;
      const p = pageRef.current;
      if (!session || !p) return;
      const frame = frameById(p, session.frameId);
      if (!frame) return;
      const canvas = getLayer(frame, session.layerId);
      const result = applyComicFilter(session.before, id, opts, selectionRef.current);
      replaceSurface(canvas, result);
      scheduleRender();
    },
    [getLayer, scheduleRender],
  );

  useEffect(() => {
    if (!filterOpen) return;
    applyFilterDraft(filterId, filterOptions);
  }, [applyFilterDraft, filterId, filterOpen, filterOptions]);

  const cancelFilter = useCallback(() => {
    const session = filterSessionRef.current;
    const p = pageRef.current;
    if (session && p) {
      const frame = frameById(p, session.frameId);
      if (frame) replaceSurface(getLayer(frame, session.layerId), session.before);
    }
    filterSessionRef.current = null;
    setFilterOpen(false);
    scheduleRender();
    setStatus("已取消滤镜");
  }, [getLayer, scheduleRender]);

  const commitFilter = useCallback(() => {
    const session = filterSessionRef.current;
    const p = pageRef.current;
    if (!session || !p) {
      setFilterOpen(false);
      return;
    }
    const frame = frameById(p, session.frameId);
    if (frame) {
      const canvas = getLayer(frame, session.layerId);
      pushUndo({
        kind: "stroke",
        frameId: frame.id,
        layerId: session.layerId,
        before: session.before,
        after: cloneSurface(canvas),
      });
    }
    filterSessionRef.current = null;
    setFilterOpen(false);
    scheduleSave();
    scheduleRender();
    setStatus("滤镜已应用到当前图层");
  }, [getLayer, pushUndo, scheduleRender, scheduleSave]);

  const startShapeTool = (kind: ShapeKind) => {
    setShapeKindState(kind);
    shapeKindRef.current = kind;
    setTool("shape");
    setAdvancedOpen(false);
    setSelectionMenuOpen(false);
    setStatus(
      kind === "rect"
        ? "图形：拖一个矩形，按住 Shift 画正方形"
        : kind === "ellipse"
          ? "图形：拖一个椭圆，按住 Shift 画正圆"
          : "图形：拖一条直线，按住 Shift 锁定 45°",
    );
  };

  const startMoveTool = () => {
    setTool("move");
    setAdvancedOpen(false);
    setSelectionMenuOpen(false);
    setStatus(
      focusRef.current
        ? "移动：拖动画面挪当前图层；有选区时只挪选区内容"
        : "先双击一个格进入聚焦，再移动图层",
    );
  };

  const startLiquifyTool = () => {
    setTool("liquify");
    setSelectionMenuOpen(false);
    setStatus(
      focusRef.current
        ? "液化：按住并推动像素；半径和力度可在进阶工具里调"
        : "先双击一个格进入聚焦，再液化",
    );
  };

  /* ───────── 键盘 ───────── */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void savePage();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (e.key === "Escape") {
        if (selectionMenuOpen) {
          setSelectionMenuOpen(false);
        } else if (selectionDraftRef.current) {
          selectionDraftRef.current = null;
          scheduleRender();
          setStatus("已取消这次框选");
        } else if (selectionRef.current) {
          clearSelection();
          setStatus("已取消选区");
        } else if (draftRef.current.length) {
          clearDraft();
          setStatus("已取消手绘分格");
        } else if (focusRef.current) {
          setFocus(null);
          setTool("select");
        } else {
          setSelectedFrames([]);
          setSelectedBalloon(null);
        }
        return;
      }
      if (focusRef.current && e.key.toLowerCase() === "b") setTool("brush");
      if (e.key.toLowerCase() === "e") setTool("eraser");
      if (!focusRef.current && e.key.toLowerCase() === "v") setTool("select");
      if (!focusRef.current && e.key.toLowerCase() === "p") setTool("panel");
      if (e.key === "[" || e.key === "]") {
        const delta = e.key === "[" ? -4 : 4;
        setBrushState((b) => {
          const next = { ...b, size: clamp(b.size + delta, 2, 180) };
          brushRef.current = next;
          return next;
        });
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [clearDraft, clearSelection, redo, savePage, scheduleRender, selectionMenuOpen, setFocus, setSelectedBalloon, setSelectedFrames, setTool, undo]);

  /* ───────── 保存时机 ───────── */

  useEffect(() => {
    const onBlur = () => {
      if (saveState === "dirty") void savePage();
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [savePage, saveState]);

  /* ───────── 坐标 ───────── */

  const toPagePoint = useCallback((clientX: number, clientY: number): Point | null => {
    const p = pageRef.current;
    const canvas = pageCanvasRef.current;
    if (!p || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / Math.max(1, rect.width)) * p.width,
      y: ((clientY - rect.top) / Math.max(1, rect.height)) * p.height,
    };
  }, []);

  const toFocusPoint = useCallback((clientX: number, clientY: number): Point | null => {
    const frame = focusFrameRef.current;
    const canvas = focusCanvasRef.current;
    if (!frame || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / Math.max(1, rect.width)) * frame.w,
      y: ((clientY - rect.top) / Math.max(1, rect.height)) * frame.h,
    };
  }, []);

  /* ───────── 页面交互 ───────── */

  const beginMarquee = (pt: Point, additive: boolean) => {
    const p = pageRef.current;
    if (!p) return;
    if (!additive) {
      setSelectedFrames([]);
      setSelectedBalloon(null);
    }
    dragRef.current = {
      mode: "marquee",
      start: pt,
      pageBefore: clonePage(p),
      moved: false,
    };
    marqueeRef.current = { x: pt.x, y: pt.y, w: 0, h: 0 };
    setMarquee(marqueeRef.current);
    scheduleRender();
  };

  const addDraftPoint = (pt: Point) => {
    const p = pageRef.current;
    if (!p) return;
    const nextPoints = [...draftRef.current, pt];
    if (nextPoints.length < 4) {
      draftRef.current = nextPoints;
      setDraftPoints(nextPoints);
      setStatus(`手绘分格：已点第 ${nextPoints.length} / 4 个角`);
      scheduleRender();
      return;
    }
    draftRef.current = [];
    setDraftPoints([]);
    const drawn = makeDrawnFrame(
      nextPoints.map((q) => [q.x, q.y] as [number, number]),
    );
    if (!drawn) {
      setStatus("这个四边形的边交叉或面积太小，重新点四个角");
      scheduleRender();
      return;
    }
    const before = clonePage(p);
    const next = clonePage(p);
    next.frames.push(drawn);
    ensurePageLayers(next);
    setSelectedFrames([drawn.id]);
    setActiveLayer(drawn.layers[0]?.id ?? null);
    setSelectedBalloon(null);
    setPanelTab("layers");
    setTool("select");
    applyPageChange(next, before);
    setStatus("手绘分格已加入，点格内继续画");
  };

  const onPagePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = pageRef.current;
    if (!p || busy) return;
    const pt = toPagePoint(e.clientX, e.clientY);
    if (!pt) return;
    if (mobileMulti) {
      const frame = framesForPoint(p, pt);
      if (frame) {
        const ids = selectedFramesRef.current;
        const already = ids.includes(frame.id);
        const next = already ? ids.filter((x) => x !== frame.id) : [...ids, frame.id];
        setSelectedFrames(next);
        setSelectedBalloon(null);
        setStatus(`已选 ${next.length} 格，再点「一起画」`);
      } else {
        setSelectedFrames([]);
        setSelectedBalloon(null);
        setStatus("点格选中，至少两格后一起画");
      }
      scheduleRender();
      return;
    }
    if (toolRef.current === "panel") {
      setPageFrameSelected(false);
      addDraftPoint(pt);
      return;
    }
    if (toolRef.current === "frame") {
      setSelectedFrames([]);
      setSelectedBalloon(null);
      setPageFrameSelected(false);
      dragRef.current = {
        mode: "createRect",
        start: pt,
        pageBefore: clonePage(p),
        moved: false,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (toolRef.current === "selection") {
      setStatus("选区只能在格内聚焦里用：先双击一个格进去");
      return;
    }
    const pf = pageFrameOf(p);
    if (toolRef.current === "pageframe") {
      setSelectedFrames([]);
      setSelectedBalloon(null);
      setPageFrameSelected(true);
      const handle = pageFrameHandleAt(pf, pt);
      dragRef.current = {
        mode: handle ? "resizePageFrame" : "movePageFrame",
        start: pt,
        pageBefore: clonePage(p),
        moved: false,
        handle: handle ?? undefined,
        pageFrameBefore: { ...pf },
        origRect: { x: pf.x, y: pf.y, w: pf.w, h: pf.h },
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      setStatus(handle ? "拖动外框边角改大小" : "拖动整页外框");
      return;
    }
    if (e.detail >= 2 && !mobileMulti) {
      const frame = framesForPoint(p, pt);
      if (frame) {
        setSelectedFrames([frame.id]);
        setActiveLayer(frame.layers[0]?.id ?? null);
        setFocus(frame.id);
        setStatus(`已进入 ${frame.id} 格内`);
        return;
      }
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    if (textEditRef.current) commitTextEdit();

    if (toolRef.current === "balloon") {
      const frame = framesForPoint(p, pt);
      const b: ComicBalloon = {
        id: uid("b"),
        frameId: frame?.id,
        x: clamp(pt.x - 150, 20, p.width - 320),
        y: clamp(pt.y - 80, 20, p.height - 220),
        w: 300,
        h: 170,
        text: "",
        fontSize: 42,
        shape: "ellipse",
        tailX: clamp(pt.x - 40, 20, p.width - 20),
        tailY: clamp(pt.y + 150, 20, p.height - 20),
        align: "center",
      };
      const next = clonePage(p);
      next.balloons.push(b);
      applyPageChange(next, p);
      setSelectedBalloon(b.id);
      setSelectedFrames([]);
      openTextEdit(b);
      setTool("select");
      return;
    }

    if (selectedBalloonRef.current) {
      const b = p.balloons.find((x) => x.id === selectedBalloonRef.current);
      if (b && Math.hypot(pt.x - b.tailX, pt.y - b.tailY) <= 42) {
        dragRef.current = {
          mode: "tail",
          start: pt,
          pageBefore: clonePage(p),
          moved: false,
          balloonId: b.id,
          balloonBefore: { ...b },
        };
        return;
      }
    }

    const balloon = balloonForPoint(p, pt);
    if (balloon) {
      setPageFrameSelected(false);
      setSelectedBalloon(balloon.id);
      setSelectedFrames([]);
      dragRef.current = {
        mode: "moveBalloon",
        start: pt,
        pageBefore: clonePage(p),
        moved: false,
        balloonId: balloon.id,
        balloonBefore: { ...balloon },
      };
      scheduleRender();
      return;
    }

    if (selectedFramesRef.current.length === 1) {
      const f = p.frames.find((x) => x.id === selectedFramesRef.current[0]);
      if (f) {
        const handle = handleAt(f, pt);
        if (handle) {
          if (handle.startsWith("v")) {
            dragRef.current = {
              mode: "moveVertex",
              start: pt,
              pageBefore: clonePage(p),
              moved: false,
              frameId: f.id,
              vertexIndex: Number(handle.slice(1)),
              origPoints: framePolygon(f),
              origRect: { x: f.x, y: f.y, w: f.w, h: f.h },
            };
            return;
          }
          dragRef.current = {
            mode: "resizeFrame",
            start: pt,
            pageBefore: clonePage(p),
            moved: false,
            frameId: f.id,
            handle,
            origRect: { x: f.x, y: f.y, w: f.w, h: f.h },
          };
          return;
        }
      }
    }

    const frame = framesForPoint(p, pt);
    if (frame) {
      setPageFrameSelected(false);
      const already = selectedFramesRef.current.includes(frame.id);
      let ids = selectedFramesRef.current;
      if (e.shiftKey || mobileMulti) {
        ids = already ? ids.filter((x) => x !== frame.id) : [...ids, frame.id];
      } else if (!already || ids.length !== 1) {
        ids = [frame.id];
      }
      setSelectedFrames(ids);
      setSelectedBalloon(null);
      if (ids.includes(frame.id)) {
        dragRef.current = {
          mode: "moveFrames",
          start: pt,
          pageBefore: clonePage(p),
          moved: false,
          frames: p.frames
            .filter((f) => ids.includes(f.id))
            .map((f) => ({ id: f.id, x: f.x, y: f.y, w: f.w, h: f.h })),
        };
      }
      scheduleRender();
      return;
    }

    beginMarquee(pt, e.shiftKey);
  };

  const onPagePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (strokeRef.current) return;
    const drag = dragRef.current;
    const p = pageRef.current;
    if (!drag || !p) return;
    const pt = toPagePoint(e.clientX, e.clientY);
    if (!pt) return;
    const dx = pt.x - drag.start.x;
    const dy = pt.y - drag.start.y;
    if (Math.hypot(dx, dy) > 3) drag.moved = true;

    if (drag.mode === "createRect") {
      const pf = pageFrameOf(p);
      let x1 = Math.min(drag.start.x, pt.x);
      let y1 = Math.min(drag.start.y, pt.y);
      let x2 = Math.max(drag.start.x, pt.x);
      let y2 = Math.max(drag.start.y, pt.y);
      x1 = clamp(x1, pf.x, pf.x + pf.w - 20);
      y1 = clamp(y1, pf.y, pf.y + pf.h - 20);
      x2 = clamp(x2, pf.x + 20, pf.x + pf.w);
      y2 = clamp(y2, pf.y + 20, pf.y + pf.h);
      if (magnetRef.current) {
        const refs = referenceTargets(p, p.frames);
        refs.xs.push(pf.x, pf.x + pf.w, pf.x + pf.w / 2);
        refs.ys.push(pf.y, pf.y + pf.h, pf.y + pf.h / 2);
        const snap = snapRect({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, refs.xs, refs.ys);
        const dxs = snap.rect.x - x1;
        const dys = snap.rect.y - y1;
        x1 = snap.rect.x;
        y1 = snap.rect.y;
        x2 += dxs;
        y2 += dys;
        setGuides(snap.guides);
      } else {
        setGuides(null);
      }
      setDraftRect({ x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) });
      scheduleRender();
      return;
    }
    if ((drag.mode === "movePageFrame" || drag.mode === "resizePageFrame") && drag.pageFrameBefore) {
      const next = clonePage(drag.pageBefore);
      const base = drag.pageFrameBefore;
      let rect = { x: base.x, y: base.y, w: base.w, h: base.h };
      if (drag.mode === "movePageFrame") {
        rect.x = clamp(base.x + dx, 0, p.width - base.w);
        rect.y = clamp(base.y + dy, 0, p.height - base.h);
      } else {
        rect = resizeByHandle(base, drag.handle ?? "se", dx, dy, p.width, p.height);
      }
      if (magnetRef.current) {
        const refs = referenceTargets(p, p.frames);
        const snap = snapRect(rect, refs.xs, refs.ys);
        rect = snap.rect;
        setGuides(snap.guides);
      } else {
        setGuides(null);
      }
      next.pageFrame = { ...rect, stroke: base.stroke };
      commitPage(next);
      scheduleRender();
      return;
    }
    if (drag.mode === "marquee") {
      marqueeRef.current = {
        x: Math.min(drag.start.x, pt.x),
        y: Math.min(drag.start.y, pt.y),
        w: Math.abs(pt.x - drag.start.x),
        h: Math.abs(pt.y - drag.start.y),
      };
      setMarquee(marqueeRef.current);
      scheduleRender();
      return;
    }
    if (drag.mode === "moveFrames" && drag.frames) {
      const next = clonePage(drag.pageBefore);
      const movingIds = new Set(drag.frames.map((f) => f.id));
      const pf = pageFrameOf(p);
      for (const item of drag.frames) {
        const f = next.frames.find((x) => x.id === item.id);
        if (!f) continue;
        let nx = clamp(item.x + dx, -f.w * 0.35, p.width - f.w * 0.65);
        let ny = clamp(item.y + dy, -f.h * 0.35, p.height - f.h * 0.65);
        if (magnetRef.current && drag.frames.length === 1) {
          const refs = referenceTargets(p, p.frames.filter((x) => !movingIds.has(x.id)));
          refs.xs.push(pf.x, pf.x + pf.w, pf.x + pf.w / 2);
          refs.ys.push(pf.y, pf.y + pf.h, pf.y + pf.h / 2);
          const snap = snapRect({ x: nx, y: ny, w: f.w, h: f.h }, refs.xs, refs.ys);
          nx = snap.rect.x;
          ny = snap.rect.y;
          setGuides(snap.guides);
        } else {
          setGuides(null);
        }
        f.x = nx;
        f.y = ny;
      }
      commitPage(next);
      scheduleRender();
      return;
    }
    if (drag.mode === "moveVertex" && drag.frameId && drag.origPoints && drag.vertexIndex != null) {
      const next = clonePage(drag.pageBefore);
      const f = next.frames.find((x) => x.id === drag.frameId);
      if (f) {
        const pts = drag.origPoints.map((q) => ({ ...q }));
        const target = pts[drag.vertexIndex];
        let nx = clamp(target.x + dx, 0, p.width);
        let ny = clamp(target.y + dy, 0, p.height);
        if (magnetRef.current) {
          const pf = pageFrameOf(p);
          const refs = referenceTargets(p, p.frames.filter((x) => x.id !== f.id));
          refs.xs.push(pf.x, pf.x + pf.w, pf.x + pf.w / 2);
          refs.ys.push(pf.y, pf.y + pf.h, pf.y + pf.h / 2);
          for (const other of p.frames) {
            if (other.id === f.id) continue;
            const poly = framePolygon(other);
            for (let i = 0; i < poly.length; i += 1) {
              const a = poly[i];
              const b = poly[(i + 1) % poly.length];
              refs.dirs.push({ x: b.x - a.x, y: b.y - a.y });
            }
          }
          const snapped = snapPoint({ x: nx, y: ny }, refs.xs, refs.ys, 14);
          nx = snapped.point.x;
          ny = snapped.point.y;
          setGuides(snapped.guides);
          const pivot = pts[(drag.vertexIndex + 3) % 4];
          const parallel = snapPointToParallel({ x: nx, y: ny }, pivot, refs.dirs, 12);
          if (parallel.guide) {
            nx = parallel.point.x;
            ny = parallel.point.y;
          }
        } else {
          setGuides(null);
        }
        target.x = nx;
        target.y = ny;
        const q = normalizeQuad(pts);
        if (q) {
          f.x = q.x;
          f.y = q.y;
          f.w = q.w;
          f.h = q.h;
          f.points = q.points;
          f.shape = "quad";
        }
      }
      commitPage(next);
      scheduleRender();
      return;
    }
    if (drag.mode === "resizeFrame" && drag.frameId && drag.origRect) {
      const next = clonePage(drag.pageBefore);
      const f = next.frames.find((x) => x.id === drag.frameId);
      if (f) {
        let rect = resizeByHandle(
          drag.origRect,
          drag.handle ?? "se",
          dx,
          dy,
          p.width,
          p.height,
        );
        if (magnetRef.current) {
          const pf = pageFrameOf(p);
          const refs = referenceTargets(p, p.frames.filter((x) => x.id !== f.id));
          refs.xs.push(pf.x, pf.x + pf.w, pf.x + pf.w / 2);
          refs.ys.push(pf.y, pf.y + pf.h, pf.y + pf.h / 2);
          const snap = snapRect(rect, refs.xs, refs.ys);
          rect = snap.rect;
          setGuides(snap.guides);
        } else {
          setGuides(null);
        }
        f.x = rect.x;
        f.y = rect.y;
        f.w = rect.w;
        f.h = rect.h;
      }
      commitPage(next);
      scheduleRender();
      return;
    }
    if (drag.mode === "moveBalloon" && drag.balloonId && drag.balloonBefore) {
      const next = clonePage(drag.pageBefore);
      const b = next.balloons.find((x) => x.id === drag.balloonId);
      if (b) {
        const nx = clamp(drag.balloonBefore.x + dx, 0, p.width - b.w);
        const ny = clamp(drag.balloonBefore.y + dy, 0, p.height - b.h);
        const mx = nx - b.x;
        const my = ny - b.y;
        b.x = nx;
        b.y = ny;
        b.tailX += mx;
        b.tailY += my;
      }
      commitPage(next);
      scheduleRender();
      return;
    }
    if (drag.mode === "resizeBalloon" && drag.balloonId && drag.balloonBefore) {
      const next = clonePage(drag.pageBefore);
      const b = next.balloons.find((x) => x.id === drag.balloonId);
      if (b) {
        const rect = resizeByHandle(
          drag.balloonBefore,
          drag.handle ?? "se",
          dx,
          dy,
          p.width,
          p.height,
        );
        b.x = rect.x;
        b.y = rect.y;
        b.w = Math.max(90, rect.w);
        b.h = Math.max(64, rect.h);
        b.tailX = clamp(b.tailX, b.x, b.x + b.w);
      }
      commitPage(next);
      scheduleRender();
      return;
    }
    if (drag.mode === "tail" && drag.balloonId) {
      const next = clonePage(drag.pageBefore);
      const b = next.balloons.find((x) => x.id === drag.balloonId);
      if (b) {
        b.tailX = clamp(pt.x, 0, p.width);
        b.tailY = clamp(pt.y, 0, p.height);
      }
      commitPage(next);
      scheduleRender();
    }
  };

  const updateFrameLayerSizes = useCallback(
    (frame: ComicFrame, _oldW: number, _oldH: number) => {
      for (const layer of frame.layers) {
        const key = keyOf(frame.id, layer.id);
        const old = layerMap.current.get(key);
        if (!old) continue;
        const next = createSurface(frame.w, frame.h);
        mustCtx(next).drawImage(old, 0, 0, frame.w, frame.h);
        layerMap.current.set(key, next);
      }
    },
    [],
  );

  const onPagePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const p = pageRef.current;
    dragRef.current = null;
    if (!drag || !p) return;
    if (drag.mode === "createRect") {
      const rect = draftRectRef.current;
      setDraftRect(null);
      setGuides(null);
      if (!rect || rect.w < 80 || rect.h < 80) return;
      const stamp = Date.now();
      const f: ComicFrame = {
        id: `f_${stamp}`,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.w),
        h: Math.round(rect.h),
        shape: "rect",
        rotation: 0,
        overflow: false,
        layers: [
          {
            id: `l_${stamp}`,
            name: "线稿",
            kind: "raster",
            visible: true,
            opacity: 1,
            locked: false,
          },
        ],
      };
      const next = clonePage(drag.pageBefore);
      next.frames.push(f);
      getLayer(f, f.layers[0].id);
      applyPageChange(next, drag.pageBefore);
      setSelectedFrames([f.id]);
      setSelectedBalloon(null);
      setActiveLayer(f.layers[0].id);
      setStatus("拖出一个新格；继续拖可以再画一格");
      return;
    }
    if (drag.mode === "marquee") {
      const m = marqueeRef.current;
      if (m && (m.w > 4 || m.h > 4)) {
        const hit = p.frames
          .filter(
            (f) =>
              f.x < m.x + m.w &&
              f.x + f.w > m.x &&
              f.y < m.y + m.h &&
              f.y + f.h > m.y,
          )
          .map((f) => f.id);
        const base = e.shiftKey ? selectedFramesRef.current : [];
        const merged = Array.from(new Set([...base, ...hit]));
        setSelectedFrames(merged);
      }
      marqueeRef.current = null;
      setMarquee(null);
      scheduleRender();
      return;
    }
    if (!drag.moved) {
      setGuides(null);
      return;
    }
    setGuides(null);

    if ((drag.mode === "resizeFrame" || drag.mode === "moveVertex") && drag.frameId && drag.origRect) {
      const next = pageRef.current;
      if (!next) return;
      const frame = next.frames.find((f) => f.id === drag.frameId);
      if (!frame) return;
      const beforeLayers: { layerId: string; canvas: HTMLCanvasElement }[] = [];
      for (const layer of frame.layers) {
        const canvas = layerMap.current.get(keyOf(frame.id, layer.id));
        if (canvas) beforeLayers.push({ layerId: layer.id, canvas: cloneSurface(canvas) });
      }
      updateFrameLayerSizes(frame, drag.origRect.w, drag.origRect.h);
      pushUndo({
        kind: "resize",
        frameId: frame.id,
        beforePage: clonePage(drag.pageBefore),
        afterPage: clonePage(next),
        beforeLayers,
      });
    } else {
      pushUndo({
        kind: "page",
        before: clonePage(drag.pageBefore),
        after: clonePage(pageRef.current ?? p),
      });
    }
    scheduleSave();
    scheduleRender();
  };

  /* ───────── 格内绘制 ───────── */

  const onFocusPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = pageRef.current;
    const frame = focusFrameRef.current;
    if (!p || !frame || busy) return;
    const jointLayer = p.jointLayers?.find((item) => item.id === focusRef.current) ?? null;
    if (jointLayer && !jointMaskRef.current) {
      jointMaskRef.current = buildJointMask(
        p.frames.filter((item) => jointLayer.frameIds.includes(item.id)),
        jointLayer.rect,
        jointLayer.crossPanel,
      );
    }
    const joint =
      jointLayer && jointMaskRef.current
        ? {
            layer: jointLayer,
            frames: p.frames.filter((item) => jointLayer.frameIds.includes(item.id)),
            mask: jointMaskRef.current,
          }
        : undefined;
    if (textEditRef.current) commitTextEdit();
    const pt = toFocusPoint(e.clientX, e.clientY);
    if (!pt) return;
    if (joint) {
      if (!maskHasPoint(joint.mask, pt.x, pt.y)) {
        setStatus("点在格缝外，这一笔没有落下");
        return;
      }
    } else if (!pointInFrame(frame, { x: pt.x + frame.x, y: pt.y + frame.y })) {
      setStatus("点在格外面，这一笔没有落下");
      return;
    }
    if (toolRef.current === "selection") {
      const mode: SelectionMode = e.shiftKey ? "add" : e.altKey ? "subtract" : selectionCombine;
      if (selectionShape === "wand") {
        const sample = buildFocusBase(p, frame, layerMap.current, assetMap.current, joint);
        const mask = wandMask(sample, pt, selectionTolerance, selectionContiguous);
        if (!mask) return;
        commitSelection(mask, mode);
        return;
      }
      selectionDraftRef.current =
        selectionShape === "rect"
          ? { shape: "rect", a: pt, b: pt, mode }
          : { shape: "lasso", points: [pt], mode };
      e.currentTarget.setPointerCapture(e.pointerId);
      setStatus(
        selectionShape === "rect"
          ? `${mode === "add" ? "加选" : mode === "subtract" ? "减选" : "框选"}：拖一个矩形`
          : `${mode === "add" ? "加选" : mode === "subtract" ? "减选" : "柳叶套索"}：按住拖一圈，松手闭合成选区`,
      );
      scheduleRender();
      return;
    }
    const layerMeta = frame.layers.find((l) => l.id === activeLayerRef.current) ?? frame.layers[0];
    if (!layerMeta || layerMeta.locked) {
      setStatus("当前图层已锁定");
      return;
    }
    const canvas = getLayer(frame, layerMeta.id);
    if (toolRef.current === "fill") {
      const before = cloneSurface(canvas);
      const mask = paintMaskForLayer(frame, layerMeta, canvas);
      const changed = fillRegion(canvas, pt.x, pt.y, brushRef.current.color, mask, layerMeta.alphaLocked);
      if (!changed) {
        setStatus(mask ? "这块区域不在选区里，或已经是这个颜色" : "这块区域已经是这个颜色");
        return;
      }
      pushUndo({
        kind: "stroke",
        frameId: frame.id,
        layerId: layerMeta.id,
        before,
        after: cloneSurface(canvas),
      });
      setStatus("已填充连通区");
      scheduleSave();
      scheduleRender();
      return;
    }
    if (toolRef.current === "eyedropper") {
      // 吸色读的是眼前这张合成图（纸白、格线、所有可见图层），
      // 不是正在画的那一层——否则新建空层上永远吸不到任何颜色。
      const sampleCanvas = focusCanvasRef.current ?? canvas;
      const ctx = mustCtx(sampleCanvas);
      const sx = sampleCanvas.width / Math.max(1, frame.w);
      const sy = sampleCanvas.height / Math.max(1, frame.h);
      const pixel = ctx.getImageData(
        Math.max(0, Math.min(sampleCanvas.width - 1, Math.round(pt.x * sx))),
        Math.max(0, Math.min(sampleCanvas.height - 1, Math.round(pt.y * sy))),
        1,
        1,
      ).data;
      if (pixel[3] === 0) {
        setStatus("这里是透明的，换一处吸色");
        return;
      }
      const hex = `#${[pixel[0], pixel[1], pixel[2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      chooseColor(hex);
      setStatus(`吸到 ${hex.toUpperCase()}`);
      return;
    }
    if (toolRef.current === "move") {
      const before = cloneSurface(canvas);
      const mask = selectionRef.current;
      let base: HTMLCanvasElement;
      let moving: HTMLCanvasElement;
      if (mask) {
        base = cloneSurface(canvas);
        const bctx = mustCtx(base);
        bctx.globalCompositeOperation = "destination-out";
        bctx.drawImage(mask, 0, 0);
        bctx.globalCompositeOperation = "source-over";
        moving = cloneSurface(canvas);
        const mctx = mustCtx(moving);
        mctx.globalCompositeOperation = "destination-in";
        mctx.drawImage(mask, 0, 0);
        mctx.globalCompositeOperation = "source-over";
      } else {
        base = createSurface(frame.w, frame.h);
        moving = before;
      }
      moveSessionRef.current = {
        frameId: frame.id,
        layerId: layerMeta.id,
        before,
        base,
        moving,
        start: pt,
        dx: 0,
        dy: 0,
        selection: !!mask,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      setStatus(mask ? "移动：拖拽挪动选区里的像素" : "移动：拖拽挪动整个图层");
      scheduleRender();
      return;
    }

    if (toolRef.current === "liquify") {
      if (layerMeta.alphaLocked) {
        setStatus("液化需要关闭「锁定透明」");
        return;
      }
      liquifySessionRef.current = {
        frameId: frame.id,
        layerId: layerMeta.id,
        before: cloneSurface(canvas),
        canvas,
        last: pt,
        moved: false,
        mask: paintMaskForLayer(frame, layerMeta, canvas),
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      setStatus("液化：按住并推动笔迹，像推湿墨一样推开像素");
      return;
    }

    if (toolRef.current === "shape") {
      const preview = createSurface(frame.w, frame.h);
      const before = cloneSurface(canvas);
      const kind = shapeKindRef.current;
      const pad = brushRef.current.size * 1.5 + 6;
      const initial: Rect = {
        x: pt.x - pad,
        y: pt.y - pad,
        w: pad * 2,
        h: pad * 2,
      };
      drawShapePath(
        mustCtx(preview),
        kind,
        pt,
        pt,
        brushRef.current.color,
        brushRef.current.size,
        brushRef.current.opacity / 100,
        e.shiftKey || shapeConstrain,
      );
      shapeSessionRef.current = {
        kind,
        start: pt,
        current: pt,
        constrain: e.shiftKey || shapeConstrain,
        frameId: frame.id,
        layerId: layerMeta.id,
        before,
        preview,
        dirty: initial,
        lastRect: initial,
      };
      focusBaseRef.current = buildFocusBase(p, frame, layerMap.current, assetMap.current, joint);
      e.currentTarget.setPointerCapture(e.pointerId);
      setStatus("拖到合适大小松手；按住 Shift 可约束比例");
      scheduleRender();
      return;
    }

    const penSample = penSampleOf(e.nativeEvent);
    const eraserEnd = penSample.eraser && penSample.pointerType === "pen" && brushRef.current.penEraser !== false;
    const erase = toolRef.current === "eraser" || eraserEnd;
    if (erase && layerMeta.alphaLocked) {
      setStatus("当前图层锁定了透明，橡皮不能擦");
      return;
    }
    const mask = paintMaskForLayer(frame, layerMeta, canvas);
    const stroke = new Stroke(frame.w, frame.h, brushRef.current, erase, mask);
    stroke.setPen(penSample);
    stroke.begin(pt.x, pt.y, penPressureOf(penSample, brushRef.current.penPressure ?? true));
    focusBaseRef.current = buildFocusBase(p, frame, layerMap.current, assetMap.current, joint);
    strokeRef.current = {
      stroke,
      frameId: frame.id,
      layerId: layerMeta.id,
      erase,
      before: cloneSurface(canvas),
    };
    strokeDirtyRef.current = null;
    strokeLastPointRef.current = pt;
    e.currentTarget.setPointerCapture(e.pointerId);
    scheduleRender();
  };

  const onFocusPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const draft = selectionDraftRef.current;
    if (draft) {
      const pt = toFocusPoint(e.clientX, e.clientY);
      if (!pt) return;
      if (draft.shape === "rect") {
        draft.b = pt;
      } else {
        const last = draft.points[draft.points.length - 1];
        if (Math.hypot(pt.x - last.x, pt.y - last.y) >= 2) draft.points.push(pt);
      }
      scheduleRender();
      return;
    }

    const move = moveSessionRef.current;
    if (move) {
      const pt = toFocusPoint(e.clientX, e.clientY);
      const frame = pageRef.current ? frameById(pageRef.current, move.frameId) : null;
      if (!pt || !frame) return;
      move.dx = pt.x - move.start.x;
      move.dy = pt.y - move.start.y;
      const canvas = layerMap.current.get(keyOf(move.frameId, move.layerId));
      if (!canvas) return;
      const ctx = mustCtx(canvas);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(move.base, 0, 0);
      ctx.drawImage(move.moving, move.dx, move.dy);
      scheduleRender();
      return;
    }

    const liq = liquifySessionRef.current;
    if (liq) {
      const pt = toFocusPoint(e.clientX, e.clientY);
      if (!pt) return;
      const dx = pt.x - liq.last.x;
      const dy = pt.y - liq.last.y;
      if (Math.hypot(dx, dy) < 0.8) return;
      const r = Math.max(18, liquifyRadius);
      const stamp = createSurface(Math.ceil(r * 2), Math.ceil(r * 2));
      const sctx = mustCtx(stamp);
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = "high";
      sctx.drawImage(
        liq.canvas,
        liq.last.x - r,
        liq.last.y - r,
        r * 2,
        r * 2,
        0,
        0,
        r * 2,
        r * 2,
      );
      sctx.globalCompositeOperation = "destination-in";
      const grad = sctx.createRadialGradient(r, r, Math.max(1, r * 0.16), r, r, r);
      grad.addColorStop(0, "rgba(0,0,0,1)");
      grad.addColorStop(0.56, "rgba(0,0,0,0.92)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      sctx.fillStyle = grad;
      sctx.fillRect(0, 0, r * 2, r * 2);
      if (liq.mask) {
        sctx.drawImage(liq.mask, -(pt.x - r), -(pt.y - r));
      }
      sctx.globalCompositeOperation = "source-over";
      const ctx = mustCtx(liq.canvas);
      ctx.save();
      ctx.globalAlpha = clamp(liquifyStrength / 100, 0.08, 1);
      ctx.drawImage(stamp, pt.x - r, pt.y - r);
      ctx.restore();
      liq.last = pt;
      liq.moved = true;
      scheduleRender();
      return;
    }

    const shape = shapeSessionRef.current;
    if (shape) {
      const pt = toFocusPoint(e.clientX, e.clientY);
      if (!pt) return;
      shape.current = pt;
      shape.constrain = e.shiftKey || shapeConstrain;
      const ctx = mustCtx(shape.preview);
      ctx.clearRect(0, 0, shape.preview.width, shape.preview.height);
      drawShapePath(
        ctx,
        shape.kind,
        shape.start,
        shape.current,
        brushRef.current.color,
        brushRef.current.size,
        brushRef.current.opacity / 100,
        shape.constrain,
      );
      const pad = brushRef.current.size * 1.5 + 6;
      const nextRect: Rect = {
        x: Math.min(shape.start.x, pt.x) - pad,
        y: Math.min(shape.start.y, pt.y) - pad,
        w: Math.abs(pt.x - shape.start.x) + pad * 2,
        h: Math.abs(pt.y - shape.start.y) + pad * 2,
      };
      const prevRect = shape.lastRect;
      shape.dirty = prevRect
        ? {
            x: Math.min(prevRect.x, nextRect.x),
            y: Math.min(prevRect.y, nextRect.y),
            w:
              Math.max(prevRect.x + prevRect.w, nextRect.x + nextRect.w) -
              Math.min(prevRect.x, nextRect.x),
            h:
              Math.max(prevRect.y + prevRect.h, nextRect.y + nextRect.h) -
              Math.min(prevRect.y, nextRect.y),
          }
        : nextRect;
      shape.lastRect = nextRect;
      scheduleRender();
      return;
    }

    const session = strokeRef.current;
    const frame = pageRef.current?.frames.find((f) => f.id === session?.frameId);
    if (!session || !frame) return;
    // 一次 pointermove 里只读一次画布布局；之前每个合并事件都 getBoundingClientRect，
    // 高刷数位板一帧十几个事件会把时间花在强制布局上，笔迹就跟不上手。
    const canvas = focusCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const sx = frame.w / Math.max(1, rect.width);
    const sy = frame.h / Math.max(1, rect.height);
    const events =
      typeof (e.nativeEvent as PointerEvent).getCoalescedEvents === "function"
        ? (e.nativeEvent as PointerEvent).getCoalescedEvents()
        : [e.nativeEvent as PointerEvent];
    const from = strokeLastPointRef.current;
    let minX = from?.x ?? Infinity;
    let minY = from?.y ?? Infinity;
    let maxX = from?.x ?? -Infinity;
    let maxY = from?.y ?? -Infinity;
    let last: Point | null = null;
    for (const ev of events) {
      const x = (ev.clientX - rect.left) * sx;
      const y = (ev.clientY - rect.top) * sy;
      const sample = penSampleOf(ev);
      session.stroke.setPen(sample);
      session.stroke.extend(
        x,
        y,
        penPressureOf(sample, brushRef.current.penPressure ?? true),
        ev.timeStamp,
      );
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      last = { x, y };
    }
    if (!last) return;
    strokeLastPointRef.current = last;
    // 只重画这一小段：底图缓存，加上当前笔迹缓冲，脏矩形大约是一个笔刷
    // 直径的几倍，不再每帧清 810×936 整张。
    const pad = brushRef.current.size * 1.25 + 10;
    const next: Rect = {
      x: minX - pad,
      y: minY - pad,
      w: maxX - minX + pad * 2,
      h: maxY - minY + pad * 2,
    };
    const prev = strokeDirtyRef.current;
    strokeDirtyRef.current = prev
      ? {
          x: Math.min(prev.x, next.x),
          y: Math.min(prev.y, next.y),
          w:
            Math.max(prev.x + prev.w, next.x + next.w) - Math.min(prev.x, next.x),
          h:
            Math.max(prev.y + prev.h, next.y + next.h) - Math.min(prev.y, next.y),
        }
      : next;
    scheduleRender();
  };

  const finishStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const draft = selectionDraftRef.current;
    if (draft) {
      const frame = focusFrameRef.current;
      const pt = toFocusPoint(e.clientX, e.clientY);
      if (frame) {
        if (draft.shape === "rect") {
          if (pt) draft.b = pt;
          if (Math.abs(draft.b.x - draft.a.x) >= 2 && Math.abs(draft.b.y - draft.a.y) >= 2) {
            commitSelection(rectMask(frame.w, frame.h, draft.a, draft.b), draft.mode);
          } else {
            selectionDraftRef.current = null;
            scheduleRender();
          }
        } else {
          if (pt) draft.points.push(pt);
          commitSelection(lassoMask(frame.w, frame.h, draft.points), draft.mode);
        }
      } else {
        selectionDraftRef.current = null;
      }
      return;
    }

    const move = moveSessionRef.current;
    if (move) {
      const pt = toFocusPoint(e.clientX, e.clientY);
      if (pt) {
        move.dx = pt.x - move.start.x;
        move.dy = pt.y - move.start.y;
      }
      const frame = pageRef.current ? frameById(pageRef.current, move.frameId) : null;
      const canvas = frame ? layerMap.current.get(keyOf(frame.id, move.layerId)) : null;
      if (canvas) {
        const ctx = mustCtx(canvas);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(move.base, 0, 0);
        ctx.drawImage(move.moving, move.dx, move.dy);
        if (Math.hypot(move.dx, move.dy) < 0.5) {
          replaceSurface(canvas, move.before);
        } else {
          pushUndo({
            kind: "stroke",
            frameId: move.frameId,
            layerId: move.layerId,
            before: move.before,
            after: cloneSurface(canvas),
          });
          if (move.selection && selectionRef.current) {
            const shifted = offsetMask(selectionRef.current, move.dx, move.dy);
            selectionRef.current = shifted;
            if (selectionCoreRef.current) {
              selectionCoreRef.current = offsetMask(selectionCoreRef.current, move.dx, move.dy);
            }
            selectionTintRef.current = selectionTint(shifted);
            selectionBoundsRef.current = selectionBounds(shifted);
            setSelectionState(shifted);
          }
          scheduleSave();
          setStatus("图层内容已移动");
        }
      }
      moveSessionRef.current = null;
      scheduleRender();
      return;
    }

    const liq = liquifySessionRef.current;
    if (liq) {
      const frame = pageRef.current ? frameById(pageRef.current, liq.frameId) : null;
      if (frame && liq.moved) {
        const canvas = getLayer(frame, liq.layerId);
        pushUndo({
          kind: "stroke",
          frameId: liq.frameId,
          layerId: liq.layerId,
          before: liq.before,
          after: cloneSurface(canvas),
        });
        scheduleSave();
        setStatus("液化已写入图层");
      } else {
        replaceSurface(liq.canvas, liq.before);
        setStatus("液化没有移动，已取消");
      }
      liquifySessionRef.current = null;
      scheduleRender();
      return;
    }

    const shape = shapeSessionRef.current;
    if (shape) {
      const pt = toFocusPoint(e.clientX, e.clientY);
      if (pt) {
        shape.current = pt;
        shape.constrain = e.shiftKey || shapeConstrain;
      }
      const frame = pageRef.current ? frameById(pageRef.current, shape.frameId) : null;
      const canvas = frame ? layerMap.current.get(keyOf(frame.id, shape.layerId)) : null;
      if (canvas) {
        const dist = Math.hypot(shape.current.x - shape.start.x, shape.current.y - shape.start.y);
        if (dist < 2) {
          setStatus("图形太小，已取消");
        } else {
          const shapeLayer = createSurface(canvas.width, canvas.height);
          const sctx = mustCtx(shapeLayer);
          drawShapePath(
            sctx,
            shape.kind,
            shape.start,
            shape.current,
            brushRef.current.color,
            brushRef.current.size,
            brushRef.current.opacity / 100,
            shape.constrain,
          );
          if (jointMaskRef.current) {
            sctx.globalCompositeOperation = "destination-in";
            sctx.drawImage(jointMaskRef.current, 0, 0);
            sctx.globalCompositeOperation = "source-over";
          }
          mustCtx(canvas).drawImage(shapeLayer, 0, 0);
          pushUndo({
            kind: "stroke",
            frameId: shape.frameId,
            layerId: shape.layerId,
            before: shape.before,
            after: cloneSurface(canvas),
          });
          scheduleSave();
          setStatus("图形已落到当前图层");
        }
      }
      shapeSessionRef.current = null;
      focusBaseRef.current = null;
      scheduleRender();
      return;
    }

    const session = strokeRef.current;
    const p = pageRef.current;
    if (!session || !p) return;
    const frame = frameById(p, session.frameId);
    if (!frame) {
      strokeRef.current = null;
      focusBaseRef.current = null;
      return;
    }
    const canvas = getLayer(frame, session.layerId);
    const pt = toFocusPoint(e.clientX, e.clientY);
    if (pt) {
      const sample = penSampleOf(e.nativeEvent);
      session.stroke.setPen(sample);
      session.stroke.extend(
        pt.x,
        pt.y,
        penPressureOf(sample, brushRef.current.penPressure ?? true),
        e.nativeEvent.timeStamp,
      );
    }
    session.stroke.finish(canvas);
    const after = cloneSurface(canvas);
    pushUndo({
      kind: "stroke",
      frameId: frame.id,
      layerId: session.layerId,
      before: session.before,
      after,
    });
    strokeRef.current = null;
    strokeDirtyRef.current = null;
    strokeLastPointRef.current = null;
    focusBaseRef.current = null;
    setStatus("笔迹已写入图层");
    scheduleSave();
    scheduleRender();
  };

  /* ───────── 文本编辑 ───────── */

  const openTextEdit = useCallback(
    (b: ComicBalloon) => {
      textBeforeRef.current = pageRef.current ? clonePage(pageRef.current) : null;
      setTextEdit({
        id: b.id,
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        text: b.text,
      });
    },
    [],
  );

  const commitTextEdit = useCallback(() => {
    const draft = textEditRef.current;
    const p = pageRef.current;
    if (!draft || !p) {
      setTextEdit(null);
      return;
    }
    const before = textBeforeRef.current ?? clonePage(p);
    const next = clonePage(p);
    const b = next.balloons.find((x) => x.id === draft.id);
    if (b && b.text !== draft.text) {
      b.text = draft.text;
      applyPageChange(next, before);
    }
    textBeforeRef.current = null;
    setTextEdit(null);
  }, [applyPageChange]);

  const onTextChange = (value: string) => {
    setTextEdit((prev) => (prev ? { ...prev, text: value } : prev));
    const p = pageRef.current;
    if (!p) return;
    const next = clonePage(p);
    const b = next.balloons.find((x) => x.id === textEditRef.current?.id);
    if (b) {
      b.text = value;
      commitPage(next);
      scheduleRender();
    }
  };

  /* ───────── 页 / 格结构 ───────── */

  const pageHasArtwork = (p: ComicPage) =>
    p.images.length > 0 ||
    p.balloons.length > 0 ||
    (p.jointLayers ?? []).some((joint) => {
      const c = layerMap.current.get(keyOf(joint.id, joint.id));
      if (!c) return false;
      const data = mustCtx(c).getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < data.length; i += 32) if (data[i] > 0) return true;
      return false;
    }) ||
    p.frames.some((f) =>
      f.layers.some((l) => {
        const c = layerMap.current.get(keyOf(f.id, l.id));
        if (!c) return false;
        const data = mustCtx(c).getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < data.length; i += 32) if (data[i] > 0) return true;
        return false;
      }),
    );

  const applyTemplate = (templateId: string, force = false) => {
    const p = pageRef.current;
    if (!p) return;
    const template = FRAME_TEMPLATES.find((t) => t.id === templateId);
    if (!template) return;
    if (!force && pageHasArtwork(p)) {
      setTemplateConfirm(templateId);
      return;
    }
    setTemplateConfirm(null);
    const before = clonePage(p);
    const beforeLayers = snapshotPageLayers(p, layerMap.current);
    const frames = buildTemplateFrames(template, p.width, p.height, Date.now());
    const next = { ...clonePage(p), frames, jointLayers: [], balloons: [], images: [] };
    layerMap.current = new Map();
    ensurePageLayers(next);
    const afterLayers = snapshotPageLayers(next, layerMap.current);
    setSelectedFrames([frames[0]?.id].filter(Boolean) as string[]);
    setActiveLayer(frames[0]?.layers[0]?.id ?? null);
    setSelectedBalloon(null);
    setFocus(null);
    setTool("select");
    commitPage(next);
    setThumbs((prev) => ({ ...prev, [next.id]: makeThumb(next) }));
    pushUndo({
      kind: "page",
      before,
      after: clonePage(next),
      beforeLayers,
      afterLayers,
    });
    scheduleSave();
    scheduleRender();
    setTemplateOpen(false);
    setStatus(`已铺「${template.name}」模板`);
  };

  const applyPreset = (presetId: string, force = false) => {
    const p = pageRef.current;
    const preset = projectRef.current?.presets?.find((x) => x.id === presetId);
    if (!p || !preset) return;
    if (!force && pageHasArtwork(p)) {
      setPresetConfirm(presetId);
      return;
    }
    setPresetConfirm(null);
    const before = clonePage(p);
    const beforeLayers = snapshotPageLayers(p, layerMap.current);
    const sx = p.width / Math.max(1, preset.width);
    const sy = p.height / Math.max(1, preset.height);
    const frames: ComicFrame[] = preset.frames.map((pf, index) => {
      const stamp = Date.now() + index;
      return {
        id: `f_${stamp}`,
        x: Math.round(pf.x * sx),
        y: Math.round(pf.y * sy),
        w: Math.max(20, Math.round(pf.w * sx)),
        h: Math.max(20, Math.round(pf.h * sy)),
        shape: pf.shape,
        points: pf.points ? pf.points.map(([x, y]) => [x, y] as [number, number]) : undefined,
        rotation: 0,
        overflow: false,
        layers: [
          {
            id: `l_${stamp}`,
            name: "线稿",
            kind: "raster",
            visible: true,
            opacity: 1,
            locked: false,
          },
        ],
      };
    });
    const pageFrame = preset.pageFrame
      ? {
          x: Math.round(preset.pageFrame.x * sx),
          y: Math.round(preset.pageFrame.y * sy),
          w: Math.round(preset.pageFrame.w * sx),
          h: Math.round(preset.pageFrame.h * sy),
          stroke: preset.pageFrame.stroke,
        }
      : pageFrameOf(p);
    const next = { ...clonePage(p), pageFrame, frames, balloons: [], images: [] };
    layerMap.current = new Map();
    ensurePageLayers(next);
    const afterLayers = snapshotPageLayers(next, layerMap.current);
    setSelectedFrames([frames[0]?.id].filter(Boolean) as string[]);
    setActiveLayer(frames[0]?.layers[0]?.id ?? null);
    setSelectedBalloon(null);
    setPageFrameSelected(false);
    setFocus(null);
    setTool("select");
    commitPage(next);
    setThumbs((prev) => ({ ...prev, [next.id]: makeThumb(next) }));
    pushUndo({
      kind: "page",
      before,
      after: clonePage(next),
      beforeLayers,
      afterLayers,
    });
    scheduleSave();
    scheduleRender();
    setTemplateOpen(false);
    setStatus(`已套用预设「${preset.name}」`);
  };

  const savePreset = async () => {
    const p = pageRef.current;
    const current = projectRef.current;
    const name = presetName.trim();
    if (!p || !current || !name) return;
    const preset: ComicPreset = {
      id: uid("ps"),
      name,
      width: p.width,
      height: p.height,
      pageFrame: { ...pageFrameOf(p) },
      frames: p.frames.map<ComicPresetFrame>((f) => ({
        x: f.x,
        y: f.y,
        w: f.w,
        h: f.h,
        shape: f.shape,
        points: f.points ? f.points.map(([x, y]) => [x, y] as [number, number]) : undefined,
      })),
    };
    const nextProject = {
      ...current,
      presets: [...(current.presets ?? []), preset],
      updatedAt: Date.now(),
    };
    projectRef.current = nextProject;
    setProject(nextProject);
    try {
      await api.comicSaveProject(pathRef.current, JSON.stringify(nextProject));
      setPresetSaveOpen(false);
      setPresetName("");
      setStatus(`已把当前排版存成「${name}」`);
    } catch (e) {
      setStatus(`保存预设失败：${String(e)}`);
    }
  };

  const deletePreset = async (presetId: string) => {
    const current = projectRef.current;
    if (!current) return;
    const nextProject = {
      ...current,
      presets: (current.presets ?? []).filter((x) => x.id !== presetId),
      updatedAt: Date.now(),
    };
    projectRef.current = nextProject;
    setProject(nextProject);
    await api.comicSaveProject(pathRef.current, JSON.stringify(nextProject)).catch(() => undefined);
    setStatus("预设已删除");
  };

  const addFrame = (kind: "frame" | "blank") => {
    const p = pageRef.current;
    if (!p) return;
    const before = clonePage(p);
    const frame = makeAddFrame(p.width, p.height, p.frames, kind, p.frames.length);
    const next = clonePage(p);
    next.frames.push(frame);
    getLayer(frame, frame.layers[0].id);
    setSelectedFrames([frame.id]);
    setActiveLayer(frame.layers[0].id);
    setSelectedBalloon(null);
    setTool("select");
    applyPageChange(next, before);
    setStatus(kind === "blank" ? "已加一张无边框整页" : "已加格");
  };

  const deleteSelected = () => {
    const p = pageRef.current;
    if (!p) return;
    if (selectedBalloonRef.current) {
      const before = clonePage(p);
      const next = clonePage(p);
      next.balloons = next.balloons.filter((b) => b.id !== selectedBalloonRef.current);
      setSelectedBalloon(null);
      applyPageChange(next, before);
      return;
    }
    const ids = selectedFramesRef.current;
    if (!ids.length) return;
    if (ids.length >= p.frames.length) {
      setStatus("至少保留一个格；可以改成无边框格");
      return;
    }
    const before = clonePage(p);
    const next = clonePage(p);
    next.frames = next.frames.filter((f) => !ids.includes(f.id));
    setSelectedFrames(next.frames[0] ? [next.frames[0].id] : []);
    setActiveLayer(next.frames[0]?.layers[0]?.id ?? null);
    applyPageChange(next, before);
  };

  const addLayer = () => {
    const p = pageRef.current;
    const frame = activeFrame;
    if (!p || !frame) return;
    const before = clonePage(p);
    const meta: ComicLayerMeta = {
      id: uid("l"),
      name: `图层 ${frame.layers.length + 1}`,
      kind: "raster",
      visible: true,
      opacity: 1,
      locked: false,
    };
    getLayer(frame, meta.id);
    const next = clonePage(p);
    const target = next.frames.find((f) => f.id === frame.id);
    target?.layers.push(meta);
    setActiveLayer(meta.id);
    applyPageChange(next, before);
  };

  const deleteLayer = (layerId: string) => {
    const p = pageRef.current;
    const frame = activeFrame;
    if (!p || !frame) return;
    if (frame.layers.length <= 1) {
      setStatus("每个格至少留一层");
      return;
    }
    const before = clonePage(p);
    const next = clonePage(p);
    const target = next.frames.find((f) => f.id === frame.id);
    if (target) target.layers = target.layers.filter((l) => l.id !== layerId);
    setActiveLayer(target?.layers[0]?.id ?? null);
    applyPageChange(next, before);
  };

  const patchLayer = (layerId: string, patch: Partial<ComicLayerMeta>) => {
    const p = pageRef.current;
    const frame = activeFrame;
    if (!p || !frame) return;
    const before = clonePage(p);
    const next = clonePage(p);
    const target = next.frames.find((f) => f.id === frame.id);
    const layer = target?.layers.find((l) => l.id === layerId);
    if (!layer) return;
    Object.assign(layer, patch);
    applyPageChange(next, before);
  };

  const patchFrame = (frameId: string, patch: Partial<ComicFrame>) => {
    const p = pageRef.current;
    if (!p) return;
    const before = clonePage(p);
    const next = clonePage(p);
    const frame = next.frames.find((f) => f.id === frameId);
    if (!frame) return;
    Object.assign(frame, patch);
    applyPageChange(next, before);
  };

  const patchBalloon = (id: string, patch: Partial<ComicBalloon>) => {
    const p = pageRef.current;
    if (!p) return;
    const before = clonePage(p);
    const next = clonePage(p);
    const b = next.balloons.find((x) => x.id === id);
    if (!b) return;
    Object.assign(b, patch);
    applyPageChange(next, before);
  };

  /* ───────── 页面管理 ───────── */

  const switchPage = async (id: string) => {
    if (!pageRef.current || id === pageRef.current.id) return;
    await savePage();
    await loadPage(id, true);
    const proj = projectRef.current;
    if (proj) {
      const next = { ...proj, currentPageId: id, updatedAt: Date.now() };
      projectRef.current = next;
      setProject(next);
      await api.comicSaveProject(path, JSON.stringify(next)).catch(() => undefined);
    }
  };

  const addPage = async () => {
    setBusy(true);
    try {
      await savePage();
      const count = visiblePages.length || 1;
      const payload = await api.comicNewPage(path, `第 ${count + 1} 页`, chapterId);
      const fresh = await api.comicProject(path);
      const proj = JSON.parse(fresh) as ComicProjectMeta;
      projectRef.current = proj;
      setProject(proj);
      await adoptPage(payload, false);
      setStatus("已新建一页");
    } catch (e) {
      setStatus(`新建页面失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const deletePage = async (id: string) => {
    if (chapterId && visiblePages.length <= 1) {
      setConfirmDeletePage(null);
      setStatus("每一话至少保留一页；可以新建一页后再删");
      return;
    }
    setBusy(true);
    try {
      await api.comicDeletePage(path, id);
      const fresh = await api.comicProject(path);
      const proj = JSON.parse(fresh) as ComicProjectMeta;
      projectRef.current = proj;
      setProject(proj);
      const fallback = proj.pages.find((p) => (chapterId ? p.chapterId === chapterId : true))?.id;
      if (fallback) await loadPage(fallback, true);
      setConfirmDeletePage(null);
      setStatus("页面已移入回收目录");
    } catch (e) {
      setStatus(`删除页面失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const renamePage = (title: string) => {
    const p = pageRef.current;
    if (!p) return;
    const before = clonePage(p);
    const next = { ...clonePage(p), title };
    applyPageChange(next, before);
  };

  /* ───────── 素材 ───────── */

  const importImage = useCallback(
    async (file: File) => {
      const p = pageRef.current;
      if (!p) return;
      if (p.jointLayers?.some((joint) => joint.id === focusRef.current)) {
        setStatus("跨格线稿暂不支持放素材；退出多格后在单格放图");
        return;
      }
      const frame = focusRef.current
        ? p.frames.find((f) => f.id === focusRef.current)
        : activeFrame ?? p.frames[0];
      if (!frame) {
        setStatus("先加一个格，再放图片");
        return;
      }
      setBusy(true);
      try {
        const dataUrl = await readFileDataUrl(file);
        const asset = await api.comicSaveAsset(path, p.id, file.name || "image.png", dataUrl);
        const img = await loadImage(dataUrl);
        assetMap.current.set(asset, img);
        const before = clonePage(p);
        const next = clonePage(p);
        const item: ComicImageItem = {
          id: uid("im"),
          frameId: frame.id,
          asset,
          x: 0,
          y: 0,
          w: frame.w,
          h: frame.h,
          fit: "cover",
          rotation: 0,
          opacity: 1,
          name: file.name || "外部图片",
          role: "art",
        };
        next.images.push(item);
        setSelectedFrames([frame.id]);
        applyPageChange(next, before);
        setPanelTab("assets");
        setStatus("图片已作为素材放进当前格");
      } catch (e) {
        setStatus(`导入图片失败：${String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [activeFrame, applyPageChange, path, setSelectedFrames],
  );

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (files.length) {
        e.preventDefault();
        void importImage(files[0]);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [importImage]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (files.length) void importImage(files[0]);
  };

  const patchImage = (id: string, patch: Partial<ComicImageItem>) => {
    const p = pageRef.current;
    if (!p) return;
    const before = clonePage(p);
    const next = clonePage(p);
    const item = next.images.find((x) => x.id === id);
    if (!item) return;
    Object.assign(item, patch);
    applyPageChange(next, before);
  };

  const deleteImage = (id: string) => {
    const p = pageRef.current;
    if (!p) return;
    const before = clonePage(p);
    const next = clonePage(p);
    next.images = next.images.filter((x) => x.id !== id);
    applyPageChange(next, before);
  };

  /* ───────── 返回 ───────── */

  const goBack = async () => {
    await savePage();
    onBack?.();
  };

  const activeImages = activeFrame && page ? page.images.filter((i) => i.frameId === activeFrame.id) : [];

  const saveLabel =
    saveState === "saving"
      ? "保存中…"
      : saveState === "dirty"
        ? "有改动"
        : saveState === "error"
          ? "保存失败"
          : "已保存";

  const mobileZoomValue = focusFrame ? zoom : pageZoom;
  const mobileZoomBy = (delta: number) => {
    setMobileZoomOpen(false);
    if (focusFrame) setZoom((z) => clamp(z + delta, 0.4, 4));
    else setPageZoom((z) => clamp(z + delta, 0.5, 3));
  };
  const mobileZoomFit = () => {
    setMobileZoomOpen(false);
    if (focusFrame) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
    } else {
      setPageZoom(1);
    }
  };
  const openBrushPanel = () => {
    setPanelTab("layers");
    setBrushSectionOpen(true);
    setMobileInspector(true);
    setMobilePages(false);
    setAdvancedOpen(false);
    setMobileZoomOpen(false);
  };
  const startPagePress = (id: string) => {
    if (pagePressRef.current) window.clearTimeout(pagePressRef.current.timer);
    pagePressFiredRef.current = false;
    const timer = window.setTimeout(() => {
      pagePressFiredRef.current = true;
      setConfirmDeletePage(id);
      if (navigator.vibrate) navigator.vibrate(18);
    }, 560);
    pagePressRef.current = { id, timer };
  };
  const endPagePress = () => {
    if (!pagePressRef.current) return;
    window.clearTimeout(pagePressRef.current.timer);
    pagePressRef.current = null;
  };
  const startPalettePress = (id: string) => {
    if (palettePressRef.current) window.clearTimeout(palettePressRef.current.timer);
    palettePressFiredRef.current = false;
    const timer = window.setTimeout(() => {
      palettePressFiredRef.current = true;
      removePaletteColor(id);
    }, 520);
    palettePressRef.current = { id, timer };
  };
  const endPalettePress = () => {
    if (!palettePressRef.current) return;
    window.clearTimeout(palettePressRef.current.timer);
    palettePressRef.current = null;
  };
  const enterSelectedFrame = () => {
    const frame = page?.frames.find((f) => selectedFrames.includes(f.id));
    if (!frame) {
      setStatus("先在页面上点一格，再进格");
      return;
    }
    if (selectedFrames.length >= 2) {
      openJointFocus(selectedFrames);
      setAdvancedOpen(false);
      return;
    }
    setSelectedFrames([frame.id]);
    setActiveLayer(frame.layers[0]?.id ?? null);
    setFocus(frame.id);
    setAdvancedOpen(false);
  };

  /* ───────── 渲染 ───────── */

  return (
    <div className={`comic-app${embedded ? " embedded" : ""}`} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {!embedded && (
      <header className="comic-topbar">
        <button className="comic-icon-btn" title="回到书架" onClick={() => void goBack()}>
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path d="M15.5 5.5 9 12l6.5 6.5" />
          </svg>
        </button>
        <div className="comic-bookmark">
          <span className="comic-bookmark-mark">漫</span>
          <div className="comic-bookmark-text">
            <strong>{meta.title}</strong>
            <span>
              漫画 · B5 · {project?.dpi ?? 200}dpi · 竖屏阅读
            </span>
          </div>
        </div>
        <div className="comic-top-actions">
          <div className={`comic-save-pill ${saveState}`}>
            <i />
            {saveLabel}
          </div>
          <button className="comic-text-btn" onClick={undo} title="撤销 (Ctrl+Z)">
            撤销
          </button>
          <button className="comic-text-btn" onClick={redo} title="重做 (Ctrl+Shift+Z)">
            重做
          </button>
          <button className="comic-text-btn" onClick={() => void savePage()}>
            保存
          </button>
          <button
            className="comic-primary-btn"
            onClick={() => setTemplateOpen(true)}
            title="重新铺分格"
          >
            铺分格
          </button>
        </div>
      </header>
      )}

      <div className={`comic-body${focusFrame ? " focusing" : ""}`}>
        {mobilePages && (
          <button className="comic-mobile-scrim" aria-label="关闭页面" onClick={() => setMobilePages(false)} />
        )}
        {!focusFrame && (
          <aside className={`comic-rail comic-pages${mobilePages ? " open" : ""}`}>
            <div className="comic-rail-head">
              <span>页面</span>
              <small className="comic-pages-hint">长按删页</small>
              <button className="comic-pages-close" onClick={() => setMobilePages(false)} title="关闭">
                ×
              </button>
              <button className="comic-mini-btn" onClick={() => void addPage()} title="新建一页">
                +
              </button>
            </div>
            <div className="comic-page-list">
              {visiblePages.map((item, index) => (
                <button
                  key={item.id}
                  className={`comic-page-card${page?.id === item.id ? " active" : ""}`}
                  onClick={() => {
                    if (pagePressFiredRef.current) {
                      pagePressFiredRef.current = false;
                      return;
                    }
                    void switchPage(item.id);
                    setMobilePages(false);
                  }}
                  onPointerDown={() => startPagePress(item.id)}
                  onPointerUp={endPagePress}
                  onPointerCancel={endPagePress}
                  onPointerLeave={endPagePress}
                  onDoubleClick={() => setConfirmDeletePage(item.id)}
                  title="单击切换；长按删除（会先确认）"
                >
                  <div className="comic-page-thumb">
                    {thumbs[item.id] ? (
                      <img src={thumbs[item.id]} alt="" />
                    ) : (
                      <PageMini page={page?.id === item.id ? page : null} />
                    )}
                  </div>
                  <div className="comic-page-meta">
                    <strong>{index + 1}</strong>
                    <span>{item.title}</span>
                  </div>
                </button>
              ))}
              <button className="comic-page-add" onClick={() => void addPage()}>
                <span>+</span>
                <em>新建页</em>
              </button>
            </div>
          </aside>
        )}

        <section className={`comic-stage${focusFrame ? " focus" : ""}`} ref={stageRef}>
          {!focusFrame ? (
            <div className="comic-stage-topline">
              <div className="comic-stage-title">
                <strong>{page?.title ?? "…"}</strong>
                <span>
                  {page?.frames.length ?? 0} 格 · {page?.images.length ?? 0} 素材 · {page?.balloons.length ?? 0} 气泡
                </span>
              </div>
              <div className="comic-stage-hint">
                <button
                  className={`comic-magnet${magnet ? " on" : ""}`}
                  onClick={() => {
                    setMagnet(!magnet);
                    setStatus(magnet ? "磁吸已关" : "磁吸已开：靠近边线自动对齐");
                  }}
                  title="平行边与邻格吸附"
                >
                  {magnet ? "磁吸 开" : "磁吸 关"}
                </button>
                {draftRect && <span className="comic-stage-flag">拖格中</span>}
                {guides && <span className="comic-stage-flag">已吸附</span>}
                单击选中 · 双击入格 · 多选后一起画
              </div>
              {selectedFrames.length >= 2 && (
                <button
                  className="comic-join-btn"
                  onClick={() => openJointFocus(selectedFrames)}
                  title="把选中的几格当成一张纸来画"
                >
                  一起画 · {selectedFrames.length} 格
                </button>
              )}
              {embedded && (
                <div className="comic-stage-actions">
                  <button
                    className={`comic-head-menu${advancedOpen ? " open" : ""}`}
                    onClick={() => setAdvancedOpen((v) => !v)}
                    title="进阶工具：形状、移动、滤镜、选区"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
                    <span>工具</span>
                  </button>
                  <div className="comic-canvas-zoom" title="滚轮缩放画布">
                    <button
                      onClick={() => setPageZoom((z) => clamp(z - 0.1, 0.5, 3))}
                      title="缩小"
                    >
                      −
                    </button>
                    <button
                      className="comic-zoom-value"
                      onClick={() => setPageZoom(1)}
                      title="点一下回到适应大小"
                    >
                      {Math.round(pageZoom * 100)}%
                    </button>
                    <button
                      onClick={() => setPageZoom((z) => clamp(z + 0.1, 0.5, 3))}
                      title="放大"
                    >
                      +
                    </button>
                  </div>
                  <button
                    className={`comic-magnet${magnet ? " on" : ""}`}
                    onClick={() => setMagnet(!magnet)}
                    title="平行边与邻格吸附"
                  >
                    {magnet ? "磁吸 开" : "磁吸 关"}
                  </button>
                  <span className={`comic-save-pill ${saveState}`}>
                    <i />
                    {saveLabel}
                  </span>
                  <button
                    className={`comic-multi-btn${mobileMulti ? " on" : ""}`}
                    onClick={() => {
                      const next = !mobileMulti;
                      setMobileMulti(next);
                      if (next) setTool("select");
                      setStatus(next ? "多选已开：依次点几格，再点「一起画」" : "多选已关");
                    }}
                    title="单指点选多格"
                  >
                    多选
                  </button>
                  <button className="comic-action-ghost" onClick={undo} title="撤销 Ctrl+Z">撤销</button>
                  <button className="comic-action-ghost" onClick={redo} title="重做 Ctrl+Shift+Z">重做</button>
                  <button className="comic-action-ghost" onClick={() => void savePage()}>保存</button>
                </div>
              )}
              {!embedded && (
                <button
                  className={`comic-head-menu${advancedOpen ? " open" : ""}`}
                  onClick={() => setAdvancedOpen((v) => !v)}
                  title="进阶工具：形状、移动、滤镜、选区"
                >
                  工具
                </button>
              )}
            </div>
          ) : (
            <div className="comic-focus-head">
              <button
                className="comic-icon-btn"
                onClick={() => {
                  setFocus(null);
                  setTool("select");
                }}
                title="退出格内聚焦"
              >
                <svg viewBox="0 0 24 24" width="18" height="18">
                  <path d="M15.5 5.5 9 12l6.5 6.5" />
                </svg>
              </button>
              <div>
                <strong>{focusJoint ? `${focusFrames.length} 格并集` : "格内聚焦"}</strong>
                <span>
                  {focusFrame.w} × {focusFrame.h} · {activeLayer?.name ?? "无图层"}
                </span>
              </div>
              {focusJoint && (
                <button
                  className={`comic-cross-toggle${focusJoint.crossPanel ? " on" : ""}`}
                  onClick={toggleCrossPanel}
                  title="跨格连画：打开后笔迹可以穿过所选格之间的格缝，格线仍在上层"
                >
                  <i />
                  跨格连画
                </button>
              )}
              <div className="comic-focus-history">
                <button onClick={undo} title="撤销 Ctrl+Z">撤销</button>
                <button onClick={redo} title="重做 Ctrl+Shift+Z">重做</button>
              </div>
              <div className="comic-zoom">
                <button onClick={() => setZoom((z) => clamp(z - 0.12, 0.4, 4))}>−</button>
                <span>{Math.round(zoom * 100)}%</span>
                <button onClick={() => setZoom((z) => clamp(z + 0.12, 0.4, 4))}>+</button>
                <button
                  onClick={() => {
                    setZoom(1);
                    setPan({ x: 0, y: 0 });
                  }}
                >
                  适应
                </button>
              </div>
              <button
                className={`comic-head-menu${advancedOpen ? " open" : ""}`}
                onClick={() => setAdvancedOpen((v) => !v)}
                title="进阶工具：形状、移动、滤镜、选区"
              >
                <svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
                    <span>工具</span>
              </button>
            </div>
          )}

          {advancedOpen && (
            <>
              <button
                className="comic-menu-scrim"
                aria-label="关闭进阶工具"
                onClick={() => setAdvancedOpen(false)}
              />
              <div className="comic-advanced-menu" role="menu">
                <div className="comic-adv-head">
                  <div>
                    <strong>进阶工具</strong>
                    <span>{focusFrame ? "全部作用于当前图层" : "先进格，再动笔"}</span>
                  </div>
                  <button onClick={() => setAdvancedOpen(false)} title="关闭">
                    ×
                  </button>
                </div>

                <div className="comic-adv-group">
                  <span>创作</span>
                  <div className="comic-adv-grid compact">
                    <button
                      className={tool === "balloon" ? "on" : ""}
                      onClick={() => {
                        setFocus(null);
                        setTool("balloon");
                        setAdvancedOpen(false);
                        setStatus("气泡：在页面上拖出一个对话框");
                      }}
                    >
                      气泡
                    </button>
                    <button
                      className={tool === "panel" ? "on" : ""}
                      onClick={() => {
                        setFocus(null);
                        setSelectedFrames([]);
                        setSelectedBalloon(null);
                        setTool("panel");
                        setAdvancedOpen(false);
                        setStatus("手绘分格：点四个角，第 4 个角落下就成格");
                      }}
                    >
                      手绘格
                    </button>
                    <button
                      className={tool === "frame" ? "on" : ""}
                      onClick={() => {
                        setFocus(null);
                        setSelectedFrames([]);
                        setSelectedBalloon(null);
                        setPageFrameSelected(false);
                        setTool("frame");
                        setAdvancedOpen(false);
                        setStatus("拖格：在页框里拖出一个矩形分格，松手成格");
                      }}
                    >
                      拖格
                    </button>
                    <button
                      onClick={() => {
                        setTemplateOpen(true);
                        setAdvancedOpen(false);
                      }}
                    >
                      模板
                    </button>
                    <button
                      onClick={() => {
                        fileRef.current?.click();
                        setAdvancedOpen(false);
                      }}
                    >
                      图片
                    </button>
                    <button onClick={enterSelectedFrame} disabled={!selectedFrames.length}>
                      进格
                    </button>
                    <button
                      className={mobileMulti ? "on" : ""}
                      onClick={() => {
                        const next = !mobileMulti;
                        setMobileMulti(next);
                        if (next) setTool("select");
                        setStatus(next ? "多选已开：依次点几格，再点「一起画」" : "多选已关");
                      }}
                    >
                      多选
                    </button>
                    <button
                      className={magnet ? "on" : ""}
                      onClick={() => {
                        setMagnet(!magnet);
                        setStatus(magnet ? "磁吸已关" : "磁吸已开：靠近边线自动对齐");
                      }}
                    >
                      磁吸
                    </button>
                    <button
                      onClick={() => {
                        setMobilePages(true);
                        setAdvancedOpen(false);
                      }}
                    >
                      页面
                    </button>
                    <button
                      onClick={() => {
                        setMobileInspector(true);
                        setAdvancedOpen(false);
                      }}
                    >
                      图层
                    </button>
                    <button
                      onClick={() => {
                        void savePage();
                        setAdvancedOpen(false);
                      }}
                    >
                      保存
                    </button>
                  </div>
                </div>

                <div className="comic-adv-group">
                  <span>任意图形</span>
                  <div className="comic-adv-grid">
                    {(
                      [
                        ["rect", "矩形"],
                        ["ellipse", "椭圆"],
                        ["line", "直线"],
                      ] as [ShapeKind, string][]
                    ).map(([kind, label]) => (
                      <button
                        key={kind}
                        className={tool === "shape" && shapeKind === kind ? "on" : ""}
                        onClick={() => startShapeTool(kind)}
                        disabled={!focusFrame}
                      >
                        {label}
                        <em>Shift 等比</em>
                      </button>
                    ))}
                    <button
                      className={tool === "move" ? "on" : ""}
                      onClick={startMoveTool}
                      disabled={!focusFrame}
                    >
                      移动
                      <em>拖图层 / 拖选区</em>
                    </button>
                    <button
                      className={shapeConstrain ? "on" : ""}
                      onClick={() => {
                        setShapeConstrain((v) => !v);
                        setStatus(shapeConstrain ? "等比已关：可自由拉长" : "等比已开：画正方 / 正圆 / 45° 线");
                      }}
                    >
                      等比
                      <em>手机替代 Shift</em>
                    </button>
                  </div>
                </div>

                <div className="comic-adv-group">
                  <span>液化</span>
                  <div className="comic-adv-grid compact">
                    <button
                      className={tool === "liquify" ? "on" : ""}
                      onClick={startLiquifyTool}
                      disabled={!focusFrame}
                    >
                      推移
                      <em>推开湿墨</em>
                    </button>
                    <label className="comic-adv-slider">
                      <span>半径</span>
                      <strong>{liquifyRadius}</strong>
                      <input
                        type="range"
                        min="24"
                        max="120"
                        value={liquifyRadius}
                        onChange={(e) => setLiquifyRadius(Number(e.target.value))}
                      />
                    </label>
                    <label className="comic-adv-slider">
                      <span>力度</span>
                      <strong>{liquifyStrength}</strong>
                      <input
                        type="range"
                        min="10"
                        max="100"
                        value={liquifyStrength}
                        onChange={(e) => setLiquifyStrength(Number(e.target.value))}
                      />
                    </label>
                  </div>
                </div>

                <div className="comic-adv-group">
                  <span>选区</span>
                  <div className="comic-adv-grid compact">
                    <button onClick={selectAll} disabled={!focusFrame}>
                      全选
                    </button>
                    <button onClick={invertSelection} disabled={!selection}>
                      反选
                    </button>
                    <button onClick={clearSelection} disabled={!selection}>
                      取消选区
                    </button>
                    <button
                      onClick={() => {
                        copySelection();
                        setAdvancedOpen(false);
                      }}
                      disabled={!selection}
                    >
                      复制
                    </button>
                    <button
                      onClick={() => {
                        cutActiveSelection();
                        setAdvancedOpen(false);
                      }}
                      disabled={!selection}
                    >
                      剪切
                    </button>
                    <button
                      onClick={() => {
                        pasteClipboard();
                        setAdvancedOpen(false);
                      }}
                      disabled={!hasClipboard}
                    >
                      粘贴成新层
                    </button>
                  </div>
                </div>

                <div className="comic-adv-group">
                  <span>图层</span>
                  <div className="comic-adv-grid compact">
                    <button onClick={() => flipActiveLayer("h")} disabled={!focusFrame}>
                      水平翻转
                    </button>
                    <button onClick={() => flipActiveLayer("v")} disabled={!focusFrame}>
                      垂直翻转
                    </button>
                    <button onClick={clearActiveLayer} disabled={!focusFrame}>
                      清空图层
                    </button>
                  </div>
                </div>

                <div className="comic-adv-group">
                  <span>滤镜</span>
                  <div className="comic-adv-grid compact">
                    {FILTER_ITEMS.map((item) => (
                      <button
                        key={item.id}
                        onClick={() => openFilter(item.id)}
                        disabled={!focusFrame}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}

          {filterOpen && (
            <>
              <button
                className="comic-menu-scrim"
                aria-label="关闭滤镜"
                onClick={cancelFilter}
              />
              <div className="comic-filter-panel">
                <div className="comic-adv-head">
                  <div>
                    <strong>滤镜 · {FILTER_ITEMS.find((f) => f.id === filterId)?.label}</strong>
                    <span>{selection ? "只改选区里的像素" : "整层预览"}</span>
                  </div>
                  <button onClick={cancelFilter} title="取消">
                    ×
                  </button>
                </div>
                {filterId === "adjust" && (
                  <>
                    <label className="comic-filter-slider">
                      <span>亮度</span>
                      <strong>{filterOptions.brightness}</strong>
                      <input
                        type="range"
                        min="-100"
                        max="100"
                        value={filterOptions.brightness}
                        onChange={(e) =>
                          setFilterOptions((v) => ({ ...v, brightness: Number(e.target.value) }))
                        }
                      />
                    </label>
                    <label className="comic-filter-slider">
                      <span>对比度</span>
                      <strong>{filterOptions.contrast}</strong>
                      <input
                        type="range"
                        min="-100"
                        max="100"
                        value={filterOptions.contrast}
                        onChange={(e) =>
                          setFilterOptions((v) => ({ ...v, contrast: Number(e.target.value) }))
                        }
                      />
                    </label>
                    <label className="comic-filter-slider">
                      <span>饱和度</span>
                      <strong>{filterOptions.saturation}</strong>
                      <input
                        type="range"
                        min="-100"
                        max="100"
                        value={filterOptions.saturation}
                        onChange={(e) =>
                          setFilterOptions((v) => ({ ...v, saturation: Number(e.target.value) }))
                        }
                      />
                    </label>
                  </>
                )}
                {filterId === "hue" && (
                  <label className="comic-filter-slider">
                    <span>色相旋转</span>
                    <strong>{filterOptions.hue}°</strong>
                    <input
                      type="range"
                      min="-180"
                      max="180"
                      value={filterOptions.hue}
                      onChange={(e) =>
                        setFilterOptions((v) => ({ ...v, hue: Number(e.target.value) }))
                      }
                    />
                  </label>
                )}
                {filterId === "blur" && (
                  <label className="comic-filter-slider">
                    <span>模糊半径</span>
                    <strong>{filterOptions.blur}px</strong>
                    <input
                      type="range"
                      min="0"
                      max="24"
                      value={filterOptions.blur}
                      onChange={(e) =>
                        setFilterOptions((v) => ({ ...v, blur: Number(e.target.value) }))
                      }
                    />
                  </label>
                )}
                {filterId === "invert" && (
                  <p className="comic-filter-note">反相会直接反转颜色，可点应用。</p>
                )}
                {filterId === "edges" && (
                  <p className="comic-filter-note">查找边缘会提取线稿感，可点应用。</p>
                )}
                {filterId === "luma-alpha" && (
                  <p className="comic-filter-note">越亮越透明，适合做高光或阴影层。</p>
                )}
                <div className="comic-filter-actions">
                  <button onClick={cancelFilter}>取消</button>
                  <button className="primary" onClick={commitFilter}>
                    应用
                  </button>
                </div>
              </div>
            </>
          )}

          <div
            className={`comic-paper-fit${focusFrame ? " focus" : ""}${pageZoom > 1.02 ? " zoomed" : ""}`}
            ref={paperFitRef}
            onWheel={(e) => {
              if (focusFrame) return;
              const fit = paperFitRef.current;
              const wrap = paperRef.current;
              if (!fit || !wrap) return;
              const oldRect = wrap.getBoundingClientRect();
              const fx = (e.clientX - oldRect.left) / Math.max(1, oldRect.width);
              const fy = (e.clientY - oldRect.top) / Math.max(1, oldRect.height);
              const next = clamp(pageZoom - Math.sign(e.deltaY) * 0.1, 0.5, 3);
              if (Math.abs(next - pageZoom) < 0.001) return;
              e.preventDefault();
              setPageZoom(next);
              requestAnimationFrame(() => {
                const newRect = wrap.getBoundingClientRect();
                fit.scrollLeft += newRect.left + newRect.width * fx - e.clientX;
                fit.scrollTop += newRect.top + newRect.height * fy - e.clientY;
              });
            }}
          >
            {!focusFrame ? (
              <div
                className="comic-paper-wrap"
                ref={paperRef}
                style={{
                  width: `${(page?.width ?? 1654) * fitScale * pageZoom}px`,
                  height: `${(page?.height ?? 2339) * fitScale * pageZoom}px`,
                }}
              >
                <canvas
                  ref={pageCanvasRef}
                  className="comic-page-canvas"
                  style={{ width: "100%", height: "100%" }}
                  onPointerDown={onPagePointerDown}
                  onPointerMove={onPagePointerMove}
                  onPointerUp={onPagePointerUp}
                  onPointerCancel={onPagePointerUp}
                  onDoubleClick={(e) => {
                    const pt = toPagePoint(e.clientX, e.clientY);
                    if (!pt || !page) return;
                    const frame = framesForPoint(page, pt);
                    if (frame) {
                      const group = selectedFramesRef.current;
                      if (group.length >= 2 && group.includes(frame.id)) {
                        openJointFocus(group);
                      } else {
                        setSelectedFrames([frame.id]);
                        setActiveLayer(frame.layers[0]?.id ?? null);
                        setFocus(frame.id);
                      }
                    } else {
                      const b = balloonForPoint(page, pt);
                      if (b) {
                        setSelectedBalloon(b.id);
                        openTextEdit(b);
                      }
                    }
                  }}
                  onWheel={(e) => {
                    if (!page || !paperRef.current) return;
                    e.preventDefault();
                    setFitScale((s) => clamp(s - Math.sign(e.deltaY) * 0.06, 0.2, 2.2));
                  }}
                />
                {tool === "panel" && !focusFrame && (
                  <div className="comic-draft-hint">
                    {draftPoints.length
                      ? `手绘分格 · 第 ${draftPoints.length} / 4 个角 · Esc 取消`
                      : "手绘分格 · 依次点四个角，第 4 个角落下就成格"}
                  </div>
                )}
                {textEdit && page && (
                  <textarea
                    className="comic-text-edit"
                    autoFocus
                    value={textEdit.text}
                    placeholder="双击输入台词"
                    style={{
                      left: `${(textEdit.x / page.width) * 100}%`,
                      top: `${(textEdit.y / page.height) * 100}%`,
                      width: `${(textEdit.w / page.width) * 100}%`,
                      height: `${(textEdit.h / page.height) * 100}%`,
                    }}
                    onChange={(e) => onTextChange(e.target.value)}
                    onBlur={commitTextEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setTextEdit(null);
                      }
                    }}
                  />
                )}
              </div>
            ) : (
              <div className="comic-focus-wrap">
                <canvas
                  ref={focusCanvasRef}
                  className="comic-focus-canvas"
                  style={{
                    width: `${focusFrame.w * focusFit}px`,
                    height: `${focusFrame.h * focusFit}px`,
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  }}
                  onPointerDown={onFocusPointerDown}
                  onPointerMove={onFocusPointerMove}
                  onPointerUp={finishStroke}
                  onPointerCancel={finishStroke}
                  onWheel={(e) => {
                    e.preventDefault();
                    setZoom((z) => clamp(z - Math.sign(e.deltaY) * 0.08, 0.4, 4));
                  }}
                />
              </div>
            )}
          </div>

          {selectionMenuOpen && (
            <div className="comic-select-menu" onPointerDown={(e) => e.stopPropagation()}>
              <div className="comic-select-head">
                <div>
                  <strong>选择方式</strong>
                  <span>Shift 加选 · Alt 减选</span>
                </div>
                <button
                  className="comic-select-close"
                  onClick={() => setSelectionMenuOpen(false)}
                  title="关闭"
                >
                  ×
                </button>
              </div>
              <div className="comic-select-modes">
                {[
                  { key: "object", label: "对象", hint: "拖格、选气泡" },
                  { key: "rect", label: "矩形", hint: "拖一个框" },
                  { key: "lasso", label: "柳叶", hint: "自由套索" },
                  { key: "wand", label: "魔棒", hint: "按颜色选" },
                ].map((item) => {
                  const active =
                    item.key === "object"
                      ? tool === "select"
                      : tool === "selection" && selectionShape === item.key;
                  return (
                    <button
                      key={item.key}
                      className={`comic-select-mode${active ? " active" : ""}`}
                      onClick={() => {
                        if (item.key === "object") {
                          setTool("select");
                          setStatus("对象选择：点格或气泡");
                          setSelectionMenuOpen(false);
                          return;
                        }
                        setSelectionShape(item.key as SelectionShape);
                        setTool("selection");
                        setSelectionMenuOpen(true);
                        setStatus(
                          focusRef.current
                            ? item.key === "wand"
                              ? "魔棒：点要选的色块"
                              : item.key === "lasso"
                                ? "柳叶套索：按住拖一圈"
                                : "矩形框选：拖一个框"
                            : "先双击一个格进入聚焦，再框选",
                        );
                      }}
                    >
                      <b>{item.label}</b>
                      <span>{item.hint}</span>
                    </button>
                  );
                })}
              </div>
              {tool === "selection" && (
                <div className="comic-select-options">
                  <div className="comic-select-combine">
                    <span>触屏并集</span>
                    {([
                      ["new", "新建"],
                      ["add", "加选"],
                      ["subtract", "减选"],
                    ] as [SelectionMode, string][]).map(([mode, label]) => (
                      <button
                        key={mode}
                        className={selectionCombine === mode ? "on" : ""}
                        onClick={() => setSelectionCombine(mode)}
                        title={`手机上没有 Shift/Alt 时用这里；键盘仍然优先`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {selectionShape === "wand" && (
                    <label className="comic-select-slider">
                      <span>容差</span>
                      <strong>{selectionTolerance}</strong>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={selectionTolerance}
                        onChange={(e) => setSelectionTolerance(Number(e.target.value))}
                      />
                    </label>
                  )}
                  {selectionShape === "wand" && (
                    <label className="comic-select-check">
                      <input
                        type="checkbox"
                        checked={selectionContiguous}
                        onChange={(e) => setSelectionContiguous(e.target.checked)}
                      />
                      只选相连区域
                    </label>
                  )}
                  <label className="comic-select-slider">
                    <span>扩展</span>
                    <strong>{selectionExpand}px</strong>
                    <input
                      type="range"
                      min="0"
                      max="12"
                      value={selectionExpand}
                      onChange={(e) => setSelectionExpand(Number(e.target.value))}
                    />
                  </label>
                  <div className="comic-select-foot">
                    <span>{selection ? "选区已生效" : "还没有选区"}</span>
                    <div className="comic-select-ops">
                      <button onClick={selectAll}>全选</button>
                      <button onClick={invertSelection} disabled={!selection}>
                        反选
                      </button>
                      <button onClick={clearSelection} disabled={!selection}>
                        取消
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          <div
            className="comic-toolbar"
            onClick={(e) => {
              const target = e.target as HTMLElement;
              const toolLabel = target.closest(".comic-tool")?.textContent?.trim();
              const pickingColor = !!target.closest(".comic-color-picker");
              if ((toolLabel && toolLabel !== "选择") || pickingColor) setSelectionMenuOpen(false);
            }}
          >
            <ToolBtn
              active={tool === "select" || tool === "selection"}
              onClick={() => setSelectionMenuOpen((v) => !v)}
              label="选择"
              icon={
                <svg viewBox="0 0 24 24">
                  <path d="M4 4h6M4 4v6M20 20h-6M20 20v-6" />
                  <path d="M9 7l10 6-4 1.6-1.5 4z" />
                </svg>
              }
            />
            <ToolBtn
              active={tool === "brush"}
              onClick={() => setTool("brush")}
              label="画笔"
              icon={
                <svg viewBox="0 0 24 24">
                  <path d="M4 20c3-1 5-3 6-6l8-9 3 3-9 8c-3 1-5 3-6 6z" />
                </svg>
              }
            />
            <ToolBtn
              active={tool === "eraser"}
              onClick={() => setTool("eraser")}
              label="橡皮"
              icon={
                <svg viewBox="0 0 24 24">
                  <path d="M5 15l7-8 6 5-6 7H7z" />
                  <path d="M4 20h16" />
                </svg>
              }
            />
            <ToolBtn
              active={tool === "fill"}
              onClick={() => {
                setTool("fill");
                setStatus(focusRef.current ? "填充：点线稿闭合区" : "先双击一个格进入聚焦，再填充");
              }}
              label="填充"
              icon={
                <svg viewBox="0 0 24 24">
                  <path d="M5 13l7-7 6 6-7 7-6-6z" />
                  <path d="M9 21c2-2 4-4 6-6" />
                </svg>
              }
            />
            <ToolBtn
              active={tool === "eyedropper"}
              onClick={() => {
                setTool("eyedropper");
                setStatus(focusRef.current ? "吸色：点画稿任意位置" : "先双击一个格进入聚焦，再吸色");
              }}
              label="吸色"
              icon={
                <svg viewBox="0 0 24 24">
                  <path d="M4 20l3-1 9-9-2-2-9 9z" />
                  <path d="M15 5l4 4" />
                </svg>
              }
            />
            <ToolBtn
              active={tool === "balloon"}
              onClick={() => {
                setFocus(null);
                setTool("balloon");
              }}
              label="气泡"
              icon={
                <svg viewBox="0 0 24 24">
                  <path d="M4 6h16v10H9l-4 4v-4z" />
                </svg>
              }
            />
            <ToolBtn
              active={tool === "panel"}
              onClick={() => {
                setFocus(null);
                setSelectedFrames([]);
                setSelectedBalloon(null);
                setTool("panel");
                setStatus("手绘分格：点四个角，第 4 个角落下就成格");
              }}
              label="手绘格"
              icon={
                <svg viewBox="0 0 24 24">
                  <path d="M4 5l15 4-2 14-13 1z" />
                </svg>
              }
            />
            <ToolBtn
              active={tool === "frame"}
              onClick={() => {
                setFocus(null);
                setSelectedFrames([]);
                setSelectedBalloon(null);
                setPageFrameSelected(false);
                setTool("frame");
                setStatus("拖格：在页框里拖出一个矩形分格，松手成格");
              }}
              label="拖格"
              icon={
                <svg viewBox="0 0 24 24">
                  <rect x="4" y="5" width="16" height="14" />
                  <path d="M4 5l16 14M20 5L4 19" />
                </svg>
              }
            />
            <ToolBtn
              active={false}
              onClick={() => setTemplateOpen(true)}
              label="模板"
              icon={
                <svg viewBox="0 0 24 24">
                  <rect x="4" y="4" width="7" height="7" />
                  <rect x="13" y="4" width="7" height="7" />
                  <rect x="4" y="13" width="16" height="7" />
                </svg>
              }
            />
            <ToolBtn
              active={false}
              onClick={() => fileRef.current?.click()}
              label="图片"
              icon={
                <svg viewBox="0 0 24 24">
                  <rect x="4" y="5" width="16" height="14" />
                  <path d="M5 16l4-4 3 3 3-4 4 5" />
                  <circle cx="9" cy="9" r="1.3" />
                </svg>
              }
            />
            <label
              className="comic-color comic-color-picker"
              title="当前画笔颜色，点开自选"
            >
              <span className="comic-color-dot" style={{ background: brush.color }} />
              <input
                type="color"
                value={brush.color}
                onChange={(e) => chooseColor(e.target.value)}
              />
            </label>
          </div>
          {isMobile && (
            <div className="comic-mobile-dock">
              {mobileZoomOpen && (
                <div className="comic-dock-zoom-pop">
                  <button onClick={() => mobileZoomBy(-0.1)} title="缩小">−</button>
                  <span>{Math.round(mobileZoomValue * 100)}%</span>
                  <button onClick={() => mobileZoomBy(0.1)} title="放大">+</button>
                  <button className="fit" onClick={mobileZoomFit}>适应</button>
                </div>
              )}
              <div className="comic-dock-actions">
                <DockBtn label="撤销" onClick={undo}>
                  <svg viewBox="0 0 24 24"><path d="M9 7H4v5" /><path d="M4 12a7 7 0 1 0 7-7" /></svg>
                </DockBtn>
                <DockBtn label="重做" onClick={redo}>
                  <svg viewBox="0 0 24 24"><path d="M15 7h5v5" /><path d="M20 12a7 7 0 1 1-7-7" /></svg>
                </DockBtn>
                <DockBtn label="笔刷" onClick={openBrushPanel} active={mobileInspector && brushSectionOpen}>
                  <svg viewBox="0 0 24 24"><path d="M4 7h9M4 12h16M4 17h7" /><circle cx="17" cy="7" r="2" /><circle cx="14" cy="17" r="2" /></svg>
                </DockBtn>
                <DockBtn
                  label="页面"
                  onClick={() => {
                    setMobilePages(true);
                    setMobileInspector(false);
                    setAdvancedOpen(false);
                    setMobileZoomOpen(false);
                  }}
                  badge={String(visiblePages.length)}
                >
                  <svg viewBox="0 0 24 24"><rect x="4" y="4" width="12" height="16" /><path d="M8 8h12v14H8z" /></svg>
                </DockBtn>
                <DockBtn
                  label="图层"
                  onClick={() => {
                    setPanelTab("layers");
                    setMobileInspector(true);
                    setMobilePages(false);
                    setAdvancedOpen(false);
                    setMobileZoomOpen(false);
                  }}
                  badge={activeFrame ? String(activeFrame.layers.length) : undefined}
                >
                  <svg viewBox="0 0 24 24"><path d="M12 4 3.5 9 12 14l8.5-5z" /><path d="M3.5 14 12 19l8.5-5" /></svg>
                </DockBtn>
                <DockBtn
                  label="缩放"
                  onClick={() => {
                    setMobileZoomOpen((v) => !v);
                    setAdvancedOpen(false);
                  }}
                  active={mobileZoomOpen}
                >
                  <svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l5 5" /><path d="M8 10.5h5" /></svg>
                </DockBtn>
                <DockBtn
                  label="更多"
                  active={advancedOpen}
                  onClick={() => {
                    setAdvancedOpen((v) => !v);
                    setMobileZoomOpen(false);
                  }}
                >
                  <svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="18" cy="12" r="1.4" /></svg>
                </DockBtn>
              </div>
              <div className="comic-dock-tools">
                <ToolBtn
                  active={tool === "select" || tool === "selection"}
                  onClick={() => setSelectionMenuOpen((v) => !v)}
                  label="选择"
                  icon={
                    <svg viewBox="0 0 24 24">
                      <path d="M4 4h6M4 4v6M20 20h-6M20 20v-6" />
                      <path d="M9 7l10 6-4 1.6-1.5 4z" />
                    </svg>
                  }
                />
                <ToolBtn
                  active={tool === "brush"}
                  onClick={() => setTool("brush")}
                  label="画笔"
                  icon={
                    <svg viewBox="0 0 24 24">
                      <path d="M4 20c3-1 5-3 6-6l8-9 3 3-9 8c-3 1-5 3-6 6z" />
                    </svg>
                  }
                />
                <ToolBtn
                  active={tool === "eraser"}
                  onClick={() => setTool("eraser")}
                  label="橡皮"
                  icon={
                    <svg viewBox="0 0 24 24">
                      <path d="M5 15l7-8 6 5-6 7H7z" />
                      <path d="M4 20h16" />
                    </svg>
                  }
                />
                <ToolBtn
                  active={tool === "fill"}
                  onClick={() => {
                    setTool("fill");
                    setStatus(focusRef.current ? "填充：点线稿闭合区" : "先双击一个格进入聚焦，再填充");
                  }}
                  label="填充"
                  icon={
                    <svg viewBox="0 0 24 24">
                      <path d="M5 13l7-7 6 6-7 7-6-6z" />
                      <path d="M9 21c2-2 4-4 6-6" />
                    </svg>
                  }
                />
                <ToolBtn
                  active={tool === "eyedropper"}
                  onClick={() => {
                    setTool("eyedropper");
                    setStatus(focusRef.current ? "吸色：点画稿任意位置" : "先双击一个格进入聚焦，再吸色");
                  }}
                  label="吸色"
                  icon={
                    <svg viewBox="0 0 24 24">
                      <path d="M4 20l3-1 9-9-2-2-9 9z" />
                      <path d="M15 5l4 4" />
                    </svg>
                  }
                />
                <label className="comic-dock-color" title="颜色与笔刷">
                  <span style={{ background: brush.color }} />
                  <em>颜色</em>
                  <input type="color" value={brush.color} onChange={(e) => chooseColor(e.target.value)} />
                </label>
              </div>
            </div>
          )}
          {!mobilePages && (
            <button
              className="comic-mobile-pages-btn"
              onClick={() => setMobilePages(true)}
              title="页面列表"
            >
              页面
            </button>
          )}
          {!mobileInspector && (
            <button
              className="comic-mobile-inspector-btn"
              onClick={() => setMobileInspector(true)}
              title="图层、颜色与笔刷"
            >
              图层
            </button>
          )}
        </section>

        {mobileInspector && (
          <button className="comic-mobile-scrim" aria-label="关闭图层" onClick={() => setMobileInspector(false)} />
        )}
        <aside className={`comic-inspector${mobileInspector ? " open" : ""}`}>
          <div className="comic-tabs">
            <button
              className={panelTab === "layers" ? "on" : ""}
              onClick={() => setPanelTab("layers")}
            >
              图层
            </button>
            <button className={panelTab === "page" ? "on" : ""} onClick={() => setPanelTab("page")}>
              页面
            </button>
            <button className={panelTab === "assets" ? "on" : ""} onClick={() => setPanelTab("assets")}>
              素材
            </button>
            <button className="comic-inspector-close" onClick={() => setMobileInspector(false)} title="关闭">
              ×
            </button>
          </div>

          {panelTab === "layers" && (
            <div className="comic-panel">
              <div className="comic-panel-title">
                <span>{activeFrame ? "这个格的图层" : "未选格"}</span>
                {activeFrame && (
                  <button className="comic-mini-btn" onClick={addLayer} title="新建图层">
                    +
                  </button>
                )}
              </div>
              {activeFrame ? (
                <>
                  <div className="comic-layer-list">
                    {[...activeFrame.layers].reverse().map((layer) => (
                      <div
                        key={layer.id}
                        className={`comic-layer-row${activeLayer?.id === layer.id ? " active" : ""}`}
                        onClick={() => setActiveLayer(layer.id)}
                      >
                        <button
                          className={`comic-eye${layer.visible ? " on" : ""}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            patchLayer(layer.id, { visible: !layer.visible });
                          }}
                          title={layer.visible ? "隐藏图层" : "显示图层"}
                        >
                          {layer.visible ? "◉" : "○"}
                        </button>
                        <div className="comic-layer-thumb">
                          <LayerDot frame={activeFrame} layer={layer} layerMap={layerMap.current} />
                        </div>
                        <div className="comic-layer-name">
                          <strong>{layer.name}</strong>
                          <span>{layer.kind === "raster" ? "栅格" : "图片"}</span>
                        </div>
                        <button
                          className="comic-row-menu"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteLayer(layer.id);
                          }}
                          title="删除图层"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                  {activeLayer && (
                    <>
                      <label className="comic-opacity">
                        <span>不透明度</span>
                        <strong>{Math.round(activeLayer.opacity * 100)}%</strong>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={Math.round(activeLayer.opacity * 100)}
                          onChange={(e) =>
                            patchLayer(activeLayer.id, { opacity: Number(e.target.value) / 100 })
                          }
                        />
                      </label>
                      <label className="comic-blend-row">
                        <span>混合</span>
                        <select
                          value={activeLayer.blendMode ?? "normal"}
                          onChange={(e) =>
                            patchLayer(activeLayer.id, {
                              blendMode: e.target.value as ComicBlendMode,
                            })
                          }
                        >
                          {BLEND_MODE_ITEMS.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="comic-layer-toggles">
                        <button
                          className={activeLayer.clipping ? "on" : ""}
                          onClick={() =>
                            patchLayer(activeLayer.id, { clipping: !activeLayer.clipping })
                          }
                          title="只显示在下方图层有像素的地方"
                        >
                          剪贴蒙版
                        </button>
                        <button
                          className={activeLayer.alphaLocked ? "on" : ""}
                          onClick={() =>
                            patchLayer(activeLayer.id, {
                              alphaLocked: !activeLayer.alphaLocked,
                            })
                          }
                          title="只能改已有像素的颜色，不能画出新区域"
                        >
                          锁定透明
                        </button>
                      </div>
                    </>
                  )}
                  <div className="comic-layer-actions">
                    <button onClick={addLayer}>新建图层</button>
                    <button onClick={() => activeLayer && deleteLayer(activeLayer.id)}>删除图层</button>
                  </div>
                  {activeLayer && (
                    <div className="comic-layer-actions comic-layer-tools">
                      <button onClick={() => flipActiveLayer("h")}>水平翻转</button>
                      <button onClick={() => flipActiveLayer("v")}>垂直翻转</button>
                      <button onClick={clearActiveLayer}>清空图层</button>
                      <button onClick={copySelection} disabled={!selection}>
                        复制
                      </button>
                      <button onClick={cutActiveSelection} disabled={!selection}>
                        剪切
                      </button>
                      <button onClick={pasteClipboard} disabled={!hasClipboard}>
                        粘贴
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className="comic-empty">先在页面上选中一个格。</div>
              )}

              <div className="comic-sep" />
              <button
                className={`comic-brush-toggle${brushSectionOpen ? " on" : ""}`}
                onClick={() => setBrushSectionOpen((v) => !v)}
              >
                <span>颜色与笔刷</span>
                <em>{PRESETS.find((item) => item.id === preset)?.name ?? "笔刷"} · {brush.color.toUpperCase()}</em>
                <strong>{brushSectionOpen ? "收起" : "展开"}</strong>
              </button>
              {brushSectionOpen && (
                <>
              <div className="comic-panel-title">
                <span>笔</span>
                <div className="comic-panel-actions">
                  <button className="comic-studio-btn" onClick={() => setBrushPanelOpen(true)}>
                    调笔
                  </button>
                  <label className="comic-color-inline" title="自选画笔颜色">
                    <i style={{ background: brush.color }} />
                    <span>{brush.color.toUpperCase()}</span>
                    <input
                      type="color"
                      value={brush.color}
                      onChange={(e) => chooseColor(e.target.value)}
                    />
                  </label>
                </div>
              </div>
              <div className="comic-color-card">
                <div className="comic-color-head">
                  <span>颜色</span>
                  <em>{brush.color.toUpperCase()}</em>
                  <button
                    className={`comic-color-self${customColorOpen ? " active" : ""}`}
                    onClick={() => {
                      setCustomColorOpen((v) => !v);
                      setSelectionMenuOpen(false);
                    }}
                  >
                    自选
                  </button>
                </div>
                {customColorOpen && (
                  <div className="comic-color-picker-panel">
                    <div
                      className="comic-sv"
                      style={{
                        background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), hsl(${hsv.h} 100% 50%)`,
                      }}
                      onPointerDown={(e) => {
                        e.currentTarget.setPointerCapture(e.pointerId);
                        pickColorFromSV(e);
                      }}
                      onPointerMove={(e) => {
                        if (e.buttons === 1) pickColorFromSV(e);
                      }}
                      onPointerUp={(e) => {
                        const color = pickColorFromSV(e);
                        chooseColor(color);
                      }}
                    >
                      <i
                        style={{
                          left: `${hsv.s * 100}%`,
                          top: `${(1 - hsv.v) * 100}%`,
                          background: brush.color,
                        }}
                      />
                    </div>
                    <input
                      className="comic-hue"
                      type="range"
                      min="0"
                      max="360"
                      value={Math.round(hsv.h)}
                      onChange={(e) => {
                        const h = Number(e.target.value);
                        const color = hsvToHex(h, hsv.s, hsv.v);
                        setHsv((prev) => ({ ...prev, h }));
                        setHexDraft(color.toUpperCase());
                        updateBrush({ color });
                      }}
                      onPointerUp={() => chooseColor(hsvToHex(hsv.h, hsv.s, hsv.v))}
                    />
                    <div className="comic-color-readout">
                      <input
                        className="comic-hex-input"
                        value={hexDraft}
                        maxLength={7}
                        spellCheck={false}
                        onChange={(e) => setHexDraft(e.target.value)}
                        onBlur={() => {
                          const hex = normalizeHex(hexDraft);
                          if (hex) chooseColor(hex);
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          const hex = normalizeHex(hexDraft);
                          if (hex) chooseColor(hex);
                        }}
                      />
                      <button
                        onClick={() => {
                          const hex = normalizeHex(hexDraft) ?? brush.color;
                          chooseColor(hex);
                          addPaletteColor(hex);
                          setStatus(`已把 ${hex.toUpperCase()} 记进色板`);
                        }}
                      >
                        记进色板
                      </button>
                    </div>
                  </div>
                )}

                <div className="comic-color-label">
                  <span>基础色板</span>
                  <em>24 色</em>
                </div>
                <div className="comic-swatch-grid">
                  {COLOR_SWATCHES.map((c) => (
                    <button
                      key={c}
                      className={`comic-swatch${brush.color.toLowerCase() === c ? " active" : ""}`}
                      style={{ background: c }}
                      title={c}
                      onClick={() => chooseColor(c)}
                    />
                  ))}
                </div>

                <div className="comic-color-label">
                  <span>我的色板</span>
                  <em>长按移除</em>
                </div>
                {paletteColors.length > 0 ? (
                  <div className="comic-swatch-grid comic-palette-grid">
                    {paletteColors.map((c) => (
                      <button
                        key={`palette-${c}`}
                        className={`comic-swatch${brush.color.toLowerCase() === c ? " active" : ""}`}
                        style={{ background: c }}
                        title={`${c} · 长按从色板移除`}
                        onClick={() => {
                          if (palettePressFiredRef.current) {
                            palettePressFiredRef.current = false;
                            return;
                          }
                          chooseColor(c);
                        }}
                        onPointerDown={() => startPalettePress(c)}
                        onPointerUp={endPalettePress}
                        onPointerCancel={endPalettePress}
                        onPointerLeave={endPalettePress}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          removePaletteColor(c);
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="comic-palette-empty">自选颜色后点「记进色板」，会留在这里。</div>
                )}

                {recentColors.length > 0 && (
                  <div className="comic-color-recent">
                    <span>最近</span>
                    {recentColors.map((c) => (
                      <button
                        key={`recent-${c}`}
                        className="comic-swatch"
                        style={{ background: c }}
                        title={c}
                        onClick={() => chooseColor(c)}
                      />
                    ))}
                  </div>
                )}
              </div>
              <div className="comic-presets">
                {PRESETS.map((item) => (
                  <button
                    key={item.id}
                    className={`comic-preset${preset === item.id ? " active" : ""}`}
                    onClick={() => {
                      setPreset(item.id);
                      setTool("brush");
                      setBrushState((b) => {
                        const next = {
                          ...b,
                          ...item.patch,
                          smoothing: 0,
                          alignToStroke: item.patch.tip === "willow",
                        };
                        brushRef.current = next;
                        return next;
                     });
                    }}
                    title={item.note}
                  >
                    <BrushThumb preset={item} color={brush.color} />
                    <span>{item.name}</span>
                  </button>
                ))}
              </div>
              <label className="comic-slider">
                <span>粗细</span>
                <strong>{Math.round(brush.size)}</strong>
                <input
                  type="range"
                  min="2"
                  max="120"
                  value={brush.size}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setBrushState((b) => {
                      const next = { ...b, size: v };
                      brushRef.current = next;
                      return next;
                    });
                  }}
                />
              </label>
              <div className="comic-toggle-row">
                <button
                  className={`comic-toggle${brush.penPressure ? " on" : ""}`}
                  onClick={() =>
                    setBrushState((b) => {
                      const next = { ...b, penPressure: !b.penPressure };
                      brushRef.current = next;
                      return next;
                    })
                  }
                >
                  压感 {brush.penPressure ? "开" : "关"}
                </button>
                <button
                  className={`comic-toggle${tool === "eraser" ? " on" : ""}`}
                  onClick={() => setTool(tool === "eraser" ? "brush" : "eraser")}
                >
                  橡皮
                </button>
              </div>
              <label className="comic-slider">
                <span>硬度</span>
                <strong>{Math.round(brush.hardness)}%</strong>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={Math.round(brush.hardness)}
                  onChange={(e) => updateBrush({ hardness: Number(e.target.value) })}
                />
              </label>
              <label className="comic-slider">
                <span>不透明度</span>
                <strong>{Math.round(brush.opacity)}%</strong>
                <input
                  type="range"
                  min="5"
                  max="100"
                  value={Math.round(brush.opacity)}
                  onChange={(e) => updateBrush({ opacity: Number(e.target.value) })}
                />
              </label>
              <label className="comic-slider">
                <span>流量</span>
                <strong>{Math.round(brush.flow)}%</strong>
                <input
                  type="range"
                  min="5"
                  max="100"
                  value={Math.round(brush.flow)}
                  onChange={(e) => updateBrush({ flow: Number(e.target.value) })}
                />
              </label>
              <label className="comic-slider">
                <span>防抖</span>
                <strong>{Math.round(brush.smoothing)}</strong>
                <input
                  type="range"
                  min="0"
                  max="80"
                  value={Math.round(brush.smoothing)}
                  onChange={(e) => updateBrush({ smoothing: Number(e.target.value) })}
                />
              </label>
              <div className="comic-brush-selects">
                <label>
                  <span>笔尖</span>
                  <select
                    value={brush.tip}
                    onChange={(e) => {
                      const tip = e.target.value as BrushSettings["tip"];
                      updateBrush({ tip, alignToStroke: tip === "willow" });
                    }}
                  >
                    <option value="round">圆头</option>
                    <option value="pencil">铅笔</option>
                    <option value="chalk">粉笔</option>
                    <option value="bristle">排毛</option>
                    <option value="spray">喷雾</option>
                    <option value="willow">柳叶</option>
                  </select>
                </label>
                <label>
                  <span>纹理</span>
                  <select
                    value={brush.texture}
                    onChange={(e) =>
                      updateBrush({ texture: e.target.value as BrushSettings["texture"] })
                    }
                  >
                    <option value="none">无</option>
                    <option value="paper">纸纹</option>
                    <option value="canvas">画布</option>
                    <option value="grain">颗粒</option>
                    <option value="dots">斑点</option>
                  </select>
                </label>
                <label>
                  <span>间距</span>
                  <select
                    value={String(brush.spacing)}
                    onChange={(e) => updateBrush({ spacing: Number(e.target.value) })}
                  >
                    {[4, 6, 8, 11, 14].map((v) => (
                      <option key={v} value={v}>
                        {v}%
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="comic-brush-note">
                Strata 同一套笔刷内核：压感、笔尖、纹理、流量与单笔缓冲。数值越小越跟手。
              </div>
                </>
              )}
            </div>
          )}

          {panelTab === "page" && page && (
            <div className="comic-panel">
              <div className="comic-panel-title">
                <span>页面</span>
              </div>
              <label className="comic-field">
                <span>页名</span>
                <input value={page.title} onChange={(e) => renamePage(e.target.value)} />
              </label>
              <div className="comic-page-facts">
                <div><span>尺寸</span><strong>{page.width} × {page.height}</strong></div>
                <div><span>格数</span><strong>{page.frames.length}</strong></div>
                <div><span>气泡</span><strong>{page.balloons.length}</strong></div>
                <div><span>素材</span><strong>{page.images.length}</strong></div>
              </div>
              {activeFrame && (
                <>
                  <div className="comic-sep" />
                  <div className="comic-panel-title">
                    <span>当前格</span>
                  </div>
                  <div className="comic-grid2">
                    <label className="comic-field">
                      <span>X</span>
                      <input
                        type="number"
                        value={Math.round(activeFrame.x)}
                        onChange={(e) => patchFrame(activeFrame.id, { x: Number(e.target.value) })}
                      />
                    </label>
                    <label className="comic-field">
                      <span>Y</span>
                      <input
                        type="number"
                        value={Math.round(activeFrame.y)}
                        onChange={(e) => patchFrame(activeFrame.id, { y: Number(e.target.value) })}
                      />
                    </label>
                    <label className="comic-field">
                      <span>宽</span>
                      <input
                        type="number"
                        value={Math.round(activeFrame.w)}
                        onChange={(e) => patchFrame(activeFrame.id, { w: Number(e.target.value) })}
                      />
                    </label>
                    <label className="comic-field">
                      <span>高</span>
                      <input
                        type="number"
                        value={Math.round(activeFrame.h)}
                        onChange={(e) => patchFrame(activeFrame.id, { h: Number(e.target.value) })}
                      />
                    </label>
                  </div>
                  <div className="comic-toggle-row">
                    <button
                      className={`comic-toggle${activeFrame.shape === "rect" ? " on" : ""}`}
                      onClick={() =>
                        patchFrame(activeFrame.id, {
                          shape: activeFrame.shape === "rect" ? "none" : "rect",
                        })
                      }
                    >
                      线框
                    </button>
                    <button
                      className={`comic-toggle${activeFrame.shape === "none" ? " on" : ""}`}
                      onClick={() => patchFrame(activeFrame.id, { shape: "none" })}
                    >
                      无边框
                    </button>
                    <button className="comic-toggle danger" onClick={deleteSelected}>
                      删格
                    </button>
                  </div>
                </>
              )}
              {selectedBalloon && page.balloons.find((b) => b.id === selectedBalloon) && (
                <>
                  <div className="comic-sep" />
                  <div className="comic-panel-title">
                    <span>当前气泡</span>
                  </div>
                  {(() => {
                    const b = page.balloons.find((x) => x.id === selectedBalloon);
                    if (!b) return null;
                    return (
                      <>
                        <div className="comic-toggle-row">
                          <button
                            className={`comic-toggle${b.shape === "ellipse" ? " on" : ""}`}
                            onClick={() => patchBalloon(b.id, { shape: "ellipse" })}
                          >
                            椭圆
                          </button>
                          <button
                            className={`comic-toggle${b.shape === "rect" ? " on" : ""}`}
                            onClick={() => patchBalloon(b.id, { shape: "rect" })}
                          >
                            方框
                          </button>
                          <button
                            className={`comic-toggle${b.shape === "thought" ? " on" : ""}`}
                            onClick={() => patchBalloon(b.id, { shape: "thought" })}
                          >
                            想
                          </button>
                        </div>
                        <label className="comic-field">
                          <span>字号</span>
                          <input
                            type="number"
                            value={b.fontSize}
                            onChange={(e) =>
                              patchBalloon(b.id, { fontSize: Number(e.target.value) })
                            }
                          />
                        </label>
                        <button className="comic-wide-btn" onClick={() => openTextEdit(b)}>
                          编辑台词
                        </button>
                        <button
                          className="comic-wide-btn danger"
                          onClick={() => {
                            const before = clonePage(page);
                            const next = clonePage(page);
                            next.balloons = next.balloons.filter((x) => x.id !== b.id);
                            setSelectedBalloon(b.id);
                            setSelectedBalloon(null);
                            applyPageChange(next, before);
                          }}
                        >
                          删除气泡
                        </button>
                      </>
                    );
                  })()}
                </>
              )}
              <div className="comic-sep" />
              <button
                className="comic-wide-btn danger"
                onClick={() => page && setConfirmDeletePage(page.id)}
              >
                删除这一页
              </button>
            </div>
          )}

          {panelTab === "assets" && (
            <div className="comic-panel">
              <div className="comic-panel-title">
                <span>这一格的素材</span>
                <button
                  className="comic-mini-btn"
                  onClick={() => fileRef.current?.click()}
                  title="导入图片"
                >
                  +
                </button>
              </div>
              {activeImages.length ? (
                <div className="comic-asset-list">
                  {activeImages.map((item) => (
                    <div className="comic-asset-row" key={item.id}>
                      <div className="comic-asset-thumb">
                        {assetMap.current.get(item.asset) ? (
                          <img src={assetMap.current.get(item.asset)?.src} alt="" />
                        ) : (
                          <span>图</span>
                        )}
                      </div>
                      <div className="comic-asset-meta">
                        <strong>{item.name}</strong>
                        <span>{item.role === "reference" ? "参考层" : "素材层"}</span>
                      </div>
                      <button className="comic-row-menu" onClick={() => deleteImage(item.id)}>
                        ×
                      </button>
                      <div className="comic-asset-controls">
                        <select
                          value={item.fit}
                          onChange={(e) =>
                            patchImage(item.id, { fit: e.target.value as "contain" | "cover" | "stretch" })
                          }
                        >
                          <option value="contain">适应</option>
                          <option value="cover">填满</option>
                          <option value="stretch">拉伸</option>
                        </select>
                        <button
                          className={`comic-toggle${item.role === "reference" ? " on" : ""}`}
                          onClick={() =>
                            patchImage(item.id, {
                              role: item.role === "reference" ? "art" : "reference",
                            })
                          }
                        >
                          {item.role === "reference" ? "参考" : "素材"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="comic-empty">
                  还没有素材。
                  <button onClick={() => fileRef.current?.click()}>导入一张图片</button>
                  <span>也可以直接 Ctrl+V 粘贴，或把图片拖进窗口。</span>
                </div>
              )}
              {activeFrame && (
                <div className="comic-drop-hint">
                  图片默认裁进当前格；适应 / 填满 / 拉伸可随时切换。参考层会压到 45% 透明度。
                </div>
              )}
            </div>
          )}
        </aside>
      </div>

      <div className="comic-status">
        <span>{status}</span>
        {focusFrame && <em>正在画：{activeLayer?.name ?? "无图层"}</em>}
        {busy && <em>处理中…</em>}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void importImage(file);
          e.target.value = "";
        }}
      />

      {templateOpen && (
        <div
          className="comic-modal-mask"
          onClick={() => {
            setTemplateOpen(false);
            setTemplateConfirm(null);
            setPresetConfirm(null);
          }}
        >
          <div className="comic-modal comic-template-modal" onClick={(e) => e.stopPropagation()}>
            <div className="comic-modal-head">
              <div>
                <strong>铺分格</strong>
                <span>会替换当前页的格；已有画稿时先确认。</span>
              </div>
              <button
                className="comic-icon-btn"
                onClick={() => {
                  setTemplateOpen(false);
                  setTemplateConfirm(null);
                }}
              >
                ×
              </button>
            </div>
            {templateConfirm && (
              <div className="comic-template-impact">
                <p>这一页已经有画稿。换模板会清空当前所有格、气泡和图层，原画稿会丢失。</p>
                <div>
                  <button onClick={() => setTemplateConfirm(null)}>取消</button>
                  <button className="danger" onClick={() => applyTemplate(templateConfirm, true)}>
                    换模板并清空
                  </button>
                </div>
              </div>
            )}
            {presetConfirm && (
              <div className="comic-template-impact">
                <p>这一页已经有画稿。套预设会清空当前所有格、气泡和图层，原画稿会丢失。</p>
                <div>
                  <button onClick={() => setPresetConfirm(null)}>取消</button>
                  <button className="danger" onClick={() => applyPreset(presetConfirm, true)}>
                    套预设并清空
                  </button>
                </div>
              </div>
            )}
            <div className="comic-template-body">
            {[
              { family: "lianhua", name: "连环画", note: "方正分格；传统连环画、条漫的底子" },
              { family: "comic", name: "漫画", note: "斜切、错位、不规则四边形" },
              { family: "canvas", name: "整页", note: "不裁切，一张画铺满" },
            ].map((group) => {
              const items = FRAME_TEMPLATES.filter((tpl) => tpl.family === group.family);
              const customPresets = group.family === "comic" ? project?.presets ?? [] : [];
              if (!items.length && !customPresets.length) return null;
              return (
                <section className="comic-template-group" key={group.family}>
                  <div className="comic-template-group-head">
                    <b>{group.name}</b>
                    <span>{group.note}</span>
                  </div>
                  <div className="comic-template-grid">
                    {items.map((tpl) => (
                      <button
                        key={tpl.id}
                        className="comic-template-card"
                        onClick={() => applyTemplate(tpl.id)}
                      >
                        <TemplateMini frames={tpl.frames} />
                        <strong>{tpl.name}</strong>
                        <span>{tpl.note}</span>
                      </button>
                    ))}
                  </div>
                  {group.family === "comic" && customPresets.length > 0 && (
                    <div className="comic-custom-block">
                      <div className="comic-template-group-head">
                        <b>自定义</b>
                        <span>你存下来的线框；点一下套用，右键删除</span>
                      </div>
                      <div className="comic-template-grid">
                        {customPresets.map((preset) => (
                          <button
                            key={preset.id}
                            className="comic-template-card comic-preset-card"
                            onClick={() => applyPreset(preset.id)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              setPresetMenu({
                                x: Math.min(e.clientX, window.innerWidth - 180),
                                y: Math.min(e.clientY, window.innerHeight - 70),
                                id: preset.id,
                              });
                            }}
                          >
                            <TemplateMini frames={presetPreviewFrames(preset)} />
                            <strong>{preset.name}</strong>
                            <span>{preset.frames.length} 格 · 右键删除</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </section>
              );
            })}
            </div>
            <div className="comic-template-foot">
              <button
                className="comic-template-draw"
                onClick={() => {
                  setTemplateOpen(false);
                  setTemplateConfirm(null);
                  setFocus(null);
                  setSelectedFrames([]);
                  setSelectedBalloon(null);
                  setTool("panel");
                  setStatus("手绘分格：在页面上点四个角");
                }}
              >
                手绘一格（点四个角）
              </button>
              <button
                onClick={() => {
                  addFrame("frame");
                  setTemplateOpen(false);
                }}
              >
                加矩形格
              </button>
              <button
                onClick={() => {
                  setPresetName(`我的排版 ${((project?.presets?.length ?? 0) + 1)}`);
                  setPresetSaveOpen(true);
                }}
              >
                存当前为预设
              </button>
              <button
                onClick={() => {
                  addFrame("blank");
                  setTemplateOpen(false);
                }}
              >
                加无边框整页
              </button>
            </div>
          </div>
        </div>
      )}

      {brushPanelOpen && (
        <BrushStudio
          brush={brush}
          isEraser={tool === "eraser"}
          onChange={updateBrush}
          onClose={() => setBrushPanelOpen(false)}
        />
      )}

      {presetMenu &&
        createPortal(
          <div className="comic-menu-layer" onClick={() => setPresetMenu(null)}>
            <div
              className="comic-card-menu"
              style={{ left: presetMenu.x, top: presetMenu.y }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => {
                  const id = presetMenu.id;
                  setPresetMenu(null);
                  void deletePreset(id);
                }}
              >
                删除这个预设
              </button>
            </div>
          </div>,
          document.body,
        )}

      {presetSaveOpen && (
        <div className="comic-modal-mask" onClick={() => setPresetSaveOpen(false)}>
          <div className="comic-modal small" onClick={(e) => e.stopPropagation()}>
            <div className="comic-modal-head">
              <div>
                <strong>存成预设</strong>
                <span>把这一页的外框、格数和四边形形状一起保存。</span>
              </div>
            </div>
            <div className="comic-preset-form">
              <input
                value={presetName}
                autoFocus
                maxLength={24}
                placeholder="给这套排版起个名字"
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void savePreset();
                  if (e.key === "Escape") setPresetSaveOpen(false);
                }}
              />
              <p>{page?.frames.length ?? 0} 格 · 可跨页复用，套用时按当前页尺寸缩放</p>
            </div>
            <div className="comic-confirm-actions">
              <button onClick={() => setPresetSaveOpen(false)}>取消</button>
              <button className="primary" onClick={() => void savePreset()} disabled={!presetName.trim()}>
                保存预设
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDeletePage && (
        <div className="comic-modal-mask" onClick={() => setConfirmDeletePage(null)}>
          <div className="comic-modal small" onClick={(e) => e.stopPropagation()}>
            <div className="comic-modal-head">
              <div>
                <strong>删除这一页？</strong>
                <span>页面会移进 comic/trash，不会立刻销毁文件。</span>
              </div>
            </div>
            <div className="comic-confirm-actions">
              <button onClick={() => setConfirmDeletePage(null)}>保留</button>
              <button className="danger" onClick={() => void deletePage(confirmDeletePage)}>
                删除这一页
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BrushThumb({
  preset,
  color,
}: {
  preset: (typeof PRESETS)[number];
  color: string;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const size = 30;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * ratio);
    canvas.height = Math.round(size * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const brush: BrushSettings = {
      ...DEFAULT_BRUSH,
      ...preset.patch,
      color,
      smoothing: 0,
      alignToStroke: preset.patch.tip === "willow",
    };
    drawBrushTipSample(ctx, size, brush, false, ratio);
  }, [color, preset]);

  return <canvas ref={ref} className="comic-preset-thumb" width={size} height={size} aria-hidden />;
}

function ToolBtn({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <button className={`comic-tool${active ? " active" : ""}`} onClick={onClick} title={label}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function DockBtn({
  label,
  onClick,
  active = false,
  badge,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`comic-dock-btn${active ? " active" : ""}`}
      onClick={onClick}
      title={label}
      type="button"
    >
      <i className="comic-dock-icon">{children}</i>
      <span>{label}</span>
      {badge ? <em>{badge}</em> : null}
    </button>
  );
}

function PageMini({ page }: { page: ComicPage | null }) {
  if (!page) {
    return <div className="comic-page-mini empty"><i /><i /><i /></div>;
  }
  return (
    <div className="comic-page-mini">
      {page.frames.slice(0, 6).map((f) => (
        <i
          key={f.id}
          style={{
            left: `${(f.x / page.width) * 100}%`,
            top: `${(f.y / page.height) * 100}%`,
            width: `${(f.w / page.width) * 100}%`,
            height: `${(f.h / page.height) * 100}%`,
          }}
        />
      ))}
    </div>
  );
}

function presetPreviewFrames(preset: ComicPreset): TemplateFrameDef[] {
  const W = Math.max(1, preset.width);
  const H = Math.max(1, preset.height);
  return preset.frames.map((f) => {
    const box: [number, number, number, number] = [f.x / W, f.y / H, f.w / W, f.h / H];
    if (f.shape === "quad" && f.points) {
      return {
        box,
        points: f.points.map(([x, y]) => [(f.x + x * f.w) / W, (f.y + y * f.h) / H] as [number, number]),
      };
    }
    return { box };
  });
}

function TemplateMini({ frames }: { frames: TemplateFrameDef[] }) {
  const W = 1000;
  const H = 1414;
  const pathOf = (frame: TemplateFrameDef) => {
    if (frame.points && frame.points.length === 4) {
      return frame.points
        .map(([x, y], i) => {
          const px = x * W;
          const py = y * H;
          return `${i === 0 ? "M" : "L"}${px.toFixed(1)} ${py.toFixed(1)}`;
        })
        .join(" ")
        .concat(" Z");
    }
    const [x, y, w, h] = frame.box;
    const x1 = x * W;
    const y1 = y * H;
    const x2 = (x + w) * W;
    const y2 = (y + h) * H;
    return `M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)} L${x1.toFixed(1)} ${y2.toFixed(1)} Z`;
  };
  return (
    <div className="comic-template-mini">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {frames.map((frame, i) => (
          <path key={i} d={pathOf(frame)} />
        ))}
      </svg>
    </div>
  );
}

function LayerDot({
  frame,
  layer,
  layerMap,
}: {
  frame: ComicFrame;
  layer: ComicLayerMeta;
  layerMap: Map<string, HTMLCanvasElement>;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    const source = layerMap.get(keyOf(frame.id, layer.id));
    if (!canvas) return;
    canvas.width = 40;
    canvas.height = 40;
    const ctx = mustCtx(canvas);
    ctx.clearRect(0, 0, 40, 40);
    ctx.fillStyle = "#fffdf9";
    ctx.fillRect(0, 0, 40, 40);
    if (source) {
      const ratio = Math.min(40 / source.width, 40 / source.height);
      const w = source.width * ratio;
      const h = source.height * ratio;
      ctx.drawImage(source, (40 - w) / 2, (40 - h) / 2, w, h);
    }
  }, [frame.id, layer.id, layerMap]);
  return <canvas ref={ref} className="comic-layer-dot" />;
}
