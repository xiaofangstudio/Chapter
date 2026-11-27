import { useEffect, useMemo, useRef, useState } from "react";
import { StudioStatusBar } from "./StudioStatusBar";
import type { PaintDims } from "./CoverPaintStudio";
import { booleanSubpaths, type BoolOp } from "./vexa/bool";
import { anchorAt, noPaint, noStroke, type PathNode, type SubPath } from "./vexa/types";

type VTool = "brush" | "eraser" | "line" | "rect" | "ellipse" | "text" | "node" | "move" | "hand";
type VKind = "path" | "line" | "rect" | "ellipse" | "text";

type VObj = {
  id: string;
  kind: VKind;
  x: number;
  y: number;
  w: number;
  h: number;
  points?: number[];
  subpaths?: number[][];
  handles?: number[];
  fill?: string;
  stroke?: string;
  strokeWidth: number;
  opacity: number;
  visible: boolean;
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
};

type Draft = { tool: VTool; x: number; y: number; w: number; h: number; points: number[]; moved?: boolean } | null;

const VTOOLS: { id: VTool; label: string; hint: string; off?: string }[] = [
  { id: "brush", label: "画笔", hint: "自由路径" },
  { id: "eraser", label: "橡皮", hint: "整笔删除" },
  { id: "line", label: "直线", hint: "矢量直线" },
  { id: "rect", label: "矩形", hint: "矢量矩形" },
  { id: "ellipse", label: "椭圆", hint: "矢量椭圆" },
  { id: "text", label: "文字", hint: "可编辑文字" },
  { id: "node", label: "节点", hint: "拖动锚点改路径" },
  { id: "move", label: "选择", hint: "选中并拖动" },
  { id: "hand", label: "抓手", hint: "平移画布" },
];

function uid() { return `v${Math.random().toString(36).slice(2, 9)}`; }
function esc(s: string) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function pathD(points: number[], handles?: number[], close = false): string {
  if (points.length < 4) return "";
  const n = points.length / 2;
  let d = `M${points[0].toFixed(1)} ${points[1].toFixed(1)} `;
  const segs = close ? n : n - 1;
  for (let i = 0; i < segs; i += 1) {
    const j = (i + 1) % n;
    const x = points[i * 2], y = points[i * 2 + 1];
    const nx = points[j * 2], ny = points[j * 2 + 1];
    const out = handles && handles.length >= n * 4 ? handles.slice(i * 4 + 2, i * 4 + 4) : null;
    const nextIn = handles && handles.length >= n * 4 ? handles.slice(j * 4, j * 4 + 2) : null;
    if (out || nextIn) {
      const c1 = out ?? [x, y], c2 = nextIn ?? [nx, ny];
      d += `C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${nx.toFixed(1)} ${ny.toFixed(1)} `;
    } else d += `L${nx.toFixed(1)} ${ny.toFixed(1)} `;
  }
  if (close) d += "Z";
  return d;
}function smoothHandlesFor(points: number[]): number[] {
  const n = points.length / 2;
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const px = points[i * 2], py = points[i * 2 + 1];
    const prev = ((i - 1 + n) % n) * 2, next = ((i + 1) % n) * 2;
    const dx = points[next] - points[prev], dy = points[next + 1] - points[prev + 1];
    const len = Math.min(72, Math.hypot(dx, dy) * 0.42) || 24;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d;
    out.push(px - ux * len, py - uy * len, px + ux * len, py + uy * len);
  }
  return out;
}
function objectSubpaths(o: VObj): SubPath[] | null {
  const rings: number[][] = o.subpaths?.length ? o.subpaths : o.points?.length ? [o.points] : [];
  if (o.kind === "rect") rings.push([o.x, o.y, o.x + o.w, o.y, o.x + o.w, o.y + o.h, o.x, o.y + o.h]);
  if (o.kind === "ellipse") {
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2, rx = Math.abs(o.w) / 2, ry = Math.abs(o.h) / 2;
    const ring: number[] = [];
    for (let i = 0; i < 64; i += 1) {
      const a = (i / 64) * Math.PI * 2;
      ring.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
    }
    rings.push(ring);
  }
  if (o.kind === "path" && o.subpaths?.length) {
    // already in rings
  }
  if (!rings.length) return null;
  return rings.filter((r) => r.length >= 6).map((r) => ({ anchors: Array.from({ length: r.length / 2 }, (_, i) => anchorAt(r[i * 2], r[i * 2 + 1])), closed: true }));
}

function toPathNode(o: VObj): PathNode | null {
  const subs = objectSubpaths(o);
  if (!subs || subs.length < 1) return null;
  return {
    kind: "path",
    id: o.id,
    name: o.kind,
    subpaths: subs,
    fill: o.fill && o.fill !== "none" ? { kind: "solid", color: o.fill, opacity: 1 } : noPaint(),
    stroke: o.stroke ? { kind: "solid", color: o.stroke, opacity: 1, width: o.strokeWidth, dash: [] } : noStroke(),
    opacity: o.opacity,
    visible: o.visible,
    locked: false,
  };
}
function bboxOf(o: VObj): [number, number, number, number] {
  if (o.kind === "path" && (o.points?.length || o.subpaths?.length)) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    const sets = o.subpaths?.length ? o.subpaths : [o.points ?? []];
    for (const pts of sets) {
      for (let i = 0; i < pts.length; i += 2) {
        const x = pts[i], y = pts[i + 1];
        if (x < x1) x1 = x; if (y < y1) y1 = y;
        if (x > x2) x2 = x; if (y > y2) y2 = y;
      }
    }
    const pad = o.strokeWidth / 2;
    return [x1 - pad, y1 - pad, x2 - x1 + pad * 2, y2 - y1 + pad * 2];
  }
  return [o.x, o.y, o.w, o.h];
}
function cloneObjects(list: VObj[]): VObj[] {
  return list.map((o) => ({ ...o, points: o.points ? [...o.points] : undefined, subpaths: o.subpaths ? o.subpaths.map((p) => [...p]) : undefined, handles: o.handles ? [...o.handles] : undefined }));
}

