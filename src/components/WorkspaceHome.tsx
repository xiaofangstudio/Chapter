import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { BookSummary, UiLanguage } from "../types";
import { dateKey, fmtWords, mdToHtml, relTime } from "../lib/text";
import { t } from "../lib/i18n";
import { companionDays, pickWelcome } from "../lib/welcome";
import { Icon } from "./Icon";
import { Logo } from "./Logo";
import { BookStage } from "./BookStage";
import { NovelCover } from "./NovelCover";

interface Props {
  books: BookSummary[];
  covers: Record<string, string>;
  totalWords: number;
  dailyLog: Record<string, number>;
  theme: "light" | "dark";
  onOpen: (book: BookSummary) => void;
  onNew: () => void;
  onImport: () => void;
  onOpenFolder: () => void;
  onSettings: () => void;
  onToggleTheme: () => void;
  onMinimal: () => void;
  language: UiLanguage;
}

type WbPane = "home" | "shelf" | "stats" | "notes";

const PANE_KEY = "chapter.workspacePane";
const PIN_KEY = "chapter.pinnedBook";
const NOTES_KEY = "chapter.workspaceNotes";
const NOTE_PROMPTS = [
  "一句没说出口的台词",
  "一个反复出现的小动作",
  "雨停之后的气味",
  "某个人改不掉的旧习惯",
  "一个不该出现的敲门声",
  "主角最怕别人问起的事",
];

function readStorage(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 存不下就只在本次生效 */
  }
}

function readPin(): string {
  return readStorage(PIN_KEY, "");
}

function readPane(): WbPane {
  const saved = readStorage(PANE_KEY, "home");
  return saved === "shelf" || saved === "stats" || saved === "notes" ? saved : "home";
}

interface Note {
  id: string;
  title: string;
  text: string;
  at: number;
  pinned?: boolean;
}

function noteTitle(text: string): string {
  const first = text
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  return (first || "未命名笔记").slice(0, 42);
}

