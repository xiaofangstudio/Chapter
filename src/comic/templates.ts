import { normalizeQuad } from "./geometry";
import type { ComicFrame } from "./types";

export type TemplateFamily = "lianhua" | "comic" | "canvas";

export interface TemplateFrameDef {
  box: [number, number, number, number];
  /** 页面内归一化四点；有值时生成四边形分格。 */
  points?: [number, number][];
}

export interface TemplateDef {
  id: string;
  name: string;
  note: string;
  family: TemplateFamily;
  frames: TemplateFrameDef[];
}

function boxOf(points: [number, number][]): [number, number, number, number] {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
}

function quad(points: [number, number][]): TemplateFrameDef {
  return { box: boxOf(points), points };
}

function rect(
  x: number,
  y: number,
  w: number,
  h: number,
): TemplateFrameDef {
  return { box: [x, y, w, h] };
}

export const FRAME_TEMPLATES: TemplateDef[] = [
  {
    id: "six",
    name: "六格",
    note: "2 × 3，最稳的叙事底",
    family: "lianhua",
    frames: [
      rect(0.07, 0.06, 0.415, 0.285),
      rect(0.515, 0.06, 0.415, 0.285),
      rect(0.07, 0.357, 0.415, 0.285),
      rect(0.515, 0.357, 0.415, 0.285),
      rect(0.07, 0.654, 0.415, 0.285),
      rect(0.515, 0.654, 0.415, 0.285),
    ],
  },
  {
    id: "four",
    name: "四格",
    note: "2 × 2，对话与停顿都够用",
    family: "lianhua",
    frames: [
      rect(0.07, 0.06, 0.415, 0.435),
      rect(0.515, 0.06, 0.415, 0.435),
      rect(0.07, 0.515, 0.415, 0.435),
      rect(0.515, 0.515, 0.415, 0.435),
    ],
  },
  {
    id: "cinema",
    name: "电影条",
    note: "上二下一，适合横移镜头",
    family: "lianhua",
    frames: [
      rect(0.07, 0.06, 0.415, 0.31),
      rect(0.515, 0.06, 0.415, 0.31),
      rect(0.07, 0.39, 0.86, 0.55),
    ],
  },
  {
    id: "splash",
    name: "大场面",
    note: "一格主画面 + 两格反应",
    family: "lianhua",
    frames: [
      rect(0.07, 0.06, 0.86, 0.5),
      rect(0.07, 0.58, 0.415, 0.36),
      rect(0.515, 0.58, 0.415, 0.36),
    ],
  },
  {
    id: "strip",
    name: "三连",
    note: "横向三格，竖屏阅读的节奏",
    family: "lianhua",
    frames: [
      rect(0.07, 0.07, 0.86, 0.255),
      rect(0.07, 0.355, 0.86, 0.255),
      rect(0.07, 0.64, 0.86, 0.255),
    ],
  },
  {
    id: "cut4",
    name: "切角四格",
    note: "外圈贴纸边，里面斜切",
    family: "comic",
    frames: [
      quad([
        [0.055, 0.055],
        [0.545, 0.055],
        [0.475, 0.455],
        [0.055, 0.415],
      ]),
      quad([
        [0.585, 0.055],
        [0.945, 0.055],
        [0.945, 0.44],
        [0.505, 0.47],
      ]),
      quad([
        [0.055, 0.475],
        [0.465, 0.515],
        [0.545, 0.945],
        [0.055, 0.945],
      ]),
      quad([
        [0.505, 0.525],
        [0.945, 0.480],
        [0.945, 0.945],
        [0.585, 0.945],
      ]),
    ],
  },
  {
    id: "slant3",
    name: "斜切三格",
    note: "外圈平直，里面三道斜线",
    family: "comic",
    frames: [
      quad([
        [0.055, 0.055],
        [0.945, 0.055],
        [0.945, 0.300],
        [0.055, 0.240],
      ]),
      quad([
        [0.055, 0.240],
        [0.945, 0.300],
        [0.945, 0.630],
        [0.055, 0.570],
      ]),
      quad([
        [0.055, 0.570],
        [0.945, 0.630],
        [0.945, 0.945],
        [0.055, 0.945],
      ]),
    ],
  },
  {
    id: "burst5",
    name: "放射五格",
    note: "中宫 + 四向，适合爆发",
    family: "comic",
    frames: [
      quad([
        [0.050, 0.050],
        [0.950, 0.050],
        [0.680, 0.300],
        [0.320, 0.300],
      ]),
      quad([
        [0.050, 0.050],
        [0.300, 0.300],
        [0.300, 0.700],
        [0.050, 0.950],
      ]),
      quad([
        [0.950, 0.050],
        [0.950, 0.950],
        [0.700, 0.700],
        [0.700, 0.300],
      ]),
      quad([
        [0.050, 0.950],
        [0.320, 0.700],
        [0.680, 0.700],
        [0.950, 0.950],
      ]),
      quad([
        [0.320, 0.300],
        [0.680, 0.300],
        [0.700, 0.700],
        [0.300, 0.700],
      ]),
    ],
  },
  {
    id: "stagger4",
    name: "错位四格",
    note: "外圈齐纸边，里面错位",
    family: "comic",
    frames: [
      quad([
        [0.055, 0.055],
        [0.620, 0.055],
        [0.560, 0.480],
        [0.055, 0.440],
      ]),
      quad([
        [0.650, 0.055],
        [0.945, 0.055],
        [0.945, 0.420],
        [0.590, 0.470],
      ]),
      quad([
        [0.055, 0.520],
        [0.530, 0.570],
        [0.590, 0.945],
        [0.055, 0.945],
      ]),
      quad([
        [0.600, 0.570],
        [0.945, 0.520],
        [0.945, 0.945],
        [0.620, 0.945],
      ]),
    ],
  },
  {
    id: "grid9",
    name: "九宫格",
    note: "3 × 3，外圈全部齐纸边",
    family: "lianhua",
    frames: [
      rect(0.060, 0.055, 0.270, 0.270),
      rect(0.355, 0.055, 0.270, 0.270),
      rect(0.650, 0.055, 0.270, 0.270),
      rect(0.060, 0.355, 0.270, 0.270),
      rect(0.355, 0.355, 0.270, 0.270),
      rect(0.650, 0.355, 0.270, 0.270),
      rect(0.060, 0.655, 0.270, 0.270),
      rect(0.355, 0.655, 0.270, 0.270),
      rect(0.650, 0.655, 0.270, 0.270),
    ],
  },
  {
    id: "grid8",
    name: "八格",
    note: "2 × 4，竖排阅读一格一格推",
    family: "lianhua",
    frames: [
      rect(0.060, 0.055, 0.415, 0.205),
      rect(0.515, 0.055, 0.415, 0.205),
      rect(0.060, 0.275, 0.415, 0.205),
      rect(0.515, 0.275, 0.415, 0.205),
      rect(0.060, 0.495, 0.415, 0.205),
      rect(0.515, 0.495, 0.415, 0.205),
      rect(0.060, 0.715, 0.415, 0.205),
      rect(0.515, 0.715, 0.415, 0.205),
    ],
  },
  {
    id: "strip4",
    name: "四横条",
    note: "四条横带，外圈天然平行",
    family: "lianhua",
    frames: [
      rect(0.060, 0.055, 0.880, 0.205),
      rect(0.060, 0.280, 0.880, 0.205),
      rect(0.060, 0.505, 0.880, 0.205),
      rect(0.060, 0.730, 0.880, 0.205),
    ],
  },
  {
    id: "tall3",
    name: "三竖格",
    note: "三条竖带，适合并排反应",
    family: "lianhua",
    frames: [
      rect(0.055, 0.055, 0.272, 0.890),
      rect(0.365, 0.055, 0.272, 0.890),
      rect(0.675, 0.055, 0.272, 0.890),
    ],
  },
  {
    id: "mosaic5",
    name: "主格五连",
    note: "左一大格，右四小格",
    family: "lianhua",
    frames: [
      rect(0.060, 0.055, 0.400, 0.890),
      rect(0.480, 0.055, 0.220, 0.430),
      rect(0.715, 0.055, 0.220, 0.430),
      rect(0.480, 0.505, 0.220, 0.440),
      rect(0.715, 0.505, 0.220, 0.440),
    ],
  },
  {
    id: "blank",
    name: "无边框",
    note: "整页一张画，不裁切",
    family: "canvas",
    frames: [rect(0.06, 0.05, 0.88, 0.9)],
  },
];

