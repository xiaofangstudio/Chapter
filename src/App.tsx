import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir, openUrl } from "@tauri-apps/plugin-opener";
import { shareFile } from "@choochmeque/tauri-plugin-sharekit-api";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import type {
  AccentTheme,
  BookMeta,
  BookSummary,
  Chapter,
  Footnote,
  HomeMode,
  ImportDoc,
  LightEffect,
  Lore,
  LoreEntry,
  LoreKind,
  MotionMode,
  NumberingRule,
  Outline,
  PaperTexture,
  Project,
  ProofreadConfig,
  RawProject,
  SaveState,
  Scene,
  SeriesMeta,
  SnapshotInfo,
  ThemeMode,
  UiLanguage,
  UiStyle,
  ViewKind,
  Volume,
} from "./types";

type BoundaryState = { error: Error | null };

class EditorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };
  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="editor-load-error">
          <div className="ele-card">
            <h3>这本书暂时打不开</h3>
            <p>排版或编辑数据可能损坏。你的原稿仍在书库中，不会丢失。</p>
            <button type="button" className="btn-primary" onClick={() => this.setState({ error: null })}>重试</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
import { LANGUAGES } from "./types";
import { api, errText } from "./lib/api";
performance.mark?.("chapter:app-module");
import { countWords, dateKey } from "./lib/text";
import { normalizeProofread } from "./lib/proofread";
import { formatChapterTitle, normalizeNumbering } from "./lib/numbering";
import { ensureUiPack, setUiLanguage, t, tf } from "./lib/i18n";
import { useProximityGlow } from "./lib/glow";
import { readVoiceMarks } from "./lib/voice";
import { Splash } from "./components/Splash";
import { AmbientBackdrop, type AmbienceScene } from "./components/AmbientBackdrop";
import { Welcome } from "./components/Welcome";
import { WorkspaceHome } from "./components/WorkspaceHome";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";

declare global {
  interface Window {
    __chapterBack?: () => boolean;
    __chapterBackExtra?: () => boolean;
  }
}
import type { EditorHandle } from "./components/Editor";
import { InfoPanel } from "./components/InfoPanel";
import {
  BookMetaDialog,
  ConfirmDialog,
  ExportDialog,
  LoreEditorDialog,
  LorePickerDialog,
  MatterDialog,
  NewBookDialog,
  PromptDialog,
  SnapshotDialog,
  SceneEditorDialog,
} from "./components/Modals";
import { CoverCropDialog } from "./components/CoverCropDialog";
import { CoverDesignerDialog } from "./components/CoverDesignerDialog";
import { CoverPickerDialog } from "./components/CoverPickerDialog";
import { TransferDialog } from "./components/TransferDialog";
import { QrScanner } from "./components/QrScanner";
import { applyAppData } from "./lib/appdata";

const PrintStudio = lazy(() =>
  import("./components/PrintStudio").then((m) => ({ default: m.PrintStudio })),
);

// 首屏只加载书架/工作台；写作视图、介绍页、大纲、设置、导入在真正打开时才取。
const BookIntroPage = lazy(() =>
  import("./components/BookIntroPage").then((m) => ({ default: m.BookIntroPage })),
);
const Editor = lazy(() => import("./components/Editor").then((m) => ({ default: m.Editor })));
const OutlineBoard = lazy(() =>
  import("./components/OutlineBoard").then((m) => ({ default: m.OutlineBoard })),
);
const BookOutline = lazy(() =>
  import("./components/BookOutline").then((m) => ({ default: m.BookOutline })),
);
const LoreView = lazy(() => import("./components/LoreView").then((m) => ({ default: m.LoreView })));
const ComicWorkspace = lazy(() =>
  import("./components/ComicWorkspace").then((m) => ({ default: m.ComicWorkspace })),
);
const ImportDialog = lazy(() =>
  import("./components/ImportDialog").then((m) => ({ default: m.ImportDialog })),
);
const SettingsDialog = lazy(() =>
  import("./components/SettingsDialog").then((m) => ({ default: m.SettingsDialog })),
);

/* ───────── 数据整理 ───────── */

function safeParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function normalizeOutline(raw: unknown): Outline {
  const src = (raw as { volumes?: unknown[] })?.volumes;
  const volumes = Array.isArray(src) ? src : [];
  return {
    volumes: volumes.map((v, vi) => {
      const vol = v as Record<string, unknown>;
      const chapters = Array.isArray(vol.chapters) ? vol.chapters : [];
      return {
        id: (vol.id as string) || `v_${Date.now()}_${vi}`,
        title: (vol.title as string) || `第${vi + 1}卷`,
        collapsed: !!vol.collapsed,
        chapters: chapters.map((c, ci) => {
          const ch = c as Record<string, unknown>;
          const scenes = Array.isArray(ch.scenes) ? ch.scenes : [];
          return {
            id: (ch.id as string) || `c_${Date.now()}_${vi}_${ci}`,
            title: (ch.title as string) || `第${ci + 1}章`,
            summary: (ch.summary as string) || "",
            words: Number(ch.words) || 0,
            updatedAt: Number(ch.updatedAt) || 0,
            scenes: scenes.map((s, si) => {
              const sc = s as Record<string, unknown>;
              return {
                id: (sc.id as string) || `s_${Date.now()}_${vi}_${ci}_${si}`,
                title: (sc.title as string) || "",
                summary: (sc.summary as string) || "",
                timeText: typeof sc.timeText === "string" ? sc.timeText : undefined,
                timeOrder: typeof sc.timeOrder === "number" ? sc.timeOrder : undefined,
                place: typeof sc.place === "string" ? sc.place : undefined,
                placeId: typeof sc.placeId === "string" ? sc.placeId : undefined,
                characterIds: Array.isArray(sc.characterIds)
                  ? sc.characterIds.filter((x): x is string => typeof x === "string")
                  : undefined,
                chapterId: typeof sc.chapterId === "string" ? sc.chapterId : undefined,
                order: typeof sc.order === "number" ? sc.order : undefined,
                color: typeof sc.color === "string" ? sc.color : undefined,
              };
            }),
            footnotes: Array.isArray(ch.footnotes)
              ? ch.footnotes
                  .filter((f) => !!f && typeof f === "object")
                  .map((f, fi) => {
                    const fn = f as Record<string, unknown>;
                    return {
                      id: (fn.id as string) || `fn_${Date.now()}_${fi}`,
                      text: (fn.text as string) || "",
                      createdAt: Number(fn.createdAt) || 0,
                    };
                  })
              : undefined,
          };
        }),
      };
    }),
  };
}

function normalizeLore(raw: unknown): Lore {
  const arr = (raw as { entries?: unknown[] })?.entries;
  const entries = Array.isArray(arr) ? arr : [];
  return {
    entries: entries.map((e, i) => {
      const en = e as Record<string, unknown>;
      const fields = Array.isArray(en.fields) ? en.fields : [];
      return {
        id: (en.id as string) || `e_${Date.now()}_${i}`,
        kind: ((en.kind as LoreKind) || "character") as LoreKind,
        name: (en.name as string) || "",
        note: (en.note as string) || "",
        fields: fields.map((f) => ({
          k: ((f as Record<string, unknown>).k as string) || "",
          v: ((f as Record<string, unknown>).v as string) || "",
        })),
      };
    }),
  };
}

function parseProject(raw: RawProject): Project {
  const meta: BookMeta = {
    id: "b_0",
    title: "未命名",
    author: "",
    cover: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    targetWords: 200000,
    dailyGoal: 2000,
    lastChapterId: null,
    daily: null,
    wordCount: 0,
    description: "",
    bookOutline: "",
    numbering: undefined,
    ...safeParse(raw.book, {}),
  };
  if (!meta.numbering) {
    meta.numbering = meta.kind === "comic"
      ? { unit: "hui", style: "arabic", pattern: "第{n}话", startAt: 1, perVolumeRestart: false }
      : { unit: "chapter", style: "arabic", pattern: "第{n}章", startAt: 1, perVolumeRestart: false };
  }
  // 旧工程只存了 cover 文件、没存 coverMode；有封面文件就是自定义封面。
  // 不补这一步，封面选择器会误以为在用默认封面，先给一排无意义的书脊色。
  if (meta.cover && !meta.coverMode) meta.coverMode = "custom";
  const outline = normalizeOutline(safeParse(raw.outline, { volumes: [] }));
  const lore = normalizeLore(safeParse(raw.lore, { entries: [] }));
  const proofread = normalizeProofread(safeParse(raw.proofread ?? "{}", {}));
  const bodies: Record<string, string> = {};
  raw.chapters.forEach((c) => {
    bodies[c.id] = c.body ?? "";
  });
  outline.volumes.forEach((v) =>
    v.chapters.forEach((c) => {
      if (bodies[c.id] === undefined) bodies[c.id] = "";
    }),
  );
  return { path: raw.path, meta, outline, lore, proofread, bodies };
}

function allChapters(outline: Outline): Chapter[] {
  return outline.volumes.flatMap((v) => v.chapters);
}

function findChapter(outline: Outline, id: string | null): Chapter | null {
  if (!id) return null;
  return allChapters(outline).find((c) => c.id === id) ?? null;
}

function firstChapterId(outline: Outline): string | null {
  return allChapters(outline)[0]?.id ?? null;
}

function totalWords(
  outline: Outline,
  bodies: Record<string, string>,
  overrideId?: string | null,
  overrideBody?: string,
): number {
  let n = 0;
  allChapters(outline).forEach((c) => {
    const text =
      overrideId === c.id && overrideBody !== undefined ? overrideBody : bodies[c.id] ?? "";
    n += countWords(text);
  });
  return n;
}

