export type ComicFrameShape = "rect" | "none" | "quad";
export type ComicImageFit = "contain" | "cover" | "stretch";
export type ComicBalloonShape = "ellipse" | "rect" | "thought";

export interface ComicLayerMeta {
  id: string;
  name: string;
  kind: "raster" | "image";
  visible: boolean;
  opacity: number;
  locked?: boolean;
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
