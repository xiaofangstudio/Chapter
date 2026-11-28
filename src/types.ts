export interface NumberingRule {
  unit: "chapter" | "hui" | "volume";
  style: "arabic" | "chinese";
  pattern: string;
  startAt: number;
  perVolumeRestart: boolean;
  specialPrefix?: string;
}

export interface Footnote {
  id: string;
  text: string;
  createdAt: number;
}

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
  numbering?: NumberingRule;
  /** 小说简介，只用于介绍页，不参与正文统计。 */
  description?: string;
  /** 整书大纲：受限 Markdown，单独于章节大纲保存。 */
  bookOutline?: string;
  /** 前言 / 序言等前置副文本，Markdown 原文。 */
  frontMatter?: string;
  /** 后记 / 附录 / 番外说明等后置副文本，Markdown 原文。 */
  backMatter?: string;
  /** 自定义封面没有画面书脊，用这个颜色画书脊。 */
  spineColor?: string;
  /** custom = 用上传的封面；default = 用内置默认封面库。 */
  coverMode?: "custom" | "default";
  /** 默认封面模板 id，见 lib/coverLibrary.ts。 */
  coverStyle?: string;
  /** 书本类型；旧工程没有这个字段，一律按小说处理。 */
  kind?: "novel" | "comic";
  /** 漫画页规格，只有 kind=comic 时存在。 */
  comic?: {
    format: string;
    pageWidth: number;
    pageHeight: number;
    dpi: number;
    colorMode: string;
    readingDirection: string;
    defaultTemplate?: string;
  };
  /** 最小书组：同一世界观下的书共用这个 id。 */
  seriesId?: string;
}

export interface Scene {
  id: string;
  title: string;
  summary: string;
  timeText?: string;
  timeOrder?: number;
  place?: string;
  placeId?: string;
  characterIds?: string[];
  chapterId?: string;
  order?: number;
  color?: string;
}

export interface Chapter {
  id: string;
  title: string;
  summary: string;
  scenes: Scene[];
  words: number;
  updatedAt: number;
  /** 章内编辑器类型；旧章节没有这个字段，按所在书的 kind 决定。 */
  kind?: "novel" | "comic";
  footnotes?: Footnote[];
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

export type LoreKind = "character" | "place" | "item" | "org";

export type RelationKind = "kin" | "ally" | "rival" | "love" | "serve" | "other";

export const RELATION_KINDS: { key: RelationKind; label: string; color: string }[] = [
  { key: "kin", label: "亲属", color: "#8a6a4a" },
  { key: "ally", label: "盟友", color: "#4f8f6a" },
  { key: "rival", label: "敌对", color: "#b45245" },
  { key: "love", label: "恋爱", color: "#b06a8f" },
  { key: "serve", label: "从属", color: "#6b7fa3" },
  { key: "other", label: "其他", color: "#7a746b" },
];

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
  /** 关系图谱里的坐标（0–1 相对画布），拖拽后保存。 */
  gx?: number;
  gy?: number;
  /** 节点标记色。 */
  color?: string;
  /** 角色立绘，存为压缩后的 data URL；不设则只显示名字。 */
  portrait?: string;
  /** 主角皇冠。 */
  crown?: boolean;
}

export interface LoreRelation {
  id: string;
  from: string;
  to: string;
  label: string;
  kind?: RelationKind;
}

export interface WorldPin {
  id: string;
  entryId: string;
  x: number;
  y: number;
  label: string;
}

export interface Lore {
  entries: LoreEntry[];
  relations?: LoreRelation[];
  worldMap?: {
    image?: string;
    pins?: WorldPin[];
  };
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
  kind?: "novel" | "comic" | null;
  seriesId?: string | null;
  comicPages?: number;
  comicPanels?: number;
  comicBalloons?: number;
}

export interface SeriesMeta {
  id: string;
  name: string;
  description?: string;
  bookIds: string[];
  sharedCharacters?: { bookId: string; entryId: string }[];
  createdAt: number;
  updatedAt: number;
}

export interface SeriesCharacter {
  bookId: string;
  bookTitle: string;
  entryId: string;
  name: string;
  note: string;
  portrait: string | null;
  fields: { k: string; v: string }[];
  shared: boolean;
}

