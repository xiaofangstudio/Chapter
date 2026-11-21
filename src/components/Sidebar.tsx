import { useState } from "react";
import type { Outline } from "../types";
import { fmtNumber, fmtWords } from "../lib/text";
import { t, tf } from "../lib/i18n";
import { Icon } from "./Icon";
import { ContextMenu, type MenuItem } from "./ContextMenu";

type DragPayload =
  | { kind: "chapter"; id: string; parent: string }
  | { kind: "volume"; id: string }
  | { kind: "scene"; id: string; parent: string };

interface Props {
  outline: Outline;
  activeId: string | null;
  bookWords: number;
  onSelectChapter: (id: string) => void;
  onToggleVolume: (id: string) => void;
  onAddVolume: () => void;
  onAddChapter: (volId: string) => void;
  onAddScene: (chId: string) => void;
  onRenameChapter: (chId: string) => void;
  onDeleteChapter: (chId: string) => void;
  onRenameVolume: (volId: string) => void;
  onDeleteVolume: (volId: string) => void;
  onMoveChapter: (chId: string, toVol: string, beforeId: string | null) => void;
  onMoveVolume: (fromId: string, toId: string) => void;
  onMoveScene: (chId: string, sceneId: string, beforeId: string | null) => void;
}

export function Sidebar(props: Props) {
  const {
    outline,
    activeId,
    bookWords,
    onSelectChapter,
    onToggleVolume,
    onAddVolume,
    onAddChapter,
    onAddScene,
    onRenameChapter,
    onDeleteChapter,
    onRenameVolume,
    onDeleteVolume,
    onMoveChapter,
    onMoveVolume,
    onMoveScene,
  } = props;

  const [drag, setDrag] = useState<DragPayload | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const chapterCount = outline.volumes.reduce((n, v) => n + v.chapters.length, 0);

  const startDrag = (e: React.DragEvent, p: DragPayload) => {
    setDrag(p);
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("application/x-chapter", JSON.stringify(p));
      e.dataTransfer.setData("text/plain", p.kind);
    } catch {
      /* ignore */
    }
  };

  const readDrag = (e: React.DragEvent): DragPayload | null => {
    try {
      const raw = e.dataTransfer.getData("application/x-chapter");
      if (raw) return JSON.parse(raw) as DragPayload;
    } catch {
      /* ignore */
    }
    return drag;
  };

  const clear = () => {
    setDrag(null);
    setOver(null);
  };

  const chapterMenu = (chId: string, volId: string, x: number, y: number) => {
    setMenu({
      x,
      y,
      items: [
        { label: t("添加场景"), icon: "plus", onClick: () => onAddScene(chId) },
        { label: t("添加一章"), icon: "plus", onClick: () => onAddChapter(volId) },
        { label: t("重命名"), icon: "edit", onClick: () => onRenameChapter(chId) },
        { label: t("删除本章"), icon: "trash", danger: true, onClick: () => onDeleteChapter(chId) },
      ],
    });
  };

  const volumeMenu = (volId: string, x: number, y: number) => {
    setMenu({
      x,
      y,
      items: [
        { label: t("添加一章"), icon: "plus", onClick: () => onAddChapter(volId) },
        { label: t("重命名本卷"), icon: "edit", onClick: () => onRenameVolume(volId) },
        { label: t("删除本卷"), icon: "trash", danger: true, onClick: () => onDeleteVolume(volId) },
      ],
    });
  };

  return (
    <aside className="sidebar">
      <div className="tree-head">
        <div className="tree-title">
          <span>{t("目录")}</span>
          <em>
            {tf("{count} 章 · {words} 字", { count: chapterCount, words: fmtWords(bookWords) })}
          </em>
        </div>
        <button className="icon-btn" title={t("新建一卷")} onClick={onAddVolume} style={{ width: 24, height: 24 }}>
          <Icon name="plus" size={15} />
        </button>
      </div>

      <div className="tree-scroll" onDragLeave={() => setOver(null)}>
        {outline.volumes.map((vol) => {
          const isCollapsed = collapsed[vol.id] ?? vol.collapsed;
          return (
            <div key={vol.id}>
              <div
                className={`vol-row${over === `v:${vol.id}` ? " drag-over" : ""}`}
                draggable
                onDragStart={(e) => startDrag(e, { kind: "volume", id: vol.id })}
                onDragEnd={clear}
                onDragOver={(e) => {
                  if (drag?.kind !== "volume" && drag?.kind !== "chapter") return;
                  e.preventDefault();
                  setOver(`v:${vol.id}`);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const p = readDrag(e);
                  if (!p) return;
                  if (p.kind === "volume") onMoveVolume(p.id, vol.id);
                  else if (p.kind === "chapter") onMoveChapter(p.id, vol.id, null);
                  clear();
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  volumeMenu(vol.id, e.clientX, e.clientY);
                }}
              >
                <button
                  className={`vol-caret${isCollapsed ? "" : " open"}`}
                  onClick={() =>
                    setCollapsed((c) => {
                      const next = { ...c, [vol.id]: !isCollapsed };
                      onToggleVolume(vol.id);
                      return next;
                    })
                  }
                  title={isCollapsed ? "展开" : "收起"}
                >
                  <Icon name="chevron" size={13} />
                </button>
                <span className="vol-name">{vol.title || "未命名卷"}</span>
                <span className="vol-count">{vol.chapters.length}</span>
                <button
                  className="row-add"
                  title="在本卷添加一章"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAddChapter(vol.id);
                  }}
                >
                  <Icon name="plus" size={13} />
                </button>
              </div>

              {!isCollapsed &&
                vol.chapters.map((ch) => (
                  <div key={ch.id}>
                    <div
                      className={`ch-row${ch.id === activeId ? " active" : ""}${
                        over === `c:${ch.id}` ? " drag-over" : ""
                      }`}
                      draggable
                      onClick={() => onSelectChapter(ch.id)}
                      onDragStart={(e) => startDrag(e, { kind: "chapter", id: ch.id, parent: vol.id })}
                      onDragEnd={clear}
                      onDragOver={(e) => {
                        if (!drag || drag.kind === "scene") return;
                        e.preventDefault();
                        setOver(`c:${ch.id}`);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const p = readDrag(e);
                        if (!p) return;
                        if (p.kind === "chapter" && p.id !== ch.id) onMoveChapter(p.id, vol.id, ch.id);
                        else if (p.kind === "volume") onMoveVolume(p.id, vol.id);
                        clear();
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        chapterMenu(ch.id, vol.id, e.clientX, e.clientY);
                      }}
                    >
                      <span className="ch-name">{ch.title || "未命名章"}</span>
                      <span className="ch-words">{ch.words > 0 ? fmtNumber(ch.words) : ""}</span>
                      <button
                        className="row-add"
                        title="本章更多"
                        onClick={(e) => {
                          e.stopPropagation();
                          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          chapterMenu(ch.id, vol.id, r.left - 132, r.bottom + 2);
                        }}
                      >
                        <Icon name="more" size={13} />
                      </button>
                    </div>

                    {ch.scenes.map((sc, si) => (
                      <div
                        key={sc.id}
                        className={`scene-row${over === `s:${sc.id}` ? " drag-over" : ""}`}
                        draggable
                        onClick={() => onSelectChapter(ch.id)}
                        onDragStart={(e) =>
                          startDrag(e, { kind: "scene", id: sc.id, parent: ch.id })
                        }
                        onDragEnd={clear}
                        onDragOver={(e) => {
                          if (drag?.kind !== "scene") return;
                          e.preventDefault();
                          setOver(`s:${sc.id}`);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          const p = readDrag(e);
                          if (p?.kind === "scene" && p.id !== sc.id && p.parent === ch.id) {
                            onMoveScene(ch.id, p.id, sc.id);
                          }
                          clear();
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          onSelectChapter(ch.id);
                        }}
                        title={sc.summary || sc.title}
                      >
                        <span className="scene-dot" />
                        <span className="scene-name">
                          {sc.title || `场景 ${si + 1}`}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}

              {!isCollapsed && vol.chapters.length === 0 && (
                <button
                  className="board-add"
                  style={{ minHeight: 44, margin: "4px 8px 8px 20px", fontSize: 11.5 }}
                  onClick={() => onAddChapter(vol.id)}
                >
                  <span>
                    <Icon name="plus" size={13} /> 添加第一章
                  </span>
                </button>
              )}
            </div>
          );
        })}

        {outline.volumes.length === 0 && (
          <div style={{ padding: "18px 12px", fontSize: 12, color: "var(--text-3)", lineHeight: 1.8 }}>
            还没有卷。先建一卷，再往里放章。
            <div style={{ marginTop: 10 }}>
              <button className="btn btn-outline" onClick={onAddVolume}>
                新建第一卷
              </button>
            </div>
          </div>
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </aside>
  );
}
