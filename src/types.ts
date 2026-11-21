export interface BookMeta {
  id: string;
  title: string;
  author: string;
  cover: string | null;
  createdAt: number;
  updatedAt: number;
  targetWords: number;
  dailyGoal: number;
  lastChapterId: string | null;
  daily: { date: string; base: number } | null;
  wordCount?: number;
  /** 小说简介，只用于介绍页，不参与正文统计。 */
  description?: string;
  /** 整书大纲：受限 Markdown，单独于章节大纲保存。 */
  bookOutline?: string;
  /** 自定义封面没有画面书脊，用这个颜色画书脊。 */
  spineColor?: string;
}

export interface Scene {
  id: string;
  title: string;
  summary: string;
}

export interface Chapter {
  id: string;
  title: string;
  summary: string;
  scenes: Scene[];
  words: number;
  updatedAt: number;
}

export interface Volume {
  id: string;
  title: string;
  collapsed: boolean;
  chapters: Chapter[];
}

export interface Outline {
  volumes: Volume[];
}

export type LoreKind = "character" | "place" | "item";

export interface LoreField {
  k: string;
  v: string;
}

export interface LoreEntry {
  id: string;
  kind: LoreKind;
  name: string;
  fields: LoreField[];
  note: string;
}

export interface Lore {
  entries: LoreEntry[];
}

export interface BookSummary {
  path: string;
  title: string;
  author: string;
  words: number;
  updatedAt: number;
  cover: string | null;
  targetWords: number;
  id: string;
  chapterCount: number;
  spineColor?: string | null;
}

export interface RawProject {
  path: string;
  book: string;
  outline: string;
  lore: string;
  chapters: { id: string; body: string }[];
}

export interface SnapshotInfo {
  name: string;
  createdAt: number;
  words: number;
  label: string;
}

export interface Project {
  path: string;
  meta: BookMeta;
  outline: Outline;
  lore: Lore;
  bodies: Record<string, string>;
}

export interface ImportDoc {
  name: string;
  text: string;
  format: string;
}

export interface McpStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  endpoint: string;
  error: string | null;
}

export interface GitStatus {
  installed: boolean;
  version: string;
  isRepo: boolean;
  branch: string;
  dirty: boolean;
}

export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  date: string;
  subject: string;
  refs: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
}

export interface ImportChapter {
  id: string;
  title: string;
  body: string;
  volumeTitle: string;
}

export type ViewKind = "write" | "outline" | "bookOutline" | "lore";
export type ThemeMode = "light" | "dark" | "system";
export type MotionMode = "full" | "reduced" | "off";
export type LightEffect = "still" | "flow" | "spot";
export type SaveState = "idle" | "dirty" | "saving" | "saved";
export type HomeMode = "minimal" | "workspace";
export type AccentTheme = "amber" | "rust" | "olive" | "ocean" | "plum";

export const ACCENTS: { key: AccentTheme; label: string; css: string }[] = [
  { key: "amber", label: "琥珀", css: "#c96a1f" },
  { key: "rust", label: "赤陶", css: "#b85a48" },
  { key: "olive", label: "橄榄", css: "#6f7d3c" },
  { key: "ocean", label: "深青", css: "#2f7a83" },
  { key: "plum", label: "梅紫", css: "#8a5578" },
];
export type PaperTexture = "none" | "grain" | "ruled" | "dots" | "rice";
export type UiLanguage =
  | "zh"
  | "en"
  | "ja"
  | "ko"
  | "fr"
  | "de"
  | "es"
  | "pt"
  | "ru"
  | "ar";

export const LANGUAGES: { key: UiLanguage; label: string; dir: "ltr" | "rtl" }[] = [
  { key: "zh", label: "简体中文", dir: "ltr" },
  { key: "en", label: "English", dir: "ltr" },
  { key: "ja", label: "日本語", dir: "ltr" },
  { key: "ko", label: "한국어", dir: "ltr" },
  { key: "fr", label: "Français", dir: "ltr" },
  { key: "de", label: "Deutsch", dir: "ltr" },
  { key: "es", label: "Español", dir: "ltr" },
  { key: "pt", label: "Português", dir: "ltr" },
  { key: "ru", label: "Русский", dir: "ltr" },
  { key: "ar", label: "العربية", dir: "rtl" },
];

export const LORE_KINDS: { key: LoreKind; label: string; icon: string }[] = [
  { key: "character", label: "人物", icon: "user" },
  { key: "place", label: "地点", icon: "pin" },
  { key: "item", label: "物品", icon: "box" },
];