export function buildTemplateFrames(
  template: TemplateDef,
  pageW: number,
  pageH: number,
  seed: number,
): ComicFrame[] {
  const stamp = seed;
  return template.frames.map(({ box, points }, index) => {
    const id = `f_${stamp}_${index + 1}`;
    const x = Math.round(box[0] * pageW);
    const y = Math.round(box[1] * pageH);
    const w = Math.round(box[2] * pageW);
    const h = Math.round(box[3] * pageH);
    return {
      id,
      x,
      y,
      w,
      h,
      shape: points ? "quad" : template.family === "canvas" ? "none" : "rect",
      points: points
        ? points.map(
            ([px, py]) =>
              [
                Number(((px - box[0]) / box[2]).toFixed(4)),
                Number(((py - box[1]) / box[3]).toFixed(4)),
              ] as [number, number],
          )
        : undefined,
      rotation: 0,
      overflow: false,
      layers: [
        {
          id: `l_${stamp}_${index + 1}`,
          name: template.family === "canvas" ? "场景" : "线稿",
          kind: "raster" as const,
          visible: true,
          opacity: 1,
          locked: false,
        },
      ],
    };
  });
}

export function makeAddFrame(
  pageW: number,
  pageH: number,
  existing: ComicFrame[],
  kind: "frame" | "blank",
  index: number,
): ComicFrame {
  const stamp = Date.now() + index;
  const w = kind === "blank" ? Math.round(pageW * 0.86) : Math.round(pageW * 0.36);
  const h = kind === "blank" ? Math.round(pageH * 0.8) : Math.round(pageH * 0.24);
  const offset = (existing.length % 5) * 22;
  return {
    id: `f_${stamp}`,
    x: Math.round((pageW - w) / 2 + offset),
    y: Math.round((pageH - h) / 2 + offset),
    w,
    h,
    shape: kind === "blank" ? "none" : "rect",
    rotation: 0,
    overflow: false,
    layers: [
      {
        id: `l_${stamp}`,
        name: kind === "blank" ? "场景" : "线稿",
        kind: "raster",
        visible: true,
        opacity: 1,
        locked: false,
      },
    ],
  };
}

/** 页面四角手绘：转成 x/y/w/h + 归一化 points。 */
export function makeDrawnFrame(points: [number, number][]): ComicFrame | null {
  const q = normalizeQuad(points.map(([x, y]) => ({ x, y })));
  if (!q) return null;
  const stamp = Date.now();
  return {
    id: `f_${stamp}`,
    x: q.x,
    y: q.y,
    w: q.w,
    h: q.h,
    shape: "quad",
    points: q.points,
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
}
