import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import type {
  AccentTheme,
  BookMeta,
  BookSummary,
  Chapter,
  HomeMode,
  ImportDoc,
  LightEffect,
  Lore,
  LoreEntry,
  LoreKind,
  MotionMode,
  Outline,
  PaperTexture,
  Project,
  RawProject,
  SaveState,
  SnapshotInfo,
  ThemeMode,
  UiLanguage,
  ViewKind,
  Volume,
} from "./types";
import { LANGUAGES } from "./types";
import { api, errText } from "./lib/api";
performance.mark?.("chapter:app-module");
import { countWords, dateKey } from "./lib/text";
import { ensureUiPack, setUiLanguage, t, tf } from "./lib/i18n";
import { useProximityGlow } from "./lib/glow";
import { Splash } from "./components/Splash";
import { AmbientBackdrop, type AmbienceScene } from "./components/AmbientBackdrop";
import { Welcome } from "./components/Welcome";
import { WorkspaceHome } from "./components/WorkspaceHome";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import type { EditorHandle } from "./components/Editor";
import { InfoPanel } from "./components/InfoPanel";
import {
  BookMetaDialog,
  ConfirmDialog,
  ExportDialog,
  LoreEditorDialog,
  LorePickerDialog,
  NewBookDialog,
  PromptDialog,
  SnapshotDialog,
  SceneEditorDialog,
} from "./components/Modals";
import { CoverCropDialog } from "./components/CoverCropDialog";
import { CoverPickerDialog } from "./components/CoverPickerDialog";

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
              };
            }),
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
    ...safeParse(raw.book, {}),
  };
  const outline = normalizeOutline(safeParse(raw.outline, { volumes: [] }));
  const lore = normalizeLore(safeParse(raw.lore, { entries: [] }));
  const bodies: Record<string, string> = {};
  raw.chapters.forEach((c) => {
    bodies[c.id] = c.body ?? "";
  });
  outline.volumes.forEach((v) =>
    v.chapters.forEach((c) => {
      if (bodies[c.id] === undefined) bodies[c.id] = "";
    }),
  );
  return { path: raw.path, meta, outline, lore, bodies };
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

