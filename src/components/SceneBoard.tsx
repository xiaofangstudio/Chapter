import { useMemo, useRef, useState } from "react";
import type { Lore, Outline, Scene } from "../types";
import { t } from "../lib/i18n";
import { Icon } from "./Icon";

interface Props {
  outline: Outline;
  lore: Lore;
  onOpenChapter: (id: string) => void;
  onAddScene: (chapterId: string) => void;
  onEditScene: (chapterId: string, sceneId: string) => void;
  onMoveScene: (fromChapterId: string, sceneId: string, toChapterId: string, beforeId: string | null) => void;
  onBack: () => void;
}

function sortScenes(scenes: Scene[]): Scene[] {
  return [...scenes].sort((a, b) => {
    const ao = a.timeOrder ?? a.order ?? 0;
    const bo = b.timeOrder ?? b.order ?? 0;
    if (ao !== bo) return ao - bo;
    return (a.order ?? 0) - (b.order ?? 0);
  });
}

export function SceneBoard({
  outline,
  lore,
  onOpenChapter,
  onAddScene,
  onEditScene,
  onMoveScene,
  onBack,
}: Props) {
  const [mode, setMode] = useState<"chapter" | "timeline" | "place">("chapter");
  const [drag, setDrag] = useState<{ chapterId: string; sceneId: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const holdTimer = useRef<number | null>(null);

  const chapters = useMemo(
    () => outline.volumes.flatMap((v) => v.chapters.map((c) => ({ ...c, volumeTitle: v.title }))),
    [outline],
  );
  const places = useMemo(() => {
    const set = new Set<string>();
    chapters.forEach((c) => c.scenes.forEach((s) => s.place && set.add(s.place)));
    return ["未标地点", ...Array.from(set)];
  }, [chapters]);

  const dropBefore = (chapterId: string, beforeId: string | null) => {
    if (!drag) return;
    const targetChapter =
      chapters.find((c) => c.scenes.some((s) => s.id === beforeId))?.id ?? chapterId;
    if (!targetChapter) return;
    onMoveScene(drag.chapterId, drag.sceneId, targetChapter, beforeId);
    setDrag(null);
    setOver(null);
  };

  const startLongPress = (chapterId: string, sceneId: string) => {
    window.clearTimeout(holdTimer.current ?? undefined);
    holdTimer.current = window.setTimeout(() => setDrag({ chapterId, sceneId }), 360);
  };

  const clearLongPress = () => {
    window.clearTimeout(holdTimer.current ?? undefined);
    holdTimer.current = null;
  };

  const column = (key: string, title: string, scenes: Scene[], chapterId: string, canAdd = true) => (
    <section
      className={`scene-col${over === key ? " over" : ""}`}
      key={key}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(key);
      }}
      onDragLeave={() => setOver((x) => (x === key ? null : x))}
      onDrop={(e) => {
        e.preventDefault();
        const before = (e.target as HTMLElement).closest<HTMLElement>("[data-scene-id]")?.dataset.sceneId ?? null;
        dropBefore(chapterId, before);
      }}
    >
      <header>
        <div>
          <b>{title}</b>
          <span>{scenes.length} 场</span>
        </div>
        {canAdd && (
          <button className="btn btn-ghost btn-sm" onClick={() => onAddScene(chapterId)}>
            <Icon name="plus" size={12} />
          </button>
        )}
      </header>
      <div className="scene-col-list">
        {scenes.length === 0 && (
          <div className="scene-col-empty">
            <span>{t("还没有场景")}</span>
            {canAdd && (
              <button className="btn btn-outline btn-sm" onClick={() => onAddScene(chapterId)}>
                <Icon name="plus" size={12} /> {t("添加场景")}
              </button>
            )}
          </div>
        )}
        {scenes.map((s) => (
          <article
            key={s.id}
            data-scene-id={s.id}
            className={`scene-card${drag?.sceneId === s.id ? " dragging" : ""}`}
            style={{ borderLeftColor: s.color || "#7c9a82" }}
            draggable={!!chapterId}
            onDragStart={() => chapterId && setDrag({ chapterId: s.chapterId || chapterId, sceneId: s.id })}
            onDragEnd={() => {
              setDrag(null);
              setOver(null);
            }}
            onPointerDown={() => chapterId && startLongPress(s.chapterId || chapterId, s.id)}
            onPointerUp={clearLongPress}
            onPointerLeave={clearLongPress}
            onPointerCancel={clearLongPress}
            onPointerMove={(e) => {
              if (!drag || drag.sceneId !== s.id) return;
              if (e.pointerType === "mouse") return;
              const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-scene-id]");
              const targetId = el?.dataset.sceneId;
              if (targetId && targetId !== s.id) {
                const targetChapter = chapters.find((c) => c.scenes.some((x) => x.id === targetId));
                if (targetChapter) {
                  onMoveScene(s.chapterId || chapterId, s.id, targetChapter.id, targetId);
                  setDrag(null);
                }
              }
            }}
            onClick={() => onEditScene(s.chapterId || chapterId, s.id)}
          >
            <div className="scene-card-top">
              <span className="scene-time">{s.timeText || t("未标时间")}</span>
              {s.place && <span className="scene-place">{s.place}</span>}
            </div>
            <b>{s.title || t("未命名场景")}</b>
            {s.summary && <p>{s.summary}</p>}
            {(s.characterIds?.length ?? 0) > 0 && (
              <div className="scene-cast">
                {s.characterIds!.slice(0, 4).map((id) => (
                  <span key={id}>{lore.entries.find((e) => e.id === id)?.name ?? "?"}</span>
                ))}
                {s.characterIds!.length > 4 && <em>+{s.characterIds!.length - 4}</em>}
              </div>
            )}
            <div className="scene-card-actions">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenChapter(s.chapterId || chapterId);
                }}
              >
                {t("去写这一章")}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );

  return (
    <div className="scene-board">
      <div className="scene-board-head">
        <div>
          <span className="eyebrow">{t("场景板")}</span>
          <h2>{t("把每场戏摆在桌面上")}</h2>
          <p>{t("按章节、时间或地点查看；拖动只改顺序和归属，不改正文。")}</p>
        </div>
        <button className="btn btn-outline" onClick={onBack}>
          <Icon name="outline" size={13} />
          {t("回章节大纲")}
        </button>
      </div>
      <div className="scene-board-bar">
        <div className="scene-board-tabs">
          {(
            [
              ["chapter", "按章节"],
              ["timeline", "按时间"],
              ["place", "按地点"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={mode === k ? "on" : ""} onClick={() => setMode(k)}>
              {t(label)}
            </button>
          ))}
        </div>
        <span className="scene-board-tip">{drag ? t("松手放到目标章节") : t("按住卡片可拖动")}</span>
      </div>

      {mode === "chapter" && (
        <div className="scene-columns">
          {chapters.map((c) =>
            column(c.id, c.title, sortScenes(c.scenes).map((s) => ({ ...s, chapterId: c.id })), c.id),
          )}
          {chapters.length === 0 && <div className="scene-board-empty">{t("先建一章，再来摆场景。")}</div>}
        </div>
      )}

      {mode === "timeline" && (
        <div className="scene-columns single">
          {column(
            "timeline-all",
            t("全书时间线"),
            chapters
              .flatMap((c) => c.scenes.map((s) => ({ ...s, chapterId: c.id })))
              .sort((a, b) => (a.timeOrder ?? a.order ?? 0) - (b.timeOrder ?? b.order ?? 0)),
            "",
            false,
          )}
        </div>
      )}

      {mode === "place" && (
        <div className="scene-columns">
          {places.map((place) =>
            column(
              `place-${place}`,
              place,
              chapters.flatMap((c) =>
                sortScenes(c.scenes)
                  .filter((s) => (place === "未标地点" ? !s.place : s.place === place))
                  .map((s) => ({ ...s, chapterId: c.id })),
              ),
              chapters[0]?.id ?? "",
              false,
            ),
          )}
        </div>
      )}
    </div>
  );
}
