import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createSurface, mustCtx } from "../../lib/paint/surface";
import { ConfirmDialog } from "../Modals";
import type { PaintDims } from "./CoverPaintStudio";
import { Stroke, DEFAULT_BRUSH, type BrushSettings, type BrushTip, type BrushTexture } from "./engine/strataPaint";

type Tool =
  | "brush"
  | "eraser"
  | "fill"
  | "line"
  | "rect"
  | "ellipse"
  | "text"
  | "image"
  | "eyedropper"
  | "select"
  | "move"
  | "hand";

type BlendMode = "source-over" | "multiply" | "screen" | "overlay" | "darken" | "lighten";
type BrushPreset = "pen" | "pencil" | "marker" | "water" | "spray" | "chalk" | "bristle";
type SelectionMode = "rect" | "lasso" | "wand";

type Layer = {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blend?: BlendMode;
  groupId?: string;
  clip?: boolean;
  canvas: HTMLCanvasElement;
};

type LayerGroup = {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blend?: BlendMode;
};

type Hist =
  | {
      kind: "pixels";
      layerId: string;
      x: number;
      y: number;
      w: number;
      h: number;
      before: ImageData;
      after: ImageData;
    }
  | { kind: "layers"; before: LayerSnap[]; after: LayerSnap[] };

type LayerSnap = {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blend?: BlendMode;
  groupId?: string;
  clip?: boolean;
  data: string;
};

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: "brush", label: "画笔", hint: "压感与防抖落笔" },
  { id: "eraser", label: "橡皮", hint: "按像素擦除" },
  { id: "fill", label: "填充", hint: "容差油漆桶" },
  { id: "line", label: "直线", hint: "拖一条直线" },
  { id: "rect", label: "矩形", hint: "拖矩形，可填充" },
  { id: "ellipse", label: "椭圆", hint: "拖椭圆，可填充" },
  { id: "text", label: "文字", hint: "点一下落字" },
  { id: "image", label: "图片", hint: "导入照片作新图层" },
  { id: "eyedropper", label: "吸色", hint: "从画面取色" },
  { id: "select", label: "选区", hint: "矩形选区，可删/复制" },
  { id: "move", label: "移动", hint: "拖动当前图层" },
  { id: "hand", label: "抓手", hint: "平移画布" },
];

const PALETTE = [
  "#1d1a16", "#f5efe3", "#c9a96b", "#b9684a", "#8d3b34",
  "#455d4b", "#2f6f7e", "#3d4f91", "#6d4a8f", "#a35477",
  "#e7c8a4", "#c7d3c0", "#8f9aa6", "#5a6068", "#ffffff",
  "#000000",
];

function newLayer(name: string, w: number, h: number, fill?: string): Layer {
  return {
    id: `l${Math.random().toString(36).slice(2, 9)}`,
    name,
    visible: true,
    opacity: 1,
    blend: "source-over",
    canvas: createSurface(w, h, fill),
  };
}

function hexToRgba(hex: string, alpha = 1): [number, number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [
    parseInt(full.slice(0, 2) || "0", 16),
    parseInt(full.slice(2, 4) || "0", 16),
    parseInt(full.slice(4, 6) || "0", 16),
    Math.round(alpha * 255),
  ];
}

function cropPixels(src: ImageData, x: number, y: number, w: number, h: number): ImageData {
  const out = new ImageData(w, h);
  const sw = src.width;
  for (let row = 0; row < h; row += 1) {
    const from = ((y + row) * sw + x) * 4;
    out.data.set(src.data.subarray(from, from + w * 4), row * w * 4);
  }
  return out;
}

function restoreSnaps(snaps: LayerSnap[]): Promise<Layer[]> {
  return Promise.all(
    snaps.map(
      (s) =>
        new Promise<Layer>((resolve) => {
          const canvas = createSurface(1, 1);
          const ctx = mustCtx(canvas);
          const img = new Image();
          img.onload = () => {
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0);
            resolve({ ...s, canvas });
          };
          img.onerror = () => resolve({ ...s, canvas });
          img.src = s.data;
        }),
    ),
  );
}

