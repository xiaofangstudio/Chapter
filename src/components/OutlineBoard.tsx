import { useState } from "react";
import type { Outline } from "../types";
import { fmtNumber } from "../lib/text";
import { t } from "../lib/i18n";
import { Icon } from "./Icon";
import { ContextMenu, type MenuItem } from "./ContextMenu";

interface Props {
  outline: Outline;
  activeId: string | null;
  onOpen: (id: string) => void;
  onSummary: (chapterId: string, text: string) => void;
  onMoveChapter: (chId: string, toVol: string, beforeId: string | null) => void;
  onAddChapter: (volId: string) => void;
  onAddVolume: () => void;
  onRenameChapter: (chapterId: string) => void;
  onDeleteChapter: (chapterId: string) => void;
  onRenameVolume: (volId: string) => void;
}

export function OutlineBoard(props: Props) {
  const {
    outline,
    activeId,
    onOpen,
    onSummary,
    onMoveChapter,
    onAddChapter,
    onAddVolume,
    onRenameChapter,
    onDeleteChapter,
    onRenameVolume,
  } = props;
  const [drag, setDrag] = useState<{ vol: string; id: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  let running = 0;

  const cardMenu = (chId: string, x: number, y: number) => {
    setMenu({
      x,
      y,
      items: [
        { label: "打开这一章", icon: "book", onClick: () => onOpen(chId) },
        { label: "重命名", icon: "edit", onClick: () => onRenameChapter(chId) },
        { label: "删除本章", icon: "trash", danger: true, onClick: () => onDeleteChapter(chId) },
      ],
    });
  };

  return (
    <div className="view-scroll">
      <div className="view-inner">
        <div className="view-head">
          <div>
            <h2>{t("大纲墙")}</h2>
            <p>{t("一张卡片一章。先把故事拆明白，再回去写细节；拖动卡片调顺序，改动即时保存。")}</p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-outline" onClick={onAddVolume}>
              <Icon name="plus" size={14} />
              新建一卷
            </button>
            <button
              className="btn btn-primary"
              onClick={() => onAddChapter(outline.volumes[outline.volumes.length - 1]?.id ?? "")}
              disabled={outline.volumes.length === 0}
            >
              <Icon name="plus" size={14} />
              新建一章
            </button>
          </div>
        </div>

        {outline.volumes.map((vol) => {
          const start = running;
          running += vol.chapters.length;
          return (
            <section className="board-vol" key={vol.id}>
              <div className="board-vol-head">
                <h3>{vol.title || "未命名卷"}</h3>
                <span className="rule" />
                <span className="count">{vol.chapters.length} 章</span>
                <button
                  className="icon-btn"
                  style={{ width: 24, height: 24 }}
                  title="重命名本卷"
                  onClick={() => onRenameVolume(vol.id)}
                >
                  <Icon name="edit" size={13} />
                </button>
              </div>
              <div className="board-grid">
                {vol.chapters.map((ch, i) => (
                  <article
                    key={ch.id}
                    className={`ocard${over === ch.id ? " over" : ""}${
                      drag?.id === ch.id ? " dragging" : ""
                    }`}
                    onClick={() => onOpen(ch.id)}
                    onDragOver={(e) => {
                      if (!drag) return;
                      e.preventDefault();
                      setOver(ch.id);
                    }}
                    onDragLeave={() => setOver((v) => (v === ch.id ? null : v))}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (drag && drag.id !== ch.id) onMoveChapter(drag.id, vol.id, ch.id);
                      setDrag(null);
                      setOver(null);
                    }}
                    style={ch.id === activeId ? { borderColor: "var(--accent)" } : undefined}
                  >
                    <div className="ocard-top">
                      <span className="ocard-num">第 {start + i + 1} 章</span>
                      <div style={{ display: "flex", gap: 1, margin: "-4px -4px 0 0" }}>
                        <button
                          className="icon-btn"
                          style={{ width: 20, height: 20, cursor: "grab" }}
                          title="拖动排序"
                          draggable
                          onDragStart={(e) => {
                            e.stopPropagation();
                            setDrag({ vol: vol.id, id: ch.id });
                            e.dataTransfer.effectAllowed = "move";
                            try {
                              e.dataTransfer.setData("text/plain", ch.id);
                            } catch {
                              /* ignore */
                            }
                          }}
                          onDragEnd={() => {
                            setDrag(null);
                            setOver(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Icon name="grip" size={13} />
                        </button>
                        <button
                          className="icon-btn"
                          style={{ width: 20, height: 20 }}
                          title="更多"
                          onClick={(e) => {
                            e.stopPropagation();
                            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            cardMenu(ch.id, r.left - 130, r.bottom + 2);
                          }}
                        >
                          <Icon name="more" size={13} />
                        </button>
                      </div>
                    </div>
                    <h4>{ch.title || "未命名章"}</h4>
                    <textarea
                      className="ocard-summary"
                      value={ch.summary ?? ""}
                      placeholder="一句话写清这一章发生了什么……"
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => onSummary(ch.id, e.target.value)}
                    />
                    <div className="ocard-foot">
                      <span className="scenes">
                        {ch.scenes.length > 0
                          ? ch.scenes.map((s) => s.title || "场景").join(" · ")
                          : "还没有场景"}
                      </span>
                      <span className="words">{fmtNumber(ch.words || 0)} 字</span>
                    </div>
                  </article>
                ))}
                <button
                  className="board-add"
                  onClick={() => onAddChapter(vol.id)}
                  title="在本卷添加一章"
                >
                  <span>
                    <Icon name="plus" size={14} /> 添加一章
                  </span>
                </button>
              </div>
            </section>
          );
        })}

        {outline.volumes.length === 0 && (
          <div className="lore-empty">
            还没有卷与章。新建第一卷，故事就有了起点。
            <div style={{ marginTop: 12 }}>
              <button className="btn btn-primary" onClick={onAddVolume}>
                新建第一卷
              </button>
            </div>
          </div>
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
