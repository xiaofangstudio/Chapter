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
  /** custom = 用上传的封面；default = 用内置默认封面库。 */
  coverMode?: "custom" | "default";
  /** 默认封面模板 id，见 lib/coverLibrary.ts。 */
  coverStyle?: string;
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
  coverMode?: "custom" | "default" | null;
  coverStyle?: string | null;
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
export type LanguageDir = "ltr" | "rtl";

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
  | "ar"
  | "it"
  | "nl"
  | "tr"
  | "pl"
  | "uk"
  | "sv"
  | "da"
  | "fi"
  | "cs"
  | "el"
  | "he"
  | "hi"
  | "vi"
  | "id"
  | "th"
  | "fa"
  | "ro"
  | "hu"
  | "bg"
  | "sr"
  | "hr"
  | "sk"
  | "sl"
  | "lt"
  | "lv"
  | "et"
  | "ca"
  | "nb"
  | "ms"
  | "fil"
  | "bn"
  | "ur"
  | "ta"
  | "te"
  | "mr"
  | "sw"
  | "af"
  | "sq"
  | "mk"
  | "hy"
  | "az"
  | "kk";

export interface LanguageOption {
  key: UiLanguage;
  label: string;
  english: string;
  country: string;
  countryZh: string;
  codes: string[];
  dir: LanguageDir;
}