function VGlyph({ tool }: { tool: VTool | "image" }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (tool) {
    case "brush": return <svg viewBox="0 0 24 24"><path {...p} d="M4 20c2.6-.2 4-1.3 5-3.2 1.2-2.2 2.8-4.4 5-6.5l5-5 1.2 1.2-5 5c-2.2 2.2-4.3 3.8-6.4 5-2 1.1-3.2 2.5-3.4 4.2z" /></svg>;
    case "eraser": return <svg viewBox="0 0 24 24"><path {...p} d="m4.6 13.6 6-6a3 3 0 0 1 4.2 0l3.6 3.6a3 3 0 0 1 0 4.2l-4.4 4.4H8.2l-3.6-3.6a3 3 0 0 1 0-2.6z" /><path {...p} d="M10 8.2l6.6 6.6M8 20h11" /></svg>;
    case "line": return <svg viewBox="0 0 24 24"><path {...p} d="M4 19 20 5" /><circle {...p} cx="4" cy="19" r="1.7" /><circle {...p} cx="20" cy="5" r="1.7" /></svg>;
    case "rect": return <svg viewBox="0 0 24 24"><rect {...p} x="4" y="6" width="16" height="12" /></svg>;
    case "ellipse": return <svg viewBox="0 0 24 24"><ellipse {...p} cx="12" cy="12" rx="8" ry="6" /></svg>;
    case "text": return <svg viewBox="0 0 24 24"><path {...p} d="M5 6V4h14v2M12 4v16M8 20h8" /></svg>;
    case "node": return <svg viewBox="0 0 24 24"><path {...p} d="M4 18c4-8 10-11 16-12" /><circle {...p} cx="4" cy="18" r="2.2" /><circle {...p} cx="12" cy="11.5" r="2.2" /><circle {...p} cx="20" cy="6" r="2.2" /></svg>;
    case "move": return <svg viewBox="0 0 24 24"><path {...p} d="M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5" /></svg>;
    case "hand": return <svg viewBox="0 0 24 24"><path {...p} d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V5.5a1.5 1.5 0 0 1 3 0V13M17 9.5a1.5 1.5 0 0 1 3 0V15c0 3.2-2.2 6-6 6h-2c-2.2 0-3.3-1-4.5-3L4.2 13a1.6 1.6 0 0 1 2.6-1.8L8 13" /></svg>;
    case "image": return <svg viewBox="0 0 24 24"><rect {...p} x="3.5" y="5" width="17" height="14" /><path {...p} d="m5 17 4.5-4.5 3 3 2.5-2.5 4 4" /></svg>;
  }
}