export default function App() {
  useProximityGlow();
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [library, setLibrary] = useState("");
  const [booting, setBooting] = useState(true);
  const [splashLeaving, setSplashLeaving] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [view, setView] = useState<ViewKind>("write");
  const [focus, setFocus] = useState(false);
  const [panel, setPanel] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [themeMode, setThemeMode] = useState<ThemeMode>(
    readLS("chapter.theme", "system") as ThemeMode,
  );
  const [accent, setAccent] = useState<AccentTheme>(
    readLS("chapter.accent", "amber") as AccentTheme,
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
  const [dailyLog, setDailyLog] = useState<Record<string, number>>(() => {
    try {
      const parsed = JSON.parse(readLS("chapter.daily", "{}")) as Record<string, number>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  });
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

  const [toasts, setToasts] = useState<
    { id: number; text: string; warn?: boolean; leaving?: boolean; action?: { label: string; run: () => void } }[]
  >([]);

  const toastSeq = useRef(0);
  const projectRef = useRef<Project | null>(null);
  const activeRef = useRef<string | null>(null);
  const editorRef = useRef<EditorHandle | null>(null);
  const lastSaved = useRef<Record<string, string>>({});
  const outlineTimer = useRef<number | undefined>(undefined);
  const bookOutlineTimer = useRef<number | undefined>(undefined);
  const savedTimer = useRef<number | undefined>(undefined);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const saveStateRef = useRef<SaveState>("idle");

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

  const openSettings = useCallback(
    (section: "appearance" | "writing" | "ai" | "git" | "about" = "appearance") => {
      setSettingsSection(section);
      setModal("shelfSettings");
    },
    [],
  );

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
    document.documentElement.dataset.accent = accent;
    try {
      localStorage.setItem("chapter.accent", accent);
    } catch {
      /* ignore */
    }
  }, [accent]);

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
      await loadCovers(list);
    } catch (e) {
      toast(`读取书架失败：${errText(e)}`, { warn: true });
    }
  }, [loadCovers, toast]);

  useEffect(() => {
    let alive = true;
    performance.mark?.("chapter:boot-start");
    (async () => {
      try {
        const lib = await api.library();
        if (alive) setLibrary(lib);
        const list = await api.listBooks();
        performance.mark?.("chapter:boot-data");
        if (alive) {
          setBooks(list);
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
    async (path: string) => {
      try {
        if (projectRef.current) await saveAll(true);
        const raw = await api.openBook(path);
        const p = parseProject(raw);
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
        window.setTimeout(() => {
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

  const backToShelf = useCallback(async () => {
    await saveAll(true);
    setProject(null);
    setActiveId(null);
    setFocus(false);
    setView("write");
    setIntro(true);
    await api.mcpSetProject(null).catch(() => undefined);
    await refreshBooks();
  }, [refreshBooks, saveAll]);

  /** 外部工具（MCP / Git）改过磁盘后，只重读当前工程，不替用户写回任何东西。 */
  const reloadFromDisk = useCallback(async (focusChapter?: string) => {
    const p = projectRef.current;
    if (!p) return;
    try {
      const raw = await api.openBook(p.path);
      const fresh = parseProject(raw);
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
    (v: ViewKind) => {
      if (v !== "write" && view === "write") {
        editorRef.current?.flush();
        void saveAll(true);
      }
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
        const meta = { ...p.meta, lastChapterId: id };
        commit({ ...p, meta });
        api.saveJson(p.path, "book.json", JSON.stringify(meta)).catch(() => undefined);
      }
      window.setTimeout(() => editorRef.current?.focus(), 120);
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
        const meta = { ...p.meta, lastChapterId: id };
        commit({ ...p, meta });
        api.saveJson(p.path, "book.json", JSON.stringify(meta)).catch(() => undefined);
      }
      window.setTimeout(() => editorRef.current?.focus(), 160);
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

  const addVolume = useCallback(() => {
    const p = projectRef.current;
    if (!p) return;
    const id = `v_${Date.now()}`;
    const title = `第${p.outline.volumes.length + 1}卷`;
    applyOutline((o) => {
      o.volumes.push({ id, title, collapsed: false, chapters: [] });
      return o;
    });
    toast("已新建一卷");
  }, [applyOutline, toast]);

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
      const title = `第${vol.chapters.length + 1}章`;
      const ch: Chapter = {
        id,
        title,
        summary: "",
        scenes: [],
        words: 0,
        updatedAt: Date.now(),
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
      window.setTimeout(() => editorRef.current?.focus(), 120);
    },
    [commit, saveAll, scheduleOutline, toast],
  );

  const addScene = useCallback((chapterId: string, scene?: { id: string; title: string; summary: string }) => {
    const p = projectRef.current;
    if (!p) return;
    const chapter = findChapter(p.outline, chapterId);
    if (!chapter) return;
    const id = scene?.id ?? `s_${Date.now()}`;
    const title = scene?.title ?? "";
    const summary = scene?.summary ?? "";
    applyOutline((o) => {
      const v = o.volumes.find((vv) => vv.chapters.some((c) => c.id === chapterId));
      const c = v?.chapters.find((cc) => cc.id === chapterId);
      if (!c) return o;
      const idx = c.scenes.findIndex((s) => s.id === id);
      if (idx >= 0) c.scenes[idx] = { ...c.scenes[idx], title, summary };
      else c.scenes.push({ id, title, summary });
      return o;
    });
    void p;
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
          applyOutline((o) => {
            const c = allChapters(o).find((x) => x.id === chapterId);
            if (c) c.title = value;
            return o;
          });
          const body = p.bodies[chapterId] ?? "";
          api.saveChapter(p.path, chapterId, value, body).catch(() => undefined);
          setPrompt(null);
        },
      });
    },
    [applyOutline],
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
            await api.deleteChapter(fresh.path, chapterId);
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
    [commit, saveAll, scheduleOutline, toast],
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
          applyOutline((o) => {
            const v = o.volumes.find((x) => x.id === volId);
            if (v) v.title = value;
            return o;
          });
          setPrompt(null);
        },
      });
    },
    [applyOutline],
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
          commit({ ...fresh, outline });
          scheduleOutline(outline);
          if (activeRef.current && !findChapter(outline, activeRef.current)) {
            setActiveId(firstChapterId(outline));
          }
          toast("已删除本卷");
        },
      });
    },
    [commit, saveAll, scheduleOutline, toast],
  );

  const moveChapter = useCallback(
    (chId: string, toVol: string, beforeId: string | null) => {
      const p = projectRef.current;
      if (!p || chId === beforeId) return;
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
    [applyOutline],
  );

  const moveVolume = useCallback(
    (fromId: string, toId: string) => {
      if (fromId === toId) return;
      applyOutline((o) => {
        const from = o.volumes.findIndex((v) => v.id === fromId);
        const to = o.volumes.findIndex((v) => v.id === toId);
        if (from < 0 || to < 0) return o;
        const [v] = o.volumes.splice(from, 1);
        o.volumes.splice(to, 0, v);
        return o;
      });
    },
    [applyOutline],
  );

  const moveScene = useCallback(
    (chId: string, sceneId: string, beforeId: string | null) => {
      if (sceneId === beforeId) return;
      applyOutline((o) => {
        const c = allChapters(o).find((x) => x.id === chId);
        if (!c) return o;
        const idx = c.scenes.findIndex((s) => s.id === sceneId);
        if (idx < 0) return o;
        const [s] = c.scenes.splice(idx, 1);
        const bi = beforeId ? c.scenes.findIndex((x) => x.id === beforeId) : -1;
        if (bi >= 0) c.scenes.splice(bi, 0, s);
        else c.scenes.push(s);
        return o;
      });
    },
    [applyOutline],
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

  const saveLore = useCallback(
    (lore: Lore) => {
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
      saveLore({ entries });
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
          saveLore({ entries: p.lore.entries.filter((e) => e.id !== entry.id) });
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
      title: string;
      author: string;
      description: string;
      spineColor?: string;
    }) => {
      const p = projectRef.current;
      if (!p) return;
      const meta = { ...p.meta, ...patch, updatedAt: Date.now() };
      commit({ ...p, meta });
      persistJson("book.json", meta);
      await refreshBooks();
      toast("书籍信息已更新");
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
    async (title: string, author: string, target: number, goal: number, template: "blank" | "three") => {
      setModal(null);
      try {
        const raw = await api.createBook(title, author, target, goal);
        let p = parseProject(raw);
        if (template === "three") {
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
        toast(`《${title}》已建好，开始写吧`);
        window.setTimeout(() => editorRef.current?.focus(), 300);
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
        window.setTimeout(() => editorRef.current?.focus(), 180);
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
      const ext = format;
      try {
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

  const bookWords = useMemo(
    () => flat.reduce((n, c) => n + (c.words ?? 0), 0),
    [flat],
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
      {project ? (
        intro ? (
          <Suspense fallback={<div className="lazy-fallback">{t("正在翻开这本书…")}</div>}>
          <BookIntroPage
            meta={project.meta}
            outline={project.outline}
            coverUrl={coverUrl}
            activeId={activeId}
            theme={theme}
            onBack={backToShelf}
            onSelectChapter={(id) => void enterChapter(id)}
            onBookSettings={() => setMetaDialog(true)}
            onPickCover={openCoverPicker}
            onToggleTheme={() => setThemeMode(theme === "light" ? "dark" : "light")}
            onSettings={() => openSettings()}
            onAddVolume={addVolume}
          />
          </Suspense>
        ) : (
        <div className={`workspace${focus ? " focus" : ""}`}>
          <TopBar
            meta={project.meta}
            coverUrl={coverUrl}
            saveState={saveState}
            view={view}
            panel={panel}
            theme={theme}
            onView={changeView}
            onTogglePanel={() => setPanel((p) => !p)}
            onToggleTheme={() => setThemeMode(theme === "light" ? "dark" : "light")}
            onSettings={() => openSettings()}
            onExport={() => {
              void saveAll(true);
              setModal("export");
            }}
            onImport={() => void pickImport("append")}
            onSnapshots={() => {
              void loadSnapshots(project.path);
              setModal("snapshots");
            }}
            onVersions={() => openSettings("git")}
            onBack={backToShelf}
            onBookSettings={() => setMetaDialog(true)}
            onPickCover={openCoverPicker}
            onDeleteBook={deleteBook}
          />

          <div className="ws-body">
            <Sidebar
              outline={project.outline}
              activeId={activeId}
              bookWords={bookWords}
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

            <main className="stage">
              <Suspense fallback={<div className="lazy-fallback">{t("正在准备写作台…")}</div>}>
              {view === "write" &&
                (activeChapter ? (
                  <Editor
                    key={`${project.path}:${activeChapter.id}:${editorEpoch}`}
                    chapter={activeChapter}
                    body={project.bodies[activeChapter.id] ?? ""}
                    meta={project.meta}
                    index={chapterIndex >= 0 ? chapterIndex : 0}
                    total={flat.length}
                    bookWords={bookWords}
                    todayAdded={todayAdded}
                    focusMode={focus}
                    apiRef={editorRef}
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
                  outline={project.outline}
                  activeId={activeId}
                  onOpen={selectChapter}
                  onSummary={updateSummary}
                  onMoveChapter={moveChapter}
                  onAddChapter={addChapter}
                  onAddVolume={addVolume}
                  onRenameChapter={renameChapter}
                  onDeleteChapter={deleteChapter}
                  onRenameVolume={renameVolume}
                />
              )}

              {view === "bookOutline" && (
                <BookOutline
                  meta={project.meta}
                  chapters={flat}
                  onChange={updateBookOutline}
                  onSave={saveBookOutlineNow}
                />
              )}

              {view === "lore" && (
                <LoreView
                  lore={project.lore}
                  onAdd={(kind) => setLoreEdit({ entry: null, kind })}
                  onEdit={(entry) => setLoreEdit({ entry, kind: entry.kind })}
                  onDelete={deleteLoreEntry}
                  onInsert={insertLore}
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
          covers={covers}
          totalWords={books.reduce((n, b) => n + b.words, 0)}
          dailyLog={dailyLog}
          theme={theme}
          onOpen={(b) => openProject(b.path)}
          onNew={() => setModal("new")}
          onImport={() => void pickImport("new")}
          onOpenFolder={openExisting}
          onSettings={() => openSettings()}
          onToggleTheme={() => setThemeMode(theme === "light" ? "dark" : "light")}
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
          onWorkspace={() => setHomeMode("workspace")}
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
          onToggleTheme={() => setThemeMode(theme === "light" ? "dark" : "light")}
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
          onPickFile={chooseCoverFile}
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
          onClose={() => setMetaDialog(false)}
          onSave={(patch) => saveBookMeta(patch)}
        />
      )}

      {modal === "export" && project && (
        <ExportDialog
          meta={project.meta}
          chapters={flat.length}
          words={bookWords}
          onClose={closeModal}
          onExport={doExport}
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
            onTheme={setThemeMode}
            onMotion={setMotion}
            onHomeMode={setHomeMode}
            onLanguage={setLanguage}
            onPaper={setPaper}
            onAccent={setAccent}
            onLightEffect={setLightEffect}
            onPickBg={pickBackground}
            onClearBg={clearBackground}
            onSaveGoals={saveGoals}
            onChangeLibrary={changeLibrary}
            onMcpEnabled={setMcpEnabled}
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
          onClose={() => setSceneEdit(null)}
          onSave={(scene) => {
            addScene(sceneEdit.chapterId, scene);
            setSceneEdit(null);
          }}
        />
      )}
    </div>
  );
}

/* 极简内联图标，避免为两个按钮多开依赖 */
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