function readNotes(): Note[] {
  try {
    const parsed = JSON.parse(readStorage(NOTES_KEY, "[]")) as Note[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((n) => n && typeof n.text === "string")
      .map((n, i) => ({
        id: typeof n.id === "string" ? n.id : `n_${i}_${Date.now()}`,
        title: typeof n.title === "string" && n.title.trim() ? n.title : noteTitle(n.text),
        text: n.text,
        at: typeof n.at === "number" ? n.at : Date.now(),
        pinned: Boolean(n.pinned),
      }));
  } catch {
    return [];
  }
}

function tagsOf(text: string): string[] {
  const tags = new Set<string>();
  for (const m of text.matchAll(/#([\p{L}\p{N}_-]{1,24})/gu)) tags.add(m[1]);
  return Array.from(tags).slice(0, 12);
}

function noteSnippet(text: string): string {
  return text
    .replace(/^#+\s*/gm, "")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/(\*\*|__|\*|_|`|~~|>)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
}

function streakOf(log: Record<string, number>): number {
  const d = new Date();
  let n = 0;
  let guard = 0;
  if (!(log[dateKey(d)] > 0)) d.setDate(d.getDate() - 1);
  while (log[dateKey(d)] > 0 && guard < 3650) {
    n += 1;
    d.setDate(d.getDate() - 1);
    guard += 1;
  }
  return n;
}

function coverFor(book: BookSummary, covers: Record<string, string>): string | undefined {
  if (book.coverMode === "default") return undefined;
  return covers[book.path];
}

const PANE_META: Record<WbPane, { label: string; eyebrow: string }> = {
  home: { label: "工作台", eyebrow: "TODAY'S DESK" },
  shelf: { label: "书架", eyebrow: "THE SHELF" },
  stats: { label: "写作统计", eyebrow: "WRITING RHYTHM" },
  notes: { label: "灵感便签", eyebrow: "MARGINS" },
};

export function WorkspaceHome({
  books,
  covers,
  totalWords,
  dailyLog,
  theme,
  onOpen,
  onNew,
  onImport,
  onOpenFolder,
  onSettings,
  onToggleTheme,
  onMinimal,
  language,
}: Props) {
  const now = new Date();
  const locale = document.documentElement.lang || "zh-CN";
  const weekLabels = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) =>
        new Date(2024, 0, 7 + i).toLocaleDateString(locale, { weekday: "short" }),
      ),
    [locale],
  );
  const [pane, setPane] = useState<WbPane>(readPane);
  const [leaving, setLeaving] = useState<WbPane | null>(null);
  const [leaveDir, setLeaveDir] = useState<"up" | "down">("up");
  const leaveTimer = useRef<number | undefined>(undefined);
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [clock, setClock] = useState(new Date());
  const [welcome, setWelcome] = useState(pickWelcome);
  const [pin, setPin] = useState(readPin);
  const [stageOpen, setStageOpen] = useState(false);
  const [stageOrigin, setStageOrigin] = useState<DOMRect | null>(null);
  const [query, setQuery] = useState("");
  const [shelfPage, setShelfPage] = useState(1);
  const PAGE_SIZE = 24;
  const [notes, setNotes] = useState<Note[]>(readNotes);
  const [selectedNote, setSelectedNote] = useState<string | null>(null);
  const [noteSearch, setNoteSearch] = useState("");
  const [notePreview, setNotePreview] = useState(true);
  const [noteSavedAt, setNoteSavedAt] = useState(0);
  const bookCoverRef = useRef<HTMLDivElement | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const noteBodyRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setWelcome(pickWelcome());
  }, [language]);

  useEffect(() => {
    const id = window.setInterval(() => setClock(new Date()), 30000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    writeStorage(PANE_KEY, pane);
  }, [pane]);

  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  useEffect(() => {
    const id = window.setTimeout(() => {
      writeStorage(NOTES_KEY, JSON.stringify(notes));
      setNoteSavedAt(Date.now());
    }, 500);
    return () => window.clearTimeout(id);
  }, [notes]);

  useEffect(() => {
    if (pane !== "notes") return;
    if (selectedNote && notes.some((n) => n.id === selectedNote)) return;
    setSelectedNote(notes[0]?.id ?? null);
  }, [pane, notes, selectedNote]);

  const orderedNotes = useMemo(() => {
    const q = noteSearch.trim().toLowerCase();
    const list = [...notes].sort(
      (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.at - a.at,
    );
    if (!q) return list;
    return list.filter((n) => `${n.title}\n${n.text}`.toLowerCase().includes(q));
  }, [notes, noteSearch]);

  const activeNote = notes.find((n) => n.id === selectedNote) ?? null;
  const activeTags = activeNote ? tagsOf(activeNote.text) : [];

  const addNote = (seed = "") => {
    const id = `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const note: Note = {
      id,
      title: seed ? noteTitle(seed) : "未命名笔记",
      text: seed,
      at: Date.now(),
    };
    setNotes((prev) => [note, ...prev]);
    setSelectedNote(id);
    setNoteSearch("");
  };

  const patchNote = (id: string, patch: Partial<Note>) => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, ...patch } : n)));
  };

  const removeNote = (id: string) => {
    const rest = notes.filter((n) => n.id !== id);
    setNotes(rest);
    if (selectedNote === id) setSelectedNote(rest[0]?.id ?? null);
  };

  const days = useMemo(companionDays, []);
  const current = useMemo(() => {
    const pinned = books.find((b) => b.path === pin);
    if (pinned) return pinned;
    return [...books].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }, [books, pin]);

  const isPinned = Boolean(current && current.path === pin);
  const currentCover = current ? coverFor(current, covers) : undefined;
  const hour = clock.getHours();
  const dateText = clock.toLocaleDateString(locale, { month: "long", day: "numeric", weekday: "long" });
  const timeText = clock.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const weatherIcon = hour >= 6 && hour < 18 ? "sun" : "moon";
  const weatherText = hour >= 6 && hour < 11 ? t("晨光") : hour >= 11 && hour < 18 ? t("晴") : t("夜色");

  const today = dateKey();
  const todayWords = dailyLog[today] ?? 0;
  const streak = useMemo(() => streakOf(dailyLog), [dailyLog]);

  const monthCells = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1);
    const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate();
    const lead = first.getDay();
    const cells: (number | null)[] = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= daysInMonth; d += 1) cells.push(d);
    return cells;
  }, [cursor]);

  const monthWords = useMemo(() => {
    const prefix = `${cursor.y}-${String(cursor.m + 1).padStart(2, "0")}-`;
    return Object.entries(dailyLog)
      .filter(([k]) => k.startsWith(prefix))
      .reduce((n, [, v]) => n + v, 0);
  }, [cursor, dailyLog]);

  const monthDays = useMemo(() => {
    const prefix = `${cursor.y}-${String(cursor.m + 1).padStart(2, "0")}-`;
    return Object.entries(dailyLog).filter(([k, v]) => k.startsWith(prefix) && v > 0).length;
  }, [cursor, dailyLog]);

  const weekBars = useMemo(() => {
    const out: { label: string; value: number; date: string }[] = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = dateKey(d);
      out.push({ label: weekLabels[d.getDay()], value: dailyLog[key] ?? 0, date: key });
    }
    return out;
  }, [dailyLog, weekLabels]);

  const maxBar = Math.max(1, ...weekBars.map((b) => b.value));
  const goal = 2000;
  const pct = Math.min(100, Math.round((todayWords / goal) * 100));

  const last30 = useMemo(() => {
    const out: { key: string; label: string; value: number }[] = [];
    for (let i = 29; i >= 0; i -= 1) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = dateKey(d);
      out.push({
        key,
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        value: dailyLog[key] ?? 0,
      });
    }
    return out;
  }, [dailyLog]);

  const max30 = Math.max(1, ...last30.map((d) => d.value));
  const sum30 = last30.reduce((n, d) => n + d.value, 0);
  const days30 = last30.filter((d) => d.value > 0).length;
  const avg30 = days30 ? Math.round(sum30 / days30) : 0;

  const ranking = useMemo(
    () => [...books].sort((a, b) => b.words - a.words).slice(0, 8),
    [books],
  );
  const maxBookWords = Math.max(1, ...ranking.map((b) => b.words));

  const shelfBooks = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return books;
    return books.filter((b) => `${b.title} ${b.author}`.toLowerCase().includes(q));
  }, [books, query]);
  const shelfPageCount = Math.max(1, Math.ceil(shelfBooks.length / PAGE_SIZE));
  const pagedShelf = useMemo(
    () => shelfBooks.slice((shelfPage - 1) * PAGE_SIZE, shelfPage * PAGE_SIZE),
    [shelfBooks, shelfPage],
  );

  useEffect(() => {
    if (shelfPage > shelfPageCount) setShelfPage(shelfPageCount);
  }, [shelfPage, shelfPageCount]);

  const togglePin = () => {
    if (!current) return;
    const next = isPinned ? "" : current.path;
    setPin(next);
    writeStorage(PIN_KEY, next);
  };

  const paneMeta = PANE_META[pane];
  const paneSubtitle =
    pane === "home"
      ? `${dateText} · ${timeText} · ${weatherText}`
      : pane === "shelf"
        ? `${books.length} ${t("本")} · ${fmtWords(totalWords)} ${t("字")}`
        : pane === "stats"
          ? `${t("近 30 天")} · ${fmtWords(sum30)} ${t("字")}`
          : `${notes.length} ${t("条")} · ${t("只存在这台电脑上")}`;

  const railItems: { key: WbPane; icon: "book" | "outline" | "clock" | "quote"; label: string }[] = [
    { key: "home", icon: "book", label: "工作台" },
    { key: "shelf", icon: "outline", label: "书架" },
    { key: "stats", icon: "clock", label: "写作统计" },
    { key: "notes", icon: "quote", label: "灵感便签" },
  ];

  /**
   * 切换工作台页面：旧页继续留在 DOM 里完成 160ms 离场，新页同时入场。
   * 不克隆整页、不拍浏览器快照，旧页本身就是已经渲染好的节点，切页不再有空白帧。
   */
  const switchPane = (next: WbPane) => {
    if (next === pane) return;
    const order: WbPane[] = ["home", "shelf", "stats", "notes"];
    const dir: "up" | "down" = order.indexOf(next) > order.indexOf(pane) ? "up" : "down";
    const calm =
      document.documentElement.dataset.motion === "off" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.clearTimeout(leaveTimer.current);
    if (calm) {
      setLeaving(null);
      setPane(next);
      return;
    }
    setLeaveDir(dir);
    setLeaving(pane);
    setPane(next);
    leaveTimer.current = window.setTimeout(() => setLeaving(null), 165);
  };

  const paneView = (which: WbPane) => (
which === "home" ? (
          <main className="workbench">
            <div className="wb-glance">
              <div className="wb-glance-left">
                <span className="wb-date">{dateText}</span>
                <span className="wb-clock">{timeText}</span>
                <span className="wb-weather" title={t("按本地时间显示的天气示意")}>
                  <Icon name={weatherIcon} size={14} />
                  {weatherText}
                </span>
              </div>
              <div className="wb-glance-right">
                <span>{t("连续写作")} <b>{streak}</b> {t("天")}</span>
                <i />
                <span>{t("累计")} <b>{fmtWords(totalWords)}</b> {t("字")}</span>
                <i />
                <span>Chapter {t("陪你")} <b>{days}</b> {t("天")}</span>
              </div>
            </div>

            <section className="wb-greeting">
              <p className="wb-eyebrow">{t("今天想写点什么")}</p>
              <h1>{t(welcome)}</h1>
              <div className="wb-quick">
                <button className="btn btn-primary btn-sm" onClick={current ? () => onOpen(current) : onNew}>
                  <Icon name="edit" size={14} />
                  {current ? t("继续写") : t("开始写")}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={onImport}>
                  <Icon name="download" size={14} />
                  {t("导入书稿")}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={onNew}>
                  <Icon name="plus" size={14} />
                  {t("新建书")}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={onOpenFolder}>
                  <Icon name="folder" size={14} />
                  {t("打开工程")}
                </button>
              </div>
            </section>

            <div className="wb-grid">
              <section className="wb-book-card glow-card">
                {current ? (
                  <>
                    <div className="wb-book-head">
                      <span className="wb-kicker">
                        {isPinned ? t("置顶的书") : t("最新更新")}
                      </span>
                      <span className="wb-updated">{relTime(current.updatedAt)}</span>
                    </div>
                    <div
                      className="wb-book-stage"
                      onClick={() => {
                        setStageOrigin(bookCoverRef.current?.getBoundingClientRect() ?? null);
                        setStageOpen(true);
                      }}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setStageOrigin(bookCoverRef.current?.getBoundingClientRect() ?? null);
                          setStageOpen(true);
                        }
                      }}
                      title={t("打开书架")}
                    >
                      <div
                        ref={bookCoverRef}
                        className={`wb-cover-frame${currentCover ? " has-cover" : ""}`}
                        style={{ "--book-spine": current.spineColor || "#6d4a33" } as CSSProperties}
                      >
                        <NovelCover
                          title={current.title}
                          author={current.author}
                          coverUrl={coverFor(current, covers)}
                          template={current.coverStyle}
                          loading="eager"
                        />
                      </div>
                      <span className="wb-open-hint">{t("点开看看")}</span>
                    </div>
                    <div className="wb-book-meta">
                      <div>
                        <h2>{current.title}</h2>
                        <p>
                          {current.author || t("佚名")} · {current.chapterCount} {t("章")} · {fmtWords(current.words)}{" "}
                          {t("字")}
                        </p>
                      </div>
                      <button
                        className={`pin-btn${isPinned ? " on" : ""}`}
                        onClick={togglePin}
                        title={isPinned ? t("取消置顶") : t("置顶这本书")}
                      >
                        <Icon name="pin" size={13} />
                        {isPinned ? t("置顶") : t("置顶")}
                      </button>
                    </div>
                    <div className="wb-progress">
                      <i style={{ width: `${Math.min(100, (current.words / Math.max(1, current.targetWords)) * 100)}%` }} />
                    </div>
                    <div className="wb-book-foot">
                      <span>
                        {t("目标")} {fmtWords(current.targetWords || 200000)} {t("字")}
                      </span>
                      <button className="link-btn" onClick={() => onOpen(current)}>
                        {t("继续写")} <Icon name="arrow" size={12} />
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="dash-empty">
                    <b>{t("书架还是空的")}</b>
                    <p>{t("新建一本，或者把已有的 TXT / Markdown / Word 导入。")}</p>
                    <div>
                      <button className="btn btn-primary btn-sm" onClick={onNew}>
                        {t("新建一本书")}
                      </button>
                      <button className="btn btn-outline btn-sm" onClick={onImport}>
                        {t("导入书稿")}
                      </button>
                    </div>
                  </div>
                )}
              </section>

              <section className="wb-calendar glow-card">
                <div className="dash-card-head">
                  <h2>{t("打卡日历")}</h2>
                  <div className="cal-nav">
                    <button
                      className="icon-btn"
                      onClick={() => setCursor((c) => (c.m === 0 ? { y: c.y - 1, m: 11 } : { ...c, m: c.m - 1 }))}
                      title={t("上个月")}
                    >
                      <Icon name="chevron" size={13} />
                    </button>
                    <span>{new Date(cursor.y, cursor.m, 1).toLocaleDateString(locale, { year: "numeric", month: "long" })}</span>
                    <button
                      className="icon-btn flip"
                      onClick={() => setCursor((c) => (c.m === 11 ? { y: c.y + 1, m: 0 } : { ...c, m: c.m + 1 }))}
                      title={t("下个月")}
                    >
                      <Icon name="chevron" size={13} />
                    </button>
                  </div>
                </div>
                <div className="cal-week">
                  {weekLabels.map((w, i) => (
                    <span key={i}>{w}</span>
                  ))}
                </div>
                <div className="cal-grid">
                  {monthCells.map((d, i) => {
                    if (!d) return <span key={`e${i}`} className="cal-cell empty" />;
                    const key = `${cursor.y}-${String(cursor.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
                    const n = dailyLog[key] ?? 0;
                    const isToday = key === today;
                    return (
                      <span
                        key={key}
                        className={`cal-cell${n ? " wrote" : ""}${isToday ? " today" : ""}`}
                        title={n ? `${key} · ${n} 字` : key}
                      >
                        <b>{d}</b>
                        {n > 0 && <i />}
                      </span>
                    );
                  })}
                </div>
                <div className="wb-cal-summary">
                  <div>
                    <span>{t("本月字数")}</span>
                    <b>{fmtWords(monthWords)}</b>
                  </div>
                  <i />
                  <div>
                    <span>{t("写作天数")}</span>
                    <b>{monthDays} {t("天")}</b>
                  </div>
                  <i />
                  <div>
                    <span>{t("日均")}</span>
                    <b>{fmtWords(monthDays ? Math.round(monthWords / monthDays) : 0)}</b>
                  </div>
                </div>
                <div className="cal-foot">
                  <span>
                    {t("本月")} <b>{fmtWords(monthWords)}</b> {t("字")}
                  </span>
                  <span>
                    {t("连续写作")} <b>{streak}</b> {t("天")}
                  </span>
                </div>
              </section>

              <section className="wb-today glow-card">
                <div className="dash-card-head">
                  <h2>{t("今天")}</h2>
                  <span className="dash-sub">
                    {t("目标")} {fmtWords(goal)} {t("字")}
                  </span>
                </div>
                <div className="wb-today-main">
                  <div className="habit-ring" style={{ "--pct": `${pct}%` } as CSSProperties}>
                    <span>{pct}%</span>
                  </div>
                  <div className="wb-today-text">
                    <b>{fmtWords(todayWords)}</b>
                    <em>{t("字")}</em>
                    <p>{todayWords >= goal ? t("今天的目标完成了。") : `${t("还差")} ${fmtWords(goal - todayWords)} ${t("字")}`}</p>
                  </div>
                </div>
                <div className="week-bars">
                  {weekBars.map((b) => (
                    <div key={b.date} className={`week-bar${b.date === today ? " today" : ""}`}>
                      <span className="bar" style={{ height: `${Math.max(3, (b.value / maxBar) * 54)}px` }} />
                      <em>{b.label}</em>
                    </div>
                  ))}
                </div>
                <p className="wb-today-note">
                  {todayWords > 0
                    ? `${t("今天已经写了")} ${fmtWords(todayWords)} ${t("字")}${streak > 1 ? `，${t("连续")} ${streak} ${t("天")}` : ""}。`
                    : t("还没落笔。哪怕只写一段，也比空白好。")}
                </p>
              </section>
            </div>
          </main>
        ) : which === "shelf" ? (
          <main className="wb-pane wb-shelf">
            <div className="wb-pane-head">
              <div>
                <h1>{t("书架")}</h1>
                <p>{t("所有作品都在这里；点开封面进入介绍页。")}</p>
              </div>
              <div className="wb-pane-actions">
                <label className="wb-search">
                  <Icon name="search" size={14} className="wb-search-icon" />
                  <input
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setShelfPage(1);
                    }}
                    placeholder={t("搜索书名或笔名")}
                  />
                </label>
                <button className="btn btn-primary btn-sm" onClick={onNew}>
                  <Icon name="plus" size={14} />
                  {t("新建书")}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={onImport}>
                  <Icon name="download" size={14} />
                  {t("导入书稿")}
                </button>
              </div>
            </div>

            {shelfBooks.length === 0 ? (
              <div className="wb-pane-empty">
                <Icon name="book" size={26} />
                <b>{books.length ? t("没有找到这本书") : t("书架还是空的")}</b>
                <p>{books.length ? t("换个关键词试试。") : t("新建一本，或者把已有的 TXT / Markdown / Word 导入。")}</p>
              </div>
            ) : (
              <>
              <div className="wb-shelf-grid">
                {pagedShelf.map((b) => (
                  <button key={b.path} className="wb-shelf-card" onClick={() => onOpen(b)}>
                    <div className="wb-shelf-cover">
                      <NovelCover
                        title={b.title}
                        author={b.author}
                        coverUrl={coverFor(b, covers)}
                        template={b.coverStyle}
                        loading="lazy"
                      />
                    </div>
                    <div className="wb-shelf-copy">
                      <h3>{b.title || t("未命名")}</h3>
                      <p>{b.author || t("佚名")}</p>
                      <span>
                        {b.chapterCount} {t("章")} · {fmtWords(b.words)} {t("字")} · {relTime(b.updatedAt)}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
              {shelfPageCount > 1 && (
                <nav className="wb-shelf-pager" aria-label={t("书架分页")}>
                  <button
                    className="wb-pager-step"
                    disabled={shelfPage <= 1}
                    onClick={() => setShelfPage((p) => Math.max(1, p - 1))}
                    title={t("上一页")}
                  >
                    <Icon name="arrow" size={12} />
                  </button>
                  <span>{shelfPage} / {shelfPageCount}</span>
                  <em>{shelfBooks.length} {t("本")}</em>
                  <button
                    className="wb-pager-step next"
                    disabled={shelfPage >= shelfPageCount}
                    onClick={() => setShelfPage((p) => Math.min(shelfPageCount, p + 1))}
                    title={t("下一页")}
                  >
                    <Icon name="arrow" size={12} />
                  </button>
                </nav>
              )}
              </>
            )}
          </main>
        ) : which === "stats" ? (
          <main className="wb-pane wb-stats">
            <div className="wb-pane-head">
              <div>
                <h1>{t("写作统计")}</h1>
                <p>{t("只统计这台电脑上真实写过的字，不做估算。")}</p>
              </div>
            </div>

            <div className="wb-stat-cards">
              <div className="wb-stat-card">
                <span>{t("累计字数")}</span>
                <b>{fmtWords(totalWords)}</b>
                <em>{books.length} {t("本")} · {books.reduce((n, b) => n + b.chapterCount, 0)} {t("章")}</em>
              </div>
              <div className="wb-stat-card">
                <span>{t("连续写作")}</span>
                <b>{streak} <small>{t("天")}</small></b>
                <em>{t("今天")} {fmtWords(todayWords)} {t("字")}</em>
              </div>
              <div className="wb-stat-card">
                <span>{t("近 30 天")}</span>
                <b>{fmtWords(sum30)}</b>
                <em>{days30} {t("个写作日")} · {t("日均")} {fmtWords(avg30)}</em>
              </div>
              <div className="wb-stat-card">
                <span>{t("本月")}</span>
                <b>{fmtWords(monthWords)}</b>
                <em>{monthDays} {t("天")} · {t("日均")} {fmtWords(monthDays ? Math.round(monthWords / monthDays) : 0)}</em>
              </div>
            </div>

            <section className="wb-chart-card glow-card">
              <div className="wb-chart-head">
                <div>
                  <h2>{t("最近 30 天")}</h2>
                  <p>{t("每一根柱子是一天的真实字数。")}</p>
                </div>
                <span className="wb-chart-total">{fmtWords(sum30)} {t("字")}</span>
              </div>
              <div className="wb-chart">
                {last30.map((d) => (
                  <div key={d.key} className={`wb-chart-col${d.value > 0 ? " has" : ""}`}>
                    <i style={{ height: `${Math.max(3, (d.value / max30) * 154)}px` }} />
                    <em>{d.value > 0 ? fmtWords(d.value) : ""}</em>
                    {(d.key === today || d.key.endsWith("-01")) && <span>{d.key === today ? t("今天") : d.label}</span>}
                  </div>
                ))}
              </div>
            </section>

            <section className="wb-rank-card glow-card">
              <div className="wb-chart-head">
                <div>
                  <h2>{t("作品字数")}</h2>
                  <p>{t("按整本书的累计字数排。")}</p>
                </div>
              </div>
              <div className="wb-rank-list">
                {ranking.map((b, i) => (
                  <button key={b.path} className="wb-rank-row" onClick={() => onOpen(b)}>
                    <span className="wb-rank-no">{pad2(i + 1)}</span>
                    <div className="wb-rank-main">
                      <div>
                        <b>{b.title}</b>
                        <em>{fmtWords(b.words)} {t("字")}</em>
                      </div>
                      <i style={{ width: `${Math.max(3, (b.words / maxBookWords) * 100)}%` }} />
                    </div>
                    <Icon name="arrow" size={13} />
                  </button>
                ))}
              </div>
            </section>
          </main>
        ) : (
          <main className="wb-pane wb-notes">
            <div className="wb-pane-head">
              <div>
                <h1>{t("灵感便签")}</h1>
                <p>{t("左边找笔记，右边用 Markdown 写；置顶、标签、实时预览，都只在本地。")}</p>
              </div>
              <span className="wb-notes-count">
                {notes.length} {t("条")}
                {noteSavedAt > 0 && ` · ${t("已自动保存")}`}
              </span>
            </div>

            <div className="wb-note-workspace">
              <aside className="wb-note-list">
                <button className="wb-note-new" onClick={() => addNote()}>
                  <Icon name="plus" size={14} />
                  {t("新建笔记")}
                  <em>⌘N</em>
                </button>
                <label className="wb-note-search">
                  <Icon name="search" size={13} />
                  <input
                    value={noteSearch}
                    onChange={(e) => setNoteSearch(e.target.value)}
                    placeholder={t("搜索标题或正文")}
                  />
                  {noteSearch && (
                    <button onClick={() => setNoteSearch("")} title={t("清空搜索")}>
                      <Icon name="close" size={11} />
                    </button>
                  )}
                </label>
                <div className="wb-note-items" role="listbox" aria-label={t("笔记列表")}>
                  {orderedNotes.map((note) => {
                    const tags = tagsOf(note.text);
                    return (
                      <button
                        key={note.id}
                        role="option"
                        aria-selected={note.id === selectedNote}
                        className={`wb-note-item${note.id === selectedNote ? " on" : ""}`}
                        onClick={() => setSelectedNote(note.id)}
                      >
                        <div className="wb-note-item-title">
                          {note.pinned && <Icon name="pin" size={11} />}
                          <b>{note.title || noteTitle(note.text)}</b>
                        </div>
                        <em>
                          {noteSnippet(note.text) || t("空白笔记")}
                        </em>
                        <footer>
                          <span>{relTime(note.at)}</span>
                          {tags.slice(0, 2).map((tag) => (
                            <i key={tag}>#{tag}</i>
                          ))}
                        </footer>
                      </button>
                    );
                  })}
                  {orderedNotes.length === 0 && notes.length > 0 && (
                    <p className="wb-note-none">{t("没有匹配的笔记")}</p>
                  )}
                </div>
              </aside>

              <section className="wb-note-desk">
                {activeNote ? (
                  <>
                    <div className="wb-note-desk-head">
                      <input
                        className="wb-note-title"
                        value={activeNote.title}
                        onChange={(e) => patchNote(activeNote.id, { title: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            noteBodyRef.current?.focus();
                          }
                        }}
                        placeholder={t("笔记标题")}
                        spellCheck={false}
                      />
                      <div className="wb-note-actions">
                        <button
                          className={`wb-note-act${activeNote.pinned ? " on" : ""}`}
                          onClick={() =>
                            patchNote(activeNote.id, { pinned: !activeNote.pinned })
                          }
                          title={activeNote.pinned ? t("取消置顶") : t("置顶")}
                        >
                          <Icon name="pin" size={14} />
                        </button>
                        <button
                          className={`wb-note-act${notePreview ? " on" : ""}`}
                          onClick={() => setNotePreview((v) => !v)}
                          title={t("切换预览")}
                        >
                          <Icon name="file" size={14} />
                        </button>
                        <button
                          className="wb-note-act danger"
                          onClick={() => removeNote(activeNote.id)}
                          title={t("删除这条便签")}
                        >
                          <Icon name="trash" size={14} />
                        </button>
                      </div>
                    </div>
                    {(activeTags.length > 0 || activeNote.pinned) && (
                      <div className="wb-note-tags">
                        {activeNote.pinned && (
                          <span className="wb-note-pin-tag">
                            <Icon name="pin" size={10} />
                            {t("置顶")}
                          </span>
                        )}
                        {activeTags.map((tag) => (
                          <button key={tag} onClick={() => setNoteSearch(`#${tag}`)}>
                            #{tag}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className={`wb-note-split${notePreview ? "" : " preview-off"}`}>
                      <textarea
                        ref={noteBodyRef}
                        value={activeNote.text}
                        onChange={(e) => {
                          const v = e.target.value;
                          const autoTitle =
                            !activeNote.title.trim() || activeNote.title === "未命名笔记";
                          patchNote(activeNote.id, {
                            text: v,
                            ...(autoTitle ? { title: noteTitle(v) } : {}),
                          });
                        }}
                        placeholder={t("# 从这里开始\n\n一句对白、一个场景、一个念头。支持 #标签、**粗体**、> 引用、- 列表。")}
                        spellCheck={false}
                      />
                      {notePreview && (
                        <div className="wb-note-preview">
                          <div
                            className="wb-note-preview-body"
                            dangerouslySetInnerHTML={{ __html: mdToHtml(activeNote.text) }}
                          />
                        </div>
                      )}
                    </div>
                    <div className="wb-note-foot">
                      <span>{activeNote.text.length} {t("字符")}</span>
                      <span>{activeTags.length} {t("个标签")}</span>
                      <span className="grow" />
                      <span>{t("Markdown · 本地自动保存")}</span>
                    </div>
                  </>
                ) : notes.length === 0 ? (
                  <div className="wb-note-empty">
                    <span className="wb-note-empty-mark">“</span>
                    <h2>{t("从一句开始")}</h2>
                    <p>{t("点一句，直接变成一条 Markdown 笔记，再改成你自己的。")}</p>
                    <div className="wb-note-prompt-grid">
                      {NOTE_PROMPTS.map((prompt) => (
                        <button key={prompt} type="button" onClick={() => addNote(prompt)}>
                          <span>“</span>
                          {t(prompt)}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="wb-note-empty">
                    <h2>{t("没有匹配的笔记")}</h2>
                    <p>{t("换个词搜，或者新建一条。")}</p>
                    <button className="btn btn-outline btn-sm" onClick={() => addNote()}>
                      <Icon name="plus" size={13} />
                      {t("新建笔记")}
                    </button>
                  </div>
                )}
              </section>
            </div>
          </main>
        )
  );

  return (
    <div className={`welcome workspace-home${stageOpen ? " stage-open" : ""}`}>
      <aside className="wb-rail" aria-label={t("工作台导航")}>
        <div className="wb-rail-brand">
          <Logo size={25} className="logo" />
          <div className="wb-rail-brand-text">
            <b>Chapter</b>
            <em>{t("小方工作室 · 小说写作")}</em>
          </div>
        </div>
        <div className="wb-rail-seal">
          <span>CHAPTER</span>
          <i />
          <span>{t("小说 · 写作 · 归档")}</span>
        </div>

        <nav className="wb-rail-nav">
          {railItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`wb-rail-item${pane === item.key ? " on" : ""}`}
              aria-current={pane === item.key ? "page" : undefined}
              onClick={() => switchPane(item.key)}
              title={t(item.label)}
            >
              <Icon name={item.icon} size={16} />
              <span className="wb-rail-label">{t(item.label)}</span>
              {item.key === "notes" && notes.length > 0 && (
                <em className="wb-rail-count">{notes.length}</em>
              )}
            </button>
          ))}
          <button type="button" className="wb-rail-item" onClick={onSettings} title={t("偏好设置")}>
            <Icon name="settings" size={16} />
            <span className="wb-rail-label">{t("偏好设置")}</span>
          </button>
        </nav>

        <div className="wb-rail-spacer" />

        <div className="wb-rail-quote">
          <span className="wb-rail-quote-mark">“</span>
          <p>{t(welcome)}</p>
          <em>{t("今天想写点什么")}</em>
        </div>

        <div className="wb-rail-today">
          <div className="wb-rail-today-head">
            <span>{t("今天")}</span>
            <b>
              {fmtWords(todayWords)} <em>/ {fmtWords(goal)}</em>
            </b>
          </div>
          <div className="wb-rail-progress">
            <i style={{ width: `${pct}%` }} />
          </div>
          <p>
            {t("连续写作")} <b>{streak}</b> {t("天")} · Chapter {t("陪你")} {days} {t("天")}
          </p>
        </div>

        <button className="wb-rail-minimal" onClick={onMinimal}>
          <Icon name="book" size={14} />
          <span>{t("极简模式")}</span>
        </button>
      </aside>

      <div className="wb-main" ref={mainRef}>
        <header className="welcome-top wb-main-top">
          <div className="wb-top-copy">
            <span className="wb-top-eyebrow">CHAPTER / {paneMeta.eyebrow}</span>
            {pane === "home" && <h2>{t(paneMeta.label)}</h2>}
            <p>{paneSubtitle}</p>
          </div>
          <div className="spacer" />
          <button className="home-mode-btn" onClick={onMinimal} title={t("切回极简首页")}>
            <Icon name="book" size={14} />
            {t("极简模式")}
          </button>
          <button className="icon-btn" title={theme === "light" ? t("切到夜幕") : t("切到夕阳")} onClick={onToggleTheme}>
            <Icon name={theme === "light" ? "moon" : "sun"} size={17} />
          </button>
          <button className="icon-btn" title={t("偏好设置")} onClick={onSettings}>
            <Icon name="settings" size={17} />
          </button>
        </header>

        <div className="wb-view-stack">
          {leaving && (
            <div
              key={`leave-${leaving}`}
              className={`wb-view-frame is-leaving leave-${leaveDir}`}
              aria-hidden="true"
            >
              {paneView(leaving)}
            </div>
          )}
          <div key={pane} className={`wb-view-frame enter-${leaveDir}`}>
            {paneView(pane)}
          </div>
        </div>
      </div>

      {stageOpen && current && (
        <BookStage
          books={books}
          covers={covers}
          initialPath={current.path}
          originRect={stageOrigin}
          onClose={() => {
            setStageOpen(false);
            setStageOrigin(null);
          }}
          onEnter={(book) => {
            setStageOpen(false);
            setStageOrigin(null);
            onOpen(book);
          }}
        />
      )}
    </div>
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