export interface ProofreadTerm {
  id: string;
  text: string;
  enabled: boolean;
  note: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProofreadPunctuation {
  enabled: boolean;
  rules: {
    halfWidth: boolean;
    quotes: boolean;
    ellipsis: boolean;
    duplicates: boolean;
  };
}

export interface ProofreadIgnored {
  termId: string;
  contextHash: string;
  span: [number, number];
}

export interface ProofreadConfig {
  version: number;
  enabled?: boolean;
  terms: ProofreadTerm[];
  punctuation: ProofreadPunctuation;
  ignored: ProofreadIgnored[];
}

export interface ProofreadIssue {
  id: string;
  kind: "term" | "punctuation";
  start: number;
  end: number;
  text: string;
  message: string;
  suggestions: string[];
  confidence: "high" | "normal";
  termId?: string;
  rule: string;
}

export interface RawProject {
  path: string;
  book: string;
  outline: string;
  lore: string;
  proofread?: string;
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
  proofread: ProofreadConfig;
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

export interface SyncFile {
  path: string;
  kind: string;
  size: number;
  mtime: number;
  hash: string;
}

export interface SyncManifest {
  version: number;
  bookId: string;
  title: string;
  author: string;
  updatedAt: number;
  chapterCount: number;
  totalBytes: number;
  files: SyncFile[];
}

export interface TransferDevice {
  name: string;
  platform: string;
  model: string;
  appVersion: string;
  lastSeenAt: number;
  manifest: SyncManifest | null;
}

export interface TransferItem {
  path: string;
  kind: string;
  state: "pcNewer" | "phoneNewer" | "pcOnly" | "phoneOnly" | "conflict";
  pcSize: number;
  phoneSize: number;
  pcMtime: number;
  phoneMtime: number;
}

export interface TransferComparison {
  pcFiles: number;
  phoneFiles: number;
  pcBytes: number;
  phoneBytes: number;
  same: number;
  pcOnly: number;
  phoneOnly: number;
  pcNewer: number;
  phoneNewer: number;
  conflicts: number;
  changedPcToPhone: number;
  changedPhoneToPc: number;
  changedBytesPcToPhone: number;
  changedBytesPhoneToPc: number;
  suggestedDirection: "pc_to_phone" | "phone_to_pc";
  confidence: string;
  items: TransferItem[];
}

export interface TransferProgress {
  bytesDone: number;
  totalBytes: number;
  percent: number;
  speed: number;
  currentFile: string;
  filesDone: number;
  filesTotal: number;
  startedAt: number;
}

export interface TransferBookBrief {
  path: string | null;
  id: string;
  title: string;
  author: string;
  chapters: number;
  bytes: number;
  updatedAt: number;
  empty: boolean;
}

export type TransferPhase =
  | "waiting"
  | "ready"
  | "preparing"
  | "transferring"
  | "applying"
  | "done"
  | "error"
  | "cancelled";

export interface TransferSnapshot {
  id: string;
  phase: TransferPhase;
  url: string;
  host: string;
  port: number;
  expiresAt: number;
  book: TransferBookBrief | null;
  device: TransferDevice | null;
  direction: "pc_to_phone" | "phone_to_pc";
  comparison: TransferComparison | null;
  progress: TransferProgress;
  canConfirm: boolean;
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
export type UiStyle = "wood" | "flat";
export const UI_STYLES: { key: UiStyle; label: string; note: string }[] = [
  { key: "wood", label: "金丝楠木", note: "暖纸、木色与金色丝线" },
  { key: "flat", label: "扁平化", note: "近白分层，颜色只作点缀" },
];
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
  | "zhTW"
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
  | "kk"
  | "bo"
  | "ug"
  | "mn"
  | "za"
  | "cat"
  | "luxun"
  | "wenyan"
  | "upside";

export interface LanguageOption {
  key: UiLanguage;
  label: string;
  english: string;
  country: string;
  countryZh: string;
  countryHant?: string;
  codes: string[];
  dir: LanguageDir;
}

export const LANGUAGES: LanguageOption[] = [
  { key: "zh", label: "简体中文", english: "Chinese", country: "China", countryZh: "中国", codes: ["CN", "CH", "PRC", "ZH"], dir: "ltr" },
  { key: "zhTW", label: "繁體中文", english: "Traditional Chinese", country: "Taiwan / Hong Kong / Macau", countryZh: "台湾 / 香港 / 澳门", codes: ["TW", "HK", "MO", "ZH", "HANT", "CHT", "繁体", "繁體", "繁中", "台灣", "台湾", "臺灣", "台", "港澳"], dir: "ltr" },
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
  { key: "bo", label: "བོད་ཡིག", english: "Tibetan", country: "China (Tibet / Qinghai / Sichuan / Gansu / Yunnan)", countryZh: "中国（西藏 / 青海 / 四川 / 甘肃 / 云南）", codes: ["BO", "TIB", "藏语", "藏文", "西藏"], dir: "ltr" },
  { key: "ug", label: "ئۇيغۇرچە", english: "Uyghur", country: "China (Xinjiang)", countryZh: "中国（新疆）", codes: ["UG", "Uighur", "维吾尔语", "维吾尔文", "新疆"], dir: "rtl" },
  { key: "mn", label: "ᠮᠣᠩᠭᠣᠯ ᠬᠡᠯᠡ", english: "Mongolian", country: "China (Inner Mongolia) / Mongolia", countryZh: "中国（内蒙古）/ 蒙古国", codes: ["MN", "Mongol", "蒙古语", "蒙古文", "内蒙古"], dir: "ltr" },
  { key: "za", label: "Vahcuengh", english: "Zhuang", country: "China (Guangxi)", countryZh: "中国（广西）", codes: ["ZA", "ZHUANG", "壮语", "壮文", "广西"], dir: "ltr" },
  { key: "cat", label: "萌猫语", english: "Cat Speak", country: "Cat Island", countryZh: "猫岛", codes: ["CAT", "MEOW", "LOLCAT", "萌猫", "猫语", "小猫"], dir: "ltr" },
  { key: "luxun", label: "鲁迅语", english: "Lu Xun", country: "China (Shaoxing)", countryZh: "中国（绍兴）", codes: ["LUXUN", "鲁迅", "绍兴", "周树人"], dir: "ltr" },
  { key: "wenyan", label: "文言文", english: "Classical Chinese", country: "China", countryZh: "中国", codes: ["WENYAN", "文言", "古文", "古汉语"], dir: "ltr" },
  { key: "upside", label: "Upsidedown", english: "Upside Down", country: "Inverted Realm", countryZh: "倒悬国", codes: ["UPSIDE", "UPSIDEDOWN", "倒置", "倒过来", "倒字"], dir: "ltr" },
];

const HANT_COUNTRY: Record<string, string> = {
  "中国": "中國",
  "台湾 / 香港 / 澳门": "臺灣 / 香港 / 澳門",
  "美国 / 英国": "美國 / 英國",
  "日本": "日本",
  "韩国": "韓國",
  "法国": "法國",
  "德国 / 奥地利": "德國 / 奧地利",
  "西班牙 / 墨西哥 / 阿根廷": "西班牙 / 墨西哥 / 阿根廷",
  "葡萄牙 / 巴西": "葡萄牙 / 巴西",
  "俄罗斯": "俄羅斯",
  "沙特阿拉伯 / 阿联酋 / 埃及": "沙烏地阿拉伯 / 阿聯酋 / 埃及",
  "意大利": "義大利",
  "荷兰 / 比利时": "荷蘭 / 比利時",
  "土耳其": "土耳其",
  "波兰": "波蘭",
  "乌克兰": "烏克蘭",
  "瑞典": "瑞典",
  "丹麦": "丹麥",
  "芬兰": "芬蘭",
  "捷克": "捷克",
  "希腊": "希臘",
  "以色列": "以色列",
  "印度": "印度",
  "越南": "越南",
  "印度尼西亚": "印度尼西亞",
  "泰国": "泰國",
  "伊朗": "伊朗",
  "罗马尼亚": "羅馬尼亞",
  "匈牙利": "匈牙利",
  "保加利亚": "保加利亞",
  "塞尔维亚": "塞爾維亞",
  "克罗地亚": "克羅埃西亞",
  "斯洛伐克": "斯洛伐克",
  "斯洛文尼亚": "斯洛維尼亞",
  "立陶宛": "立陶宛",
  "拉脱维亚": "拉脫維亞",
  "爱沙尼亚": "愛沙尼亞",
  "西班牙（加泰罗尼亚）": "西班牙（加泰羅尼亞）",
  "挪威": "挪威",
  "马来西亚": "馬來西亞",
  "菲律宾": "菲律賓",
  "孟加拉国": "孟加拉國",
  "巴基斯坦": "巴基斯坦",
  "印度（泰米尔）": "印度（泰米爾）",
  "印度（泰卢固）": "印度（泰盧固）",
  "印度（马拉地）": "印度（馬拉地）",
  "肯尼亚 / 坦桑尼亚": "肯亞 / 坦尚尼亞",
  "南非": "南非",
  "阿尔巴尼亚": "阿爾巴尼亞",
  "北马其顿": "北馬其頓",
  "亚美尼亚": "亞美尼亞",
  "阿塞拜疆": "亞塞拜然",
  "哈萨克斯坦": "哈薩克",
};

for (const item of LANGUAGES) {
  item.countryHant = HANT_COUNTRY[item.countryZh] ?? item.country;
}

export function countryLabel(item: LanguageOption, language: UiLanguage): string {
  if (language === "zhTW") return item.countryHant ?? item.country;
  return language === "zh" ? item.countryZh : item.country;
}

export const LORE_KINDS: { key: LoreKind; label: string; icon: string }[] = [
  { key: "character", label: "人物", icon: "user" },
  { key: "place", label: "地点", icon: "pin" },
  { key: "item", label: "物品", icon: "box" },
  { key: "org", label: "组织", icon: "users" },
];
