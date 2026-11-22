import { useEffect, useRef, useState } from "react";
import type { Outline } from "../types";
import { fmtNumber } from "../lib/text";
import { t, tf } from "../lib/i18n";
import { recallScroll, rememberScroll } from "../lib/viewMemory";
import { Icon } from "./Icon";
import { ContextMenu, type MenuItem } from "./ContextMenu";

interface Props {
  bookPath: string;
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
    bookPath,
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollKey = `outline:${bookPath}`;

  // 大纲看得好好的，切去写两行再回来，应当停在刚才那一卷，而不是从头。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const saved = recallScroll(scrollKey);
    const restore = () => {
      if (saved > 0) el.scrollTop = Math.min(saved, Math.max(0, el.scrollHeight - el.clientHeight));
    };
    requestAnimationFrame(restore);
    const lateRestore = window.setTimeout(restore, 120);
    const onScroll = () => rememberScroll(scrollKey, el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.clearTimeout(lateRestore);
      // 不在卸载时读 scrollTop：DOM 已被摘掉时它可能被浏览器归零，
      // 会把刚刚滚动时记下的位置覆盖成 0。滚动事件已经实时记住了位置。
      el.removeEventListener("scroll", onScroll);
    };
  }, [scrollKey]);

  let running = 0;
  const totalChapters = outline.volumes.reduce((s, v) => s + v.chapters.length, 0);
  const totalWords = outline.volumes.reduce(
    (s, v) => s + v.chapters.reduce((a, c) => a + (c.words || 0), 0),
    0
  );

  const cardMenu = (chId: string, x: number, y: number) => {
    setMenu({
      x,
      y,
      items: [
        { label: t("打开这一章"), icon: "book", onClick: () => onOpen(chId) },
        { label: t("重命名"), icon: "edit", onClick: () => onRenameChapter(chId) },
        { label: t("删除本章"), icon: "trash", danger: true, onClick: () => onDeleteChapter(chId) },
      ],
    });
  };

  return (
    <div className="view-scroll" ref={scrollRef}>
      <div className="view-inner">
        <div className="view-head outline-head">
          <div>
            <span className="eyebrow">{t("故事骨架")}</span>
            <h2>{t("章节大纲")}</h2>
            <p>{t("一张卡片一章。先把故事拆明白，再回去写细节；拖动卡片调顺序，改动即时保存。")}</p>
          </div>
          <div className="view-head-actions">
            <button className="btn btn-outline" onClick={onAddVolume}>
              <Icon name="plus" size={14} />
              {t("新建一卷")}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => onAddChapter(outline.volumes[outline.volumes.length - 1]?.id ?? "")}
              disabled={outline.volumes.length === 0}
            >
              <Icon name="plus" size={14} />
              {t("新建一章")}
            </button>
          </div>
        </div>

        <div className="board-stats">
          <span>
            <b>{fmtNumber(outline.volumes.length)}</b>
            {t("卷")}
          </span>
          <i />
          <span>
            <b>{fmtNumber(totalChapters)}</b>
            {t("章")}
          </span>
          <i />
          <span>
            <b>{fmtNumber(totalWords)}</b>
            {t("字")}
          </span>
          <span className="board-hint">
            <Icon name="grip" size={12} />
            {t("拖住卡片右侧的把手即可排序")}
          </span>
        </div>

        {outline.volumes.map((vol, vi) => {
          const start = running;
          running += vol.chapters.length;
          const volWords = vol.chapters.reduce((a, c) => a + (c.words || 0), 0);
          return (
            <section className="board-vol" key={vol.id}>
              <div className="board-vol-head">
                <span className="vol-no">{String(vi + 1).padStart(2, "0")}</span>
                <h3>{vol.title || t("未命名卷")}</h3>
                <span className="rule" />
                <span className="count">
                  {tf("{count} 章", { count: vol.chapters.length })}
                  <em>·</em>
                  {fmtNumber(volWords)} {t("字")}
                </span>
                <button
                  className="icon-btn"
                  style={{ width: 24, height: 24 }}
                  title={t("重命名本卷")}
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
                    }${ch.id === activeId ? " active" : ""}`}
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
                  >
                    <div className="ocard-top">
                      <span className="ocard-num">
                        <b>{String(start + i + 1).padStart(2, "0")}</b>
                        {t("章")}
                      </span>
                      <div className="ocard-tools">
                        <button
                          className="icon-btn"
                          style={{ width: 24, height: 24, cursor: "grab" }}
                          title={t("拖动排序")}
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
                          style={{ width: 24, height: 24 }}
                          title={t("更多")}
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
                    <h4>{ch.title || t("未命名章")}</h4>
                    <textarea
                      className="ocard-summary"
                      value={ch.summary ?? ""}
                      placeholder={t("一句话写清这一章发生了什么……")}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => onSummary(ch.id, e.target.value)}
                    />
                    <div className="ocard-foot">
                      <span className="scenes">
                        {ch.scenes.length > 0
                          ? ch.scenes.map((s) => s.title || t("场景")).join(" · ")
                          : t("还没有场景")}
                      </span>
                      <span className="words">
                        {fmtNumber(ch.words || 0)} {t("字")}
                      </span>
                    </div>
                  </article>
                ))}
                <button
                  className="board-add"
                  onClick={() => onAddChapter(vol.id)}
                  title={t("在本卷添加一章")}
                >
                  <span>
                    <Icon name="plus" size={14} /> {t("添加一章")}
                  </span>
                </button>
              </div>
            </section>
          );
        })}

        {outline.volumes.length === 0 && (
          <div className="lore-empty">
            {t("还没有卷与章。新建第一卷，故事就有了起点。")}
            <div style={{ marginTop: 12 }}>
              <button className="btn btn-primary" onClick={onAddVolume}>
                {t("新建第一卷")}
              </button>
            </div>
          </div>
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
