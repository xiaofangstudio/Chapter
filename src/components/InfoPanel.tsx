import type { BookMeta, Chapter, SnapshotInfo } from "../types";
import { fmtNumber, fmtTime, fmtWords } from "../lib/text";
import { t, tf } from "../lib/i18n";
import { Icon } from "./Icon";

interface Props {
  meta: BookMeta;
  chapter: Chapter | null;
  bookWords: number;
  todayAdded: number;
  totalChapters: number;
  snapshots: SnapshotInfo[];
  onOpenSnapshots: () => void;
  onSnapshot: () => void;
  onAddScene: () => void;
  onEditScene: (sceneId: string) => void;
  onDeleteScene: (sceneId: string) => void;
}

export function InfoPanel({
  meta,
  chapter,
  bookWords,
  todayAdded,
  totalChapters,
  snapshots,
  onOpenSnapshots,
  onSnapshot,
  onAddScene,
  onEditScene,
  onDeleteScene,
}: Props) {
  const todayPct =
    meta.dailyGoal > 0 ? Math.min(100, Math.round((todayAdded / meta.dailyGoal) * 100)) : 0;
  const totalPct =
    meta.targetWords > 0 ? Math.min(100, Math.round((bookWords / meta.targetWords) * 100)) : 0;
  const remaining = Math.max(0, meta.dailyGoal - todayAdded);

  return (
    <aside className="info-panel">
      <div className="panel-card">
        <div className="panel-title">
          <span>{t("今日")}</span>
          <span style={{ color: "var(--text-3)", letterSpacing: 0 }}>
            {tf("目标 {value} 字", { value: fmtNumber(meta.dailyGoal) })}
          </span>
        </div>
        <div className="stat-row">
          <span>{t("今日新增")}</span>
          <b>
            +{fmtNumber(todayAdded)}
            <small>{t("字")}</small>
          </b>
        </div>
        <div className="panel-bar">
          <i style={{ width: `${todayPct}%` }} />
        </div>
        <div className="panel-note">
          <span>{todayPct >= 100 ? t("今天的目标已经写完") : tf("还差 {count} 字", { count: fmtNumber(remaining) })}</span>
          <span>{todayPct}%</span>
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-title">
          <span>{t("全书")}</span>
          <span style={{ color: "var(--text-3)", letterSpacing: 0 }}>
            {tf("{count} 章", { count: totalChapters })}
          </span>
        </div>
        <div className="stat-row">
          <span>{t("总字数")}</span>
          <b>
            {fmtWords(bookWords)}
            <small>{t("字")}</small>
          </b>
        </div>
        <div className="panel-bar">
          <i style={{ width: `${totalPct}%` }} />
        </div>
        <div className="panel-note">
          <span>{tf("目标 {value} 字", { value: fmtWords(meta.targetWords) })}</span>
          <span>{totalPct}%</span>
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-title">
          <span>{t("本章")}</span>
          <span style={{ color: "var(--text-3)", letterSpacing: 0 }}>
            {chapter ? tf("{words} 字", { words: fmtNumber(chapter.words) }) : t("未选择")}
          </span>
        </div>
        {chapter ? (
          <>
            <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--text)", marginBottom: 8 }}>
              {chapter.title || t("未命名章")}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-3)", lineHeight: 1.7 }}>
              {chapter.summary?.trim() || t("这一章还没有摘要。去大纲里写一句。")}
            </div>
            <div
              style={{
                display: "flex",
                gap: 10,
                marginTop: 9,
                fontSize: 10.5,
                color: "var(--text-3)",
              }}
            >
              <span>{tf("{count} 个场景", { count: chapter.scenes.length })}</span>
              <span>·</span>
              <span>{tf("更新 {time}", { time: fmtTime(chapter.updatedAt) })}</span>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12, color: "var(--text-3)" }}>{t("从左边目录里选一章。")}</div>
        )}
      </div>

      <div className="panel-card">
        <div className="panel-title">
          <span>{t("场景")}</span>
          <button className="link" onClick={onAddScene}>
            {t("+ 新场景")}
          </button>
        </div>
        {chapter && chapter.scenes.length > 0 ? (
          <div>
            {chapter.scenes.map((sc, i) => (
              <div className="scene-mini" key={sc.id}>
                <div className="n">{String(i + 1).padStart(2, "0")}</div>
                <div style={{ flex: 1, minWidth: 0 }} onClick={() => onEditScene(sc.id)}>
                  <div className="t">{sc.title || t("未命名场景")}</div>
                  {sc.summary && <div className="s">{sc.summary}</div>}
                </div>
                <div className="acts">
                  <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => onEditScene(sc.id)} title={t("编辑")}>
                    <Icon name="edit" size={12} />
                  </button>
                  <button
                    className="icon-btn"
                    style={{ width: 22, height: 22 }}
                    onClick={() => onDeleteScene(sc.id)}
                    title={t("删除")}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.7 }}>
            {t("场景是章的骨头。把这一章拆成两三个场景，写起来就不慌。")}
          </div>
        )}
      </div>

      <div className="panel-card">
        <div className="panel-title">
          <span>{t("版本")}</span>
          <button className="link" onClick={onSnapshot}>
            {t("存一版")}
          </button>
        </div>
        {snapshots.length === 0 ? (
          <div style={{ fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.7 }}>
            {t("每次打开这本书都会自动留一版，最多保留 20 个。")}
          </div>
        ) : (
          snapshots.slice(0, 4).map((s) => (
            <div className="snap-row" key={s.name}>
              <Icon name="clock" size={13} />
              <b>{fmtTime(s.createdAt)}</b>
              <span style={{ marginLeft: "auto" }}>{tf("{words} 字", { words: fmtNumber(s.words) })}</span>
            </div>
          ))
        )}
        <button
          className="btn btn-ghost"
          style={{ marginTop: 6, height: 26, fontSize: 11, padding: "0 4px", color: "var(--accent)" }}
          onClick={onOpenSnapshots}
        >
          {t("查看全部版本")}
          <Icon name="arrow" size={12} />
        </button>
      </div>
    </aside>
  );
}
