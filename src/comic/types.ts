export type ComicFrameShape = "rect" | "none" | "quad";
export type ComicImageFit = "contain" | "cover" | "stretch";
export type ComicBalloonShape = "ellipse" | "rect" | "thought";
export type ComicBlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity"
  | "linear-burn"
  | "linear-dodge"
  | "linear-light"
  | "pin-light"
  | "hard-mix";

export interface ComicLayerMeta {
  id: string;
  name: string;
  kind: "raster" | "image";
  visible: boolean;
  opacity: number;
  locked?: boolean;
  /** 与下层合成方式，缺省视为 normal。 */
  blendMode?: ComicBlendMode;
  /** 只作用于下一层的不透明像素。 */
  clipping?: boolean;
  /** 锁定透明：落笔只能改已有像素，不能扩大 alpha。 */
  alphaLocked?: boolean;
}

export interface ComicFrame {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  shape: ComicFrameShape;
  /** shape=quad 时，四个角相对 x/y/w/h 的归一化坐标；支持凹四边形。 */
  points?: [number, number][];
  rotation: number;
  overflow: boolean;
  layers: ComicLayerMeta[];
}

export interface ComicBalloon {
  id: string;
  frameId?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fontSize: number;
  shape: ComicBalloonShape;
  tailX: number;
  tailY: number;
  align?: "center" | "left";
}

export interface ComicImageItem {
  id: string;
  frameId: string;
  asset: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fit: ComicImageFit;
  rotation: number;
  opacity: number;
  name: string;
  role: "art" | "reference";
}

export interface ComicPageFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 外框线宽，页面单位。 */
  stroke: number;
}

/** 页级跨格线稿：多格并集聚焦时，把几格当成一张纸来画。 */
export interface ComicJointLayer {
  id: string;
  name: string;
  /** 创建时绑定的格；格移动/删除后仍以 rect 为准，frameIds 用于重建并集。 */
  frameIds: string[];
  rect: { x: number; y: number; w: number; h: number };
  /** 跨格连画：打开后笔迹可以穿过相邻选中格之间的格缝。 */
  crossPanel: boolean;
  visible: boolean;
  opacity: number;
  locked?: boolean;
  blendMode?: ComicBlendMode;
  createdAt: number;
}

export interface ComicPage {
  version: number;
  id: string;
  title: string;
  width: number;
  height: number;
  backgroundColor: string;
  /** 整页大外框；老页面没有这个字段，载入时按 3.5% 页边生成。 */
  pageFrame?: ComicPageFrame;
  frames: ComicFrame[];
  /** 页级跨格线稿；老页面没有这个字段。 */
  jointLayers?: ComicJointLayer[];
  balloons: ComicBalloon[];
  images: ComicImageItem[];
  createdAt: number;
  updatedAt: number;
}

export interface ComicPresetFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  shape: ComicFrameShape;
  points?: [number, number][];
}

export interface ComicPreset {
  id: string;
  name: string;
  width: number;
  height: number;
  pageFrame?: ComicPageFrame;
  frames: ComicPresetFrame[];
}

export interface ComicProjectMeta {
  version: number;
  kind: "comic";
  title: string;
  format: string;
  pageWidth: number;
  pageHeight: number;
  dpi: number;
  colorMode: string;
  readingDirection: string;
  pages: { id: string; title: string; chapterId?: string }[];
  currentPageId: string;
  /** 用户把整页排版存下来的预设。 */
  presets?: ComicPreset[];
  createdAt: number;
  updatedAt: number;
}

export interface ComicLayerPayload {
  id: string;
  dataUrl: string;
}

export interface ComicAssetPayload {
  path: string;
  dataUrl: string;
}

export interface ComicPagePayload {
  json: string;
  layers: ComicLayerPayload[];
  assets: ComicAssetPayload[];
}

export interface ComicFrameTemplate {
  id: string;
  name: string;
  note: string;
  rows: number[][];
}