export function CoverVectorEditor({
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
  const stageRef = useRef<HTMLDivElement>(null);
  const [objects, setObjects] = useState<VObj[]>([]);
  const objectsRef = useRef<VObj[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const selectedRef = useRef("");
  const [multiIds, setMultiIds] = useState<string[]>([]);
  const [tool, setTool] = useState<VTool>("brush");
  const toolRef = useRef<VTool>("brush");
  const [color, setColor] = useState("#1d1a16");
  const colorRef = useRef("#1d1a16");
  const [bg, setBg] = useState("#fbf7ee");
  const [width, setWidth] = useState(8);
  const widthRef = useRef(8);
  const [opacity, setOpacity] = useState(100);
  const [shapeFill, setShapeFill] = useState(false);
  const [text, setText] = useState("封面标题");
  const [fontSize, setFontSize] = useState(90);
  const [fontFamily, setFontFamily] = useState("'Noto Serif SC', serif");
  const [bold, setBold] = useState(true);
  const [italic, setItalic] = useState(false);
  const [symmetry, setSymmetry] = useState<"none" | "x" | "y">("none");
  const [baseScale, setBaseScale] = useState(0);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const [draft, setDraft] = useState<Draft>(null);
  const draftRef = useRef<Draft>(null);
  const [panel, setPanel] = useState<"brush" | "layers" | "adjust">("brush");
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, setHistV] = useState(0);
  const undoRef = useRef<VObj[][]>([]);
  const redoRef = useRef<VObj[][]>([]);
  const nodeDragRef = useRef<{ active: boolean; index: number; objId: string; before: VObj[] | null; moved: boolean; handle: "anchor" | "in" | "out" }>({ active: false, index: -1, objId: "", before: null, moved: false, handle: "anchor" });
  const [nodeIndex, setNodeIndex] = useState(-1);
  const dragRef = useRef<{
    active: boolean;
    mode: "draw" | "move" | "pan";
    x: number;
    y: number;
    ox: number;
    oy: number;
    panX: number;
    panY: number;
    panL: number;
    panT: number;
    before: VObj[] | null;
    moved: boolean;
  }>({ active: false, mode: "draw", x: 0, y: 0, ox: 0, oy: 0, panX: 0, panY: 0, panL: 0, panT: 0, before: null, moved: false });

  const syncObjects = (list: VObj[]) => {
    objectsRef.current = list;
    setObjects(list);
  };
  const syncSelected = (id: string) => {
    selectedRef.current = id;
    setSelectedId(id);
    setNodeIndex(-1);
    setMultiIds([]);
  };
  const pushHistory = (before: VObj[]) => {
    undoRef.current.push(before);
    if (undoRef.current.length > 32) undoRef.current.shift();
    redoRef.current = [];
    setHistV((v) => v + 1);
  };
  const undo = () => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    redoRef.current.push(cloneObjects(objectsRef.current));
    syncObjects(cloneObjects(prev));
    setHistV((v) => v + 1);
  };
  const redo = () => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(cloneObjects(objectsRef.current));
    syncObjects(cloneObjects(next));
    setHistV((v) => v + 1);
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedRef.current && document.activeElement?.tagName !== "TEXTAREA") {
          const before = cloneObjects(objectsRef.current);
          syncObjects(before.filter((o) => o.id !== selectedRef.current));
          syncSelected("");
          pushHistory(before);
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { widthRef.current = width; }, [width]);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const fit = () => {
      const sw = stage.clientWidth, sh = stage.clientHeight;
      if (!sw || !sh) return;
      const padH = window.innerWidth <= 820 ? 184 : 44;
      setBaseScale(Math.min((sw - 44) / W, Math.max(80, sh - padH) / H));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [W, H]);

  const pointOf = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) };
  };

  const hit = (x: number, y: number): VObj | null => {
    for (let i = objectsRef.current.length - 1; i >= 0; i -= 1) {
      const o = objectsRef.current[i];
      if (!o.visible) continue;
      const [bx, by, bw, bh] = bboxOf(o);
      if (x >= bx - 8 && x <= bx + bw + 8 && y >= by - 8 && y <= by + bh + 8) return o;
    }
    return null;
  };

  const addObject = (o: VObj) => {
    const before = cloneObjects(objectsRef.current);
    syncObjects([...objectsRef.current, o]);
    syncSelected(o.id);
    pushHistory(before);
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const p = pointOf(e);
    const t = toolRef.current;
    if (t === "hand") {
      const stage = stageRef.current;
      dragRef.current = { active: true, mode: "pan", x: e.clientX, y: e.clientY, ox: 0, oy: 0, panX: 0, panY: 0, panL: stage?.scrollLeft ?? 0, panT: stage?.scrollTop ?? 0, before: null, moved: false };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (t === "eraser") {
      const h = hit(p.x, p.y);
      if (h) {
        const before = cloneObjects(objectsRef.current);
        syncObjects(objectsRef.current.filter((o) => o.id !== h.id));
        syncSelected("");
        pushHistory(before);
      }
      return;
    }
    if (t === "text") {
      addObject({
        id: uid(), kind: "text", x: p.x, y: p.y, w: Math.max(40, text.length * fontSize * 0.9), h: fontSize * 1.2,
        text, fontSize, fontFamily, bold, italic, stroke: colorRef.current, strokeWidth: 1, opacity: opacity / 100, visible: true,
      });
      return;
    }
    if (t === "node") {
      const sel = objectsRef.current.find((o) => o.id === selectedRef.current);
      if (!sel || sel.kind !== "path") return;
      const pts = sel.subpaths?.[0] ?? sel.points;
      if (!pts) return;
      const tol = 22 / Math.max(0.001, baseScale * zoomRef.current);
      const hd = sel.handles && sel.handles.length >= (pts.length / 2) * 4 ? sel.handles : smoothHandlesFor(pts);
      if (nodeIndex >= 0 && nodeIndex < pts.length / 2) {
        const ax = pts[nodeIndex * 2], ay = pts[nodeIndex * 2 + 1];
        for (const side of ["in", "out"] as const) {
          const hx = side === "in" ? hd[nodeIndex * 4] : hd[nodeIndex * 4 + 2];
          const hy = side === "in" ? hd[nodeIndex * 4 + 1] : hd[nodeIndex * 4 + 3];
          if (Math.hypot(hx - p.x, hy - p.y) < tol * 0.8) {
            sel.handles = [...hd];
            nodeDragRef.current = { active: true, index: nodeIndex, objId: sel.id, before: cloneObjects(objectsRef.current), moved: false, handle: side };
            void ax; void ay;
            e.currentTarget.setPointerCapture(e.pointerId);
            return;
          }
        }
      }
      let best = -1, bestD = tol;
      for (let i = 0; i < pts.length; i += 2) {
        const d = Math.hypot(pts[i] - p.x, pts[i + 1] - p.y);
        if (d < bestD) { bestD = d; best = i / 2; }
      }
      if (best < 0) return;
      setNodeIndex(best);
      nodeDragRef.current = { active: true, index: best, objId: sel.id, before: cloneObjects(objectsRef.current), moved: false, handle: "anchor" };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }    if (t === "move") {
      const h = hit(p.x, p.y);
      if (!h) { syncSelected(""); return; }
      if (e.shiftKey) { selectAdd(h.id); return; }
      syncSelected(h.id);
      dragRef.current = { active: true, mode: "move", x: p.x, y: p.y, ox: h.x, oy: h.y, panX: 0, panY: 0, panL: 0, panT: 0, before: cloneObjects(objectsRef.current), moved: false };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    dragRef.current = { active: true, mode: "draw", x: p.x, y: p.y, ox: p.x, oy: p.y, panX: 0, panY: 0, panL: 0, panT: 0, before: cloneObjects(objectsRef.current), moved: false };
    if (t === "brush") {
      draftRef.current = { tool: "brush", x: p.x, y: p.y, w: 0, h: 0, points: [p.x, p.y] };
      setDraft(draftRef.current);
    } else {
      draftRef.current = { tool: t, x: p.x, y: p.y, w: 0, h: 0, points: [] };
      setDraft(draftRef.current);
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = pointOf(e);
    const nd = nodeDragRef.current;
    if (nd.active) {
      const o = objectsRef.current.find((x) => x.id === nd.objId);
      const pts = o ? (o.subpaths?.[0] ?? o.points) : null;
      if (o && pts) {
        if (nd.handle === "anchor") {
          const dx = p.x - pts[nd.index * 2], dy = p.y - pts[nd.index * 2 + 1];
          pts[nd.index * 2] = p.x;
          pts[nd.index * 2 + 1] = p.y;
          if (o.handles) {
            for (let i = 0; i < o.handles.length; i += 2) { o.handles[i] += dx; o.handles[i + 1] += dy; }
          }
        } else {
          const n = pts.length / 2;
          if (!o.handles || o.handles.length < n * 4) o.handles = smoothHandlesFor(pts);
          const hd = o.handles;
          const ax = pts[nd.index * 2], ay = pts[nd.index * 2 + 1];
          if (nd.handle === "out") {
            hd[nd.index * 4 + 2] = p.x; hd[nd.index * 4 + 3] = p.y;
            hd[nd.index * 4] = ax * 2 - p.x; hd[nd.index * 4 + 1] = ay * 2 - p.y;
          } else {
            hd[nd.index * 4] = p.x; hd[nd.index * 4 + 1] = p.y;
            hd[nd.index * 4 + 2] = ax * 2 - p.x; hd[nd.index * 4 + 3] = ay * 2 - p.y;
          }
        }
        nd.moved = true;
        setObjects([...objectsRef.current]);
      }
      return;
    }
    const d = dragRef.current;
    if (!d.active) return;
    if (d.mode === "pan") {
      const stage = stageRef.current;
      if (stage) {
        stage.scrollLeft = d.panL - (e.clientX - d.x);
        stage.scrollTop = d.panT - (e.clientY - d.y);
      }
      return;
    }
    if (d.mode === "move") {
      const sel = objectsRef.current.find((o) => o.id === selectedRef.current);
      if (!sel) return;
      const orig = d.before?.find((o) => o.id === sel.id) ?? sel;
      const dx = p.x - d.x, dy = p.y - d.y;
      d.moved = true;
      sel.x = orig.x + dx;
      sel.y = orig.y + dy;
      if (sel.points) sel.points = orig.points?.map((v, i) => v + (i % 2 === 0 ? dx : dy)) ?? sel.points;
      if (sel.subpaths) sel.subpaths = orig.subpaths?.map((pts) => pts.map((v, i) => v + (i % 2 === 0 ? dx : dy))) ?? sel.subpaths;
      if (sel.handles) sel.handles = orig.handles?.map((v, i) => v + (i % 2 === 0 ? dx : dy)) ?? sel.handles;
      setObjects([...objectsRef.current]);
      return;
    }
    const dr = draftRef.current;
    if (!dr) return;
    dr.moved = true;
    if (dr.tool === "brush") {
      const lastX = dr.points[dr.points.length - 2];
      const lastY = dr.points[dr.points.length - 1];
      if (Math.hypot(p.x - lastX, p.y - lastY) > 2) {
        dr.points.push(p.x, p.y);
        setDraft({ ...dr, points: [...dr.points] });
      }
    } else {
      dr.w = p.x - dr.x;
      dr.h = p.y - dr.y;
      setDraft({ ...dr });
    }
  };

  const onPointerUp = () => {
    const nd = nodeDragRef.current;
    if (nd.active) {
      if (nd.moved && nd.before) pushHistory(nd.before);
      nodeDragRef.current = { active: false, index: -1, objId: "", before: null, moved: false, handle: "anchor" };
      return;
    }
    const d = dragRef.current;
    if (!d.active) return;
    d.active = false;
    if (d.mode === "pan") return;
    if (d.mode === "move") {
      if (d.moved && d.before) pushHistory(d.before);
      return;
    }
    const dr = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (!dr) return;
    if (dr.tool === "brush") {
      if (dr.points.length < 4) return;
      addObject({
        id: uid(), kind: "path", x: 0, y: 0, w: 0, h: 0, points: dr.points,
        stroke: colorRef.current, strokeWidth: widthRef.current, opacity: opacity / 100, visible: true,
      });
      if (symmetry !== "none") {
        const mirrored = dr.points.map((v, i) => (i % 2 === 0 ? (symmetry === "x" ? W - v : v) : (symmetry === "y" ? H - v : v)));
        addObject({ id: uid(), kind: "path", x: 0, y: 0, w: 0, h: 0, points: mirrored, stroke: colorRef.current, strokeWidth: widthRef.current, opacity: opacity / 100, visible: true });
      }
      return;
    }
    if (Math.abs(dr.w) < 2 || Math.abs(dr.h) < 2) return;
    const x = Math.min(dr.x, dr.x + dr.w);
    const y = Math.min(dr.y, dr.y + dr.h);
    addObject({
      id: uid(), kind: dr.tool === "line" ? "line" : dr.tool === "rect" ? "rect" : "ellipse",
      x, y, w: Math.abs(dr.w), h: Math.abs(dr.h),
      fill: shapeFill ? colorRef.current : "none",
      stroke: colorRef.current, strokeWidth: widthRef.current, opacity: opacity / 100, visible: true,
    });
  };

  const selected = objects.find((o) => o.id === selectedId);

  const removeSelected = () => {
    if (!selected) return;
    const before = cloneObjects(objectsRef.current);
    syncObjects(objectsRef.current.filter((o) => o.id !== selected.id));
    syncSelected("");
    pushHistory(before);
  };
  const duplicateSelected = () => {
    if (!selected) return;
    const copy = cloneObjects([selected])[0];
    copy.id = uid();
    copy.x += 24; copy.y += 24;
    if (copy.points) copy.points = copy.points.map((v) => v + 24);
    if (copy.subpaths) copy.subpaths = copy.subpaths.map((pts) => pts.map((v) => v + 24));
    if (copy.handles) copy.handles = copy.handles.map((v) => v + 24);
    addObject(copy);
  };
  const selectAdd = (id: string) => {
    if (!selectedRef.current) { syncSelected(id); return; }
    if (id === selectedRef.current) return;
    setMultiIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const selectedIds = [selectedId, ...multiIds].filter(Boolean);
  const selectedObjects = objects.filter((o) => selectedIds.includes(o.id));

  const boolSelected = (op: BoolOp) => {
    const nodes = selectedObjects.map(toPathNode).filter((n): n is PathNode => Boolean(n));
    if (nodes.length < 2) return;
    const before = cloneObjects(objectsRef.current);
    const subs = booleanSubpaths(nodes, op);
    if (!subs.length) return;
    const first = selectedObjects[selectedObjects.length - 1];
    const result: VObj = {
      id: uid(), kind: "path", x: 0, y: 0, w: 0, h: 0,
      subpaths: subs.map((sp) => sp.anchors.flatMap((a) => [a.x, a.y])),
      fill: first.fill && first.fill !== "none" ? first.fill : first.stroke,
      stroke: "none", strokeWidth: 0, opacity: 1, visible: true,
    };
    const next = objectsRef.current.filter((o) => !selectedIds.includes(o.id));
    next.push(result);
    syncObjects(next);
    syncSelected(result.id);
    pushHistory(before);
  };

  const curveSelected = () => {
    const sel = objectsRef.current.find((o) => o.id === selectedRef.current);
    if (!sel || sel.kind !== "path" || !(sel.points || sel.subpaths)) return;
    const before = cloneObjects(objectsRef.current);
    const pts = sel.subpaths?.[0] ?? sel.points!;
    sel.handles = smoothHandlesFor(pts);
    syncObjects([...objectsRef.current]);
    pushHistory(before);
  };

  const straightenSelected = () => {
    const sel = objectsRef.current.find((o) => o.id === selectedRef.current);
    if (!sel || !sel.handles) return;
    const before = cloneObjects(objectsRef.current);
    delete sel.handles;
    syncObjects([...objectsRef.current]);
    pushHistory(before);
  };

  const scaleSelected = (percent: number) => {
    if (!selected) return;
    const [bx, by, bw, bh] = bboxOf(selected);
    const cx = bx + bw / 2, cy = by + bh / 2;
    const s = percent / 100;
    selected.x = cx + (selected.x - cx) * s;
    selected.y = cy + (selected.y - cy) * s;
    selected.w *= s; selected.h *= s;
    selected.fontSize = (selected.fontSize ?? 0) * s || undefined;
    selected.strokeWidth *= s;
    if (selected.points) {
      selected.points = selected.points.map((v, i) => {
        const center = i % 2 === 0 ? cx : cy;
        return center + (v - center) * s;
      });
    }
    if (selected.subpaths) selected.subpaths = selected.subpaths.map((pts) => pts.map((v, i) => (i % 2 === 0 ? cx : cy) + (v - (i % 2 === 0 ? cx : cy)) * s));
    if (selected.handles) selected.handles = selected.handles.map((v, i) => (i % 2 === 0 ? cx : cy) + (v - (i % 2 === 0 ? cx : cy)) * s);
    setObjects([...objectsRef.current]);
  };
  const moveLayer = (dir: -1 | 1) => {
    if (!selected) return;
    const list = [...objectsRef.current];
    const idx = list.findIndex((o) => o.id === selected.id);
    const to = Math.max(0, Math.min(list.length - 1, idx + dir));
    if (to === idx) return;
    list.splice(idx, 1);
    list.splice(to, 0, selected);
    syncObjects(list);
  };
  const toggleVisible = (id: string) => {
    const o = objectsRef.current.find((x) => x.id === id);
    if (o) { o.visible = !o.visible; setObjects([...objectsRef.current]); }
  };

  const renderObj = (o: VObj, key?: string) => {
    if (!o.visible) return null;
    const op = o.opacity;
    const common = { opacity: op, key };
    switch (o.kind) {
      case "path": {
        const d = o.subpaths?.length
          ? o.subpaths.map((pts) => pathD(pts, undefined, true)).join(" ")
          : pathD(o.points ?? [], o.handles, false);
        return <path {...common} d={d} fill={o.fill || "none"} fillRule="nonzero" stroke={o.stroke} strokeWidth={o.strokeWidth} strokeLinecap="round" strokeLinejoin="round" />;
      }
      case "line":
        return <line {...common} x1={o.x} y1={o.y} x2={o.x + (o.w || 0)} y2={o.y + (o.h || 0)} stroke={o.stroke} strokeWidth={o.strokeWidth} />;
      case "rect":
        return <rect {...common} x={o.x} y={o.y} width={Math.max(1, o.w)} height={Math.max(1, o.h)} fill={o.fill ?? "none"} stroke={o.stroke} strokeWidth={o.strokeWidth} />;
      case "ellipse":
        return <ellipse {...common} cx={o.x + o.w / 2} cy={o.y + o.h / 2} rx={Math.max(1, o.w / 2)} ry={Math.max(1, o.h / 2)} fill={o.fill ?? "none"} stroke={o.stroke} strokeWidth={o.strokeWidth} />;
      case "text":
        return <text {...common} x={o.x} y={o.y} fill={o.stroke} fontSize={o.fontSize} fontFamily={o.fontFamily} fontWeight={o.bold ? 700 : 400} fontStyle={o.italic ? "italic" : "normal"}>{o.text}</text>;
    }
  };

  const svgString = () => {
    const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`];
    parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${bg}"/>`);
    for (const o of objectsRef.current) {
      if (!o.visible) continue;
      const op = ` opacity="${o.opacity}"`;
      if (o.kind === "path" && (o.points || o.subpaths)) {
        const d = o.subpaths?.length ? o.subpaths.map((pts) => pathD(pts, undefined, true)).join(" ") : pathD(o.points ?? [], o.handles, false);
        parts.push(`<path d="${d}" fill="${o.fill || "none"}" fill-rule="nonzero" stroke="${o.stroke}" stroke-width="${o.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${op}/>`);
      } else if (o.kind === "line") {
        parts.push(`<line x1="${o.x}" y1="${o.y}" x2="${o.x + o.w}" y2="${o.y + o.h}" stroke="${o.stroke}" stroke-width="${o.strokeWidth}"${op}/>`);
      } else if (o.kind === "rect") {
        parts.push(`<rect x="${o.x}" y="${o.y}" width="${Math.max(1, o.w)}" height="${Math.max(1, o.h)}" fill="${o.fill || "none"}" stroke="${o.stroke}" stroke-width="${o.strokeWidth}"${op}/>`);
      } else if (o.kind === "ellipse") {
        parts.push(`<ellipse cx="${o.x + o.w / 2}" cy="${o.y + o.h / 2}" rx="${Math.max(1, o.w / 2)}" ry="${Math.max(1, o.h / 2)}" fill="${o.fill || "none"}" stroke="${o.stroke}" stroke-width="${o.strokeWidth}"${op}/>`);
      } else if (o.kind === "text") {
        parts.push(`<text x="${o.x}" y="${o.y}" fill="${o.stroke}" font-size="${o.fontSize}" font-family="${esc(o.fontFamily || "serif")}" font-weight="${o.bold ? 700 : 400}" font-style="${o.italic ? "italic" : "normal"}"${op}>${esc(o.text || "")}</text>`);
      }
    }
    parts.push("</svg>");
    return parts.join("");
  };

  const downloadSvg = () => {
    const blob = new Blob([svgString()], { type: "image/svg+xml;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${title || "封面"}-矢量.svg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  };

  const rasterPng = async (outW = 1600, outH = 0): Promise<string> => {
    const outHeight = outH || Math.round((outW * H) / W);
    const blob = new Blob([svgString()], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error("SVG 渲染失败"));
        im.src = url;
      });
      const c = document.createElement("canvas");
      c.width = outW; c.height = outHeight;
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("无法创建画布");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, outW, outHeight);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, outW, outHeight);
      return c.toDataURL("image/png");
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const leave = () => {
    if ((objectsRef.current.length > 0 || undoRef.current.length > 0) && !window.confirm("返回会丢失当前矢量画稿，确定离开画室？")) return;
    onClose();
  };

  const finish = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onDone(await rasterPng());
    } finally {
      setBusy(false);
    }
  };

  const displayScale = baseScale * zoom;

  const panelBody = useMemo(() => {
    const section = (id: typeof panel) => (
      <section className={`cpr-sec${panel === id ? " on" : ""}`} data-sec={id}>
        {id === "brush" && (
          <>
            <label className="cpr-range"><span>线宽</span><strong>{width}px</strong><input type="range" min={1} max={120} value={width} onChange={(e) => setWidth(Number(e.target.value))} /></label>
            <label className="cpr-range"><span>不透明度</span><strong>{opacity}%</strong><input type="range" min={1} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} /></label>
            {tool === "text" && (
              <>
                <label className="cpr-field"><span>文字</span><textarea value={text} rows={2} onChange={(e) => setText(e.target.value)} /></label>
                <label className="cpr-range"><span>字号</span><strong>{fontSize}</strong><input type="range" min={20} max={300} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} /></label>
                <label className="cpr-field"><span>字体</span><select value={fontFamily} onChange={(e) => setFontFamily(e.target.value)}><option value="'Noto Serif SC', serif">宋体</option><option value="'Noto Sans SC', sans-serif">黑体</option><option value="Georgia, serif">衬线西文</option><option value="'Helvetica Neue', sans-serif">无衬线西文</option></select></label>
                <div className="cpr-btn-grid two">
                  <button className={bold ? "on" : ""} onClick={() => setBold(!bold)}>加粗</button>
                  <button className={italic ? "on" : ""} onClick={() => setItalic(!italic)}>斜体</button>
                </div>
              </>
            )}
            {(tool === "rect" || tool === "ellipse") && <label className="cpr-check"><input type="checkbox" checked={shapeFill} onChange={(e) => setShapeFill(e.target.checked)} /><span>填充图形</span></label>}
            {tool === "node" && (
              <>
                <div className="cpr-btn-grid two">
                  <button onClick={curveSelected}>曲线化</button>
                  <button onClick={straightenSelected}>拉直</button>
                </div>
                <p className="cpr-hint">点中锚点后拖两侧手柄改曲线；拖动锚点整段移动。每步都可撤销。</p>
              </>
            )}
            {tool === "brush" && <div className="cpr-field"><span>对称</span><div className="cpr-seg small">{[["none", "关"], ["x", "左右"], ["y", "上下"]].map(([k, label]) => <button key={k} className={symmetry === k ? "on" : ""} onClick={() => setSymmetry(k as typeof symmetry)}>{label}</button>)}</div></div>}
            <label className="cpr-field"><span>底色</span><div className="cpr-inline-color"><input type="color" value={bg} onChange={(e) => setBg(e.target.value)} /><em>{bg}</em></div></label>
            <div className="cpr-colors">
              {["#1d1a16", "#f5efe3", "#c9a96b", "#b9684a", "#8d3b34", "#455d4b", "#2f6f7e", "#3d4f91", "#6d4a8f", "#a35477", "#e7c8a4", "#ffffff"].map((c) => <button key={c} className={color === c ? "on" : ""} style={{ background: c }} onClick={() => setColor(c)} />)}
              <label className="cpr-color-input"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} /><span>自定义</span></label>
            </div>
            <p className="cpr-hint">矢量模式不支持导入图片；橡皮是整笔删除，不能擦局部像素。</p>
            <button className="cpr-wide-btn ghost" onClick={() => setTool("text")}>切到文字工具</button>
          </>
        )}
        {id === "layers" && (
          <>
            <div className="cpr-layer-list">
              {[...objects].reverse().map((o, i) => (
                <div key={o.id} className={`cpr-layer${o.id === selectedId ? " on" : ""}`} onClick={(e) => (e.shiftKey ? selectAdd(o.id) : syncSelected(o.id))}>
                  <button className="cpr-eye" onClick={(e) => { e.stopPropagation(); toggleVisible(o.id); }}>{o.visible ? "◉" : "○"}</button>
                  <span>{o.kind === "text" ? `文字 ${o.text?.slice(0, 8) || ""}` : o.kind === "path" ? `路径 ${objects.length - i}` : o.kind}</span>
                  <em>{Math.round(o.opacity * 100)}%</em>
                </div>
              ))}
              {!objects.length && <p className="cpr-empty">还没有对象，先落一笔。</p>}
            </div>
            <div className="cpr-btn-grid two">
              <button onClick={() => boolSelected("union")} disabled={selectedObjects.length < 2}>并集</button>
              <button onClick={() => boolSelected("intersect")} disabled={selectedObjects.length < 2}>相交</button>
              <button onClick={() => boolSelected("subtract")} disabled={selectedObjects.length < 2}>减去</button>
              <button onClick={() => boolSelected("exclude")} disabled={selectedObjects.length < 2}>差集</button>
            </div>
            <p className="cpr-hint">Shift + 点选多个对象后可布尔运算；结果由 Vexa 路径内核拍平合并。</p>
            {selected && (
              <>
                <div className="cpr-btn-grid">
                  <button onClick={duplicateSelected}>复制</button>
                  <button onClick={() => moveLayer(1)}>上移</button>
                  <button onClick={() => moveLayer(-1)}>下移</button>
                  <button onClick={removeSelected}>删除</button>
                </div>
                {(selected.kind === "path" || selected.kind === "rect" || selected.kind === "ellipse") && (
                  <div className="cpr-field-row">
                    <label className="cpr-field"><span>填充</span><input type="color" value={selected.fill && selected.fill !== "none" ? selected.fill : "#fbf7ee"} onChange={(e) => { selected.fill = e.target.value; setObjects([...objectsRef.current]); }} /></label>
                    <label className="cpr-field"><span>描边</span><input type="color" value={selected.stroke && selected.stroke !== "none" ? selected.stroke : "#1a1611"} onChange={(e) => { selected.stroke = e.target.value; if (!selected.strokeWidth) selected.strokeWidth = 8; setObjects([...objectsRef.current]); }} /></label>
                  </div>
                )}                {selected.kind === "text" && (
                  <>
                    <label className="cpr-field"><span>选中文字</span><textarea rows={2} value={selected.text || ""} onChange={(e) => { selected.text = e.target.value; setObjects([...objectsRef.current]); }} /></label>
                    <label className="cpr-range"><span>字号</span><strong>{Math.round(selected.fontSize || 90)}</strong><input type="range" min={20} max={300} value={selected.fontSize || 90} onChange={(e) => { selected.fontSize = Number(e.target.value); setObjects([...objectsRef.current]); }} /></label>
                  </>
                )}
                <label className="cpr-range"><span>缩放选中</span><input type="range" min={30} max={200} defaultValue={100} onPointerUp={(e) => scaleSelected(Number((e.target as HTMLInputElement).value))} /></label>
                <button className="cpr-wide-btn danger" onClick={removeSelected}>删除选中对象</button>
              </>
            )}
          </>
        )}
        {id === "adjust" && (
          <>
            <div className="cpr-btn-grid two">
              <button onClick={() => { const before = cloneObjects(objectsRef.current); syncObjects([]); syncSelected(""); pushHistory(before); }}>清空画面</button>
              <button onClick={() => { setBg("#fbf7ee"); }}>米白底</button>
              <button onClick={() => { setBg("#11100e"); }}>墨黑底</button>
              <button onClick={() => { setBg("#ffffff"); }}>纯白底</button>
            </div>
            <label className="cpr-field"><span>底色</span><div className="cpr-inline-color"><input type="color" value={bg} onChange={(e) => setBg(e.target.value)} /><em>{bg}</em></div></label>
            <p className="cpr-hint">导出 SVG 会保留路径、形状和文字；导出封面时会栅格成 PNG。字体缺失时系统会替换，正式封面请先预览。</p>
            <button className="cpr-wide-btn" onClick={downloadSvg}>下载 SVG（矢量原件）</button>
          </>
        )}
      </section>
    );
    return (
      <>
        <div className="cpr-panel-tabs">
          {[["brush", "笔刷"], ["layers", "图层"], ["adjust", "画布"]].map(([id, label]) => (
            <button key={id} className={panel === id ? "on" : ""} onClick={() => setPanel(id as typeof panel)}>{label}</button>
          ))}
        </div>
        {section("brush")}
        {section("layers")}
        {section("adjust")}
      </>
    );
  }, [panel, tool, width, opacity, text, fontSize, fontFamily, bold, italic, shapeFill, symmetry, bg, color, objects, selectedId, selected, multiIds]);

  return (
    <div className={`cps-root cpr-root${sheet ? " sheet-open" : ""}`}>
      <StudioStatusBar />
      <header className="cpr-head">
        <button className="cps-icon-btn" onClick={leave} aria-label="返回">
          <svg viewBox="0 0 24 24"><path d="M15 5 8 12l7 7" /></svg>
        </button>
        <div className="cpr-title"><span>手绘封面 · SVG 矢量</span><strong>{title || "未命名"}{author ? ` · ${author}` : ""}</strong></div>
        <div className="cpr-head-actions">
          <button className="cps-icon-btn" onClick={undo} disabled={!undoRef.current.length} title="撤销"><svg viewBox="0 0 24 24"><path d="M9 7 4 12l5 5M4 12h9a5 5 0 0 1 5 5" /></svg></button>
          <button className="cps-icon-btn" onClick={redo} disabled={!redoRef.current.length} title="重做"><svg viewBox="0 0 24 24"><path d="m15 7 5 5-5 5M20 12h-9a5 5 0 0 0-5 5" /></svg></button>
          <button className="cps-btn primary small" onClick={() => void finish()} disabled={busy}>{busy ? "导出中…" : "用作封面"}</button>
        </div>
      </header>

      <div className="cpr-body">
        <aside className="cpr-toolbar">
          {VTOOLS.map((item) => (
            <button key={item.id} className={tool === item.id ? "on" : ""} title={item.hint} onClick={() => setTool(item.id)}><VGlyph tool={item.id} /><span>{item.label}</span></button>
          ))}
          <button className="off" title="矢量模式不支持导入图片" onClick={() => setPanel("brush")}><VGlyph tool="image" /><span>图片</span><b>禁用</b></button>
        </aside>

        <div className="cpr-stage" ref={stageRef}>
          <div className="cpr-canvas-shell" style={displayScale ? { width: W * displayScale, height: H * displayScale } : { width: "80%", height: "80%" }}>
            <svg
              viewBox={`0 0 ${W} ${H}`}
              style={{ width: "100%", height: "100%", touchAction: "none", display: "block", background: bg }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <rect x={0} y={0} width={W} height={H} fill={bg} />
              {objects.map((o) => renderObj(o, o.id))}
              {draft?.tool === "brush" && draft.points.length >= 4 && (
                <path d={draft.points.reduce((d, v, i) => d + `${i === 0 ? "M" : i % 2 === 1 ? " L" : " "}${v}`, "")} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" opacity={0.85} />
              )}
              {draft && draft.tool !== "brush" && (
                draft.tool === "line"
                  ? <line x1={draft.x} y1={draft.y} x2={draft.x + draft.w} y2={draft.y + draft.h} stroke={color} strokeWidth={width} />
                  : draft.tool === "ellipse"
                    ? <ellipse cx={draft.x + draft.w / 2} cy={draft.y + draft.h / 2} rx={Math.abs(draft.w / 2)} ry={Math.abs(draft.h / 2)} fill={shapeFill ? color : "none"} stroke={color} strokeWidth={width} />
                    : <rect x={Math.min(draft.x, draft.x + draft.w)} y={Math.min(draft.y, draft.y + draft.h)} width={Math.abs(draft.w)} height={Math.abs(draft.h)} fill={shapeFill ? color : "none"} stroke={color} strokeWidth={width} />
              )}
              {selected && tool === "node" && selected.kind === "path" && (selected.points || selected.subpaths) && (() => {
                const pts = selected.subpaths?.[0] ?? selected.points!;
                const count = pts.length / 2;
                const step = Math.max(1, Math.ceil(count / 36));
                const r = 8 / Math.max(0.001, displayScale);
                const hd = selected.handles && selected.handles.length >= count * 4 ? selected.handles : smoothHandlesFor(pts);
                const out = [];
                for (let i = 0; i < count; i += step) {
                  out.push(<circle key={i} cx={pts[i * 2]} cy={pts[i * 2 + 1]} r={r} fill={i === nodeIndex ? "#e6b96d" : "#1a1611"} stroke="#ffe1ad" strokeWidth={r * 0.35} />);
                }
                if (nodeIndex >= 0 && nodeIndex < count) {
                  const ax = pts[nodeIndex * 2], ay = pts[nodeIndex * 2 + 1];
                  const ix = hd[nodeIndex * 4], iy = hd[nodeIndex * 4 + 1];
                  const ox = hd[nodeIndex * 4 + 2], oy = hd[nodeIndex * 4 + 3];
                  out.push(<g key="handles"><line x1={ix} y1={iy} x2={ax} y2={ay} stroke="#e6b96d" strokeWidth={1.2} /><line x1={ax} y1={ay} x2={ox} y2={oy} stroke="#e6b96d" strokeWidth={1.2} /><circle cx={ix} cy={iy} r={r * 0.72} fill="#fff6df" stroke="#c58c3c" strokeWidth={1} /><circle cx={ox} cy={oy} r={r * 0.72} fill="#fff6df" stroke="#c58c3c" strokeWidth={1} /></g>);
                }
                return <g>{out}</g>;
              })()}              {selected && (() => {
                const [bx, by, bw, bh] = bboxOf(selected);
                return <g pointerEvents="none"><rect x={bx - 6} y={by - 6} width={bw + 12} height={bh + 12} fill="none" stroke="#e6b96d" strokeDasharray="8 6" strokeWidth={2} /><circle cx={bx + bw + 6} cy={by + bh + 6} r={7} fill="#e6b96d" /></g>;
              })()}
              {multiIds.map((id) => {
                const o = objects.find((x) => x.id === id);
                if (!o) return null;
                const [bx, by, bw, bh] = bboxOf(o);
                return <g key={id} pointerEvents="none"><rect x={bx - 5} y={by - 5} width={bw + 10} height={bh + 10} fill="none" stroke="#9fc5e8" strokeDasharray="4 4" strokeWidth={1.5} /></g>;
              })}
            </svg>
          </div>
        </div>

        <aside className="cpr-panel">{panelBody}</aside>
      </div>

      <footer className="cpr-foot">
        <div className="cpr-zoom">
          <button onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}>−</button>
          <span>{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.min(5, z + 0.25))}>＋</button>
          <button className="fit" onClick={() => setZoom(1)}>适应</button>
        </div>
        <div className="cpr-foot-info">SVG 矢量 · {W}×{H} · 导出 1600×{Math.round((1600 * H) / W)}</div>
        <div className="cpr-foot-actions">
          <button className="cpr-sheet-toggle" onClick={() => setSheet((v) => !v)}>参数</button>
          <button onClick={downloadSvg}>下载 SVG</button>
          <button className="primary" onClick={() => void finish()} disabled={busy}>用作封面</button>
        </div>
      </footer>
    </div>
  );
}











