function readLS(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/* ───────── 应用 ───────── */

type UndoFile = {
  id: string;
  title: string;
  body?: string;
  /** 删章撤销：优先从 .md.deleted 原文件恢复，失败再补写。 */
  preferDisk?: boolean;
  /** 重命名撤销：用当前正文，只把标题改回去，避免覆盖之后写下的内容。 */
  preserveBody?: boolean;
};

type UndoEntry = {
  label: string;
  outline: Outline;
  activeId: string | null;
  files?: UndoFile[];
};

const IS_ANDROID_APP =
  typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

export default function App() {
  useProximityGlow();
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [series, setSeries] = useState<SeriesMeta[]>([]);
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [library, setLibrary] = useState("");
  const [booting, setBooting] = useState(true);
  const [splashLeaving, setSplashLeaving] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [view, setView] = useState<ViewKind>("write");
  const [comicExportSignal, setComicExportSignal] = useState(0);
  const [loreMode, setLoreMode] = useState<"cards" | "graph" | "map">("cards");
  const [focus, setFocus] = useState(false);
  const [panel, setPanel] = useState(() =>
    typeof window === "undefined" ? true : !window.matchMedia("(max-width: 820px)").matches
  );
  const [mobileNav, setMobileNav] = useState(false);

  useEffect(() => {
    if (view === "write" && project?.meta.kind === "comic") setPanel(false);
    if (window.matchMedia("(max-width: 820px)").matches) setPanel(false);
    setMobileNav(false);
  }, [view, project?.meta.kind, project?.path]);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [themeMode, setThemeMode] = useState<ThemeMode>(
    readLS("chapter.theme", "system") as ThemeMode,
  );
  const [accent, setAccent] = useState<AccentTheme>(
    readLS("chapter.accent", "amber") as AccentTheme,
  );
  const [uiStyle, setUiStyle] = useState<UiStyle>(() =>
    readLS("chapter.ui", "wood") === "flat" ? "flat" : "wood",
  );
  const [motion, setMotion] = useState<MotionMode>(
    readLS("chapter.motion", "full") as MotionMode,
  );
  const [lightEffect, setLightEffect] = useState<LightEffect>(
    readLS("chapter.lightEffect", "still") as LightEffect,
  );
  const [homeMode, setHomeMode] = useState<HomeMode>(
    readLS("chapter.home", "minimal") as HomeMode,
  );
  const [language, setLanguage] = useState<UiLanguage>(
    readLS("chapter.lang", "zh") as UiLanguage,
  );
  const [paper, setPaper] = useState<PaperTexture>(
    readLS("chapter.paper", "none") as PaperTexture,
  );
  const [bgPath, setBgPath] = useState(readLS("chapter.bg", ""));
  const [bgData, setBgData] = useState("");
  const [mcpEnabled, setMcpEnabled] = useState(readLS("chapter.mcp", "off") === "on");
  const [voicePad, setVoicePadState] = useState(readLS("chapter.voicePad", "on") !== "off");
  const [voiceMarks, setVoiceMarksState] = useState(() => readVoiceMarks(readLS("chapter.voiceMarks", "")));
  const [dailyLog, setDailyLog] = useState<Record<string, number>>(() => {
    try {
      const parsed = JSON.parse(readLS("chapter.daily", "{}")) as Record<string, number>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  });

  // 互传导入的全站数据已经写进 localStorage，这里再把界面状态同步过来，
  // 打卡日历、主题、语言不用重启就能看到。
  useEffect(() => {
    const onAppData = (event: Event) => {
      const entries = (event as CustomEvent<Record<string, string>>).detail;
      if (!entries) return;
      const daily = entries["chapter.daily"];
      if (daily) {
        try {
          const parsed = JSON.parse(daily) as Record<string, number>;
          if (parsed && typeof parsed === "object") setDailyLog(parsed);
        } catch {
          /* 数据坏了就保留原样 */
        }
      }
      const theme = entries["chapter.theme"];
      if (theme === "light" || theme === "dark" || theme === "system") setThemeMode(theme);
      const ui = entries["chapter.ui"];
      if (ui === "wood" || ui === "flat") setUiStyle(ui);
      const lang = entries["chapter.lang"];
      if (lang) setLanguage(lang as UiLanguage);
    };
    window.addEventListener("chapter:appdata", onAppData);
    return () => window.removeEventListener("chapter:appdata", onAppData);
  }, []);
  const [importState, setImportState] = useState<{
    doc: ImportDoc;
    mode: "new" | "append";
  } | null>(null);
  const [intro, setIntro] = useState(true);
  const [metaDialog, setMetaDialog] = useState(false);
  const [systemDark, setSystemDark] = useState(
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : false,
  );
  const [modal, setModal] = useState<null | "new" | "export" | "snapshots" | "shelfSettings">(
    null,
  );
  const modalCloseTimer = useRef<number | undefined>(undefined);
  const modalHistory = useRef(false);
  const projectHistory = useRef(false);
  const suppressBack = useRef(false);
  const closeBookForBack = useRef<() => void>(() => undefined);

  // 手机键盘弹出时，dvh 不会跟着缩；用可视视口高度当真实页面高度。
  useEffect(() => {
    const vv = window.visualViewport;
    const sync = () => {
      const h = vv?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--app-h", `${Math.round(h)}px`);
      const kb = Math.max(0, window.innerHeight - h - (vv?.offsetTop ?? 0));
      document.documentElement.style.setProperty("--kb-inset", `${Math.round(kb)}px`);
    };
    sync();
    vv?.addEventListener("resize", sync);
    vv?.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    return () => {
      vv?.removeEventListener("resize", sync);
      vv?.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
    };
  }, []);
  const [matterDialog, setMatterDialog] = useState(false);
  const [printStudio, setPrintStudio] = useState<null | "pdf" | "word">(null);
  const [settingsSection, setSettingsSection] = useState<
    "appearance" | "writing" | "ai" | "git" | "about"
  >("appearance");
  const [, setI18nRevision] = useState(0);
  const [prompt, setPrompt] = useState<{
    title: string;
    subtitle?: string;
    label: string;
    value: string;
    placeholder?: string;
    confirmText?: string;
    multiline?: boolean;
    onOk: (v: string) => void;
  } | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    message: string;
    confirmText?: string;
    danger?: boolean;
    onOk: () => void;
    onCancel?: () => void;
  } | null>(null);
  const [loreEdit, setLoreEdit] = useState<{ entry: LoreEntry | null; kind: LoreKind } | null>(
    null,
  );
  const [lorePicker, setLorePicker] = useState(false);
  const [sceneEdit, setSceneEdit] = useState<{ chapterId: string; sceneId: string | null } | null>(
    null,
  );
  const [coverDraft, setCoverDraft] = useState<{
    path: string;
    src: string;
    name: string;
  } | null>(null);
  const [coverPickerOpen, setCoverPickerOpen] = useState(false);
  const [coverDesignerOpen, setCoverDesignerOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferBookPath, setTransferBookPath] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  useEffect(() => {
    try {
      if (sessionStorage.getItem("chapter.scan.pending") === "1") setScanOpen(true);
    } catch {
      /* ignore */
    }
  }, []);

  const [toasts, setToasts] = useState<
    { id: number; text: string; warn?: boolean; leaving?: boolean; action?: { label: string; run: () => void } }[]
  >([]);

  const toastSeq = useRef(0);
  const projectRef = useRef<Project | null>(null);
  const packageInputRef = useRef<HTMLInputElement | null>(null);
  const androidImportRef = useRef<HTMLInputElement | null>(null);
  const androidImportMode = useRef<"new" | "append">("new");
  const androidCoverRef = useRef<HTMLInputElement | null>(null);
  const activeRef = useRef<string | null>(null);
  const editorRef = useRef<EditorHandle | null>(null);
  const lastSaved = useRef<Record<string, string>>({});
  const outlineTimer = useRef<number | undefined>(undefined);
  const bookOutlineTimer = useRef<number | undefined>(undefined);
  const savedTimer = useRef<number | undefined>(undefined);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const saveStateRef = useRef<SaveState>("idle");
  const undoRef = useRef<UndoEntry[]>([]);
  const undoingRef = useRef(false);

  projectRef.current = project;
  activeRef.current = activeId;
  saveStateRef.current = saveState;

  const toast = useCallback(
    (text: string, opts?: { warn?: boolean; action?: { label: string; run: () => void } }) => {
      const id = ++toastSeq.current;
      setToasts((t) => [...t, { id, text, warn: opts?.warn, action: opts?.action }]);
      window.setTimeout(
        () => {
          setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
          window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 180);
        },
        opts?.action ? 6000 : 2800,
      );
    },
    [],
  );

  const closeModal = useCallback(() => {
    if (document.documentElement.dataset.modalClosing === "1") return;
    const calm =
      document.documentElement.dataset.motion === "off" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (calm) {
      setModal(null);
      return;
    }
    document.documentElement.dataset.modalClosing = "1";
    window.clearTimeout(modalCloseTimer.current);
    modalCloseTimer.current = window.setTimeout(() => {
      document.documentElement.removeAttribute("data-modal-closing");
      setModal(null);
    }, 160);
  }, []);

  useEffect(
    () => () => {
      window.clearTimeout(modalCloseTimer.current);
      document.documentElement.removeAttribute("data-modal-closing");
    },
    [],
  );

  // 手机上把弹层和书写页都当成真实页面：系统返回先关弹层，再退回书架。
  useEffect(() => {
    const onPop = () => {
      if (suppressBack.current) {
        suppressBack.current = false;
        return;
      }
      // 有些页面自己管弹层（封面选择、书籍设置等），没进全局 modal 历史。
      // 返回时先把被弹掉的作品状态 forward 回来，再点关闭，避免一滑直接退回书架。
      if (!modalHistory.current) {
        const localModal = document.querySelector<HTMLElement>(".backdrop .modal");
        if (localModal) {
          suppressBack.current = true;
          window.history.forward();
          window.setTimeout(() => {
            localModal.querySelector<HTMLElement>(".modal-head .icon-btn")?.click();
          }, 0);
          return;
        }
      }
      if (modalHistory.current) {
        modalHistory.current = false;
        document.documentElement.removeAttribute("data-modal-closing");
        setModal(null);
        return;
      }
      if (projectRef.current) {
        projectHistory.current = false;
        void closeBookForBack.current();
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (modal && !modalHistory.current) {
      modalHistory.current = true;
      window.history.pushState({ chapterModal: true }, "");
      return;
    }
    if (!modal && modalHistory.current) {
      const pushed = window.history.state?.chapterModal === true;
      modalHistory.current = false;
      if (pushed) {
        suppressBack.current = true;
        window.history.back();
      }
    }
  }, [modal]);

  useEffect(() => {
    if (project) {
      if (!projectHistory.current) {
        projectHistory.current = true;
        window.history.pushState({ chapterBook: true }, "");
      }
      return;
    }
    if (projectHistory.current) {
      const pushed = window.history.state?.chapterBook === true;
      projectHistory.current = false;
      if (pushed) {
        suppressBack.current = true;
        window.history.back();
      }
    }
  }, [project]);

  const closeMatter = useCallback(() => {
    if (document.documentElement.dataset.modalClosing === "1") return;
    const calm =
      document.documentElement.dataset.motion === "off" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (calm) {
      setMatterDialog(false);
      return;
    }
    document.documentElement.dataset.modalClosing = "1";
    window.clearTimeout(modalCloseTimer.current);
    modalCloseTimer.current = window.setTimeout(() => {
      document.documentElement.removeAttribute("data-modal-closing");
      setMatterDialog(false);
    }, 160);
  }, []);

  const openSettings = useCallback(
    (section: "appearance" | "writing" | "ai" | "git" | "about" = "appearance") => {
      setSettingsSection(section);
      setModal("shelfSettings");
    },
    [],
  );

  const setVoicePad = useCallback((on: boolean) => {
    setVoicePadState(on);
    try {
      localStorage.setItem("chapter.voicePad", on ? "on" : "off");
    } catch {
      /* 本地存储不可用时只影响本次会话 */
    }
  }, []);

  const setVoiceMarks = useCallback((marks: string[]) => {
    setVoiceMarksState(marks);
    try {
      localStorage.setItem("chapter.voiceMarks", JSON.stringify(marks));
    } catch {
      /* 同上 */
    }
  }, []);

  const commit = useCallback((next: Project) => {
    projectRef.current = next;
    setProject(next);
  }, []);

  const theme = themeMode === "system" ? (systemDark ? "dark" : "light") : themeMode;

  /* ───────── 偏好与主题 ───────── */

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("chapter.theme", themeMode);
    } catch {
      /* ignore */
    }
  }, [theme, themeMode]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const win = getCurrentWindow();
    let busy = false;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F11") return;
      e.preventDefault();
      if (busy) return;
      busy = true;
      void win
        .isFullscreen()
        .then((on) => win.setFullscreen(!on))
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleTheme = useCallback(() => {    const next = theme === "light" ? "dark" : "light";
    const reduced =
      document.documentElement.dataset.motion === "off" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => { ready: Promise<void> };
    };
    if (reduced || !doc.startViewTransition) {
      setThemeMode(next);
      return;
    }
    const transition = doc.startViewTransition(() => {
      flushSync(() => setThemeMode(next));
      document.documentElement.dataset.theme = next;
    });
    void transition.ready.then(() => {
      const radius = Math.hypot(window.innerWidth, window.innerHeight);
      document.documentElement.animate(
        {
          clipPath: [
            "circle(0px at 88% 8%)",
            `circle(${radius.toFixed(0)}px at 88% 8%)`,
          ],
        },
        {
          duration: 560,
          easing: "cubic-bezier(0.22, 0.8, 0.24, 1)",
          pseudoElement: "::view-transition-new(root)",
        },
      );
    });
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.accent = accent;
    try {
      localStorage.setItem("chapter.accent", accent);
    } catch {
      /* ignore */
    }
  }, [accent]);

  useEffect(() => {
    document.documentElement.dataset.ui = uiStyle;
    try {
      localStorage.setItem("chapter.ui", uiStyle);
    } catch {
      /* ignore */
    }
  }, [uiStyle]);

  useEffect(() => {
    document.documentElement.dataset.motion = motion;
    try {
      localStorage.setItem("chapter.motion", motion);
    } catch {
      /* ignore */
    }
  }, [motion]);

  useEffect(() => {
    document.documentElement.dataset.lightEffect = lightEffect;
    try {
      localStorage.setItem("chapter.lightEffect", lightEffect);
    } catch {
      /* ignore */
    }
  }, [lightEffect]);

  useEffect(() => {
    document.documentElement.dataset.paper = paper;
    document.documentElement.dataset.home = homeMode;
    try {
      localStorage.setItem("chapter.paper", paper);
      localStorage.setItem("chapter.home", homeMode);
    } catch {
      /* ignore */
    }
  }, [paper, homeMode]);

  useEffect(() => {
    const meta = LANGUAGES.find((l) => l.key === language) ?? LANGUAGES[0];
    document.documentElement.lang =
      language === "zh" ? "zh-CN" : language === "zhTW" ? "zh-Hant" : language;
    document.documentElement.dir = meta.dir;
    try {
      localStorage.setItem("chapter.lang", language);
    } catch {
      /* ignore */
    }
  }, [language]);

  useEffect(() => {
    if (!bgPath) {
      setBgData("");
      return;
    }
    let alive = true;
    api
      .imageData(bgPath)
      .then((d) => alive && setBgData(d))
      .catch(() => {
        if (!alive) return;
        setBgData("");
        setBgPath("");
        try {
          localStorage.removeItem("chapter.bg");
        } catch {
          /* ignore */
        }
      });
    return () => {
      alive = false;
    };
  }, [bgPath]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--app-bg-image",
      bgData ? `url("${bgData}")` : "none",
    );
    document.documentElement.dataset.bg = bgData ? "image" : "none";
  }, [bgData]);

  useEffect(() => {
    try {
      localStorage.setItem("chapter.daily", JSON.stringify(dailyLog));
    } catch {
      /* ignore */
    }
  }, [dailyLog]);

  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const fn = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("chapter.mcp", mcpEnabled ? "on" : "off");
    } catch {
      /* ignore */
    }
    api.mcpSetEnabled(mcpEnabled, 18765).catch(() => {
      /* 端口冲突或系统策略禁止时，设置页会显示错误 */
    });
  }, [mcpEnabled]);

  useEffect(() => {
    void api.mcpSetProject(project?.path ?? null).catch(() => undefined);
  }, [project?.path]);

  /* ───────── 启动 ───────── */

  const loadCovers = useCallback(async (list: BookSummary[]) => {
    const urls: Record<string, string> = {};
    await Promise.all(
      list
        .filter((b) => b.cover)
        .map(async (b) => {
          try {
            const d = await api.coverData(b.path, b.cover!);
            if (d) urls[b.path] = d;
          } catch {
            /* 封面坏了不影响书架 */
          }
        }),
    );
    setCovers((prev) => ({ ...prev, ...urls }));
  }, []);

  const refreshBooks = useCallback(async () => {
    try {
      const list = await api.listBooks();
      setBooks(list);
      setSeries(await api.listSeries());
      await loadCovers(list);
    } catch (e) {
      toast(`读取书架失败：${errText(e)}`, { warn: true });
    }
  }, [loadCovers, toast]);

  const createSeries = useCallback(
    async (name: string, description?: string) => {
      const created = await api.createSeries(name, description);
      await refreshBooks();
      return created;
    },
    [refreshBooks],
  );

  const updateSeries = useCallback(
    async (id: string, name: string, description?: string) => {
      const updated = await api.updateSeries(id, name, description);
      await refreshBooks();
      return updated;
    },
    [refreshBooks],
  );

  const deleteSeries = useCallback(
    async (id: string) => {
      await api.deleteSeries(id);
      await refreshBooks();
    },
    [refreshBooks],
  );

  const assignBookSeries = useCallback(
    async (book: BookSummary, seriesId: string | null) => {
      await api.assignBookSeries(book.path, seriesId);
      await refreshBooks();
    },
    [refreshBooks],
  );

  const seriesCharacters = useCallback(async (seriesId: string) => {
    return api.seriesCharacters(seriesId);
  }, []);

  const setSeriesShared = useCallback(
    async (seriesId: string, bookId: string, entryId: string, shared: boolean) => {
      await api.setSeriesShared(seriesId, bookId, entryId, shared);
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    performance.mark?.("chapter:boot-start");
    (async () => {
      try {
        const lib = await api.library();
        if (alive) setLibrary(lib);
        const list = await api.listBooks();
        const groups = await api.listSeries();
        performance.mark?.("chapter:boot-data");
        if (alive) {
          setBooks(list);
          setSeries(groups);
          // 封面是装饰数据，不该挡住启动进入；先让界面可用，封面在后台补齐。
          void loadCovers(list);
        }
      } catch (e) {
        toast(`初始化失败：${errText(e)}`, { warn: true });
      } finally {
        window.setTimeout(() => {
          if (!alive) return;
          setSplashLeaving(true);
          performance.mark?.("chapter:splash-leaving");
          window.setTimeout(() => {
            if (!alive) return;
            setBooting(false);
            performance.mark?.("chapter:splash-gone");
          }, 320);
        }, 180);
      }
    })();
    return () => {
      alive = false;
    };
  }, [loadCovers, toast]);

  /* ───────── 保存 ───────── */

  const persistJson = useCallback(
    async (file: string, data: unknown) => {
      const p = projectRef.current;
      if (!p) return;
      try {
        await api.saveJson(p.path, file, JSON.stringify(data));
      } catch (e) {
        toast(`保存失败：${errText(e)}`, { warn: true });
      }
    },
    [toast],
  );

  const scheduleOutline = useCallback(
    (outline: Outline) => {
      window.clearTimeout(outlineTimer.current);
      outlineTimer.current = window.setTimeout(() => {
        persistJson("outline.json", outline);
      }, 420);
    },
    [persistJson],
  );

  const doSave = useCallback(
    async (force = false) => {
      const p = projectRef.current;
      if (!p) return;
      const cid = activeRef.current;
      if (!cid) return;
      const chapter = findChapter(p.outline, cid);
      if (!chapter) return;

      const flushed = editorRef.current?.flush();
      const body = flushed !== undefined ? flushed : p.bodies[cid] ?? "";
      const newWords = editorRef.current?.wordCount() ?? countWords(body);
      // 只按大纲里已有的章字数替换当前章，不再每次保存都重扫整本书 50 万字。
      const total = allChapters(p.outline).reduce(
        (n, c) => n + (c.id === cid ? newWords : c.words ?? 0),
        0,
      );
      const today = dateKey();
      const delta = newWords - chapter.words;
      let daily = p.meta.daily;
      if (!daily || daily.date !== today) {
        daily = { date: today, base: Math.max(0, total - delta) };
      }

      const outline: Outline = {
        ...p.outline,
        volumes: p.outline.volumes.map((v) => ({
          ...v,
          chapters: v.chapters.map((c) =>
            c.id === cid ? { ...c, words: newWords, updatedAt: Date.now() } : c,
          ),
        })),
      };
      const meta: BookMeta = {
        ...p.meta,
        wordCount: total,
        updatedAt: Date.now(),
        lastChapterId: cid,
        daily,
      };
      const next: Project = { ...p, outline, meta, bodies: { ...p.bodies, [cid]: body } };

      const dirty = lastSaved.current[cid] !== body;
      if (!dirty && !force && newWords === chapter.words) return;

      setSaveState("saving");
      try {
        if (dirty) {
          await api.saveChapter(p.path, cid, chapter.title, body);
          lastSaved.current[cid] = body;
        }
        commit(next);
        await Promise.all([
          api.saveJson(p.path, "outline.json", JSON.stringify(outline)),
          api.saveJson(p.path, "book.json", JSON.stringify(meta)),
        ]);
        const gained = Math.max(0, total - daily.base);
        setDailyLog((prev) => ({ ...prev, [today]: Math.max(prev[today] ?? 0, gained) }));
        setSaveState("saved");
        window.clearTimeout(savedTimer.current);
        savedTimer.current = window.setTimeout(() => setSaveState("idle"), 2400);
      } catch (e) {
        setSaveState("idle");
        toast(`保存失败：${errText(e)}`, { warn: true });
      }
    },
    [commit, toast],
  );

  /** 保存串行化：失焦、定时、切章、导出同时触发时不会互相踩到。 */
  const saveAll = useCallback(
    (force = false) => {
      const next = saveQueue.current.then(() => doSave(force));
      saveQueue.current = next.catch(() => undefined);
      return next;
    },
    [doSave],
  );

  const projectPath = project?.path ?? null;

  useEffect(() => {
    if (!projectPath) return;
    const t = window.setInterval(() => {
      saveAll(false);
    }, 30000);
    return () => window.clearInterval(t);
  }, [projectPath, saveAll]);

  useEffect(() => {
    const onBlur = () => {
      if (projectRef.current) saveAll(true);
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [saveAll]);

  // 关闭窗口前把最后一屏字落盘，避免「点 X 丢一段」。
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unlisten: (() => void) | undefined;
    let closing = false;
    const win = getCurrentWindow();
    win
      .onCloseRequested(async (event) => {
        if (closing) return;
        event.preventDefault();
        closing = true;
        try {
          await saveAll(true);
        } catch {
          // 保存失败也不把窗口卡住，下面的兜底会关掉它。
        }
        try {
          await win.close();
        } catch {
          await win.destroy();
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, [saveAll]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveAll(true);
      }
      if (e.key === "Escape") {
        setFocus(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [saveAll]);

  /* ───────── 打开 / 关闭书 ───────── */

  const loadSnapshots = useCallback(async (path: string) => {
    try {
      setSnapshots(await api.listSnapshots(path));
    } catch {
      setSnapshots([]);
    }
  }, []);

  const openProject = useCallback(
    async (path: string, opts?: { skipSave?: boolean }) => {
      try {
        if (projectRef.current && !opts?.skipSave) await saveAll(true);
        const raw = await api.openBook(path);
        const p = parseProject(raw);
        undoRef.current = [];
        commit(p);
        void api.mcpSetProject(path).catch(() => undefined);
        lastSaved.current = { ...p.bodies };
        const last =
          p.meta.lastChapterId && findChapter(p.outline, p.meta.lastChapterId)
            ? p.meta.lastChapterId
            : firstChapterId(p.outline);
        setActiveId(last);
        setView("write");
        setFocus(false);
        setIntro(true);
        setSaveState("idle");
        if (p.meta.kind !== "comic") window.setTimeout(() => {
          api
            .createSnapshot(path, "打开时自动备份")
            .then((list) => setSnapshots(list))
            .catch(() => undefined);
        }, 900);
        if (p.meta.cover) {
          api
            .coverData(path, p.meta.cover)
            .then((d) => d && setCovers((c) => ({ ...c, [path]: d })))
            .catch(() => undefined);
        }
        // 最近打开的顺序刷新
        refreshBooks();
      } catch (e) {
        toast(`打开失败：${errText(e)}`, { warn: true });
      }
    },
    [commit, refreshBooks, saveAll, toast],
  );

  /** 浏览器或系统下载下来的 .chapterpack 从 file input 读成 base64，
   * 交给 Rust 落成新书；不走 Android SAF 的 content:// 路径。 */
  const importPackageFile = useCallback(
    async (file: File) => {
      toast(`正在导入 ${file.name}…`);
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = () => reject(reader.error || new Error("读不到这个文件"));
          reader.readAsDataURL(file);
        });
        const comma = dataUrl.indexOf(",");
        if (comma < 0) throw new Error("这个文件不是同步包");
        const raw = await api.importChapterpack(dataUrl.slice(comma + 1));
        let path = raw;
        try {
          const parsed = JSON.parse(raw) as { path?: string; appData?: string | null };
          if (parsed.path) path = parsed.path;
          if (parsed.appData) applyAppData(parsed.appData);
        } catch {
          /* 兼容旧版只返回路径 */
        }
        await refreshBooks();
        toast("同步包已导入", {
          action: { label: "打开", run: () => void openProject(path, { skipSave: true }) },
        });
      } catch (e) {
        toast(`导入同步包失败：${errText(e)}`, { warn: true });
      }
    },
    [openProject, refreshBooks, toast],
  );

  const backToShelf = useCallback(async () => {
    await saveAll(true);
    undoRef.current = [];
    setProject(null);
    setActiveId(null);
    setFocus(false);
    setView("write");
    setIntro(true);
    setMatterDialog(false);
    setPrintStudio(null);
    await api.mcpSetProject(null).catch(() => undefined);
    await refreshBooks();
  }, [refreshBooks, saveAll]);

  closeBookForBack.current = () => {
    void backToShelf();
  };

  // Android 系统返回统一走这里：每次只关最上面一层。
  useEffect(() => {
    window.__chapterBack = () => {
      if (document.querySelector(".menu")) {
        document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        return true;
      }
      const localModal = document.querySelector<HTMLElement>(".backdrop .modal");
      if (localModal) {
        localModal.querySelector<HTMLElement>(".modal-head .icon-btn")?.click();
        return true;
      }
      if (modal) {
        closeModal();
        return true;
      }
      if (window.__chapterBackExtra?.()) return true;
      if (panel) {
        setPanel(false);
        return true;
      }
      if (mobileNav) {
        setMobileNav(false);
        return true;
      }
      if (projectRef.current) {
        if (!intro) {
          setIntro(true);
          setView("write");
          return true;
        }
        void backToShelf();
        return true;
      }
      return false;
    };
    return () => {
      delete window.__chapterBack;
    };
  }, [modal, panel, mobileNav, intro, closeModal, backToShelf]);

  /** 外部工具（MCP / Git）改过磁盘后，只重读当前工程，不替用户写回任何东西。 */
  const reloadFromDisk = useCallback(async (focusChapter?: string) => {
    const p = projectRef.current;
    if (!p) return;
    try {
      const raw = await api.openBook(p.path);
      const fresh = parseProject(raw);
      undoRef.current = [];
      commit(fresh);
      lastSaved.current = { ...fresh.bodies };
      const wanted = focusChapter && findChapter(fresh.outline, focusChapter) ? focusChapter : null;
      if (wanted) setActiveId(wanted);
      else if (activeRef.current && !findChapter(fresh.outline, activeRef.current)) {
        setActiveId(firstChapterId(fresh.outline));
      }
      setSaveState("idle");
      toast("已同步磁盘上的最新内容");
    } catch (e) {
      toast(`刷新失败：${errText(e)}`, { warn: true });
    }
  }, [commit, toast]);

  /** 外部改动到来时，只把当前正在写的那一章落盘，避免整份大纲覆盖掉 AI 刚写的新卷章。 */
  const saveCurrentBufferOnly = useCallback(async () => {
    const p = projectRef.current;
    const id = activeRef.current;
    if (!p || !id) return;
    const flushed = editorRef.current?.flush();
    const chapter = findChapter(p.outline, id);
    const body = typeof flushed === "string" ? flushed : p.bodies[id];
    if (typeof body !== "string") return;
    await api.saveChapter(p.path, id, chapter?.title ?? "", body);
    lastSaved.current = { ...lastSaved.current, [id]: body };
  }, []);

  /* ───────── MCP：外部 AI 的改动与删除确认 ───────── */

  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];

    void listen<{
      id: string;
      title: string;
      message: string;
      detail?: string;
      vars?: Record<string, string | number>;
    }>(
      "mcp-confirm",
      (e) => {
        if (disposed) return;
        const p = e.payload;
        // AI 的确认框必须压在最上层；设置/导入等大浮层先收起，避免点不到。
        setModal(null);
        setImportState(null);
        setPrompt(null);
        const rawTitle = p.title || "AI 请求执行操作";
        const rawMessage = p.message || p.detail || "这个操作需要你确认。";
        setConfirm({
          title: t(rawTitle),
          message: p.vars ? tf(rawMessage, p.vars) : t(rawMessage),
          confirmText: t("允许"),
          danger: true,
          onOk: () => {
            setConfirm(null);
            void api.mcpConfirm(p.id, true).catch((err) => toast(errText(err), { warn: true }));
          },
          onCancel: () => {
            setConfirm(null);
            void api.mcpConfirm(p.id, false).catch(() => undefined);
          },
        });
      },
    ).then((un) => (disposed ? un() : unlisteners.push(un)));

    void listen<{ path: string; focusChapter?: string; kind?: string }>(
      "mcp-data-changed",
      (e) => {
        if (disposed) return;
        const p = projectRef.current;
        if (!p || e.payload.path !== p.path) return;
        if (saveStateRef.current === "dirty") {
          toast(t("AI 改了这本书。先保存再点这里刷新。"), {
            warn: true,
            action: {
              label: t("保存正文并刷新"),
              run: () => {
                void (async () => {
                  try {
                    await saveCurrentBufferOnly();
                    await reloadFromDisk(e.payload.focusChapter);
                  } catch (err) {
                    toast(`刷新失败：${errText(err)}`, { warn: true });
                  }
                })();
              },
            },
          });
          return;
        }
        void reloadFromDisk(e.payload.focusChapter);
      },
    ).then((un) => (disposed ? un() : unlisteners.push(un)));

    void listen<{ path: string }>("mcp-open-book", (e) => {
      if (disposed) return;
      setModal(null);
      void openProject(e.payload.path);
    }).then((un) => (disposed ? un() : unlisteners.push(un)));

    void listen<{ path: string }>("mcp-book-deleted", (e) => {
      if (disposed) return;
      if (projectRef.current?.path !== e.payload.path) return;
      undoRef.current = [];
      setProject(null);
      setActiveId(null);
      setFocus(false);
      setIntro(false);
      setModal(null);
      void api.mcpSetProject(null).catch(() => undefined);
      void refreshBooks();
    }).then((un) => (disposed ? un() : unlisteners.push(un)));

    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [openProject, reloadFromDisk, saveCurrentBufferOnly, toast, refreshBooks]);

  /* ───────── 章节操作 ───────── */

  /** 切到非写作视图前，先把正文刷进保存队列，避免编辑器卸载时丢最后一段。 */
  const changeView = useCallback(
    (v: ViewKind, loreInitial: "cards" | "graph" | "map" = "cards") => {
      if (v !== "write" && view === "write") {
        editorRef.current?.flush();
        void saveAll(true);
      }
      if (v === "lore") setLoreMode(loreInitial);
      setView(v);
    },
    [saveAll, view],
  );

  const selectChapter = useCallback(
    async (id: string) => {
      if (id === activeRef.current && !intro && view === "write") {
        editorRef.current?.flush();
        await saveAll(true);
        setIntro(true);
        return;
      }
      await saveAll(true);
      setActiveId(id);
      setIntro(false);
      setView("write");
      const p = projectRef.current;
      if (p) {
        if (p.meta.kind === "comic") setPanel(false);
        const meta = { ...p.meta, lastChapterId: id };
        commit({ ...p, meta });
        api.saveJson(p.path, "book.json", JSON.stringify(meta)).catch(() => undefined);
      }
      window.setTimeout(() => {
        if (!IS_ANDROID_APP) editorRef.current?.focus();
      }, 120);
    },
    [commit, intro, saveAll, view],
  );

  /** 从介绍页进入某一章：即使它已经是「当前章」，也要展开编辑器。 */
  const enterChapter = useCallback(
    async (id: string) => {
      await saveAll(true);
      setActiveId(id);
      setIntro(false);
      setView("write");
      const p = projectRef.current;
      if (p) {
        if (p.meta.kind === "comic") setPanel(false);
        const meta = { ...p.meta, lastChapterId: id };
        commit({ ...p, meta });
        api.saveJson(p.path, "book.json", JSON.stringify(meta)).catch(() => undefined);
      }
      window.setTimeout(() => {
        if (!IS_ANDROID_APP) editorRef.current?.focus();
      }, 160);
    },
    [commit, saveAll],
  );

  const applyOutline = useCallback(
    (fn: (o: Outline) => Outline) => {
      const p = projectRef.current;
      if (!p) return;
      const outline = fn(structuredClone(p.outline));
      commit({ ...p, outline });
      scheduleOutline(outline);
    },
    [commit, scheduleOutline],
  );

  /** 大纲结构操作的撤销快照。只存大纲与必要稿件，不复制整本书。 */
  const pushUndo = useCallback(
    (label: string, outline: Outline, active: string | null, files?: UndoFile[]) => {
      undoRef.current.push({
        label,
        outline: structuredClone(outline),
        activeId: active,
        files,
      });
      if (undoRef.current.length > 20) undoRef.current.shift();
    },
    [],
  );

  const undoLast = useCallback(async () => {
    if (undoingRef.current) return;
    const entry = undoRef.current.pop();
    const p = projectRef.current;
    if (!entry || !p) return;
    undoingRef.current = true;
    const path = p.path;
    let failed = false;

    try {
      for (const f of entry.files ?? []) {
        try {
          let ok = false;
          if (f.preferDisk) {
            ok = await api.restoreChapter(path, f.id);
          }
          if (!ok) {
            const current = projectRef.current?.bodies[f.id];
            const body = f.preserveBody && typeof current === "string" ? current : (f.body ?? "");
            await api.saveChapter(path, f.id, f.title, body);
          }
        } catch {
          failed = true;
        }
      }

      const now = projectRef.current;
      if (!now || now.path !== path) return;
      const bodies = { ...now.bodies };
      for (const f of entry.files ?? []) {
        if (typeof f.body === "string" && bodies[f.id] === undefined) bodies[f.id] = f.body;
      }
      commit({ ...now, outline: structuredClone(entry.outline), bodies });
      activeRef.current = entry.activeId;
      setActiveId(entry.activeId);
      scheduleOutline(entry.outline);
      toast(
        failed
          ? tf("已撤销：{action}，但部分稿件未能写回，请检查工程目录", { action: entry.label })
          : tf("已撤销：{action}", { action: entry.label }),
        failed ? { warn: true } : undefined,
      );
    } finally {
      undoingRef.current = false;
    }
  }, [commit, scheduleOutline, toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "z") return;
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === "TEXTAREA" ||
          target.tagName === "INPUT" ||
          target.isContentEditable);
      if (typing) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (!undoRef.current.length) return;
      e.preventDefault();
      void undoLast();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [undoLast]);

  const addVolume = useCallback(() => {
    const p = projectRef.current;
    if (!p) return;
    const fallback = `第${p.outline.volumes.length + 1}卷`;
    setPrompt({
      title: "新建一卷",
      subtitle: "先给这一卷起个名字，再开始往里放章节。",
      label: "卷名",
      value: "",
      placeholder: fallback,
      confirmText: "创建",
      onOk: (value) => {
        const id = `v_${Date.now()}`;
        const title = value.trim() || fallback;
        pushUndo(tf("新建「{title}」", { title }), p.outline, activeRef.current);
        applyOutline((o) => {
          o.volumes.push({ id, title, collapsed: false, chapters: [] });
          return o;
        });
        toast(`已新建「${title}」`);
        setPrompt(null);
      },
    });
  }, [applyOutline, pushUndo, toast]);

  const addChapter = useCallback(
    async (volId: string) => {
      await saveAll(true);
      const p = projectRef.current;
      if (!p) return;
      let outline = structuredClone(p.outline);
      let vol = outline.volumes.find((v) => v.id === volId);
      if (!vol) {
        if (outline.volumes.length === 0) {
          const vid = `v_${Date.now()}`;
          outline.volumes.push({ id: vid, title: "第一卷", collapsed: false, chapters: [] });
          vol = outline.volumes[0];
        } else {
          vol = outline.volumes[outline.volumes.length - 1];
        }
      }
      const id = `c_${Date.now()}`;
      const comic = p.meta.kind === "comic";
      const globalIndex = outline.volumes.reduce((n, v) => n + v.chapters.length, 0);
      const title = formatChapterTitle(
        normalizeNumbering(p.meta.numbering, p.meta),
        globalIndex,
        vol.chapters.length,
      );
      const ch: Chapter = {
        id,
        title,
        summary: "",
        scenes: [],
        words: 0,
        updatedAt: Date.now(),
        ...(comic ? { kind: "comic" as const } : {}),
      };
      vol.chapters.push(ch);
      const next: Project = {
        ...p,
        outline,
        bodies: { ...p.bodies, [id]: "" },
      };
      commit(next);
      lastSaved.current[id] = "";
      scheduleOutline(outline);
      setActiveId(id);
      setView("write");
      try {
        await api.saveChapter(p.path, id, title, "");
      } catch (e) {
        toast(`创建章节失败：${errText(e)}`, { warn: true });
      }
      if (!comic && !IS_ANDROID_APP) window.setTimeout(() => editorRef.current?.focus(), 120);
    },
    [commit, saveAll, scheduleOutline, toast],
  );

  const updateFootnotes = useCallback(
    (chapterId: string, footnotes: Footnote[]) => {
      applyOutline((o) => {
        const c = o.volumes.flatMap((v) => v.chapters).find((x) => x.id === chapterId);
        if (c) c.footnotes = footnotes.length ? footnotes : undefined;
        return o;
      });
    },
    [applyOutline],
  );

  const addScene = useCallback((chapterId: string, scene?: Scene) => {
    const p = projectRef.current;
    if (!p) return;
    const chapter = findChapter(p.outline, chapterId);
    if (!chapter) return;
    const id = scene?.id ?? `s_${Date.now()}`;
    applyOutline((o) => {
      const v = o.volumes.find((vv) => vv.chapters.some((c) => c.id === chapterId));
      const c = v?.chapters.find((cc) => cc.id === chapterId);
      if (!c) return o;
      const idx = c.scenes.findIndex((s) => s.id === id);
      if (idx >= 0) c.scenes[idx] = { ...c.scenes[idx], ...scene, id };
      else c.scenes.push({ ...(scene ?? { id, title: "", summary: "" }), id, order: scene?.order ?? c.scenes.length });
      return o;
    });
  }, [applyOutline]);

  const deleteScene = useCallback(
    (chapterId: string, sceneId: string) => {
      applyOutline((o) => {
        const v = o.volumes.find((vv) => vv.chapters.some((c) => c.id === chapterId));
        const c = v?.chapters.find((cc) => cc.id === chapterId);
        if (c) c.scenes = c.scenes.filter((s) => s.id !== sceneId);
        return o;
      });
    },
    [applyOutline],
  );

  const renameChapter = useCallback(
    (chapterId: string) => {
      const p = projectRef.current;
      const chapter = p ? findChapter(p.outline, chapterId) : null;
      if (!p || !chapter) return;
      setPrompt({
        title: t("重命名章节"),
        label: t("章节名"),
        value: chapter.title,
        confirmText: t("保存"),
        onOk: (value) => {
          if (!value) return;
          const now = projectRef.current;
          const current = now ? findChapter(now.outline, chapterId) : null;
          if (!now || !current) return;
          pushUndo(
            tf("重命名「{title}」", { title: current.title }),
            now.outline,
            activeRef.current,
            [{ id: chapterId, title: current.title, preserveBody: true }],
          );
          applyOutline((o) => {
            const c = allChapters(o).find((x) => x.id === chapterId);
            if (c) c.title = value;
            return o;
          });
          const body = now.bodies[chapterId] ?? "";
          api.saveChapter(now.path, chapterId, value, body).catch(() => undefined);
          setPrompt(null);
        },
      });
    },
    [applyOutline, pushUndo],
  );

  const deleteChapter = useCallback(
    (chapterId: string) => {
      const p = projectRef.current;
      const chapter = p ? findChapter(p.outline, chapterId) : null;
      if (!p || !chapter) return;
      setConfirm({
        title: t("删除这一章？"),
        message: tf("《{title}》会从目录里移除。稿件文件会改名成 .md.deleted 留在工程目录，后悔了还能捞回来。", { title: chapter.title }),
        confirmText: t("删除"),
        danger: true,
        onOk: async () => {
          setConfirm(null);
          try {
            await saveAll(true);
            const fresh = projectRef.current;
            if (!fresh) return;
            const beforeActive = activeRef.current;
            const body = fresh.bodies[chapterId] ?? "";
            await api.deleteChapter(fresh.path, chapterId);
            pushUndo(
              tf("删除「{title}」", { title: chapter.title }),
              fresh.outline,
              beforeActive,
              [{ id: chapterId, title: chapter.title, body, preferDisk: true }],
            );
            const flat = allChapters(fresh.outline);
            const idx = flat.findIndex((c) => c.id === chapterId);
            const neighbour = flat[idx + 1]?.id ?? flat[idx - 1]?.id ?? null;
            const bodies = { ...fresh.bodies };
            delete bodies[chapterId];
            const outline = structuredClone(fresh.outline);
            outline.volumes.forEach((v) => {
              v.chapters = v.chapters.filter((c) => c.id !== chapterId);
            });
            commit({ ...fresh, outline, bodies });
            scheduleOutline(outline);
            if (activeRef.current === chapterId) {
              setActiveId(neighbour);
              activeRef.current = neighbour;
            }
            toast("已删除，稿件留在 .md.deleted");
          } catch (e) {
            toast(`删除失败：${errText(e)}`, { warn: true });
          }
        },
      });
    },
    [commit, pushUndo, saveAll, scheduleOutline, toast],
  );

  const renameVolume = useCallback(
    (volId: string) => {
      const p = projectRef.current;
      const vol = p?.outline.volumes.find((v) => v.id === volId);
      if (!p || !vol) return;
      setPrompt({
        title: t("重命名卷"),
        label: t("卷名"),
        value: vol.title,
        confirmText: t("保存"),
        onOk: (value) => {
          if (!value) return;
          const now = projectRef.current;
          const current = now?.outline.volumes.find((v) => v.id === volId);
          if (!now || !current) return;
          pushUndo(
            tf("重命名「{title}」", { title: current.title }),
            now.outline,
            activeRef.current,
          );
          applyOutline((o) => {
            const v = o.volumes.find((x) => x.id === volId);
            if (v) v.title = value;
            return o;
          });
          setPrompt(null);
        },
      });
    },
    [applyOutline, pushUndo],
  );

  const deleteVolume = useCallback(
    (volId: string) => {
      const p = projectRef.current;
      const vol = p?.outline.volumes.find((v) => v.id === volId);
      if (!p || !vol) return;
      setConfirm({
        title: t("删除这一卷？"),
        message: tf("《{title}》和它下面的 {count} 章会一起从目录移除；章节稿件文件仍留在工程目录。", { title: vol.title, count: vol.chapters.length }),
        confirmText: t("删除本卷"),
        danger: true,
        onOk: async () => {
          setConfirm(null);
          await saveAll(true);
          const fresh = projectRef.current;
          if (!fresh) return;
          const outline = structuredClone(fresh.outline);
          outline.volumes = outline.volumes.filter((v) => v.id !== volId);
          pushUndo(
            tf("删除「{title}」", { title: vol.title }),
            fresh.outline,
            activeRef.current,
          );
          commit({ ...fresh, outline });
          scheduleOutline(outline);
          if (activeRef.current && !findChapter(outline, activeRef.current)) {
            setActiveId(firstChapterId(outline));
          }
          toast("已删除本卷");
        },
      });
    },
    [commit, pushUndo, saveAll, scheduleOutline, toast],
  );

  const moveChapter = useCallback(
    (chId: string, toVol: string, beforeId: string | null) => {
      const p = projectRef.current;
      if (!p || chId === beforeId) return;
      pushUndo(t("移动章节"), p.outline, activeRef.current);
      applyOutline((o) => {
        let moved: Chapter | null = null;
        for (const v of o.volumes) {
          const idx = v.chapters.findIndex((c) => c.id === chId);
          if (idx >= 0) {
            moved = v.chapters.splice(idx, 1)[0];
            break;
          }
        }
        if (!moved) return o;
        const vol = o.volumes.find((v) => v.id === toVol) ?? o.volumes[0];
        if (!vol) return o;
        const bi = beforeId ? vol.chapters.findIndex((c) => c.id === beforeId) : -1;
        if (bi >= 0) vol.chapters.splice(bi, 0, moved);
        else vol.chapters.push(moved);
        return o;
      });
    },
    [applyOutline, pushUndo],
  );

  const moveVolume = useCallback(
    (fromId: string, toId: string) => {
      if (fromId === toId) return;
      const p = projectRef.current;
      if (!p) return;
      pushUndo(t("移动本卷"), p.outline, activeRef.current);
      applyOutline((o) => {
        const from = o.volumes.findIndex((v) => v.id === fromId);
        const to = o.volumes.findIndex((v) => v.id === toId);
        if (from < 0 || to < 0) return o;
        const [v] = o.volumes.splice(from, 1);
        o.volumes.splice(to, 0, v);
        return o;
      });
    },
    [applyOutline, pushUndo],
  );

  const moveScene = useCallback(
    (chId: string, sceneId: string, beforeId: string | null, toChapterId?: string) => {
      if (sceneId === beforeId) return;
      const p = projectRef.current;
      if (!p) return;
      pushUndo(t("移动场景"), p.outline, activeRef.current);
      applyOutline((o) => {
        const from = allChapters(o).find((x) => x.id === chId);
        const to = allChapters(o).find((x) => x.id === (toChapterId || chId));
        if (!from || !to) return o;
        const idx = from.scenes.findIndex((s) => s.id === sceneId);
        if (idx < 0) return o;
        const [s] = from.scenes.splice(idx, 1);
        s.chapterId = to.id;
        const bi = beforeId ? to.scenes.findIndex((x) => x.id === beforeId) : -1;
        if (bi >= 0) to.scenes.splice(bi, 0, s);
        else to.scenes.push(s);
        to.scenes.forEach((x, i) => {
          x.order = i;
          if (x.timeOrder === undefined) x.timeOrder = i;
        });
        return o;
      });
    },
    [applyOutline, pushUndo],
  );

  const toggleVolume = useCallback(
    (volId: string) => {
      applyOutline((o) => {
        const v = o.volumes.find((x) => x.id === volId);
        if (v) v.collapsed = !v.collapsed;
        return o;
      });
    },
    [applyOutline],
  );

  const updateSummary = useCallback(
    (chapterId: string, text: string) => {
      applyOutline((o) => {
        const c = allChapters(o).find((x) => x.id === chapterId);
        if (c) c.summary = text;
        return o;
      });
    },
    [applyOutline],
  );

  const updateTitle = useCallback(
    (chapterId: string, title: string) => {
      const p = projectRef.current;
      if (!p) return;
      // 改标题不顺手序列化整章正文：百万字章节每次改标题都全量转换会明显卡顿。
      const safeBody = p.bodies[chapterId] ?? "";
      applyOutline((o) => {
        const c = allChapters(o).find((x) => x.id === chapterId);
        if (c) c.title = title;
        return o;
      });
      api.saveChapter(p.path, chapterId, title, safeBody).catch(() => undefined);
    },
    [applyOutline],
  );

  /* ───────── 设定 ───────── */

  const saveProofread = useCallback(
    (config: ProofreadConfig) => {
      const p = projectRef.current;
      if (!p) return;
      const proofread = normalizeProofread(config);
      commit({ ...p, proofread });
      persistJson("proofread.json", proofread);
    },
    [commit, persistJson],
  );

  const saveLore = useCallback(    (lore: Lore) => {
      const p = projectRef.current;
      if (!p) return;
      commit({ ...p, lore });
      persistJson("lore.json", lore);
    },
    [commit, persistJson],
  );

  const saveLoreEntry = useCallback(
    (entry: LoreEntry) => {
      setLoreEdit(null);
      const p = projectRef.current;
      if (!p) return;
      const exists = p.lore.entries.some((e) => e.id === entry.id);
      const entries = exists
        ? p.lore.entries.map((e) => (e.id === entry.id ? entry : e))
        : [...p.lore.entries, entry];
      saveLore({ ...p.lore, entries });
      toast("设定已保存");
    },
    [saveLore, toast],
  );

  const deleteLoreEntry = useCallback(
    (entry: LoreEntry) => {
      setConfirm({
        title: t("删除这条设定？"),
        message: tf("《{name}》会从设定表里移除，正文里已经插入的名字不受影响。", { name: entry.name }),
        confirmText: t("删除"),
        danger: true,
        onOk: () => {
          setConfirm(null);
          const p = projectRef.current;
          if (!p) return;
          saveLore({
            ...p.lore,
            entries: p.lore.entries.filter((e) => e.id !== entry.id),
            relations: (p.lore.relations ?? []).filter(
              (r) => r.from !== entry.id && r.to !== entry.id,
            ),
            worldMap: {
              ...p.lore.worldMap,
              pins: (p.lore.worldMap?.pins ?? []).filter((x) => x.entryId !== entry.id),
            },
          });
          toast("已删除设定");
        },
      });
    },
    [saveLore, toast],
  );

  const insertLore = useCallback(
    (entry: LoreEntry) => {
      if (view !== "write") setView("write");
      window.setTimeout(() => {
        editorRef.current?.insertText(entry.name);
        editorRef.current?.focus();
      }, 60);
      toast(`已插入「${entry.name}」`);
    },
    [toast, view],
  );

  /* ───────── 书与封面 ───────── */

  const saveBookMeta = useCallback(
    async (patch: {
      title?: string;
      author?: string;
      description?: string;
      spineColor?: string;
      frontMatter?: string;
      backMatter?: string;
      numbering?: NumberingRule;
      renames?: { id: string; title: string }[];
    }) => {
      const p = projectRef.current;
      if (!p) return;
      const { renames, ...metaPatch } = patch;
      let outline = p.outline;
      if (renames?.length) {
        const map = new Map(renames.map((x) => [x.id, x.title]));
        outline = {
          volumes: outline.volumes.map((v) => ({
            ...v,
            chapters: v.chapters.map((c) => (map.has(c.id) ? { ...c, title: map.get(c.id)! } : c)),
          })),
        };
      }
      const meta = { ...p.meta, ...metaPatch, updatedAt: Date.now() };
      commit({ ...p, meta, outline });
      persistJson("book.json", meta);
      if (renames?.length) persistJson("outline.json", outline);
      await refreshBooks();
      toast(renames?.length ? "书籍信息与章节名已更新" : "书籍信息已更新");
    },
    [commit, persistJson, refreshBooks, toast],
  );

  const saveMatter = useCallback(
    async (patch: { frontMatter: string; backMatter: string }) => {
      const p = projectRef.current;
      if (!p) return;
      const meta = { ...p.meta, ...patch, updatedAt: Date.now() };
      commit({ ...p, meta });
      persistJson("book.json", meta);
      await refreshBooks();
      toast("副文本已保存 · Markdown");
    },
    [commit, persistJson, refreshBooks, toast],
  );

  const openCoverPicker = useCallback(() => {
    if (!projectRef.current) return;
    setCoverPickerOpen(true);
  }, []);

  const pickCoverFile = useCallback(async () => {
    const p = projectRef.current;
    if (!p) return;
    if (IS_ANDROID_APP) {
      androidCoverRef.current?.click();
      return;
    }
    try {
      await saveAll(false);
      const picked = await openDialog({
        multiple: false,
        title: t("选一张封面"),
        filters: [
          { name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] },
        ],
      });
      if (typeof picked !== "string") return;
      const src = await api.imageData(picked);
      if (!src) throw new Error("无法读取这张图片");
      setCoverDraft({
        path: p.path,
        src,
        name: picked.split(/[\\/]/).pop() ?? picked,
      });
    } catch (e) {
      toast(`读取封面失败：${errText(e)}`, { warn: true });
    }
  }, [saveAll, toast]);

  const chooseCoverFile = useCallback(() => {
    setCoverPickerOpen(false);
    void pickCoverFile();
  }, [pickCoverFile]);

  const applyCover = useCallback(
    async (dataUrl: string) => {
      const draft = coverDraft;
      if (!draft) return;
      try {
        const rel = await api.setCoverImage(draft.path, dataUrl);
        const data = await api.coverData(draft.path, rel);
        if (data) setCovers((c) => ({ ...c, [draft.path]: data }));
        // set_cover_image 只写 cover 字段；把模式明确为自定义，旧的自定义图也保留。
        const raw = await api.openBook(draft.path);
        const fresh = parseProject(raw);
        const meta = {
          ...fresh.meta,
          cover: fresh.meta.cover ?? rel,
          coverMode: "custom" as const,
          updatedAt: Date.now(),
        };
        await api.saveJson(draft.path, "book.json", JSON.stringify(meta));
        const p = projectRef.current;
        if (p && p.path === draft.path) {
          commit({ ...fresh, meta });
        }
        await refreshBooks();
        setCoverDraft(null);
        toast("封面已复制到小说目录");
      } catch (e) {
        // 保留裁切框，用户可以直接重试，不用再选一次原图。
        toast(`设置封面失败：${errText(e)}`, { warn: true });
      }
    },
    [commit, coverDraft, refreshBooks, toast],
  );

  const applyCoverOptions = useCallback(
    async (value: { mode: "custom" | "default"; style: string; spineColor: string }) => {
      const p = projectRef.current;
      if (!p) return;
      if (value.mode === "custom" && !p.meta.cover) {
        toast("先选择一张自定义封面图片", { warn: true });
        return;
      }
      const meta = {
        ...p.meta,
        coverMode: value.mode,
        coverStyle: value.style,
        spineColor: value.spineColor,
        updatedAt: Date.now(),
      };
      commit({ ...p, meta });
      await api.saveJson(p.path, "book.json", JSON.stringify(meta));
      setCoverPickerOpen(false);
      await refreshBooks();
      toast(value.mode === "default" ? "已使用默认封面" : "已使用自定义封面");
    },
    [commit, refreshBooks, toast],
  );

  const applyDesignedCover = useCallback(
    async (dataUrl: string, spine: string) => {
      const p = projectRef.current;
      if (!p) return;
      try {
        const rel = await api.setCoverImage(p.path, dataUrl);
        const data = await api.coverData(p.path, rel);
        if (data) setCovers((c) => ({ ...c, [p.path]: data }));
        const meta = {
          ...p.meta,
          cover: rel || p.meta.cover,
          coverMode: "custom" as const,
          spineColor: spine,
          updatedAt: Date.now(),
        };
        commit({ ...p, meta });
        await api.saveJson(p.path, "book.json", JSON.stringify(meta));
        setCoverDesignerOpen(false);
        await refreshBooks();
        toast("封面已导出并写回这本书");
      } catch (e) {
        toast(`封面写回失败：${errText(e)}`, { warn: true });
      }
    },
    [commit, refreshBooks, toast],
  );

  const deleteBook = useCallback(() => {
    const p = projectRef.current;
    if (!p) return;
    setConfirm({
      title: `删除《${p.meta.title}》？`,
      message: t("整本工程会移到书库的 .回收站 文件夹，不会立刻销毁；需要时可以手动拿回来。"),
      confirmText: t("移到回收站"),
      danger: true,
      onOk: async () => {
        setConfirm(null);
        try {
          await saveAll(true);
          await api.deleteBook(p.path);
          setProject(null);
          setActiveId(null);
          setFocus(false);
          await api.mcpSetProject(null).catch(() => undefined);
          await refreshBooks();
          toast("已移到回收站");
        } catch (e) {
          toast(`删除失败：${errText(e)}`, { warn: true });
        }
      },
    });
  }, [refreshBooks, toast]);

  const changeLibrary = useCallback(async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false, title: "选择新的书库文件夹" });
      if (typeof picked !== "string") return;
      const dir = await api.setLibrary(picked);
      setLibrary(dir);
      await refreshBooks();
      toast("书库位置已更换");
    } catch (e) {
      toast(`更换书库失败：${errText(e)}`, { warn: true });
    }
  }, [refreshBooks, toast]);

  const saveGoals = useCallback(
    (target: number, goal: number) => {
      const p = projectRef.current;
      if (!p) return;
      const meta = { ...p.meta, targetWords: target || 200000, dailyGoal: goal || 2000 };
      commit({ ...p, meta });
      persistJson("book.json", meta);
      toast("写作目标已更新");
    },
    [commit, persistJson, toast],
  );

  const updateBookOutline = useCallback(
    (md: string) => {
      const p = projectRef.current;
      if (!p) return;
      const meta = { ...p.meta, bookOutline: md };
      commit({ ...p, meta });
      window.clearTimeout(bookOutlineTimer.current);
      bookOutlineTimer.current = window.setTimeout(() => {
        api.saveJson(p.path, "book.json", JSON.stringify(meta)).catch(() => undefined);
      }, 520);
    },
    [commit],
  );

  const saveBookOutlineNow = useCallback(() => {
    const p = projectRef.current;
    if (!p) return;
    window.clearTimeout(bookOutlineTimer.current);
    commit(p);
    api
      .saveJson(p.path, "book.json", JSON.stringify(p.meta))
      .then(() => {
        setSaveState("saved");
        window.clearTimeout(savedTimer.current);
        savedTimer.current = window.setTimeout(() => setSaveState("idle"), 2400);
      })
      .catch((e) => toast(`保存失败：${errText(e)}`, { warn: true }));
  }, [commit, toast]);

  const pickBackground = useCallback(async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        title: t("选一张背景图"),
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
      });
      if (typeof picked !== "string") return;
      const data = await api.imageData(picked);
      setBgPath(picked);
      setBgData(data);
      try {
        localStorage.setItem("chapter.bg", picked);
      } catch {
        /* ignore */
      }
      toast("背景已更换");
    } catch (e) {
      toast(`背景图失败：${errText(e)}`, { warn: true });
    }
  }, [toast]);

  const clearBackground = useCallback(() => {
    setBgPath("");
    setBgData("");
    try {
      localStorage.removeItem("chapter.bg");
    } catch {
      /* ignore */
    }
  }, []);

  /* ───────── 新建 ───────── */

  const createBook = useCallback(
    async (
      title: string,
      author: string,
      target: number,
      goal: number,
      template: "blank" | "three",
      kind: "novel" | "comic",
    ) => {
      setModal(null);
      try {
        const raw = await api.createBook(title, author, target, goal, kind);
        let p = parseProject(raw);
        if (template === "three" && kind !== "comic") {
          const plan: { vol: string; chapters: string[] }[] = [
            { vol: "第一幕 · 建置", chapters: ["第一章 日常", "第二章 意外", "第三章 无法回头"] },
            { vol: "第二幕 · 对抗", chapters: ["第四章 试错", "第五章 中点", "第六章 代价"] },
            { vol: "第三幕 · 解决", chapters: ["第七章 最低谷", "第八章 决断", "第九章 余波"] },
          ];
          const stamp = Date.now();
          const outline: Outline = { volumes: [] };
          const bodies = { ...p.bodies };
          const jobs: Promise<unknown>[] = [];
          plan.forEach((v, vi) => {
            const chapters = v.chapters.map((t, ci) => {
              const id = `c_${stamp}_${vi}_${ci}`;
              bodies[id] = "";
              jobs.push(api.saveChapter(p.path, id, t, ""));
              return { id, title: t, summary: "", scenes: [], words: 0, updatedAt: stamp } as Chapter;
            });
            outline.volumes.push({
              id: `v_${stamp}_${vi}`,
              title: v.vol,
              collapsed: false,
              chapters,
            });
          });
          await Promise.all(jobs);
          await api.saveJson(p.path, "outline.json", JSON.stringify(outline));
          p = { ...p, outline, bodies };
        }
        commit(p);
        lastSaved.current = { ...p.bodies };
        if (kind === "comic") setPanel(false);
        const first = firstChapterId(p.outline);
        setActiveId(first);
        setView("write");
        setFocus(false);
        setSaveState("idle");
        await refreshBooks();
        api
          .createSnapshot(p.path, "新建时")
          .then((list) => setSnapshots(list))
          .catch(() => undefined);
        toast(kind === "comic" ? `《${title}》已建好，开始画吧` : `《${title}》已建好，开始写吧`);
        if (kind !== "comic" && !IS_ANDROID_APP) window.setTimeout(() => editorRef.current?.focus(), 300);
      } catch (e) {
        toast(`新建失败：${errText(e)}`, { warn: true });
      }
    },
    [commit, refreshBooks, toast],
  );

  const openExisting = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "选择一本 .chapter 工程",
      });
      if (typeof picked !== "string") return;
      await openProject(picked);
    } catch (e) {
      toast(`打开失败：${errText(e)}`, { warn: true });
    }
  }, [openProject, toast]);

  /* ───────── 导入书稿 ───────── */

  const pickImport = useCallback(
    async (mode: "new" | "append") => {
      if (IS_ANDROID_APP) {
        androidImportMode.current = mode;
        androidImportRef.current?.click();
        return;
      }
      try {
        const picked = await openDialog({
          multiple: false,
          title: "导入 TXT / Markdown / Word",
          filters: [
            { name: "书稿", extensions: ["txt", "md", "markdown", "docx"] },
            { name: "纯文本", extensions: ["txt"] },
            { name: "Markdown", extensions: ["md", "markdown"] },
            { name: "Word", extensions: ["docx"] },
          ],
        });
        if (typeof picked !== "string") return;
        const doc = await api.readImportFile(picked);
        setImportState({ doc, mode });
      } catch (e) {
        toast(`读取书稿失败：${errText(e)}`, { warn: true });
      }
    },
    [toast],
  );

  /** Android 系统选择器给的是 content://，Vite/WebView 读成 base64 后再交给 Rust。 */
  const importOnAndroid = useCallback(
    async (file: File) => {
      const ext = (file.name.split(".").pop() ?? "").toLowerCase();
      if (!["txt", "md", "markdown", "docx"].includes(ext)) {
        toast("只支持 TXT、Markdown、DOCX", { warn: true });
        return;
      }
      toast(`正在读取 ${file.name}…`);
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = () => reject(reader.error || new Error("读不到这个文件"));
          reader.readAsDataURL(file);
        });
        const comma = dataUrl.indexOf(",");
        if (comma < 0) throw new Error("这个文件读不出来");
        const name = file.name.replace(/\.(docx|markdown|md|txt)$/i, "") || "导入稿";
        const doc = await api.readImportBytes(name, ext, dataUrl.slice(comma + 1));
        setImportState({ doc, mode: androidImportMode.current });
      } catch (e) {
        toast(`读取书稿失败：${errText(e)}`, { warn: true });
      }
    },
    [toast],
  );

  const performImport = useCallback(
    async (payload: {
      title: string;
      author: string;
      sections: { title: string; body: string; volumeTitle: string }[];
    }) => {
      const mode = importState?.mode ?? "new";
      const stamp = Date.now();
      const build = (prefix: string) => {
        const volumes: Volume[] = [];
        const bodies: Record<string, string> = {};
        payload.sections.forEach((s, i) => {
          let vol = volumes.find((v) => v.title === s.volumeTitle);
          if (!vol) {
            vol = { id: `${prefix}_v_${i}`, title: s.volumeTitle || "第一卷", collapsed: false, chapters: [] };
            volumes.push(vol);
          }
          const id = `${prefix}_c_${i}`;
          const words = countWords(s.body);
          vol.chapters.push({
            id,
            title: s.title,
            summary: "",
            scenes: [],
            words,
            updatedAt: stamp,
          });
          bodies[id] = s.body;
        });
        return { volumes, bodies };
      };
      const total = payload.sections.reduce((n, s) => n + countWords(s.body), 0);

      try {
        if (mode === "new") {
          const raw = await api.createBook(payload.title, payload.author, 200000, 2000);
          const base = parseProject(raw);
          const oldIds = allChapters(base.outline).map((c) => c.id);
          const built = build(`c_${stamp}`);
          const outline: Outline = { volumes: built.volumes };
          await api.saveJson(base.path, "outline.json", JSON.stringify(outline));
          await Promise.all(
            built.volumes.flatMap((v) =>
              v.chapters.map((c) => api.saveChapter(base.path, c.id, c.title, built.bodies[c.id] ?? "")),
            ),
          );
          await Promise.all(oldIds.map((id) => api.deleteChapter(base.path, id).catch(() => undefined)));
          const firstId = built.volumes[0]?.chapters[0]?.id ?? null;
          const meta: BookMeta = {
            ...base.meta,
            wordCount: total,
            updatedAt: stamp,
            lastChapterId: firstId,
            bookOutline: "",
            daily: null,
          };
          await api.saveJson(base.path, "book.json", JSON.stringify(meta));
          setImportState(null);
          await openProject(base.path);
          toast(`已导入《${payload.title}》· ${payload.sections.length} 章`, {
            action: { label: "开始写", run: () => setImportState(null) },
          });
          return;
        }

        const p0 = projectRef.current;
        if (!p0) return;
        await saveAll(true);
        const p = projectRef.current;
        if (!p) return;
        const built = build(`imp_${stamp}`);
        // 追加时避开已有卷名，减少重名
        const used = new Set(p.outline.volumes.map((v) => v.title));
        built.volumes.forEach((v) => {
          if (used.has(v.title)) v.title = `${v.title} · 导入`;
          used.add(v.title);
        });
        const outline: Outline = {
          volumes: [...p.outline.volumes, ...built.volumes],
        };
        const bodies = { ...p.bodies, ...built.bodies };
        const firstNew = built.volumes[0]?.chapters[0]?.id ?? null;
        const meta: BookMeta = {
          ...p.meta,
          wordCount: totalWords(outline, bodies),
          updatedAt: stamp,
          lastChapterId: firstNew,
        };
        commit({ ...p, outline, bodies, meta });
        lastSaved.current = { ...lastSaved.current, ...built.bodies };
        await api.saveJson(p.path, "outline.json", JSON.stringify(outline));
        await api.saveJson(p.path, "book.json", JSON.stringify(meta));
        await Promise.all(
          built.volumes.flatMap((v) =>
            v.chapters.map((c) => api.saveChapter(p.path, c.id, c.title, built.bodies[c.id] ?? "")),
          ),
        );
        setImportState(null);
        if (firstNew) {
          setActiveId(firstNew);
          setView("write");
        }
        if (!IS_ANDROID_APP) window.setTimeout(() => editorRef.current?.focus(), 180);
        toast(`已追加 ${payload.sections.length} 章`);
      } catch (e) {
        toast(`导入失败：${errText(e)}`, { warn: true });
        throw e;
      }
    },
    [commit, importState?.mode, openProject, saveAll, toast],
  );

  /* ───────── 版本 ───────── */

  const snapshotNow = useCallback(async () => {
    const p = projectRef.current;
    if (!p) return;
    try {
      await saveAll(true);
      const list = await api.createSnapshot(p.path, "手动存版");
      setSnapshots(list);
      toast("已存一版");
    } catch (e) {
      toast(`存版失败：${errText(e)}`, { warn: true });
    }
  }, [saveAll, toast]);

  const restoreSnapshot = useCallback(
    (name: string) => {
      const p = projectRef.current;
      if (!p) return;
      setConfirm({
        title: t("恢复到这个版本？"),
        message: t("当前正文会被这个版本覆盖。恢复前会自动把现在的状态存成一版，留后路。"),
        confirmText: t("恢复"),
        onOk: async () => {
          setConfirm(null);
          try {
            const raw = await api.restoreSnapshot(p.path, name);
            const fresh = parseProject(raw);
            commit(fresh);
            lastSaved.current = { ...fresh.bodies };
            const id = fresh.meta.lastChapterId && findChapter(fresh.outline, fresh.meta.lastChapterId)
              ? fresh.meta.lastChapterId
              : firstChapterId(fresh.outline);
            setActiveId(id);
            setEditorEpoch((n) => n + 1);
            setModal(null);
            const list = await api.listSnapshots(p.path);
            setSnapshots(list);
            toast("已恢复到该版本");
          } catch (e) {
            toast(`恢复失败：${errText(e)}`, { warn: true });
          }
        },
      });
    },
    [commit, toast],
  );

  /* ───────── 导出 ───────── */

  const doExport = useCallback(
    async (format: string) => {
      const p = projectRef.current;
      if (!p) return;
      if (p.meta.kind === "comic") {
        // 漫画不是文字稿：回到画布，由漫画导出面板选当前页 / 当前话 / 整本。
        setModal(null);
        setView("write");
        setComicExportSignal((n) => n + 1);
        return;
      }
      const ext = format;
      try {
        if (IS_ANDROID_APP) {
          // Android 的系统“另存为”会给白屏或返回 content://，直接落到 App 导出目录再走系统分享。
          const fileName = `${p.meta.title || "未命名"}.${ext}`;
          await saveAll(true);
          const dest = await api.exportBookToApp(p.path, format, fileName);
          setModal(null);
          const mime =
            format === "epub"
              ? "application/epub+zip"
              : format === "md"
                ? "text/markdown"
                : "text/plain";
          try {
            await shareFile(`file://${dest}`, { mimeType: mime, title: fileName });
            toast("已生成导出文件，可在系统面板里保存或发送");
          } catch {
            toast("已生成导出文件；系统分享打不开，可稍后在设置里重试", { warn: true });
          }
          return;
        }
        const dest = await saveDialog({
          title: "导出到…",
          defaultPath: `${p.meta.title || "未命名"}.${ext}`,
          filters: [
            {
              name:
                format === "epub" ? "EPUB 电子书" : format === "md" ? "Markdown 文件" : "纯文本",
              extensions: [ext],
            },
          ],
        });
        if (typeof dest !== "string") return;
        await saveAll(true);
        const msg = await api.exportBook(p.path, format, dest);
        setModal(null);
        toast(`${msg} · 已存到 ${dest.split(/[\\/]/).pop()}`, {
          action: { label: "打开位置", run: () => void revealItemInDir(dest) },
        });
      } catch (e) {
        toast(`导出失败：${errText(e)}`, { warn: true });
      }
    },
    [saveAll, toast],
  );

  /* ───────── 派生 ───────── */

  const activeChapter = useMemo(
    () => (project ? findChapter(project.outline, activeId) : null),
    [project, activeId],
  );

  const flat = useMemo(() => (project ? allChapters(project.outline) : []), [project]);
  const chapterIndex = activeChapter ? flat.findIndex((c) => c.id === activeChapter.id) : -1;
  const activeVolume = useMemo(
    () =>
      project && activeChapter
        ? project.outline.volumes.find((v) => v.chapters.some((c) => c.id === activeChapter.id)) ?? null
        : null,
    [project, activeChapter],
  );

  const bookWords = useMemo(
    () => flat.reduce((n, c) => n + (c.words ?? 0), 0),
    [flat],
  );

  const currentBookSummary = useMemo(
    () => books.find((b) => project && b.path === project.path) ?? null,
    [books, project?.path],
  );

  const todayAdded = useMemo(() => {
    if (!project) return 0;
    const today = dateKey();
    const base =
      project.meta.daily && project.meta.daily.date === today
        ? project.meta.daily.base
        : bookWords;
    return Math.max(0, bookWords - base);
  }, [project, bookWords]);

  // 打开旧书时，把今天已有的新增字数补进打卡记录（以后由保存逻辑累加）。
  useEffect(() => {
    if (!project || todayAdded <= 0) return;
    const today = dateKey();
    setDailyLog((prev) =>
      (prev[today] ?? 0) >= todayAdded ? prev : { ...prev, [today]: todayAdded },
    );
    // 只在换书时补一次，不跟着每次按键抖动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.path]);

  const rawCoverUrl = project ? covers[project.path] : undefined;
  const coverUrl = project && project.meta.coverMode !== "default" ? rawCoverUrl : undefined;

  /* ───────── 渲染 ───────── */

  useEffect(() => {
    let live = true;
    void ensureUiPack(language).then(() => {
      if (live) setI18nRevision((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [language]);

  setUiLanguage(language);

  const scene: AmbienceScene = project ? (intro ? "intro" : "write") : "shelf";

  return (
    <div className="app">
      <AmbientBackdrop scene={scene} />
      <input
        ref={packageInputRef}
        type="file"
        accept=".chapterpack,.zip,application/zip,application/octet-stream"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.currentTarget.value = "";
          if (file) void importPackageFile(file);
        }}
      />
      <input
        ref={androidImportRef}
        type="file"
        accept=".txt,.md,.markdown,.docx,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.currentTarget.value = "";
          if (file) void importOnAndroid(file);
        }}
      />
      <input
        ref={androidCoverRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.currentTarget.value = "";
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            const p = projectRef.current;
            const src = String(reader.result || "");
            if (!p || !src) return;
            setCoverDraft({ path: p.path, src, name: file.name });
          };
          reader.onerror = () => toast("读不到这张图片", { warn: true });
          reader.readAsDataURL(file);
        }}
      />
      {project ? (
        intro ? (
          <Suspense fallback={<div className="lazy-fallback">{t("正在翻开这本书…")}</div>}>
          <BookIntroPage
            meta={project.meta}
            outline={project.outline}
            coverUrl={coverUrl}
            activeId={activeId}
            theme={theme}
            comicPages={currentBookSummary?.comicPages ?? 0}
            comicPanels={currentBookSummary?.comicPanels ?? 0}
            comicBalloons={currentBookSummary?.comicBalloons ?? 0}
            onBack={backToShelf}
            onSelectChapter={(id) => void enterChapter(id)}
            onBookSettings={() => setMetaDialog(true)}
            onMatter={() => setMatterDialog(true)}
            onPickCover={openCoverPicker}
            onToggleTheme={toggleTheme}
            onSettings={() => openSettings()}
            onAddVolume={addVolume}
            onAddChapter={addChapter}
          />
          </Suspense>
        ) : (
        <div className={`workspace${focus ? " focus" : ""}${mobileNav ? " mobile-nav" : ""}`}>
          <TopBar
            meta={project.meta}
            coverUrl={coverUrl}
            saveState={saveState}
            view={view}
            loreMode={loreMode}
            panel={panel}
            theme={theme}
            onView={changeView}
            onWorldMap={() => changeView("lore", "map")}
            onTogglePanel={() => {
              if (window.matchMedia("(max-width: 820px)").matches) {
                setMobileNav(false);
              }
              setPanel((p) => !p);
            }}
            onToggleSidebar={() => setMobileNav((v) => !v)}
            onToggleTheme={toggleTheme}
            onSettings={() => openSettings()}
            onExport={() => {
              void saveAll(true);
              if (project.meta.kind === "comic") {
                setView("write");
                setModal(null);
                setComicExportSignal((n) => n + 1);
              } else {
                setModal("export");
              }
            }}
            onImport={() => void pickImport("append")}
            onTransfer={() => {
              setTransferBookPath(project.path);
              setTransferOpen(true);
            }}
            onSnapshots={() => {
              void loadSnapshots(project.path);
              setModal("snapshots");
            }}
            onVersions={() => openSettings("git")}
            onBack={backToShelf}
            onBookSettings={() => setMetaDialog(true)}
            onMatter={() => setMatterDialog(true)}
            onPickCover={openCoverPicker}
            onDeleteBook={deleteBook}
          />

          <div className="ws-body">
            {mobileNav && (
              <button className="mobile-nav-scrim" aria-label="关闭目录" onClick={() => setMobileNav(false)} />
            )}
            <Sidebar
              outline={project.outline}
              activeId={activeId}
              bookWords={bookWords}
              bookKind={project.meta.kind ?? "novel"}
              comicPages={currentBookSummary?.comicPages ?? 0}
              comicPanels={currentBookSummary?.comicPanels ?? 0}
              onSelectChapter={selectChapter}
              onToggleVolume={toggleVolume}
              onAddVolume={addVolume}
              onAddChapter={addChapter}
              onAddScene={(chId) => setSceneEdit({ chapterId: chId, sceneId: null })}
              onRenameChapter={renameChapter}
              onDeleteChapter={deleteChapter}
              onRenameVolume={renameVolume}
              onDeleteVolume={deleteVolume}
              onMoveChapter={moveChapter}
              onMoveVolume={moveVolume}
              onMoveScene={moveScene}
            />

            <main className={`stage${panel ? " panel-open" : ""}`}>
              <Suspense fallback={<div className="lazy-fallback">{t("正在准备写作台…")}</div>}>
              {view === "write" &&
                (activeChapter ? (
                  project.meta.kind === "comic" ? (
                    <Suspense fallback={<div className="lazy-fallback">{t("正在打开漫画画布…")}</div>}>
                      <ComicWorkspace
                        key={`${project.path}:${activeChapter.id}`}
                        path={project.path}
                        meta={project.meta}
                        embedded
                        chapterId={activeChapter.id}
                        firstChapterId={flat[0]?.id}
                        proofread={project.proofread}
                        onProofread={saveProofread}
                        openExportSignal={comicExportSignal}
                      />
                    </Suspense>
                  ) : (
                  <EditorBoundary>
                    <Editor
                    key={`${project.path}:${activeChapter.id}:${editorEpoch}`}
                    chapter={activeChapter}
                    body={project.bodies[activeChapter.id] ?? ""}
                    meta={project.meta}
                    bookPath={project.path}
                    index={chapterIndex >= 0 ? chapterIndex : 0}
                    total={flat.length}
                    volumeTitle={activeVolume?.title}
                    saveState={saveState}
                    bookWords={bookWords}
                    todayAdded={todayAdded}
                    focusMode={focus}
                    apiRef={editorRef}
                    proofread={project.proofread}
                    onProofread={saveProofread}
                    voicePad={voicePad}
                    voiceMarks={voiceMarks}
                    onFootnotes={(next) => updateFootnotes(activeChapter.id, next)}
                    onBody={() => {
                      // 正文先留在编辑器里，等 1.4 秒自动保存时再整章落盘。
                      // 每次按键都 setProject 会触发整棵工作台重渲染和大纲重算，长文明显卡顿。
                      setSaveState("dirty");
                    }}
                    onTitle={(title) => activeId && updateTitle(activeId, title)}
                    onSave={() => saveAll(true)}
                    onInsertLore={() => setLorePicker(true)}
                    onToggleFocus={() => setFocus((f) => !f)}
                  />
                  </EditorBoundary>
                  )
                ) : (
                  <div className="view-scroll">
                    <div className="view-inner">
                      <div className="lore-empty">
                        这本书还没有章节。
                        <div style={{ marginTop: 14 }}>
                          <button
                            className="btn btn-primary"
                            onClick={() => addChapter(project.outline.volumes[0]?.id ?? "")}
                          >
                            <IconPlus />
                            新建第一章
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}

              {view === "outline" && (
                <OutlineBoard
                  bookPath={project.path}
                  outline={project.outline}
                  lore={project.lore}
                  activeId={activeId}
                  onOpen={selectChapter}
                  onSummary={updateSummary}
                  onMoveChapter={moveChapter}
                  onAddChapter={addChapter}
                  onAddVolume={addVolume}
                  onRenameChapter={renameChapter}
                  onDeleteChapter={deleteChapter}
                  onRenameVolume={renameVolume}
                  onDeleteVolume={deleteVolume}
                  onAddScene={(chId) => setSceneEdit({ chapterId: chId, sceneId: null })}
                  onEditScene={(chId, sceneId) => setSceneEdit({ chapterId: chId, sceneId })}
                  onMoveScene={(chId, sceneId, toChapterId, beforeId) =>
                    moveScene(chId, sceneId, beforeId, toChapterId)
                  }
                />
              )}

              {view === "bookOutline" && (
                <BookOutline
                  bookPath={project.path}
                  meta={project.meta}
                  chapters={flat}
                  onChange={updateBookOutline}
                  onSave={saveBookOutlineNow}
                  outline={project.outline}
                  onOpenChapter={selectChapter}
                />
              )}

              {view === "lore" && (
                <LoreView
                  lore={project.lore}
                  onAdd={(kind) => setLoreEdit({ entry: null, kind })}
                  onEdit={(entry) => setLoreEdit({ entry, kind: entry.kind })}
                  onDelete={deleteLoreEntry}
                  onInsert={insertLore}
                  onSaveLore={saveLore}
                  initialMode={loreMode}
                />
              )}
              </Suspense>
            </main>

            {panel && (
              <InfoPanel
                meta={project.meta}
                chapter={activeChapter}
                bookWords={bookWords}
                todayAdded={todayAdded}
                totalChapters={flat.length}
                snapshots={snapshots}
                onClose={() => setPanel(false)}
                onOpenSnapshots={() => {
                  void loadSnapshots(project.path);
                  setModal("snapshots");
                }}
                onSnapshot={snapshotNow}
                onAddScene={() =>
                  activeChapter && setSceneEdit({ chapterId: activeChapter.id, sceneId: null })
                }
                onEditScene={(sceneId) =>
                  activeChapter && setSceneEdit({ chapterId: activeChapter.id, sceneId })
                }
                onDeleteScene={(sceneId) =>
                  activeChapter &&
                  setConfirm({
                    title: t("删除这个场景？"),
                    message: t("只删除场景卡片，正文不受影响。"),
                    confirmText: t("删除"),
                    danger: true,
                    onOk: () => {
                      setConfirm(null);
                      deleteScene(activeChapter.id, sceneId);
                    },
                  })
                }
              />
            )}
          </div>

          {focus && (
            <>
              <button className="focus-exit glass" onClick={() => setFocus(false)}>
                <IconShrink />
                {t("退出专注")}
              </button>
              <div className="focus-hint">{t("Esc 退出 · 光标始终在视线中间")}</div>
            </>
          )}
        </div>
        )
      ) : homeMode === "workspace" ? (
        <WorkspaceHome
          books={books}
          series={series}
          covers={covers}
          totalWords={books.reduce((n, b) => n + b.words, 0)}
          dailyLog={dailyLog}
          theme={theme}
          onOpen={(b) => openProject(b.path)}
          onCreateSeries={createSeries}
          onUpdateSeries={updateSeries}
          onDeleteSeries={deleteSeries}
          onAssignSeries={assignBookSeries}
          onSeriesCharacters={seriesCharacters}
          onSetSeriesShared={setSeriesShared}
          onNew={() => setModal("new")}
          onImport={() => void pickImport("new")}
          onTransfer={() => {
            setTransferBookPath(null);
            setTransferOpen(true);
          }}
          onScan={() => setScanOpen(true)}
          onOpenFolder={openExisting}
          onSettings={() => openSettings()}
          onToggleTheme={toggleTheme}
          onMinimal={() => setHomeMode("minimal")}
          language={language}
        />
      ) : (
        <Welcome
          books={books}
          covers={covers}
          theme={theme}
          totalWords={books.reduce((n, b) => n + b.words, 0)}
          onOpen={(b) => openProject(b.path)}
          onNew={() => setModal("new")}
          onImport={() => void pickImport("new")}
          onImportPackage={() => packageInputRef.current?.click()}
          onWorkspace={() => setHomeMode("workspace")}
          onTransfer={() => {
            setTransferBookPath(null);
            setTransferOpen(true);
          }}
          onScan={() => setScanOpen(true)}
          onOpenFolder={openExisting}
          onRename={(b) => {
            setPrompt({
              title: t("重命名这本书"),
              label: t("书名"),
              value: b.title,
              confirmText: t("保存"),
              onOk: async (value) => {
                if (!value) return;
                try {
                  const raw = await api.openBook(b.path);
                  const p = parseProject(raw);
                  const meta = { ...p.meta, title: value };
                  await api.saveJson(b.path, "book.json", JSON.stringify(meta));
                  setPrompt(null);
                  await refreshBooks();
                } catch (e) {
                  toast(`重命名失败：${errText(e)}`, { warn: true });
                }
              },
            });
          }}
          onDelete={(b) => {
            setConfirm({
              title: tf("删除《{title}》？", { title: b.title }),
              message: t("整本工程会移到书库的 .回收站，不会立刻销毁。"),
              confirmText: t("移到回收站"),
              danger: true,
              onOk: async () => {
                setConfirm(null);
                try {
                  await api.deleteBook(b.path);
                  await refreshBooks();
                  toast("已移到回收站");
                } catch (e) {
                  toast(`删除失败：${errText(e)}`, { warn: true });
                }
              },
            });
          }}
          onReveal={(b) => void revealItemInDir(b.path).catch(() => undefined)}
          onToggleTheme={toggleTheme}
          onSettings={() => openSettings()}
          language={language}
        />
      )}

      {booting && <Splash leaving={splashLeaving} />}

      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.warn ? " warn" : ""}${t.leaving ? " leaving" : ""}`}>
            {t.text}
            {t.action && (
              <button
                onClick={() => t.action?.run()}
                style={{
                  marginLeft: 10,
                  color: t.warn ? "#fff" : "var(--accent-light)",
                  textDecoration: "underline",
                  fontSize: 12,
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>

      {coverPickerOpen && project && (
        <CoverPickerDialog
          title={project.meta.title}
          author={project.meta.author}
          coverMode={project.meta.coverMode}
          coverStyle={project.meta.coverStyle}
          spineColor={project.meta.spineColor}
          customCoverUrl={rawCoverUrl}
          onClose={() => setCoverPickerOpen(false)}
          onApply={applyCoverOptions}
          onOpenDesigner={() => {
            setCoverPickerOpen(false);
            setCoverDesignerOpen(true);
          }}
          onPickFile={chooseCoverFile}
        />
      )}

      {coverDesignerOpen && project && (
        <CoverDesignerDialog
          title={project.meta.title}
          author={project.meta.author}
          spineColor={project.meta.spineColor || "#6d4a2a"}
          onClose={() => setCoverDesignerOpen(false)}
          onApply={applyDesignedCover}
        />
      )}

      {coverDraft && (
        <CoverCropDialog
          src={coverDraft.src}
          fileName={coverDraft.name}
          onClose={() => setCoverDraft(null)}
          onConfirm={applyCover}
        />
      )}

      {modal === "new" && (
        <NewBookDialog onClose={closeModal} onCreate={createBook} />
      )}

      {metaDialog && project && (
        <BookMetaDialog
          meta={project.meta}
          outline={project.outline}
          onClose={() => setMetaDialog(false)}
          onSave={(patch) => saveBookMeta(patch)}
        />
      )}

      {matterDialog && project && (
        <MatterDialog
          meta={project.meta}
          onClose={closeMatter}
          onSave={saveMatter}
        />
      )}

      {modal === "export" && project && (
        <ExportDialog
          meta={project.meta}
          chapters={flat.length}
          words={bookWords}
          kind={project.meta.kind === "comic" ? "comic" : "novel"}
          onClose={closeModal}
          onExport={doExport}
          onPrint={(f) => {
            setPrintStudio(f);
            closeModal();
          }}
        />
      )}

      {modal === "snapshots" && (
        <SnapshotDialog
          snapshots={snapshots}
          onClose={closeModal}
          onCreate={snapshotNow}
          onRestore={restoreSnapshot}
        />
      )}

      {modal === "shelfSettings" && (
        <Suspense fallback={null}>
          <SettingsDialog
            initialSection={settingsSection}
            themeMode={themeMode}
            accent={accent}
            uiStyle={uiStyle}
            motion={motion}
            lightEffect={lightEffect}
            homeMode={homeMode}
            language={language}
            paper={paper}
            bgPath={bgPath}
            library={library}
            targetWords={project?.meta.targetWords}
            dailyGoal={project?.meta.dailyGoal}
            mcpEnabled={mcpEnabled}
            projectPath={project?.path ?? null}
            voicePad={voicePad}
            voiceMarks={voiceMarks}
            onTheme={setThemeMode}
            onMotion={setMotion}
            onHomeMode={setHomeMode}
            onLanguage={setLanguage}
            onPaper={setPaper}
            onAccent={setAccent}
            onUiStyle={setUiStyle}
            onLightEffect={setLightEffect}
            onPickBg={pickBackground}
            onClearBg={clearBackground}
            onSaveGoals={saveGoals}
            onChangeLibrary={changeLibrary}
            onMcpEnabled={setMcpEnabled}
            onVoicePad={setVoicePad}
            onVoiceMarks={setVoiceMarks}
            onReloadProject={() => reloadFromDisk()}
            onSaveCurrent={() => saveAll(true)}
            onClose={() => setModal(null)}
          />
        </Suspense>
      )}

      {importState && (
        <Suspense fallback={null}>
          <ImportDialog
            doc={importState.doc}
            mode={importState.mode}
            bookTitle={project?.meta.title}
            onClose={() => setImportState(null)}
            onImport={performImport}
          />
        </Suspense>
      )}

      {prompt && (
        <PromptDialog
          title={prompt.title}
          subtitle={prompt.subtitle}
          label={prompt.label}
          value={prompt.value}
          placeholder={prompt.placeholder}
          multiline={prompt.multiline}
          confirmText={prompt.confirmText}
          onClose={() => setPrompt(null)}
          onOk={(v) => prompt.onOk(v)}
        />
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmText={confirm.confirmText}
          danger={confirm.danger}
          onClose={() => {
            confirm.onCancel?.();
            setConfirm(null);
          }}
          onOk={confirm.onOk}
        />
      )}

      {loreEdit && (
        <LoreEditorDialog
          entry={loreEdit.entry}
          kind={loreEdit.kind}
          onClose={() => setLoreEdit(null)}
          onSave={saveLoreEntry}
        />
      )}

      {lorePicker && project && (
        <LorePickerDialog
          entries={project.lore.entries}
          onClose={() => setLorePicker(false)}
          onPick={(entry) => {
            setLorePicker(false);
            insertLore(entry);
          }}
        />
      )}

      {sceneEdit && project && (
        <SceneEditorDialog
          chapter={findChapter(project.outline, sceneEdit.chapterId) ?? null}
          sceneId={sceneEdit.sceneId}
          lore={project.lore}
          chapters={flat}
          onClose={() => setSceneEdit(null)}
          onSave={(scene) => {
            addScene(sceneEdit.chapterId, scene);
            setSceneEdit(null);
          }}
        />
      )}
      {scanOpen && (
        <QrScanner
          onClose={() => setScanOpen(false)}
          onResult={(url) => {
            setScanOpen(false);
            if (!/^https?:\/\//i.test(url)) {
              toast("这个二维码不是 Chapter 的配对地址", { warn: true });
              return;
            }
            void openUrl(url).catch((e) => toast(`打不开配对页：${errText(e)}`, { warn: true }));
          }}
        />
      )}
      {transferOpen && (
        <TransferDialog
          bookPath={transferBookPath}
          outline={project?.outline ?? null}
          onClose={() => setTransferOpen(false)}
          onScan={() => setScanOpen(true)}
          onApplied={(path, appData) => {
            setTransferOpen(false);
            if (appData) applyAppData(appData);
            void openProject(path, { skipSave: true });
            void refreshBooks();
          }}
        />
      )}
      {printStudio && project && (
        <Suspense fallback={null}>
          <PrintStudio
            project={project}
            target={printStudio}
            initialChapter={activeId ?? undefined}
            onClose={() => setPrintStudio(null)}
          />
        </Suspense>
      )}
    </div>
  );
}
function IconPlus() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function IconShrink() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
      <path d="M9 3.5v5.5H3.5M15 20.5V15h5.5M20.5 9H15V3.5M3.5 15H9v5.5" />
    </svg>
  );
}
