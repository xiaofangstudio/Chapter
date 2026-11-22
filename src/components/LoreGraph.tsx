import { useEffect, useMemo, useRef, useState } from "react";
import type { Lore, LoreEntry, LoreKind, LoreRelation } from "../types";
import { t } from "../lib/i18n";
import { Icon } from "./Icon";

interface Props {
  lore: Lore;
  kind: LoreKind;
  onSave: (lore: Lore) => void;
  onEdit: (entry: LoreEntry) => void;
  onAdd: () => void;
  onDelete: (entry: LoreEntry) => void;
}

type Pos = { x: number; y: number };

const COLORS = ["#d97757", "#6f8f6a", "#7d8fb3", "#c79a4a", "#9a7fb0", "#4f8f92"];

function defaultPos(i: number, count: number): Pos {
  const cols = Math.max(2, Math.min(4, Math.ceil(Math.sqrt(count))));
  const row = Math.floor(i / cols);
  const col = i % cols;
  const rows = Math.max(1, Math.ceil(count / cols));
  return {
    x: 0.16 + (col + 0.5) / cols * 0.68,
    y: 0.16 + (row + 0.5) / rows * 0.68,
  };
}

/** 把本地图片压成小尺寸 data URL，避免 lore.json 被原图撑大。 */
function readImage(file: File, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("image"));
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("canvas"));
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.86));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export function LoreGraph({ lore, kind, onSave, onEdit, onAdd, onDelete }: Props) {
  const entries = useMemo(
    () => lore.entries.filter((e) => e.kind === kind),
    [lore.entries, kind],
  );
  const [pos, setPos] = useState<Record<string, Pos>>({});
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [relationForm, setRelationForm] = useState<{ from: string; to: string; label: string } | null>(null);
  const [worldView, setWorldView] = useState(false);
  const [pinPlace, setPinPlace] = useState<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const portraitFor = useRef<string | null>(null);
  const dragRef = useRef<{ id: string; moved: boolean } | null>(null);
  const pinDrag = useRef<string | null>(null);

  useEffect(() => {
    const next: Record<string, Pos> = {};
    entries.forEach((e, i) => {
      next[e.id] = {
        x: typeof e.gx === "number" ? e.gx : defaultPos(i, entries.length).x,
        y: typeof e.gy === "number" ? e.gy : defaultPos(i, entries.length).y,
      };
    });
    setPos(next);
    setMenu(null);
    setConnectFrom(null);
    setRelationForm(null);
  }, [entries]);

  const relations = useMemo(
    () =>
      (lore.relations ?? []).filter(
        (r) => entries.some((e) => e.id === r.from) && entries.some((e) => e.id === r.to),
      ),
    [lore.relations, entries],
  );

  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);

  const persist = (patch: Partial<Lore>) => {
    onSave({ ...lore, ...patch });
  };

  const persistEntry = (id: string, patch: Partial<LoreEntry>) => {
    persist({ entries: lore.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) });
  };

  const boardPoint = (clientX: number, clientY: number): Pos => {
    const box = boardRef.current?.getBoundingClientRect();
    if (!box) return { x: 0.5, y: 0.5 };
    return {
      x: Math.min(1, Math.max(0, (clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (clientY - box.top) / box.height)),
    };
  };

  const startDrag = (id: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id, moved: false };
  };

  const onBoardPointerMove = (e: React.PointerEvent) => {
    if (pinDrag.current) {
      const p = boardPoint(e.clientX, e.clientY);
      const id = pinDrag.current;
      persist({
        worldMap: {
          ...lore.worldMap,
          pins: (lore.worldMap?.pins ?? []).map((pin) =>
            pin.id === id ? { ...pin, x: p.x, y: p.y } : pin,
          ),
        },
      });
      return;
    }
    if (!dragRef.current) return;
    const p = boardPoint(e.clientX, e.clientY);
    dragRef.current.moved = true;
    setPos((cur) => ({ ...cur, [dragRef.current!.id]: p }));
  };

  const endDrag = () => {
    if (pinDrag.current) pinDrag.current = null;
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (!drag.moved) return;
    const p = pos[drag.id];
    if (p) persistEntry(drag.id, { gx: p.x, gy: p.y });
  };

  const relationLine = (r: LoreRelation) => {
    const a = pos[r.from];
    const b = pos[r.to];
    if (!a || !b) return null;
    return (
      <g key={r.id}>
        <line
          x1={a.x * 1000}
          y1={a.y * 1000}
          x2={b.x * 1000}
          y2={b.y * 1000}
          className="lg-line"
        />
        {r.label && (
          <text
            x={(a.x + b.x) * 500}
            y={(a.y + b.y) * 500 - 6}
            textAnchor="middle"
            className="lg-line-label"
          >
            {r.label}
          </text>
        )}
      </g>
    );
  };

  const choosePortrait = (id: string) => {
    portraitFor.current = id;
    fileRef.current?.click();
  };

  const onPortraitFile = async (file?: File) => {
    const id = portraitFor.current;
    portraitFor.current = null;
    if (!file || !id) return;
    const data = await readImage(file, 320);
    persistEntry(id, { portrait: data });
  };

  const worldMap = lore.worldMap ?? {};
  const pins = worldMap.pins ?? [];

  const uploadMap = async (file?: File) => {
    if (!file) return;
    const data = await readImage(file, 1600);
    persist({ worldMap: { ...worldMap, image: data } });
  };

  if (kind === "place" && worldView) {
    return (
      <div className="lore-world">
        <div className="lore-world-bar">
          <div>
            <strong>{t("世界观地图")}</strong>
            <span>{t("上传一张世界地图，再把地点钉上去；位置会随书保存。")}</span>
          </div>
          <div className="lore-world-actions">
            <button className="btn btn-ghost btn-xs" onClick={() => setWorldView(false)}>
              <Icon name="outline" size={13} />
              {t("返回地点网")}
            </button>
            <label className="btn btn-ghost btn-xs">
              <Icon name="image" size={13} />
              {worldMap.image ? t("更换地图") : t("上传地图")}
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  void uploadMap(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
            <button
              className={`btn btn-xs ${pinPlace ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setPinPlace(pinPlace ? null : entries[0]?.id ?? null)}
              disabled={!entries.length}
            >
              <Icon name="pin" size={13} />
              {pinPlace ? t("点地图放置") : t("钉一个地点")}
            </button>
          </div>
        </div>

        <div className="lore-world-stage">
          {worldMap.image ? (
            <div
              className="lore-map"
              onPointerMove={onBoardPointerMove}
              onPointerUp={endDrag}
              onClick={(e) => {
                if (!pinPlace) return;
                const p = boardPoint(e.clientX, e.clientY);
                persist({
                  worldMap: {
                    ...worldMap,
                    pins: [
                      ...pins,
                      {
                        id: `pin_${Date.now()}`,
                        entryId: pinPlace,
                        x: p.x,
                        y: p.y,
                        label: byId.get(pinPlace)?.name ?? "",
                      },
                    ],
                  },
                });
                setPinPlace(null);
              }}
            >
              <img src={worldMap.image} alt="" draggable={false} />
              {pins.map((pin) => {
                const entry = byId.get(pin.entryId);
                return (
                  <button
                    key={pin.id}
                    className="lore-pin"
                    style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      pinDrag.current = pin.id;
                      e.currentTarget.setPointerCapture(e.pointerId);
                    }}
                    onPointerUp={(e) => {
                      e.stopPropagation();
                      pinDrag.current = null;
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      persist({
                        worldMap: {
                          ...worldMap,
                          pins: pins.filter((x) => x.id !== pin.id),
                        },
                      });
                    }}
                    title={entry ? t("右键移除这个地点") : pin.label}
                  >
                    <Icon name="pin" size={14} />
                    <span>{pin.label || entry?.name}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="lore-world-empty">
              <Icon name="image" size={26} />
              <strong>{t("还没有世界观地图")}</strong>
              <p>{t("找一张大陆、城市或宅邸的图，上传后就能把地点钉在上面。")}</p>
            </div>
          )}
        </div>

        {entries.length > 0 && (
          <div className="lore-world-places">
            {entries.map((e) => (
              <button key={e.id} className="lore-place-chip" onClick={() => onEdit(e)}>
                <span style={{ background: e.color ?? "var(--accent)" }} />
                {e.name || t("未命名")}
                {e.fields[0]?.v && <em>{e.fields[0].v}</em>}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="lore-graph-wrap">
      <div className="lore-graph-bar">
        <span>
          {connectFrom ? t("再点一个节点，填上关系") : t("拖动节点改位置；右键节点可连线、标色、加皇冠、传立绘。")}
        </span>
        <button className="btn btn-ghost btn-xs" onClick={onAdd}>
          <Icon name="plus" size={13} />
          {t("新增")}
        </button>
        {kind === "place" && (
          <button className="btn btn-ghost btn-xs" onClick={() => setWorldView(true)}>
            <Icon name="pin" size={13} />
            {t("世界观地图")}
          </button>
        )}
      </div>

      <div
        ref={boardRef}
        className={`lore-graph${connectFrom ? " is-connecting" : ""}`}
        onPointerMove={onBoardPointerMove}
        onPointerUp={endDrag}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            setMenu(null);
            setConnectFrom(null);
          }
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <svg className="lore-lines" viewBox="0 0 1000 1000" preserveAspectRatio="none">
          {relations.map(relationLine)}
        </svg>

        {entries.map((e) => {
          const p = pos[e.id];
          if (!p) return null;
          const color = e.color ?? "var(--accent)";
          return (
            <div
              key={e.id}
              className={`lore-node${connectFrom === e.id ? " on" : ""}${e.crown ? " crown" : ""}`}
              style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, "--node-color": color } as React.CSSProperties}
              onPointerDown={startDrag(e.id)}
              onContextMenu={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const box = boardRef.current?.getBoundingClientRect();
                setMenu({
                  id: e.id,
                  x: ev.clientX - (box?.left ?? 0),
                  y: ev.clientY - (box?.top ?? 0),
                });
              }}
              onClick={(ev) => {
                ev.stopPropagation();
                if (connectFrom && connectFrom !== e.id) {
                  setRelationForm({ from: connectFrom, to: e.id, label: "" });
                  setConnectFrom(null);
                }
                setMenu(null);
              }}
              onDoubleClick={() => onEdit(e)}
            >
              {e.crown && <span className="lore-crown">♛</span>}
              <div className="lore-node-avatar">
                {e.portrait ? <img src={e.portrait} alt="" draggable={false} /> : <b>{Array.from(e.name)[0] ?? "？"}</b>}
              </div>
              <div className="lore-node-name">{e.name || t("未命名")}</div>
              {e.note && <div className="lore-node-note">{e.note}</div>}
            </div>
          );
        })}

        {menu && byId.get(menu.id) && (
          <div className="lore-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => {
                setConnectFrom(menu.id);
                setMenu(null);
              }}
            >
              <Icon name="arrow" size={12} /> {t("从这里连线")}
            </button>
            <button
              onClick={() => {
                persistEntry(menu.id, { crown: !byId.get(menu.id)!.crown });
                setMenu(null);
              }}
            >
              <span>♛</span> {byId.get(menu.id)!.crown ? t("取消主角") : t("标为主角")}
            </button>
            <button
              onClick={() => {
                choosePortrait(menu.id);
                setMenu(null);
              }}
            >
              <Icon name="image" size={12} /> {t("上传立绘")}
            </button>
            {byId.get(menu.id)!.portrait && (
              <button
                onClick={() => {
                  persistEntry(menu.id, { portrait: undefined });
                  setMenu(null);
                }}
              >
                <Icon name="close" size={12} /> {t("移除立绘")}
              </button>
            )}
            <div className="lore-menu-colors">
              {COLORS.map((c) => (
                <button
                  key={c}
                  style={{ background: c }}
                  className={byId.get(menu.id)!.color === c ? "on" : ""}
                  onClick={() => {
                    persistEntry(menu.id, { color: c });
                    setMenu(null);
                  }}
                  aria-label={c}
                />
              ))}
            </div>
            <button
              onClick={() => {
                onEdit(byId.get(menu.id)!);
                setMenu(null);
              }}
            >
              <Icon name="edit" size={12} /> {t("编辑字段")}
            </button>
            <button
              className="danger"
              onClick={() => {
                onDelete(byId.get(menu.id)!);
                setMenu(null);
              }}
            >
              <Icon name="trash" size={12} /> {t("删除")}
            </button>
          </div>
        )}

        {connectFrom && (
          <div className="lore-connect-hint">{t("点击另一个节点建立关系")}</div>
        )}

        {entries.length === 0 && (
          <div className="lore-graph-empty">
            <p>{t("还没有节点。先建一个角色或地点，再回来连关系。")}</p>
            <button className="btn btn-outline" onClick={onAdd}>
              <Icon name="plus" size={13} />
              {t("新增")}
            </button>
          </div>
        )}
      </div>

      <div className="lore-relations">
        {relations.length === 0 ? (
          <span className="lore-rel-empty">{t("还没有连线。右键一个节点，选「从这里连线」。")}</span>
        ) : (
          relations.map((r) => (
            <div className="lore-rel" key={r.id}>
              <span>{byId.get(r.from)?.name}</span>
              <input
                value={r.label}
                placeholder={t("关系")}
                onChange={(e) =>
                  persist({
                    relations: (lore.relations ?? []).map((x) =>
                      x.id === r.id ? { ...x, label: e.target.value } : x,
                    ),
                  })
                }
              />
              <span>{byId.get(r.to)?.name}</span>
              <button
                className="icon-btn"
                onClick={() =>
                  persist({ relations: (lore.relations ?? []).filter((x) => x.id !== r.id) })
                }
                title={t("删除")}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ))
        )}
      </div>

      {relationForm && (
        <div className="lore-rel-dialog">
          <strong>
            {byId.get(relationForm.from)?.name} → {byId.get(relationForm.to)?.name}
          </strong>
          <input
            autoFocus
            value={relationForm.label}
            placeholder={t("例如：师父 / 宿敌 / 同乡")}
            onChange={(e) => setRelationForm({ ...relationForm, label: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                persist({
                  relations: [
                    ...(lore.relations ?? []),
                    { id: `rel_${Date.now()}`, from: relationForm.from, to: relationForm.to, label: relationForm.label.trim() || t("关系") },
                  ],
                });
                setRelationForm(null);
              }
              if (e.key === "Escape") setRelationForm(null);
            }}
          />
          <div>
            <button className="btn btn-ghost btn-xs" onClick={() => setRelationForm(null)}>
              {t("取消")}
            </button>
            <button
              className="btn btn-primary btn-xs"
              onClick={() => {
                persist({
                  relations: [
                    ...(lore.relations ?? []),
                    { id: `rel_${Date.now()}`, from: relationForm.from, to: relationForm.to, label: relationForm.label.trim() || t("关系") },
                  ],
                });
                setRelationForm(null);
              }}
            >
              {t("建立关系")}
            </button>
          </div>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          void onPortraitFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