function floodFill(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  hex: string,
  tolerance: number,
): { x: number; y: number; w: number; h: number } | null {
  const { width: w, height: h } = ctx.canvas;
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const start = (sy * w + sx) * 4;
  const tr = d[start], tg = d[start + 1], tb = d[start + 2], ta = d[start + 3];
  const [nr, ng, nb, na] = hexToRgba(hex, 1);
  const tol = (tolerance / 100) * 441;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [sy * w + sx];
  let minX = w, minY = h, maxX = 0, maxY = 0;
  const match = (i: number) => {
    const p = i * 4;
    const dr = d[p] - tr, dg = d[p + 1] - tg, db = d[p + 2] - tb, da = d[p + 3] - ta;
    return Math.sqrt(dr * dr + dg * dg + db * db + da * da) <= tol;
  };
  if (tr === nr && tg === ng && tb === nb && ta === na) return null;
  while (stack.length) {
    const i = stack.pop() as number;
    if (seen[i]) continue;
    if (!match(i)) continue;
    seen[i] = 1;
    const x = i % w, y = (i / w) | 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    d[i * 4] = nr;
    d[i * 4 + 1] = ng;
    d[i * 4 + 2] = nb;
    d[i * 4 + 3] = na;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  if (maxX < minX) return null;
  ctx.putImageData(img, 0, 0);
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function ToolGlyph({ tool }: { tool: Tool }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (tool) {
    case "brush":
      return <svg viewBox="0 0 24 24"><path {...common} d="M4 20c2.6-.2 4-1.3 5-3.2 1.2-2.2 2.8-4.4 5-6.5l5-5 1.2 1.2-5 5c-2.2 2.2-4.3 3.8-6.4 5-2 1.1-3.2 2.5-3.4 4.2z" /><path {...common} d="M14.4 6.4l3.2 3.2" /></svg>;
    case "eraser":
      return <svg viewBox="0 0 24 24"><path {...common} d="m4.6 13.6 6-6a3 3 0 0 1 4.2 0l3.6 3.6a3 3 0 0 1 0 4.2l-4.4 4.4H8.2l-3.6-3.6a3 3 0 0 1 0-2.6z" /><path {...common} d="M10 8.2l6.6 6.6M8 20h11" /></svg>;
    case "fill":
      return <svg viewBox="0 0 24 24"><path {...common} d="m4 12 7-7 7 7-7 7z" /><path {...common} d="M9 5V3M4 12H2M19 17c1.3 0 2 1 2 2.2 0 1-.8 1.8-2 1.8s-2-.8-2-1.8c0-1.2.7-2.2 2-2.2z" /></svg>;
    case "line":
      return <svg viewBox="0 0 24 24"><path {...common} d="M4 19 20 5" /><circle {...common} cx="4" cy="19" r="1.8" /><circle {...common} cx="20" cy="5" r="1.8" /></svg>;
    case "rect":
      return <svg viewBox="0 0 24 24"><rect {...common} x="4" y="6" width="16" height="12" rx="1" /></svg>;
    case "ellipse":
      return <svg viewBox="0 0 24 24"><ellipse {...common} cx="12" cy="12" rx="8" ry="6" /></svg>;
    case "text":
      return <svg viewBox="0 0 24 24"><path {...common} d="M5 6V4h14v2M12 4v16M8 20h8" /></svg>;
    case "image":
      return <svg viewBox="0 0 24 24"><rect {...common} x="3.5" y="5" width="17" height="14" rx="1.5" /><circle {...common} cx="8.5" cy="10" r="1.6" /><path {...common} d="m5 17 4.5-4.5 3 3 2.5-2.5 4 4" /></svg>;
    case "eyedropper":
      return <svg viewBox="0 0 24 24"><path {...common} d="m4 20 1.4-4.5L15 5l4 4-10.5 9.5z" /><path {...common} d="m13.5 6.5 4 4M15.5 4.5l4 4" /></svg>;
    case "move":
      return <svg viewBox="0 0 24 24"><path {...common} d="M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5" /></svg>;
    case "select":
      return <svg viewBox="0 0 24 24"><rect {...common} x="4" y="5" width="16" height="14" strokeDasharray="3 3" /><path {...common} d="M8 3v3M16 3v3M8 18v3M16 18v3M2 9h3M2 15h3M19 9h3M19 15h3" /></svg>;
    case "hand":
      return <svg viewBox="0 0 24 24"><path {...common} d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V5.5a1.5 1.5 0 0 1 3 0V13M17 9.5a1.5 1.5 0 0 1 3 0V15c0 3.2-2.2 6-6 6h-2c-2.2 0-3.3-1-4.5-3L4.2 13a1.6 1.6 0 0 1 2.6-1.8L8 13" /></svg>;
  }
}

export function CoverRasterEditor({
  title,
  author,
  dims,
  onClose,
  onDone,
}: {
  title: string;
  author: string;
  dims: PaintDims;
  onClose: () => void;
  onDone: (dataUrl: string) => Promise<void> | void;
}) {
  const W = dims.w;
  const H = dims.h;
  const viewRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [layers, setLayers] = useState<Layer[]>([]);
  const layersRef = useRef<Layer[]>([]);
  const [groups, setGroups] = useState<LayerGroup[]>([]);
  const groupsRef = useRef<LayerGroup[]>([]);
  const [activeId, setActiveId] = useState("");
  const activeIdRef = useRef("");
  const [version, setVersion] = useState(0);
  const [tool, setTool] = useState<Tool>("brush");
  const toolRef = useRef<Tool>("brush");
  const [selection, setSelection] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const selectionRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("rect");
  const selectionModeRef = useRef<SelectionMode>("rect");
  const selMaskRef = useRef<HTMLCanvasElement | null>(null);
  const selTintRef = useRef<HTMLCanvasElement | null>(null);
  const clipboardRef = useRef<ImageData | null>(null);
  const [hasClip, setHasClip] = useState(false);
  const [color, setColor] = useState("#c9a96b");
  const colorRef = useRef("#c9a96b");
  const [size, setSize] = useState(22);
  const sizeRef = useRef(22);
  const [opacity, setOpacity] = useState(100);
  const opacityRef = useRef(100);
  const [hardness, setHardness] = useState(80);
  const hardnessRef = useRef(80);
  const [preset, setPreset] = useState<BrushPreset>("pen");
  const presetRef = useRef<BrushPreset>("pen");
  const [texture, setTexture] = useState<BrushTexture>("none");
  const textureRef = useRef<BrushTexture>("none");
  const [textureDepth, setTextureDepth] = useState(18);
  const textureDepthRef = useRef(18);
  const strokeRef = useRef<Stroke | null>(null);
  const [tolerance, setTolerance] = useState(18);
  const toleranceRef = useRef(18);
  const [symmetry, setSymmetry] = useState<"none" | "x" | "y" | "both">("none");
  const symmetryRef = useRef<"none" | "x" | "y" | "both">("none");
  const [smooth, setSmooth] = useState(35);
  const smoothRef = useRef(35);
  const [pressureOn, setPressureOn] = useState(true);
  const pressureRef = useRef(true);
  const [shapeFill, setShapeFill] = useState(false);
  const shapeFillRef = useRef(false);
  const imageSourceRef = useRef<{ id: string; img: HTMLImageElement; base: number } | null>(null);
  const [imgScale, setImgScale] = useState(100);
  const [imgRot, setImgRot] = useState(0);
  const [imgReady, setImgReady] = useState(false);
  const [text, setText] = useState("封面标题");
  const [fontSize, setFontSize] = useState(90);
  const fontSizeRef = useRef(90);
  const [fontFamily, setFontFamily] = useState("'Noto Serif SC', serif");
  const fontFamilyRef = useRef("'Noto Serif SC', serif");
  const [baseScale, setBaseScale] = useState(0);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const [panel, setPanel] = useState<"brush" | "layers" | "adjust">("brush");
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [leaveAsk, setLeaveAsk] = useState(false);
  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast] = useState(0);
  const [saturate, setSaturate] = useState(0);
  const [blur, setBlur] = useState(0);
  const [, setHistV] = useState(0);

  const histRef = useRef<Hist[]>([]);
  const redoRef = useRef<Hist[]>([]);
  const drawing = useRef<{
    down: boolean;
    pointerId: number;
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    sx: number;
    sy: number;
    moved: boolean;
    before: ImageData | null;
    bbox: [number, number, number, number];
  }>({ down: false, pointerId: -1, x: 0, y: 0, lastX: 0, lastY: 0, sx: 0, sy: 0, moved: false, before: null, bbox: [0, 0, 0, 0] });
  const panRef = useRef({ active: false, x: 0, y: 0, left: 0, top: 0 });
  const moveSelRef = useRef<{ float: HTMLCanvasElement; base: HTMLCanvasElement } | null>(null);
  const lassoRef = useRef<{ active: boolean; points: { x: number; y: number }[] }>({ active: false, points: [] });
  const baseScaleRef = useRef(0);
  const brushCursorRef = useRef<HTMLDivElement>(null);
  const touchPointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{
    startDist: number;
    startZoom: number;
    logicalX: number;
    logicalY: number;
  } | null>(null);

  const syncLayers = (next: Layer[]) => {
    layersRef.current = next;
    setLayers(next);
  };
  const syncGroups = (next: LayerGroup[]) => {
    groupsRef.current = next;
    setGroups(next);
  };
  const syncActive = (id: string) => {
    activeIdRef.current = id;
    setActiveId(id);
  };
  const bump = () => setVersion((v) => v + 1);
  const activeLayer = layers.find((l) => l.id === activeId);
  const activeGroup = groups.find((g) => g.id === activeLayer?.groupId) || null;

  useEffect(() => {
    const bg = newLayer("背景", W, H, "#fbf7ee");
    const ink = newLayer("图层 1", W, H);
    syncLayers([bg, ink]);
    syncGroups([]);
    syncActive(ink.id);
    histRef.current = [];
    redoRef.current = [];
    setHistV((v) => v + 1);
  }, [W, H]);

  const paintLayer = (ctx: CanvasRenderingContext2D, l: Layer, prev: HTMLCanvasElement | null) => {
    if (!l.visible) return prev;
    if (l.clip && prev) {
      const temp = createSurface(W, H);
      const tc = mustCtx(temp);
      tc.drawImage(l.canvas, 0, 0);
      tc.globalCompositeOperation = "destination-in";
      tc.drawImage(prev, 0, 0);
      tc.globalCompositeOperation = "source-over";
      ctx.save();
      ctx.globalAlpha = l.opacity;
      ctx.globalCompositeOperation = l.blend || "source-over";
      ctx.drawImage(temp, 0, 0);
      ctx.restore();
      return temp;
    }
    ctx.save();
    ctx.globalAlpha = l.opacity;
    ctx.globalCompositeOperation = l.blend || "source-over";
    ctx.drawImage(l.canvas, 0, 0);
    ctx.restore();
    return l.canvas;
  };

  const paintStack = (ctx: CanvasRenderingContext2D, list: Layer[]) => {
    const seen = new Set<string>();
    let prev: HTMLCanvasElement | null = null;
    for (const l of list) {
      if (l.groupId) {
        if (seen.has(l.groupId)) continue;
        seen.add(l.groupId);
        const g = groupsRef.current.find((x) => x.id === l.groupId);
        if (!g || !g.visible) { prev = null; continue; }
        const members = list.filter((x) => x.groupId === l.groupId);
        const gc = createSurface(W, H);
        const gctx = mustCtx(gc);
        let gp: HTMLCanvasElement | null = null;
        for (const m of members) gp = paintLayer(gctx, m, gp);
        ctx.save();
        ctx.globalAlpha = g.opacity;
        ctx.globalCompositeOperation = g.blend || "source-over";
        ctx.drawImage(gc, 0, 0);
        ctx.restore();
        prev = gc;
        continue;
      }
      prev = paintLayer(ctx, l, l.clip ? prev : null);
    }
  };
  const render = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const ctx = mustCtx(view);
    ctx.clearRect(0, 0, W, H);
    const cell = 22;
    for (let y = 0; y < H; y += cell) {
      for (let x = 0; x < W; x += cell) {
        ctx.fillStyle = ((x / cell + y / cell) | 0) % 2 ? "#e9e3d5" : "#f5f0e6";
        ctx.fillRect(x, y, cell, cell);
      }
    }
    paintStack(ctx, layersRef.current);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    const live = strokeRef.current;
    if (live) {
      if (toolRef.current === "eraser") {
        const tmp = createSurface(W, H);
        const tc = mustCtx(tmp);
        paintStack(tc, layersRef.current);
        tc.globalCompositeOperation = "destination-out";
        tc.drawImage(live.buffer, 0, 0);
        tc.globalCompositeOperation = "source-over";
        ctx.drawImage(tmp, 0, 0);
      } else {
        ctx.save();
        ctx.globalAlpha = opacityRef.current / 100;
        ctx.drawImage(live.buffer, 0, 0);
        ctx.restore();
      }
    }
    const sel = selectionRef.current;
    if (sel) {
      const tint = selTintRef.current;
      if (tint) {
        ctx.save();
        ctx.globalAlpha = 0.16;
        ctx.drawImage(tint, 0, 0);
        ctx.restore();
      }
      ctx.save();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#d7ad6f";
      ctx.setLineDash([10, 8]);
      ctx.strokeRect(sel.x, sel.y, sel.w, sel.h);
      ctx.restore();
    }
    const lasso = lassoRef.current;
    if (lasso.active && lasso.points.length > 1) {
      ctx.save();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#d7ad6f";
      ctx.setLineDash([8, 7]);
      ctx.beginPath();
      lasso.points.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
  }, [W, H]);
  useEffect(() => {
    render();
  }, [layers, groups, version, render]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const fit = () => {
      const sw = stage.clientWidth;
      const sh = stage.clientHeight;
      if (!sw || !sh) return;
      const padH = window.innerWidth <= 820 ? 184 : 44;
      const padX = window.innerWidth <= 820 ? 30 : 60;
      setBaseScale(Math.min((sw - padX) / W, Math.max(80, sh - padH) / H));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [W, H]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { selectionModeRef.current = selectionMode; }, [selectionMode]);
  useEffect(() => { baseScaleRef.current = baseScale; }, [baseScale]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { sizeRef.current = size; }, [size]);
  useEffect(() => { opacityRef.current = opacity; }, [opacity]);
  useEffect(() => { hardnessRef.current = hardness; }, [hardness]);
  useEffect(() => { presetRef.current = preset; }, [preset]);
  useEffect(() => { textureRef.current = texture; }, [texture]);
  useEffect(() => { textureDepthRef.current = textureDepth; }, [textureDepth]);
  useEffect(() => { toleranceRef.current = tolerance; }, [tolerance]);
  useEffect(() => { symmetryRef.current = symmetry; }, [symmetry]);
  useEffect(() => { smoothRef.current = smooth; }, [smooth]);
  useEffect(() => { pressureRef.current = pressureOn; }, [pressureOn]);
  useEffect(() => { shapeFillRef.current = shapeFill; }, [shapeFill]);
  useEffect(() => { fontSizeRef.current = fontSize; }, [fontSize]);
  useEffect(() => { fontFamilyRef.current = fontFamily; }, [fontFamily]);

  const pushHistory = (entry: Hist) => {
    histRef.current.push(entry);
    if (histRef.current.length > 14) histRef.current.shift();
    redoRef.current = [];
    setHistV((v) => v + 1);
  };

  const pushPixels = (layer: Layer, before: ImageData, bbox: [number, number, number, number]) => {
    let x = Math.max(0, Math.floor(bbox[0]));
    let y = Math.max(0, Math.floor(bbox[1]));
    let x2 = Math.min(W, Math.ceil(bbox[2]));
    let y2 = Math.min(H, Math.ceil(bbox[3]));
    if (x2 <= x || y2 <= y) return;
    const w = x2 - x, h = y2 - y;
    const c = before;
    let bx = x, by = y, bw = w, bh = h;
    if (c.width !== W || c.height !== H) {
      bx = 0; by = 0; bw = c.width; bh = c.height;
    }
    const beforeCrop = cropPixels(c, bx, by, bw, bh);
    const afterCrop = mustCtx(layer.canvas).getImageData(bx, by, bw, bh);
    pushHistory({ kind: "pixels", layerId: layer.id, x: bx, y: by, w: bw, h: bh, before: beforeCrop, after: afterCrop });
  };

  const undo = async () => {
    const entry = histRef.current.pop();
    if (!entry) return;
    redoRef.current.push(entry);
    if (entry.kind === "pixels") {
      const layer = layersRef.current.find((l) => l.id === entry.layerId);
      if (layer) {
        mustCtx(layer.canvas).putImageData(entry.before, entry.x, entry.y);
        bump();
      }
    } else {
      const next = await restoreSnaps(entry.before);
      syncLayers(next);
    }
    setHistV((v) => v + 1);
  };

  const redo = async () => {
    const entry = redoRef.current.pop();
    if (!entry) return;
    histRef.current.push(entry);
    if (entry.kind === "pixels") {
      const layer = layersRef.current.find((l) => l.id === entry.layerId);
      if (layer) {
        mustCtx(layer.canvas).putImageData(entry.after, entry.x, entry.y);
        bump();
      }
    } else {
      const next = await restoreSnaps(entry.after);
      syncLayers(next);
    }
    setHistV((v) => v + 1);
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) void redo();
        else void undo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        void redo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") { e.preventDefault(); copySelection(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x") { e.preventDefault(); cutSelection(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") { e.preventDefault(); pasteSelection(); }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectionRef.current && document.activeElement?.tagName !== "TEXTAREA" && document.activeElement?.tagName !== "INPUT") {
          e.preventDefault();
          deleteSelection();
        }
      }
      if (e.key === "[") setSize((s) => Math.max(1, s - 2));
      if (e.key === "]") setSize((s) => Math.min(400, s + 2));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const pointOf = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = viewRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (W / r.width),
      y: (e.clientY - r.top) * (H / r.height),
      pressure: e.pointerType === "pen" && pressureRef.current ? Math.max(0.08, e.pressure || 0.5) : 1,
    };
  };

  const applyPreset = (p: BrushPreset) => {
    setPreset(p);
    const conf = {
      pen: { size: 22, hardness: 80, opacity: 100, smooth: 35, texture: "none" as BrushTexture, depth: 0 },
      pencil: { size: 10, hardness: 45, opacity: 80, smooth: 20, texture: "paper" as BrushTexture, depth: 26 },
      marker: { size: 44, hardness: 100, opacity: 60, smooth: 25, texture: "canvas" as BrushTexture, depth: 10 },
      water: { size: 64, hardness: 15, opacity: 35, smooth: 55, texture: "paper" as BrushTexture, depth: 34 },
      spray: { size: 52, hardness: 100, opacity: 45, smooth: 30, texture: "dots" as BrushTexture, depth: 22 },
      chalk: { size: 38, hardness: 70, opacity: 78, smooth: 18, texture: "grain" as BrushTexture, depth: 46 },
      bristle: { size: 46, hardness: 85, opacity: 82, smooth: 28, texture: "canvas" as BrushTexture, depth: 24 },
    }[p];
    setSize(conf.size); setHardness(conf.hardness); setOpacity(conf.opacity); setSmooth(conf.smooth);
    setTexture(conf.texture); setTextureDepth(conf.depth);
  };
  const expandBBox = (d: typeof drawing.current, x: number, y: number, radius: number) => {
    const pad = radius + 4;
    d.bbox[0] = Math.min(d.bbox[0], x - pad);
    d.bbox[1] = Math.min(d.bbox[1], y - pad);
    d.bbox[2] = Math.max(d.bbox[2], x + pad);
    d.bbox[3] = Math.max(d.bbox[3], y + pad);
  };

  const drawShape = (
    ctx: CanvasRenderingContext2D,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    t: Tool,
    constrain: boolean,
    preview: boolean,
  ) => {
    let x2 = endX, y2 = endY;
    if (constrain) {
      const dx = endX - startX, dy = endY - startY;
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      x2 = startX + Math.sign(dx) * m;
      y2 = startY + Math.sign(dy) * m;
    }
    const x = Math.min(startX, x2), y = Math.min(startY, y2);
    const w = Math.abs(x2 - startX), h = Math.abs(y2 - startY);
    ctx.save();
    ctx.globalAlpha = opacityRef.current / 100;
    ctx.strokeStyle = colorRef.current;
    ctx.fillStyle = colorRef.current;
    ctx.lineWidth = Math.max(1, sizeRef.current * (tool === "line" ? 0.45 : 0.35));
    if (t === "line") {
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    } else if (t === "rect") {
      if (shapeFillRef.current) ctx.fillRect(x, y, w, h);
      if (!shapeFillRef.current || preview) ctx.strokeRect(x, y, w, h);
    } else if (t === "ellipse") {
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      if (shapeFillRef.current) ctx.fill();
      if (!shapeFillRef.current || preview) ctx.stroke();
    }
    ctx.restore();
  };

  const overlayPreview = (startX: number, startY: number, endX: number, endY: number, constrain: boolean) => {
    render();
    const view = viewRef.current;
    if (!view) return;
    requestAnimationFrame(() => {
      const ctx = mustCtx(view);
      drawShape(ctx, startX, startY, endX, endY, toolRef.current, constrain, true);
    });
  };

  const beginMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const layer = activeLayer;
    if (!layer) return;
    const ctx = mustCtx(layer.canvas);
    const before = ctx.getImageData(0, 0, W, H);
    const sel = selectionRef.current;
    const mask = makeSelectionMask();
    if (sel && mask) {
      const float = createSurface(W, H);
      const fc = mustCtx(float);
      fc.drawImage(layer.canvas, 0, 0);
      fc.globalCompositeOperation = "destination-in";
      fc.drawImage(mask, 0, 0);
      fc.globalCompositeOperation = "source-over";
      const base = createSurface(W, H);
      const bc = mustCtx(base);
      bc.drawImage(layer.canvas, 0, 0);
      eraseMasked(bc, mask, sel);
      moveSelRef.current = { float, base };
    } else {
      moveSelRef.current = null;
    }
    drawing.current.before = before;
    drawing.current.sx = pointOf(e).x;
    drawing.current.sy = pointOf(e).y;
    drawing.current.x = drawing.current.sx;
    drawing.current.y = drawing.current.sy;
  };

  const moveLayer = (dx: number, dy: number) => {
    const layer = activeLayer;
    if (!layer || !drawing.current.before) return;
    const ctx = mustCtx(layer.canvas);
    const movingSel = moveSelRef.current;
    if (movingSel) {
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(movingSel.base, 0, 0);
      ctx.drawImage(movingSel.float, Math.round(dx), Math.round(dy));
    } else {
      ctx.clearRect(0, 0, W, H);
      const tmp = createSurface(W, H);
      mustCtx(tmp).putImageData(drawing.current.before, 0, 0);
      ctx.drawImage(tmp, Math.round(dx), Math.round(dy));
    }
    bump();
  };

  const buildSelectionTint = (mask: HTMLCanvasElement | null) => {
    if (!mask) { selTintRef.current = null; return; }
    const tint = createSurface(W, H);
    const tc = mustCtx(tint);
    tc.fillStyle = "#d7ad6f";
    tc.fillRect(0, 0, W, H);
    tc.globalCompositeOperation = "destination-in";
    tc.drawImage(mask, 0, 0);
    tc.globalCompositeOperation = "source-over";
    selTintRef.current = tint;
  };
  const syncSel = (r: { x: number; y: number; w: number; h: number } | null, mask: HTMLCanvasElement | null = null) => {
    selectionRef.current = r;
    selMaskRef.current = mask;
    buildSelectionTint(mask);
    setSelection(r);
    render();
  };

  const selectionBox = (sx: number, sy: number, ex: number, ey: number) => ({
    x: Math.max(0, Math.min(sx, ex)),
    y: Math.max(0, Math.min(sy, ey)),
    w: Math.min(W, Math.max(sx, ex)) - Math.max(0, Math.min(sx, ex)),
    h: Math.min(H, Math.max(sy, ey)) - Math.max(0, Math.min(sy, ey)),
  });

  const extractSelection = (layer: Layer, sel: { x: number; y: number; w: number; h: number }) => {
    const x = Math.max(0, Math.floor(sel.x));
    const y = Math.max(0, Math.floor(sel.y));
    const w = Math.max(1, Math.min(W - x, Math.ceil(sel.w)));
    const h = Math.max(1, Math.min(H - y, Math.ceil(sel.h)));
    const tmp = createSurface(w, h);
    const tc = mustCtx(tmp);
    tc.drawImage(layer.canvas, -x, -y);
    const mask = selMaskRef.current;
    if (mask) {
      tc.globalCompositeOperation = "destination-in";
      tc.drawImage(mask, -x, -y);
      tc.globalCompositeOperation = "source-over";
    }
    return { x, y, w, h, canvas: tmp, data: tc.getImageData(0, 0, w, h) };
  };

  const growMask = (mask: HTMLCanvasElement) => {
    const out = createSurface(W, H);
    const c = mustCtx(out);
    for (let oy = -2; oy <= 2; oy += 1) {
      for (let ox = -2; ox <= 2; ox += 1) c.drawImage(mask, ox, oy);
    }
    return out;
  };

  const eraseMasked = (ctx: CanvasRenderingContext2D, mask: HTMLCanvasElement, area: { x: number; y: number; w: number; h: number }) => {
    const x = Math.max(0, Math.floor(area.x));
    const y = Math.max(0, Math.floor(area.y));
    const w = Math.max(1, Math.min(W - x, Math.ceil(area.w)));
    const h = Math.max(1, Math.min(H - y, Math.ceil(area.h)));
    const target = ctx.getImageData(x, y, w, h);
    const maskData = mustCtx(mask).getImageData(x, y, w, h).data;
    const td = target.data;
    for (let i = 0; i < td.length; i += 4) {
      const ma = maskData[i + 3];
      if (ma > 2) td[i + 3] = 0;
    }
    ctx.putImageData(target, x, y);
  };

  const copySelection = () => {
    const layer = activeLayer;
    const sel = selectionRef.current;
    if (!layer || !sel || sel.w < 1 || sel.h < 1) return;
    clipboardRef.current = extractSelection(layer, sel).data;
    setHasClip(true);
  };

  const deleteSelection = () => {
    const layer = activeLayer;
    const sel = selectionRef.current;
    if (!layer || !sel) return;
    const ctx = mustCtx(layer.canvas);
    const before = ctx.getImageData(0, 0, W, H);
    const mask = selMaskRef.current;
    if (mask) {
      eraseMasked(ctx, mask, sel);
    } else {
      ctx.clearRect(sel.x, sel.y, sel.w, sel.h);
    }
    pushPixels(layer, before, [sel.x, sel.y, sel.x + sel.w, sel.y + sel.h]);
    bump();
  };

  const cutSelection = () => {
    copySelection();
    deleteSelection();
  };

  const pasteSelection = () => {
    const layer = activeLayer;
    const clip = clipboardRef.current;
    if (!layer || !clip) return;
    const before = mustCtx(layer.canvas).getImageData(0, 0, W, H);
    const tmp = createSurface(clip.width, clip.height);
    mustCtx(tmp).putImageData(clip, 0, 0);
    const x = Math.round((W - clip.width) / 2);
    const y = Math.round((H - clip.height) / 2);
    mustCtx(layer.canvas).drawImage(tmp, x, y);
    pushPixels(layer, before, [x, y, x + clip.width, y + clip.height]);
    syncSel({ x, y, w: clip.width, h: clip.height });
    bump();
  };

  const fillSelection = () => {
    const layer = activeLayer;
    const sel = selectionRef.current;
    if (!layer || !sel) return;
    const ctx = mustCtx(layer.canvas);
    const before = ctx.getImageData(0, 0, W, H);
    const tmp = createSurface(W, H);
    const tc = mustCtx(tmp);
    tc.fillStyle = colorRef.current;
    tc.fillRect(sel.x, sel.y, sel.w, sel.h);
    const mask = selMaskRef.current;
    if (mask) {
      tc.globalCompositeOperation = "destination-in";
      tc.drawImage(mask, 0, 0);
    }
    ctx.drawImage(tmp, 0, 0);
    pushPixels(layer, before, [sel.x, sel.y, sel.x + sel.w, sel.y + sel.h]);
    bump();
  };

  const selectAll = () => {
    syncSel({ x: 0, y: 0, w: W, h: H });
  };
  const makeSelectionMask = () => {
    const mask = selMaskRef.current;
    if (mask) return mask;
    const sel = selectionRef.current;
    if (!sel) return null;
    const out = createSurface(W, H);
    const c = mustCtx(out);
    c.fillStyle = "#fff";
    c.fillRect(sel.x, sel.y, sel.w, sel.h);
    return out;
  };

  const commitLasso = () => {
    const pts = lassoRef.current.points;
    lassoRef.current = { active: false, points: [] };
    if (pts.length < 3) { render(); return; }
    let minX = W, minY = H, maxX = 0, maxY = 0;
    for (const p of pts) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const mask = createSurface(W, H);
    const mc = mustCtx(mask);
    mc.fillStyle = "#fff";
    mc.beginPath();
    pts.forEach((p, i) => i === 0 ? mc.moveTo(p.x, p.y) : mc.lineTo(p.x, p.y));
    mc.closePath();
    mc.fill();
    const box = {
      x: Math.max(0, minX - 2), y: Math.max(0, minY - 2),
      w: Math.min(W, maxX + 2) - Math.max(0, minX - 2),
      h: Math.min(H, maxY + 2) - Math.max(0, minY - 2),
    };
    syncSel(box.w > 1 && box.h > 1 ? box : null, growMask(mask));
  };

  const magicSelect = (x: number, y: number) => {
    const layer = activeLayer;
    if (!layer) return;
    const sx = Math.round(x), sy = Math.round(y);
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;
    const img = mustCtx(layer.canvas).getImageData(0, 0, W, H);
    const d = img.data;
    const start = (sy * W + sx) * 4;
    const sr = d[start], sg = d[start + 1], sb = d[start + 2], sa = d[start + 3];
    const tol = (toleranceRef.current / 100) * 441;
    const seen = new Uint8Array(W * H);
    const stack = new Int32Array(W * H);
    let top = 0;
    const startIndex = sy * W + sx;
    seen[startIndex] = 1;
    stack[top++] = startIndex;
    const out = new ImageData(W, H);
    const od = out.data;
    let minX = W, minY = H, maxX = 0, maxY = 0, count = 0;
    while (top) {
      const i = stack[--top];
      const p = i * 4;
      const dr = d[p] - sr, dg = d[p + 1] - sg, db = d[p + 2] - sb, da = d[p + 3] - sa;
      if (Math.sqrt(dr * dr + dg * dg + db * db + da * da) > tol) continue;
      od[p] = 255; od[p + 1] = 255; od[p + 2] = 255; od[p + 3] = 255;
      count += 1;
      const px = i % W, py = (i / W) | 0;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (px > 0 && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (px < W - 1 && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (py > 0 && !seen[i - W]) { seen[i - W] = 1; stack[top++] = i - W; }
      if (py < H - 1 && !seen[i + W]) { seen[i + W] = 1; stack[top++] = i + W; }
    }
    if (!count) { syncSel(null); return; }
    const mask = createSurface(W, H);
    mustCtx(mask).putImageData(out, 0, 0);
    const box = {
      x: Math.max(0, minX - 2), y: Math.max(0, minY - 2),
      w: Math.min(W, maxX + 3) - Math.max(0, minX - 2),
      h: Math.min(H, maxY + 3) - Math.max(0, minY - 2),
    };
    syncSel(box, growMask(mask));
  };

  const transformSelection = (op: "rotate" | "flipx" | "flipy") => {
    const layer = activeLayer;
    const sel = selectionRef.current;
    if (!layer || !sel) return;
    const ctx = mustCtx(layer.canvas);
    const before = ctx.getImageData(0, 0, W, H);
    const src = extractSelection(layer, sel);
    const mask = makeSelectionMask();
    if (mask) {
      eraseMasked(ctx, mask, sel);
    } else {
      ctx.clearRect(sel.x, sel.y, sel.w, sel.h);
    }
    const nw = op === "rotate" ? src.h : src.w;
    const nh = op === "rotate" ? src.w : src.h;
    const tmp = createSurface(nw, nh);
    const tc = mustCtx(tmp);
    tc.translate(nw / 2, nh / 2);
    if (op === "rotate") tc.rotate(Math.PI / 2);
    if (op === "flipx") tc.scale(-1, 1);
    if (op === "flipy") tc.scale(1, -1);
    tc.drawImage(src.canvas, -src.w / 2, -src.h / 2);
    const nx = Math.round(sel.x + sel.w / 2 - nw / 2);
    const ny = Math.round(sel.y + sel.h / 2 - nh / 2);
    ctx.drawImage(tmp, nx, ny);
    pushPixels(layer, before, [Math.min(sel.x, nx), Math.min(sel.y, ny), Math.max(sel.x + sel.w, nx + nw), Math.max(sel.y + sel.h, ny + nh)]);
    syncSel({ x: nx, y: ny, w: nw, h: nh });
    bump();
  };

  const currentBrush = (): BrushSettings => {
    const p = presetRef.current;
    const tip: BrushTip = p === "pencil" ? "pencil" : p === "chalk" ? "chalk" : p === "bristle" ? "bristle" : p === "spray" ? "spray" : "round";
    const sym = symmetryRef.current;
    return {
      ...DEFAULT_BRUSH,
      size: sizeRef.current,
      tip,
      texture: textureRef.current,
      textureScale: 100,
      textureDepth: textureDepthRef.current,
      hardness: hardnessRef.current,
      opacity: opacityRef.current,
      flow: p === "water" ? 55 : p === "spray" ? 60 : 100,
      spacing: p === "spray" ? 6 : 8,
      color: colorRef.current,
      smoothing: smoothRef.current,
      penPressure: pressureRef.current,
      symmetry: sym === "x" ? "vertical" : sym === "y" ? "horizontal" : sym === "both" ? "both" : "none",
      roundness: p === "bristle" ? 38 : 100,
      angle: p === "bristle" ? 24 : 0,
      jitter: p === "spray" ? 38 : 0,
      scatterCount: p === "spray" ? 2 : 1,
    };
  };
  const showBrushCursor = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = brushCursorRef.current;
    const view = viewRef.current;
    if (!el || !view || e.pointerType === "touch") return;
    const r = view.getBoundingClientRect();
    const d = Math.max(6, sizeRef.current * (r.width / W));
    el.style.left = `${e.clientX - r.left}px`;
    el.style.top = `${e.clientY - r.top}px`;
    el.style.width = `${d}px`;
    el.style.height = `${d}px`;
    el.style.opacity = "1";
  };
  const hideBrushCursor = () => {
    const el = brushCursorRef.current;
    if (el) el.style.opacity = "0";
  };
  const startPinch = () => {
    const pts = [...touchPointersRef.current.values()];
    if (pts.length < 2) return;
    const stage = stageRef.current;
    const view = viewRef.current;
    if (!stage || !view) return;
    const midX = (pts[0].x + pts[1].x) / 2;
    const midY = (pts[0].y + pts[1].y) / 2;
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const scale = baseScaleRef.current * zoomRef.current || 1;
    const r = view.getBoundingClientRect();
    pinchRef.current = {
      startDist: Math.max(1, dist),
      startZoom: zoomRef.current,
      logicalX: (midX - r.left) / scale,
      logicalY: (midY - r.top) / scale,
    };
  };
  const updatePinch = () => {
    const pinch = pinchRef.current;
    const pts = [...touchPointersRef.current.values()];
    if (!pinch || pts.length < 2) return;
    const midX = (pts[0].x + pts[1].x) / 2;
    const midY = (pts[0].y + pts[1].y) / 2;
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const next = Math.min(5, Math.max(0.25, pinch.startZoom * (dist / pinch.startDist)));
    setZoom(+next.toFixed(2));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const stage = stageRef.current;
      const view = viewRef.current;
      if (!stage || !view) return;
      const scale = baseScaleRef.current * zoomRef.current;
      const r = view.getBoundingClientRect();
      stage.scrollLeft += r.left + pinch.logicalX * scale - midX;
      stage.scrollTop += r.top + pinch.logicalY * scale - midY;
    }));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    if (e.pointerType === "touch") {
      touchPointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touchPointersRef.current.size === 2) {
        if (drawing.current.down) {
          drawing.current.down = false;
          strokeRef.current = null;
          bump();
        }
        startPinch();
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
      if (touchPointersRef.current.size > 2) return;
      hideBrushCursor();
    }
    showBrushCursor(e);
    const p = pointOf(e);
    const t = toolRef.current;
    const layer = activeLayer;
    if (t === "hand") {
      const stage = stageRef.current;
      if (stage) {
        panRef.current = { active: true, x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      return;
    }
    if (t === "select") {
      const mode = selectionModeRef.current;
      if (mode === "wand") {
        magicSelect(p.x, p.y);
        return;
      }
      if (mode === "lasso") {
        lassoRef.current = { active: true, points: [{ x: p.x, y: p.y }] };
        drawing.current = {
          down: true, pointerId: e.pointerId, x: p.x, y: p.y, lastX: p.x, lastY: p.y, sx: p.x, sy: p.y,
          moved: false, before: null, bbox: [p.x, p.y, p.x, p.y],
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
      drawing.current = {
        down: true, pointerId: e.pointerId, x: p.x, y: p.y, lastX: p.x, lastY: p.y, sx: p.x, sy: p.y,
        moved: false, before: null, bbox: [p.x, p.y, p.x, p.y],
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (!layer) return;
    const ctx = mustCtx(layer.canvas);
    drawing.current = {
      down: true,
      pointerId: e.pointerId,
      x: p.x,
      y: p.y,
      lastX: p.x,
      lastY: p.y,
      sx: p.x,
      sy: p.y,
      moved: false,
      before: null,
      bbox: [p.x, p.y, p.x, p.y],
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    if (t === "eyedropper") {
      const view = viewRef.current;
      if (view) {
        const data = mustCtx(view).getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data;
        const hex = `#${[data[0], data[1], data[2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
        setColor(hex);
      }
      drawing.current.down = false;
      return;
    }
    if (t === "fill") {
      const before = ctx.getImageData(0, 0, W, H);
      const rect = floodFill(ctx, Math.round(p.x), Math.round(p.y), colorRef.current, toleranceRef.current);
      if (rect) {
        pushPixels(layer, before, [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h]);
        bump();
      }
      drawing.current.down = false;
      return;
    }
    if (t === "text") {
      const before = ctx.getImageData(0, 0, W, H);
      ctx.save();
      ctx.globalAlpha = opacityRef.current / 100;
      ctx.fillStyle = colorRef.current;
      ctx.font = `${fontSizeRef.current}px ${fontFamilyRef.current}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const lines = text.split("\n");
      lines.forEach((line, i) => ctx.fillText(line, p.x, p.y + i * fontSizeRef.current * 1.2));
      ctx.restore();
      const width = Math.max(...lines.map((l) => ctx.measureText(l).width), 10);
      pushPixels(layer, before, [p.x - 5, p.y - fontSizeRef.current * 0.7, p.x + width + 10, p.y + lines.length * fontSizeRef.current * 1.3]);
      bump();
      drawing.current.down = false;
      return;
    }
    if (t === "move") {
      beginMove(e);
      return;
    }
    if (t === "brush" || t === "eraser") {
      drawing.current.before = ctx.getImageData(0, 0, W, H);
      const st = new Stroke(W, H, currentBrush(), t === "eraser", makeSelectionMask());
      st.begin(p.x, p.y, p.pressure, e.timeStamp);
      strokeRef.current = st;
      const radius = Math.max(1, sizeRef.current / 2);
      expandBBox(drawing.current, p.x, p.y, radius);
      bump();
      return;
    }
    drawing.current.before = ctx.getImageData(0, 0, W, H);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const t = toolRef.current;
    if (e.pointerType === "touch") {
      touchPointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinchRef.current && touchPointersRef.current.size >= 2) {
        updatePinch();
        return;
      }
    }
    if (!drawing.current.down) showBrushCursor(e);
    if (t === "hand" && panRef.current.active) {
      const stage = stageRef.current;
      if (stage) {
        stage.scrollLeft = panRef.current.left - (e.clientX - panRef.current.x);
        stage.scrollTop = panRef.current.top - (e.clientY - panRef.current.y);
      }
      return;
    }
    if (!drawing.current.down) return;
    const p = pointOf(e);
    drawing.current.moved = true;
    const layer = activeLayer;
    if (!layer) return;
    if (t === "select") {
      if (selectionModeRef.current === "lasso") {
        const pts = lassoRef.current.points;
        const last = pts[pts.length - 1];
        if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 2) {
          pts.push({ x: p.x, y: p.y });
          bump();
        }
        drawing.current.x = p.x;
        drawing.current.y = p.y;
        return;
      }
      const b = selectionBox(drawing.current.sx, drawing.current.sy, p.x, p.y);
      syncSel(b);
      drawing.current.x = p.x;
      drawing.current.y = p.y;
      return;
    }
    if (t === "move") {
      moveLayer(p.x - drawing.current.sx, p.y - drawing.current.sy);
      drawing.current.x = p.x;
      drawing.current.y = p.y;
      return;
    }
    if (t === "brush" || t === "eraser") {
      const st = strokeRef.current;
      if (!st) return;
      st.extend(p.x, p.y, p.pressure, e.timeStamp);
      const radius = Math.max(1, sizeRef.current / 2);
      expandBBox(drawing.current, p.x, p.y, radius);
      drawing.current.lastX = p.x;
      drawing.current.lastY = p.y;
      drawing.current.x = p.x;
      drawing.current.y = p.y;
      bump();
      return;
    }
    if (t === "line" || t === "rect" || t === "ellipse") {
      overlayPreview(drawing.current.sx, drawing.current.sy, p.x, p.y, e.shiftKey);
      drawing.current.x = p.x;
      drawing.current.y = p.y;
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const t = toolRef.current;
    if (e.pointerType === "touch") {
      touchPointersRef.current.delete(e.pointerId);
      if (pinchRef.current && touchPointersRef.current.size >= 2) return;
      if (pinchRef.current && touchPointersRef.current.size < 2) pinchRef.current = null;
    }
    if (t === "hand") {
      panRef.current.active = false;
      return;
    }
    if (!drawing.current.down) return;
    const layer = activeLayer;
    if (!layer) return;
    const p = pointOf(e);
    if (t === "select") {
      if (selectionModeRef.current === "lasso") {
        const pts = lassoRef.current.points;
        const last = pts[pts.length - 1];
        if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 2) pts.push({ x: p.x, y: p.y });
        drawing.current.down = false;
        commitLasso();
        return;
      }
      const b = selectionBox(drawing.current.sx, drawing.current.sy, p.x, p.y);
      syncSel(b.w > 3 && b.h > 3 ? b : null);
      drawing.current.down = false;
      return;
    }
    if (t === "move") {
      if (drawing.current.before && drawing.current.moved) {
        const ctx = mustCtx(layer.canvas);
        const after = ctx.getImageData(0, 0, W, H);
        pushHistory({
          kind: "pixels", layerId: layer.id, x: 0, y: 0, w: W, h: H,
          before: drawing.current.before, after,
        });
        const moving = moveSelRef.current;
        const sel = selectionRef.current;
        if (moving && sel) {
          const dx = Math.round(p.x - drawing.current.sx);
          const dy = Math.round(p.y - drawing.current.sy);
          let nextMask: HTMLCanvasElement | null = null;
          if (selMaskRef.current) {
            nextMask = createSurface(W, H);
            mustCtx(nextMask).drawImage(selMaskRef.current, dx, dy);
          }
          syncSel({ x: sel.x + dx, y: sel.y + dy, w: sel.w, h: sel.h }, nextMask);
        }
      }
      moveSelRef.current = null;
      drawing.current.down = false;
      drawing.current.before = null;
      return;
    }
    if (t === "line" || t === "rect" || t === "ellipse") {
      const ctx = mustCtx(layer.canvas);
      drawShape(ctx, drawing.current.sx, drawing.current.sy, p.x, p.y, t, e.shiftKey, false);
      const pad = sizeRef.current + 8;
      const bx = Math.min(drawing.current.sx, p.x) - pad;
      const by = Math.min(drawing.current.sy, p.y) - pad;
      const bw = Math.abs(p.x - drawing.current.sx) + pad * 2;
      const bh = Math.abs(p.y - drawing.current.sy) + pad * 2;
      if (drawing.current.before) pushPixels(layer, drawing.current.before, [bx, by, bx + bw, by + bh]);
      bump();
      drawing.current.down = false;
      drawing.current.before = null;
      return;
    }
    if ((t === "brush" || t === "eraser") && drawing.current.before) {
      const st = strokeRef.current;
      if (st) {
        st.finish(layer.canvas, makeSelectionMask());
        const radius = Math.max(1, sizeRef.current / 2);
        expandBBox(drawing.current, p.x, p.y, radius);
        strokeRef.current = null;
        pushPixels(layer, drawing.current.before, drawing.current.bbox);
      }
    }
    drawing.current.down = false;
    drawing.current.before = null;
    bump();
  };

  const insertLayerForActiveGroup = (list: Layer[], layer: Layer) => {
    const gid = activeLayer?.groupId;
    if (!gid) return [...list, layer];
    layer.groupId = gid;
    let at = list.length;
    for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].groupId === gid) { at = i + 1; break; }
    const next = [...list];
    next.splice(at, 0, layer);
    return next;
  };
  const addLayer = () => {
    const l = newLayer(`图层 ${layersRef.current.length}`, W, H);
    syncLayers(insertLayerForActiveGroup(layersRef.current, l));
    syncActive(l.id);
  };


  const addGroup = () => {
    const g: LayerGroup = { id: `g${Math.random().toString(36).slice(2, 8)}`, name: `组 ${groupsRef.current.length + 1}`, visible: true, opacity: 1, blend: "source-over" };
    const l = newLayer(`图层 ${layersRef.current.length}`, W, H);
    l.groupId = g.id;
    syncGroups([...groupsRef.current, g]);
    syncLayers([...layersRef.current, l]);
    syncActive(l.id);
  };

  const groupWithBelow = () => {
    const list = layersRef.current;
    const idx = list.findIndex((l) => l.id === activeIdRef.current);
    if (idx <= 0) return;
    const below = list[idx - 1];
    const above = list[idx];
    if (below.groupId || above.groupId) return;
    const g: LayerGroup = { id: `g${Math.random().toString(36).slice(2, 8)}`, name: `组 ${groupsRef.current.length + 1}`, visible: true, opacity: 1, blend: "source-over" };
    below.groupId = g.id;
    above.groupId = g.id;
    syncGroups([...groupsRef.current, g]);
    syncLayers([...list]);
  };

  const ungroupActive = () => {
    const gid = activeLayer?.groupId;
    if (!gid) return;
    for (const l of layersRef.current) if (l.groupId === gid) l.groupId = undefined;
    syncGroups(groupsRef.current.filter((g) => g.id !== gid));
    syncLayers([...layersRef.current]);
  };

  const toggleGroup = (id: string) => {
    const g = groupsRef.current.find((x) => x.id === id);
    if (g) { g.visible = !g.visible; bump(); }
  };

  const toggleClip = () => {
    if (!activeLayer) return;
    activeLayer.clip = !activeLayer.clip;
    bump();
  };
  const duplicateLayer = () => {
    if (!activeLayer) return;
    const l = newLayer(`${activeLayer.name} 副本`, W, H);
    mustCtx(l.canvas).drawImage(activeLayer.canvas, 0, 0);
    l.opacity = activeLayer.opacity;
    l.blend = activeLayer.blend;
    l.groupId = activeLayer.groupId;
    const list = layersRef.current;
    const idx = list.findIndex((x) => x.id === activeLayer.id);
    const next = [...list];
    next.splice(idx + 1, 0, l);
    syncLayers(next);
    syncActive(l.id);
  };

  const reorderLayer = (dir: -1 | 1) => {
    const list = layersRef.current;
    const idx = list.findIndex((l) => l.id === activeIdRef.current);
    const to = idx + dir;
    if (idx < 0 || to < 0 || to >= list.length) return;
    if ((list[idx].groupId || "") !== (list[to].groupId || "")) return;
    const next = [...list];
    [next[idx], next[to]] = [next[to], next[idx]];
    syncLayers(next);
  };
  const deleteLayer = () => {
    if (!activeLayer || layersRef.current.length <= 1) return;
    const gid = activeLayer.groupId;
    const next = layersRef.current.filter((l) => l.id !== activeLayer.id);
    if (gid && !next.some((l) => l.groupId === gid)) syncGroups(groupsRef.current.filter((g) => g.id !== gid));
    syncLayers(next);
    syncActive(next[Math.max(0, next.length - 1)].id);
  };

  const mergeDown = () => {
    const list = layersRef.current;
    const idx = list.findIndex((l) => l.id === activeIdRef.current);
    if (idx <= 0) return;
    const below = list[idx - 1];
    const above = list[idx];
    if ((below.groupId || "") !== (above.groupId || "") || above.clip) return;
    mustCtx(below.canvas).save();
    mustCtx(below.canvas).globalAlpha = above.opacity;
    mustCtx(below.canvas).globalCompositeOperation = above.blend || "source-over";
    mustCtx(below.canvas).drawImage(above.canvas, 0, 0);
    mustCtx(below.canvas).globalCompositeOperation = "source-over";
    mustCtx(below.canvas).restore();
    const next = list.filter((l) => l.id !== above.id);
    syncLayers(next);
    syncActive(below.id);
  };

  const clearLayer = () => {
    if (!activeLayer) return;
    const before = mustCtx(activeLayer.canvas).getImageData(0, 0, W, H);
    mustCtx(activeLayer.canvas).clearRect(0, 0, W, H);
    pushHistory({ kind: "pixels", layerId: activeLayer.id, x: 0, y: 0, w: W, h: H, before, after: mustCtx(activeLayer.canvas).getImageData(0, 0, W, H) });
    bump();
  };

  const flipLayer = (axis: "x" | "y") => {
    if (!activeLayer) return;
    const before = mustCtx(activeLayer.canvas).getImageData(0, 0, W, H);
    const tmp = createSurface(W, H);
    const tctx = mustCtx(tmp);
    tctx.translate(axis === "x" ? W : 0, axis === "y" ? H : 0);
    tctx.scale(axis === "x" ? -1 : 1, axis === "y" ? -1 : 1);
    tctx.drawImage(activeLayer.canvas, 0, 0);
    const ctx = mustCtx(activeLayer.canvas);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(tmp, 0, 0);
    pushHistory({ kind: "pixels", layerId: activeLayer.id, x: 0, y: 0, w: W, h: H, before, after: ctx.getImageData(0, 0, W, H) });
    bump();
  };

  const applyFilter = () => {
    if (!activeLayer) return;
    const before = mustCtx(activeLayer.canvas).getImageData(0, 0, W, H);
    const tmp = createSurface(W, H);
    const tctx = mustCtx(tmp);
    tctx.filter = `brightness(${100 + brightness}%) contrast(${100 + contrast}%) saturate(${100 + saturate}%) blur(${blur}px)`;
    tctx.drawImage(activeLayer.canvas, 0, 0);
    const ctx = mustCtx(activeLayer.canvas);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(tmp, 0, 0);
    pushHistory({ kind: "pixels", layerId: activeLayer.id, x: 0, y: 0, w: W, h: H, before, after: ctx.getImageData(0, 0, W, H) });
    bump();
  };

  const applyImage = (pct: number, deg: number) => {
    const meta = imageSourceRef.current;
    const target = meta && layersRef.current.find((l) => l.id === meta.id);
    if (!meta || !target) { setImgReady(false); return; }
    const ctx = mustCtx(target.canvas);
    ctx.clearRect(0, 0, W, H);
    const k = meta.base * (pct / 100);
    const w = meta.img.width * k, h = meta.img.height * k;
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(meta.img, -w / 2, -h / 2, w, h);
    ctx.restore();
    bump();
  };

  const importImage = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const l = newLayer(file.name.replace(/\.[^.]+$/, "") || "图片", W, H);
        const ctx = mustCtx(l.canvas);
        const s = Math.min((W * 0.82) / img.width, (H * 0.82) / img.height);
        const w = img.width * s, h = img.height * s;
        ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
        imageSourceRef.current = { id: l.id, img, base: s };
        setImgScale(100);
        setImgRot(0);
        setImgReady(true);
        syncLayers(insertLayerForActiveGroup(layersRef.current, l));
        syncActive(l.id);
        bump();
        setTimeout(() => applyImage(100, 0), 0);
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const composite = () => {
    const c = createSurface(W, H);
    const ctx = mustCtx(c);
    paintStack(ctx, layersRef.current);
    ctx.globalAlpha = 1;
    return c;
  };

  const exportData = (maxW = 1600, maxH = 0) => {
    const src = composite();
    const outW = maxW;
    const outH = maxH || Math.round((outW * H) / W);
    const out = createSurface(outW, outH);
    const ctx = mustCtx(out);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, outW, outH);
    return out.toDataURL("image/png");
  };

  const download = () => {
    const a = document.createElement("a");
    a.href = exportData();
    a.download = `${title || "封面"}-手绘.png`;
    a.click();
  };

  const leave = () => {
    if (histRef.current.length > 0) {
      setLeaveAsk(true);
      return;
    }
    onClose();
  };

  const finish = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onDone(exportData());
    } finally {
      setBusy(false);
    }
  };

  const zoomBy = (delta: number) => setZoom((z) => Math.min(5, Math.max(0.25, +(z + delta).toFixed(2))));
  const displayScale = baseScale * zoom;

  const panelBody = useMemo(() => {
    const section = (id: typeof panel) => (
      <section className={`cpr-sec${panel === id ? " on" : ""}`} data-sec={id}>
        {id === "brush" && (
          <>
            {(tool === "brush" || tool === "eraser") && (
              <>
                <div className="cpr-brush-presets">
                  {([["pen", "钢笔"], ["pencil", "铅笔"], ["marker", "马克"], ["water", "水彩"], ["spray", "喷枪"], ["chalk", "粉笔"], ["bristle", "排笔"]] as const).map(([k, label]) => (
                    <button key={k} className={preset === k ? "on" : ""} onClick={() => applyPreset(k)}>{label}</button>
                  ))}
                </div>                <label className="cpr-range"><span>笔尖</span><strong>{size}px</strong><input type="range" min={1} max={320} value={size} onChange={(e) => setSize(Number(e.target.value))} /></label>
                <label className="cpr-range"><span>不透明度</span><strong>{opacity}%</strong><input type="range" min={1} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} /></label>
                <label className="cpr-range"><span>硬度</span><strong>{hardness}%</strong><input type="range" min={0} max={100} value={hardness} onChange={(e) => setHardness(Number(e.target.value))} /></label>
                <label className="cpr-field"><span>纸纹</span><select value={texture} onChange={(e) => setTexture(e.target.value as BrushTexture)}><option value="none">无纹理</option><option value="paper">纸纹</option><option value="canvas">画布</option><option value="grain">颗粒</option><option value="dots">网点</option></select></label>
                {texture !== "none" && <label className="cpr-range"><span>纹理深度</span><strong>{textureDepth}%</strong><input type="range" min={0} max={100} value={textureDepth} onChange={(e) => setTextureDepth(Number(e.target.value))} /></label>}
                <label className="cpr-range"><span>防抖</span><strong>{smooth}%</strong><input type="range" min={0} max={100} value={smooth} onChange={(e) => setSmooth(Number(e.target.value))} /></label>
                <p className="cpr-hint">笔尖与纸纹由 Strata 笔画内核驱动。</p>
                <label className="cpr-check"><input type="checkbox" checked={pressureOn} onChange={(e) => setPressureOn(e.target.checked)} /><span>触控笔压感</span></label>
                <div className="cpr-field"><span>对称</span><div className="cpr-seg small">{[["none", "关"], ["x", "左右"], ["y", "上下"], ["both", "四向"]].map(([k, label]) => <button key={k} className={symmetry === k ? "on" : ""} onClick={() => setSymmetry(k as typeof symmetry)}>{label}</button>)}</div></div>
              </>
            )}
            {tool === "select" && (
              <>
                <div className="cpr-field"><span>选区方式</span><div className="cpr-seg small">{[["rect", "矩形"], ["lasso", "套索"], ["wand", "魔棒"]].map(([k, label]) => <button key={k} className={selectionMode === k ? "on" : ""} onClick={() => setSelectionMode(k as SelectionMode)}>{label}</button>)}</div></div>
                <div className="cpr-btn-grid two sel-grid">
                  <button onClick={selectAll}>全选画布</button>
                  <button onClick={() => syncSel(null)}>取消选区</button>
                  <button onClick={copySelection} disabled={!selection}>复制</button>
                  <button onClick={cutSelection} disabled={!selection}>剪切</button>
                  <button onClick={deleteSelection} disabled={!selection}>删除选区</button>
                  <button onClick={pasteSelection} disabled={!hasClip}>粘贴居中</button>
                  <button onClick={fillSelection} disabled={!selection}>填充选区</button>
                  <button onClick={() => transformSelection("rotate")} disabled={!selection}>旋转 90°</button>
                  <button onClick={() => transformSelection("flipx")} disabled={!selection}>水平翻转</button>
                  <button onClick={() => transformSelection("flipy")} disabled={!selection}>垂直翻转</button>
                </div>
                <p className="cpr-hint">矩形、自由套索、魔棒都支持；魔棒按当前图层颜色取连续区域。选区可复制、删除、填色或变换，移动工具会只移动选区内像素。</p>
              </>
            )}            {tool === "fill" && (
              <label className="cpr-range"><span>容差</span><strong>{tolerance}%</strong><input type="range" min={0} max={100} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} /></label>
            )}
            {(tool === "line" || tool === "rect" || tool === "ellipse") && (
              <>
                <label className="cpr-range"><span>线宽</span><strong>{Math.round(size * 0.35)}px</strong><input type="range" min={1} max={220} value={size} onChange={(e) => setSize(Number(e.target.value))} /></label>
                {(tool === "rect" || tool === "ellipse") && <label className="cpr-check"><input type="checkbox" checked={shapeFill} onChange={(e) => setShapeFill(e.target.checked)} /><span>填充形状</span></label>}
                <p className="cpr-hint">按住 Shift 拖出等比图形。</p>
              </>
            )}
            {tool === "text" && (
              <>
                <label className="cpr-field"><span>文字</span><textarea value={text} rows={3} onChange={(e) => setText(e.target.value)} /></label>
                <label className="cpr-range"><span>字号</span><strong>{fontSize}</strong><input type="range" min={20} max={320} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} /></label>
                <label className="cpr-field"><span>字体</span><select value={fontFamily} onChange={(e) => setFontFamily(e.target.value)}><option value="'Noto Serif SC', serif">宋体</option><option value="'Noto Sans SC', sans-serif">黑体</option><option value="'KaiTi', serif">楷体</option><option value="Georgia, serif">衬线西文</option><option value="'Helvetica Neue', sans-serif">无衬线西文</option></select></label>
              </>
            )}
            {tool === "image" && <><button className="cpr-wide-btn" onClick={() => fileRef.current?.click()}>选择本地图片</button>
              {imgReady && <>
                <label className="cpr-range"><span>图片缩放</span><strong>{imgScale}%</strong><input type="range" min={25} max={300} value={imgScale} onChange={(e) => { const v = Number(e.target.value); setImgScale(v); applyImage(v, imgRot); }} /></label>
                <div className="cpr-btn-grid two">
                  <button onClick={() => { const d = imgRot - 90; setImgRot(d); applyImage(imgScale, d); }}>左转 90°</button>
                  <button onClick={() => { const d = imgRot + 90; setImgRot(d); applyImage(imgScale, d); }}>右转 90°</button>
                  <button onClick={() => { const meta = imageSourceRef.current; if (!meta) return; const pct = Math.min(300, Math.round((Math.max(W / meta.img.width, H / meta.img.height) / meta.base) * 100)); setImgScale(pct); applyImage(pct, imgRot); }}>铺满画面</button>
                  <button onClick={() => { setImgScale(100); setImgRot(0); applyImage(100, 0); }}>还原居中</button>
                </div>
              </>}
              <p className="cpr-hint">{imgReady ? "缩放与旋转以画布中心重排，之后可用移动工具整体挪位。" : "图片会新建一层并居中放入，导入后可缩放、旋转。"}</p>
            </>}
            {tool === "eyedropper" && <p className="cpr-hint">点画面任意位置取色。</p>}
            {tool === "move" && <p className="cpr-hint">拖动会平移当前图层；有选区时只移动选区内像素，松手记一步撤销。</p>}
            {tool === "hand" && <p className="cpr-hint">拖动平移画布；画布上双指捏合缩放，双指移动平移。</p>}
            <div className="cpr-colors">
              {PALETTE.map((c) => <button key={c} className={color === c ? "on" : ""} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />)}
              <label className="cpr-color-input"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} /><span>自定义</span></label>
            </div>
          </>
        )}
        {id === "layers" && (
          <>
            <div className="cpr-layer-list">
              {(() => {
                const topDown = [...layers].reverse();
                const done = new Set<string>();
                return topDown.map((l) => {
                  if (l.groupId && !done.has(l.groupId)) {
                    done.add(l.groupId);
                    const g = groups.find((x) => x.id === l.groupId);
                    const members = topDown.filter((x) => x.groupId === l.groupId);
                    return (
                      <div className="cpr-group-block" key={l.groupId}>
                        <div className={`cpr-group${activeGroup?.id === l.groupId ? " on" : ""}`} onClick={() => syncActive(members[0].id)}>
                          <button className="cpr-eye" onClick={(e) => { e.stopPropagation(); toggleGroup(l.groupId!); }} title="显示/隐藏组">{g?.visible === false ? "○" : "◉"}</button>
                          <b>▾</b>
                          <span>{g?.name || "组"}</span>
                          <em>{members.length} 层 · {Math.round((g?.opacity ?? 1) * 100)}%</em>
                        </div>
                        {members.map((m) => (
                          <div key={m.id} className={`cpr-layer child${m.id === activeId ? " on" : ""}`} onClick={() => syncActive(m.id)}>
                            <button className="cpr-eye" onClick={(e) => { e.stopPropagation(); m.visible = !m.visible; bump(); }} title="显示/隐藏">
                              {m.visible ? "◉" : "○"}
                            </button>
                            <span>{m.clip ? "↳ " : ""}{m.name}</span>
                            <em>{Math.round(m.opacity * 100)}%</em>
                          </div>
                        ))}
                      </div>
                    );
                  }
                  if (l.groupId) return null;
                  return (
                    <div key={l.id} className={`cpr-layer${l.id === activeId ? " on" : ""}`} onClick={() => syncActive(l.id)}>
                      <button className="cpr-eye" onClick={(e) => { e.stopPropagation(); l.visible = !l.visible; bump(); }} title="显示/隐藏">
                        {l.visible ? "◉" : "○"}
                      </button>
                      <span>{l.clip ? "↳ " : ""}{l.name}</span>
                      <em>{Math.round(l.opacity * 100)}%</em>
                    </div>
                  );
                });
              })()}
            </div>
            {activeGroup && (
              <>
                <label className="cpr-range"><span>组不透明度</span><strong>{Math.round(activeGroup.opacity * 100)}%</strong><input type="range" min={0} max={100} value={Math.round(activeGroup.opacity * 100)} onChange={(e) => { activeGroup.opacity = Number(e.target.value) / 100; bump(); }} /></label>
                <label className="cpr-field"><span>组混合模式</span>
                  <select value={activeGroup.blend || "source-over"} onChange={(e) => { activeGroup.blend = e.target.value as BlendMode; bump(); }}>
                    <option value="source-over">正常</option><option value="multiply">正片叠底</option><option value="screen">滤色</option><option value="overlay">叠加</option><option value="darken">变暗</option><option value="lighten">变亮</option>
                  </select>
                </label>
              </>
            )}
            <label className="cpr-field"><span>混合模式</span>
              <select value={activeLayer?.blend || "source-over"} onChange={(e) => { if (activeLayer) { activeLayer.blend = e.target.value as BlendMode; bump(); } }}>
                <option value="source-over">正常</option>
                <option value="multiply">正片叠底</option>
                <option value="screen">滤色</option>
                <option value="overlay">叠加</option>
                <option value="darken">变暗</option>
                <option value="lighten">变亮</option>
              </select>
            </label>            <label className="cpr-range"><span>图层不透明度</span><strong>{Math.round((activeLayer?.opacity ?? 1) * 100)}%</strong><input type="range" min={0} max={100} value={Math.round((activeLayer?.opacity ?? 1) * 100)} onChange={(e) => { if (activeLayer) { activeLayer.opacity = Number(e.target.value) / 100; bump(); } }} /></label>
            <div className="cpr-btn-grid">
              <button onClick={addLayer}>新图层</button>
              <button onClick={addGroup}>新建组</button>
              <button onClick={groupWithBelow}>与下层成组</button>
              <button onClick={ungroupActive} disabled={!activeGroup}>解散组</button>
              <button onClick={toggleClip} className={activeLayer?.clip ? "on" : ""}>剪贴蒙版</button>
              <button onClick={duplicateLayer}>复制</button>
              <button onClick={mergeDown}>向下合并</button>
              <button onClick={() => reorderLayer(1)}>上移</button>
              <button onClick={() => reorderLayer(-1)}>下移</button>
              <button onClick={deleteLayer}>删除</button>
            </div>
            <div className="cpr-btn-grid two">
              <button onClick={() => flipLayer("x")}>水平翻转</button>
              <button onClick={() => flipLayer("y")}>垂直翻转</button>
            </div>
            <button className="cpr-wide-btn danger" onClick={clearLayer}>清空当前图层</button>
          </>
        )}
        {id === "adjust" && (
          <>
            <label className="cpr-range"><span>亮度</span><strong>{brightness}</strong><input type="range" min={-70} max={70} value={brightness} onChange={(e) => setBrightness(Number(e.target.value))} /></label>
            <label className="cpr-range"><span>对比度</span><strong>{contrast}</strong><input type="range" min={-60} max={60} value={contrast} onChange={(e) => setContrast(Number(e.target.value))} /></label>
            <label className="cpr-range"><span>饱和度</span><strong>{saturate}</strong><input type="range" min={-100} max={100} value={saturate} onChange={(e) => setSaturate(Number(e.target.value))} /></label>
            <label className="cpr-range"><span>模糊</span><strong>{blur}px</strong><input type="range" min={0} max={30} value={blur} onChange={(e) => setBlur(Number(e.target.value))} /></label>
            <button className="cpr-wide-btn" onClick={applyFilter}>应用到当前图层</button>
            <button className="cpr-wide-btn ghost" onClick={download}>下载 PNG（1600 宽）</button>
            <p className="cpr-hint">滤镜是像素级处理，可撤销；SVG 模式不支持。</p>
            <div className="cpr-btn-grid two">
              <button onClick={() => { setBrightness(0); setContrast(0); setSaturate(0); setBlur(0); }}>重置参数</button>
              <button onClick={() => { setColor(title ? "#f5efe3" : "#111"); }}>取纸色</button>
            </div>
          </>
        )}
      </section>
    );
    const firstTabLabel = tool === "brush" ? "笔刷" : TOOLS.find((t) => t.id === tool)?.label || "笔刷";
    return (
      <>
        <div className="cpr-panel-tabs">
          {[["brush", firstTabLabel], ["layers", "图层"], ["adjust", "调整"]].map(([id, label]) => (
            <button key={id} className={panel === id ? "on" : ""} onClick={() => setPanel(id as typeof panel)}>{label}</button>
          ))}
        </div>
        {section("brush")}
        {section("layers")}
        {section("adjust")}
      </>
    );
  }, [panel, tool, preset, size, opacity, hardness, smooth, pressureOn, symmetry, tolerance, shapeFill, text, fontSize, fontFamily, color, layers, groups, activeId, activeLayer, activeGroup, texture, textureDepth, version, brightness, contrast, saturate, blur, title, selection, selectionMode, hasClip]);

  return (
    <div className={`cps-root cpr-root${sheet ? " sheet-open" : ""}`}>
      <header className="cpr-head">
        <button className="cps-icon-btn" onClick={leave} aria-label="返回">
          <svg viewBox="0 0 24 24"><path d="M15 5 8 12l7 7" /></svg>
        </button>
        <div className="cpr-title">
          <span>手绘封面 · PNG 位图</span>
          <strong>{title || "未命名"}{author ? ` · ${author}` : ""}</strong>
        </div>
        <div className="cpr-head-actions">
          <button className="cps-icon-btn" onClick={() => void undo()} disabled={!histRef.current.length} title="撤销">
            <svg viewBox="0 0 24 24"><path d="M9 7 4 12l5 5M4 12h9a5 5 0 0 1 5 5" /></svg>
          </button>
          <button className="cps-icon-btn" onClick={() => void redo()} disabled={!redoRef.current.length} title="重做">
            <svg viewBox="0 0 24 24"><path d="m15 7 5 5-5 5M20 12h-9a5 5 0 0 0-5 5" /></svg>
          </button>
          <button className="cps-btn primary small" onClick={() => void finish()} disabled={busy}>{busy ? "导出中…" : "用作封面"}</button>
        </div>
      </header>

      <div className="cpr-body">
        <aside className="cpr-toolbar">
          {TOOLS.map((item) => (
            <button key={item.id} className={tool === item.id ? "on" : ""} title={item.hint} onClick={() => { setTool(item.id); if (item.id === "image") fileRef.current?.click(); }}>
              <ToolGlyph tool={item.id} />
              <span>{item.label}</span>
            </button>
          ))}
        </aside>

        <div className="cpr-stage" ref={stageRef}>
          <div className="cpr-canvas-shell" style={displayScale ? { width: W * displayScale, height: H * displayScale } : { width: "80%", height: "80%" }}>
            <canvas
              ref={viewRef}
              width={W}
              height={H}
              style={{ width: "100%", height: "100%", touchAction: "none" }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerEnter={showBrushCursor}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onPointerLeave={(e) => { hideBrushCursor(); if (drawing.current.down && tool !== "hand") onPointerUp(e); }}
              onWheel={(e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(e.deltaY > 0 ? -0.15 : 0.15); } }}
            />
            <div className="cpr-brush-cursor" ref={brushCursorRef} aria-hidden="true" />
          </div>
        </div>

        <aside className={`cpr-panel tool-${tool}`}>{panelBody}</aside>
      </div>

      <footer className="cpr-foot">
        <div className="cpr-zoom">
          <button onClick={() => zoomBy(-0.25)}>−</button>
          <span>{Math.round(zoom * 100)}%</span>
          <button onClick={() => zoomBy(0.25)}>＋</button>
          <button className="fit" onClick={() => setZoom(1)}>适应</button>
        </div>
        <div className="cpr-foot-info">{dims.label} · {W}×{H} · 导出 1600×{Math.round((1600 * H) / W)}</div>
        <div className="cpr-foot-actions">
          <button className="cpr-sheet-toggle" onClick={() => setSheet((v) => !v)}>参数</button>
          <button onClick={download}>下载 PNG</button>
          <button className="primary" onClick={() => void finish()} disabled={busy}>用作封面</button>
        </div>
      </footer>

      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importImage(f); e.target.value = ""; }} />

      {leaveAsk && (
        <ConfirmDialog
          title="离开画室？"
          message="当前画稿还没有用作封面，离开后这一笔记录不会保留。"
          confirmText="离开"
          danger
          onClose={() => setLeaveAsk(false)}
          onOk={() => {
            setLeaveAsk(false);
            onClose();
          }}
        />
      )}
    </div>
  );
}












