export const LANGUAGES: LanguageOption[] = [
  { key: "zh", label: "简体中文", english: "Chinese", country: "China", countryZh: "中国", codes: ["CN", "CH", "PRC", "ZH"], dir: "ltr" },
  { key: "en", label: "English", english: "English", country: "United States / United Kingdom", countryZh: "美国 / 英国", codes: ["US", "UK", "GB", "EN"], dir: "ltr" },
  { key: "ja", label: "日本語", english: "Japanese", country: "Japan", countryZh: "日本", codes: ["JP", "JA"], dir: "ltr" },
  { key: "ko", label: "한국어", english: "Korean", country: "South Korea", countryZh: "韩国", codes: ["KR", "KO"], dir: "ltr" },
  { key: "fr", label: "Français", english: "French", country: "France", countryZh: "法国", codes: ["FR"], dir: "ltr" },
  { key: "de", label: "Deutsch", english: "German", country: "Germany / Austria", countryZh: "德国 / 奥地利", codes: ["DE", "AT"], dir: "ltr" },
  { key: "es", label: "Español", english: "Spanish", country: "Spain / Mexico / Argentina", countryZh: "西班牙 / 墨西哥 / 阿根廷", codes: ["ES", "MX", "AR"], dir: "ltr" },
  { key: "pt", label: "Português", english: "Portuguese", country: "Portugal / Brazil", countryZh: "葡萄牙 / 巴西", codes: ["PT", "BR"], dir: "ltr" },
  { key: "ru", label: "Русский", english: "Russian", country: "Russia", countryZh: "俄罗斯", codes: ["RU"], dir: "ltr" },
  { key: "ar", label: "العربية", english: "Arabic", country: "Saudi Arabia / UAE / Egypt", countryZh: "沙特阿拉伯 / 阿联酋 / 埃及", codes: ["SA", "AE", "EG"], dir: "rtl" },
  { key: "it", label: "Italiano", english: "Italian", country: "Italy", countryZh: "意大利", codes: ["IT"], dir: "ltr" },
  { key: "nl", label: "Nederlands", english: "Dutch", country: "Netherlands / Belgium", countryZh: "荷兰 / 比利时", codes: ["NL", "BE"], dir: "ltr" },
  { key: "tr", label: "Türkçe", english: "Turkish", country: "Türkiye", countryZh: "土耳其", codes: ["TR"], dir: "ltr" },
  { key: "pl", label: "Polski", english: "Polish", country: "Poland", countryZh: "波兰", codes: ["PL"], dir: "ltr" },
  { key: "uk", label: "Українська", english: "Ukrainian", country: "Ukraine", countryZh: "乌克兰", codes: ["UA"], dir: "ltr" },
  { key: "sv", label: "Svenska", english: "Swedish", country: "Sweden", countryZh: "瑞典", codes: ["SE"], dir: "ltr" },
  { key: "da", label: "Dansk", english: "Danish", country: "Denmark", countryZh: "丹麦", codes: ["DK"], dir: "ltr" },
  { key: "fi", label: "Suomi", english: "Finnish", country: "Finland", countryZh: "芬兰", codes: ["FI"], dir: "ltr" },
  { key: "cs", label: "Čeština", english: "Czech", country: "Czechia", countryZh: "捷克", codes: ["CZ"], dir: "ltr" },
  { key: "el", label: "Ελληνικά", english: "Greek", country: "Greece", countryZh: "希腊", codes: ["GR"], dir: "ltr" },
  { key: "he", label: "עברית", english: "Hebrew", country: "Israel", countryZh: "以色列", codes: ["IL"], dir: "rtl" },
  { key: "hi", label: "हिन्दी", english: "Hindi", country: "India", countryZh: "印度", codes: ["IN"], dir: "ltr" },
  { key: "vi", label: "Tiếng Việt", english: "Vietnamese", country: "Vietnam", countryZh: "越南", codes: ["VN"], dir: "ltr" },
  { key: "id", label: "Bahasa Indonesia", english: "Indonesian", country: "Indonesia", countryZh: "印度尼西亚", codes: ["ID"], dir: "ltr" },
  { key: "th", label: "ไทย", english: "Thai", country: "Thailand", countryZh: "泰国", codes: ["TH"], dir: "ltr" },
  { key: "fa", label: "فارسی", english: "Persian", country: "Iran", countryZh: "伊朗", codes: ["IR"], dir: "rtl" },
  { key: "ro", label: "Română", english: "Romanian", country: "Romania", countryZh: "罗马尼亚", codes: ["RO"], dir: "ltr" },
  { key: "hu", label: "Magyar", english: "Hungarian", country: "Hungary", countryZh: "匈牙利", codes: ["HU"], dir: "ltr" },
  { key: "bg", label: "Български", english: "Bulgarian", country: "Bulgaria", countryZh: "保加利亚", codes: ["BG"], dir: "ltr" },
  { key: "sr", label: "Српски", english: "Serbian", country: "Serbia", countryZh: "塞尔维亚", codes: ["RS"], dir: "ltr" },
  { key: "hr", label: "Hrvatski", english: "Croatian", country: "Croatia", countryZh: "克罗地亚", codes: ["HR"], dir: "ltr" },
  { key: "sk", label: "Slovenčina", english: "Slovak", country: "Slovakia", countryZh: "斯洛伐克", codes: ["SK"], dir: "ltr" },
  { key: "sl", label: "Slovenščina", english: "Slovenian", country: "Slovenia", countryZh: "斯洛文尼亚", codes: ["SI"], dir: "ltr" },
  { key: "lt", label: "Lietuvių", english: "Lithuanian", country: "Lithuania", countryZh: "立陶宛", codes: ["LT"], dir: "ltr" },
  { key: "lv", label: "Latviešu", english: "Latvian", country: "Latvia", countryZh: "拉脱维亚", codes: ["LV"], dir: "ltr" },
  { key: "et", label: "Eesti", english: "Estonian", country: "Estonia", countryZh: "爱沙尼亚", codes: ["EE"], dir: "ltr" },
  { key: "ca", label: "Català", english: "Catalan", country: "Spain (Catalonia)", countryZh: "西班牙（加泰罗尼亚）", codes: ["ES", "CA"], dir: "ltr" },
  { key: "nb", label: "Norsk bokmål", english: "Norwegian", country: "Norway", countryZh: "挪威", codes: ["NO"], dir: "ltr" },
  { key: "ms", label: "Bahasa Melayu", english: "Malay", country: "Malaysia", countryZh: "马来西亚", codes: ["MY"], dir: "ltr" },
  { key: "fil", label: "Filipino", english: "Filipino", country: "Philippines", countryZh: "菲律宾", codes: ["PH"], dir: "ltr" },
  { key: "bn", label: "বাংলা", english: "Bengali", country: "Bangladesh", countryZh: "孟加拉国", codes: ["BD"], dir: "ltr" },
  { key: "ur", label: "اردو", english: "Urdu", country: "Pakistan", countryZh: "巴基斯坦", codes: ["PK"], dir: "rtl" },
  { key: "ta", label: "தமிழ்", english: "Tamil", country: "India (Tamil)", countryZh: "印度（泰米尔）", codes: ["IN"], dir: "ltr" },
  { key: "te", label: "తెలుగు", english: "Telugu", country: "India (Telugu)", countryZh: "印度（泰卢固）", codes: ["IN"], dir: "ltr" },
  { key: "mr", label: "मराठी", english: "Marathi", country: "India (Marathi)", countryZh: "印度（马拉地）", codes: ["IN"], dir: "ltr" },
  { key: "sw", label: "Kiswahili", english: "Swahili", country: "Kenya / Tanzania", countryZh: "肯尼亚 / 坦桑尼亚", codes: ["KE", "TZ"], dir: "ltr" },
  { key: "af", label: "Afrikaans", english: "Afrikaans", country: "South Africa", countryZh: "南非", codes: ["ZA"], dir: "ltr" },
  { key: "sq", label: "Shqip", english: "Albanian", country: "Albania", countryZh: "阿尔巴尼亚", codes: ["AL"], dir: "ltr" },
  { key: "mk", label: "Македонски", english: "Macedonian", country: "North Macedonia", countryZh: "北马其顿", codes: ["MK"], dir: "ltr" },
  { key: "hy", label: "Հայերեն", english: "Armenian", country: "Armenia", countryZh: "亚美尼亚", codes: ["AM"], dir: "ltr" },
  { key: "az", label: "Azərbaycanca", english: "Azerbaijani", country: "Azerbaijan", countryZh: "阿塞拜疆", codes: ["AZ"], dir: "ltr" },
  { key: "kk", label: "Қазақша", english: "Kazakh", country: "Kazakhstan", countryZh: "哈萨克斯坦", codes: ["KZ"], dir: "ltr" },
];

export const LORE_KINDS: { key: LoreKind; label: string; icon: string }[] = [
  { key: "character", label: "人物", icon: "user" },
  { key: "place", label: "地点", icon: "pin" },
  { key: "item", label: "物品", icon: "box" },
];
