import { useMemo, useRef, useState } from "react";
import type { Chapter, Outline } from "../types";
import { t, tf } from "../lib/i18n";
import { Icon } from "./Icon";

interface Props {
  bookId: string;
  chapters: Chapter[];
  outline: Outline;
  onOpen?: (id: string) => void;
}

type Pos = { x: number; y: number };

function keyOf(bookId: string) {
  return `chapter.storymap:${bookId}`;
}

function defaultPositions(chapters: Chapter[], outline: Outline): Record<string, Pos> {
  const groups = outline.volumes.filter((v) => v.chapters.length > 0);
  const out: Record<string, Pos> = {};
  const totalRows = Math.max(
    1,
    groups.reduce((sum, v) => sum + Math.max(1, Math.ceil(v.chapters.length / 6)), 0),
  );
  let rowBase = 0;
  groups.forEach((vol) => {
    const rows = Math.max(1, Math.ceil(vol.chapters.length / 5));
    const band = (rows / totalRows) * 0.9;
    const top = 0.06 + (rowBase / totalRows) * 0.9;
    rowBase += rows;
    vol.chapters.forEach((ch, ci) => {
      const row = Math.floor(ci / 6);
      const col = ci % 6;
      out[ch.id] = {
        x: 0.08 + (col / 5) * 0.84,
        y: top + ((row + 0.5) / rows) * band,
      };
    });
  });
  chapters.forEach((ch, i) => {
    if (!out[ch.id]) out[ch.id] = { x: 0.5, y: 0.2 + (i % 6) * 0.12 };
  });
  return out;
}

export function StoryMap({ bookId, chapters, outline, onOpen }: Props) {
  const [pos, setPos] = useState<Record<string, Pos>>(() => {
    try {
      const raw = localStorage.getItem(keyOf(bookId));
      const saved = raw ? (JSON.parse(raw) as Record<string, Pos>) : {};
      return { ...defaultPositions(chapters, outline), ...saved };
    } catch {
      return defaultPositions(chapters, outline);
    }
  });
  const [menu, setMenu] = useState<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; moved: boolean } | null>(null);

  const volumeOf = useMemo(() => {
    const map = new Map<string, { title: string; index: number }>();
    outline.volumes.forEach((v, i) => {
      v.chapters.forEach((c) => map.set(c.id, { title: v.title, index: i }));
    });
    return map;
  }, [outline]);

  const save = (next: Record<string, Pos>) => {
    setPos(next);
    try {
      localStorage.setItem(keyOf(bookId), JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const start = (id: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id, moved: false };
  };

  const move = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const box = boardRef.current?.getBoundingClientRect();
    if (!box) return;
    const p = {
      x: Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)),
    };
    drag.moved = true;
    setPos((cur) => ({ ...cur, [drag.id]: p }));
  };

  const end = () => {
    if (dragRef.current?.moved) {
      try {
        localStorage.setItem(keyOf(bookId), JSON.stringify(pos));
      } catch {
        /* ignore */
      }
    }
    dragRef.current = null;
  };

  const reset = () => {
    const next = defaultPositions(chapters, outline);
    save(next);
  };

  const mapRows = Math.max(
    1,
    outline.volumes.reduce((sum, v) => sum + Math.max(1, Math.ceil(v.chapters.length / 6)), 0),
  );
  return (
    <div className="storymap-wrap">
      <div className="storymap-bar">
        <span>{t("按卷铺开每一章；拖动卡片理清故事线，位置只存在这台电脑。")}</span>
        <button className="btn btn-ghost btn-xs" onClick={reset}>
          <Icon name="refresh" size={13} />
          {t("重排")}
        </button>
      </div>
      <div
        ref={boardRef}
        className="storymap"
        style={{ height: `${Math.max(400, mapRows * 70 + 24)}px` }}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
      >
        <svg className="storymap-lines" viewBox="0 0 1000 1000" preserveAspectRatio="none">
          {chapters.slice(1).map((ch, i) => {
            const a = pos[chapters[i]?.id];
            const b = pos[ch.id];
            if (!a || !b) return null;
            return (
              <line
                key={ch.id}
                x1={a.x * 1000}
                y1={a.y * 1000}
                x2={b.x * 1000}
                y2={b.y * 1000}
                className="storymap-line"
              />
            );
          })}
        </svg>

        {chapters.map((ch, i) => {
          const p = pos[ch.id];
          if (!p) return null;
          const vol = volumeOf.get(ch.id);
          return (
            <button
              key={ch.id}
              className="storymap-node"
              style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
              onPointerDown={start(ch.id)}
              onDoubleClick={() => onOpen?.(ch.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu(ch.id);
              }}
              title={ch.title}
            >
              <span className="storymap-head">
                <em>{String(i + 1).padStart(2, "0")}</em>
                {vol && <b>{vol.title.split(/[：:]/)[0]}</b>}
              </span>
              <strong>{ch.title}</strong>
              {ch.summary && <p>{ch.summary}</p>}
              <span className="storymap-foot">{tf("{n} 字", { n: ch.words.toLocaleString() })}</span>
            </button>
          );
        })}

        {menu && (
          <div className="storymap-menu">
            <button
              onClick={() => {
                onOpen?.(menu);
                setMenu(null);
              }}
            >
              <Icon name="arrow" size={12} />
              {t("跳到这一章")}
            </button>
            <button onClick={() => setMenu(null)}>
              <Icon name="close" size={12} />
              {t("关闭")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
