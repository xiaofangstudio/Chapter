import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { BookSummary, UiLanguage } from "../types";
import { dateKey, fmtWords, relTime } from "../lib/text";
import { t } from "../lib/i18n";
import { companionDays, pickWelcome } from "../lib/welcome";
import { Icon } from "./Icon";
import { Logo } from "./Logo";
import { BookObject, BookStage } from "./BookStage";

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

const PIN_KEY = "chapter.pinnedBook";

function readPin(): string {
  try {
    return localStorage.getItem(PIN_KEY) ?? "";
  } catch {
    return "";
  }
}

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
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [clock, setClock] = useState(new Date());
  const [welcome, setWelcome] = useState(pickWelcome);
  useEffect(() => {
    setWelcome(pickWelcome());
  }, [language]);
  const days = useMemo(companionDays, []);
  const [pin, setPin] = useState(readPin);
  const [stageOpen, setStageOpen] = useState(false);
  const bookTiltRef = useRef<HTMLDivElement | null>(null);
  const tiltRaf = useRef(0);
  const tiltNext = useRef({ x: 0, y: 0 });

  const paintTilt = () => {
    tiltRaf.current = 0;
    if (bookTiltRef.current) {
      bookTiltRef.current.style.transform = `rotateX(${tiltNext.current.x}deg) rotateY(${tiltNext.current.y}deg)`;
    }
  };
  const onBookMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = (e.clientX - rect.left) / rect.width - 0.5;
    const cy = (e.clientY - rect.top) / rect.height - 0.5;
    tiltNext.current = { x: -cy * 4, y: cx * 10 };
    if (!tiltRaf.current) tiltRaf.current = requestAnimationFrame(paintTilt);
  };
  const resetTilt = () => {
    tiltNext.current = { x: 0, y: 0 };
    if (bookTiltRef.current) bookTiltRef.current.style.transform = "rotateX(0deg) rotateY(0deg)";
  };

  useEffect(() => {
    const id = window.setInterval(() => setClock(new Date()), 30000);
    return () => window.clearInterval(id);
  }, []);

  const current = useMemo(() => {
    const pinned = books.find((b) => b.path === pin);
    if (pinned) return pinned;
    return [...books].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }, [books, pin]);

  const isPinned = Boolean(current && current.path === pin);
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
    const days = new Date(cursor.y, cursor.m + 1, 0).getDate();
    const lead = first.getDay();
    const cells: (number | null)[] = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= days; d += 1) cells.push(d);
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

  const togglePin = () => {
    if (!current) return;
    const next = isPinned ? "" : current.path;
    setPin(next);
    try {
      if (next) localStorage.setItem(PIN_KEY, next);
      else localStorage.removeItem(PIN_KEY);
    } catch {
      /* 存不下就只在本次生效 */
    }
  };

  return (
    <div className={`welcome workspace-home${stageOpen ? " stage-open" : ""}`}>
      <header className="welcome-top">
        <div className="brand">
          <Logo size={26} className="logo" />
          <span className="brand-word">Chapter</span>
          <span className="brand-sub">{t("小方工作室 · 小说写作工作台")}</span>
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
                  onPointerMove={onBookMove}
                  onPointerLeave={resetTilt}
                  onClick={() => setStageOpen(true)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setStageOpen(true);
                    }
                  }}
                  title={t("打开 3D 书架")}
                >
                  <div
                    ref={bookTiltRef}
                    className="wb-book-tilt"
                  >
                    <BookObject book={current} coverUrl={covers[current.path]} />
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

      {stageOpen && current && (
        <BookStage
          books={books}
          covers={covers}
          initialPath={current.path}
          onClose={() => setStageOpen(false)}
          onEnter={(book) => {
            setStageOpen(false);
            onOpen(book);
          }}
        />
      )}
    </div>
  );
}
