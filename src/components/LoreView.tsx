import { useEffect, useState } from "react";
import type { Lore, LoreEntry, LoreKind } from "../types";
import { LORE_KINDS } from "../types";
import { t, tf } from "../lib/i18n";
import { Icon } from "./Icon";
import { LoreGraph } from "./LoreGraph";

interface Props {
  lore: Lore;
  onAdd: (kind: LoreKind) => void;
  onEdit: (entry: LoreEntry) => void;
  onDelete: (entry: LoreEntry) => void;
  onInsert: (entry: LoreEntry) => void;
  onSaveLore: (lore: Lore) => void;
  initialMode?: "cards" | "graph" | "map";
}

export function LoreView({ lore, onAdd, onEdit, onDelete, onInsert, onSaveLore, initialMode = "cards" }: Props) {
  const [kind, setKind] = useState<LoreKind>("character");
  const [mode, setMode] = useState<"cards" | "graph" | "map">(initialMode);

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);
  const entries = lore.entries.filter((e) => e.kind === kind);
  const current = LORE_KINDS.find((k) => k.key === kind)!;

  if (mode !== "cards") {
    const mapMode = mode === "map";
    return (
      <div className="view-scroll lore-graph-view">
        <div className="view-inner">
          <div className="view-head lore-head">
            <div>
              <h2>{mapMode ? t("世界观地图") : t("关系图谱")}</h2>
              <p>
                {mapMode
                  ? t("上传一张世界观地图，把地点钉在上面；拖动钉子调整位置，长按删除。")
                  : t("人物、地点各成一张网；拖动、连线、标色、皇冠和立绘都只保存在这本书里。")}
              </p>
            </div>
            <div className="segmini lore-view-switch">
              <button onClick={() => setMode("cards")}>{t("卡片")}</button>
              <button className={mode === "graph" ? "on" : ""} onClick={() => setMode("graph")}>
                {t("图谱")}
              </button>
              <button className={mode === "map" ? "on" : ""} onClick={() => setMode("map")}>
                {t("世界观地图")}
              </button>
            </div>
          </div>
          {!mapMode && (
            <div className="lore-tabs" style={{ marginBottom: 14 }}>
              {LORE_KINDS.map((k) => (
                <button
                  key={k.key}
                  className={`chip${kind === k.key ? " on" : ""}`}
                  onClick={() => setKind(k.key)}
                >
                  {t(k.label)}
                </button>
              ))}
              <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-3)" }}>
                {tf("共 {count} 条设定", { count: lore.entries.length })}
              </span>
            </div>
          )}
          <LoreGraph
            key={mapMode ? "map" : `graph-${kind}`}
            lore={lore}
            kind={mapMode ? "place" : kind}
            onSave={onSaveLore}
            onEdit={onEdit}
            onAdd={() => onAdd(mapMode ? "place" : kind)}
            onDelete={onDelete}
            worldOnly={mapMode}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="view-scroll">
      <div className="view-inner">
        <div className="view-head lore-head">
          <div>
            <h2>{t("设定表")}</h2>
            <p>{t("人物、地点、物品，字段随你定。写正文时按下「设定」就能把名字插进去，不怕记混。")}</p>
          </div>
          <div className="view-head-actions">
            <div className="segmini lore-view-switch">
              <button className="on">{t("卡片")}</button>
              <button onClick={() => setMode("graph")}>{t("图谱")}</button>
              <button onClick={() => setMode("map")}>{t("世界观地图")}</button>
            </div>
            <button className="btn btn-primary" onClick={() => onAdd(kind)}>
              <Icon name="plus" size={14} />
              {t("新增")}{t(current.label)}
            </button>
          </div>
        </div>


        <div className="lore-tabs" style={{ marginBottom: 18 }}>
          {LORE_KINDS.map((k) => {
            const n = lore.entries.filter((e) => e.kind === k.key).length;
            return (
              <button
                key={k.key}
                className={`chip${kind === k.key ? " on" : ""}`}
                onClick={() => setKind(k.key)}
              >
                {t(k.label)} {n > 0 ? n : ""}
              </button>
            );
          })}
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-3)" }}>
            {tf("共 {count} 条设定", { count: lore.entries.length })}
          </span>
        </div>

        {entries.length === 0 ? (
          <div className="lore-empty">
            {tf("还没有{label}。", { label: t(current.label) })}
            <br />
            {t("先立住主角，再补对手与关键配角；地点与物品写到了再建也不迟。")}
            <div style={{ marginTop: 14 }}>
              <button className="btn btn-outline" onClick={() => onAdd(kind)}>
                <Icon name="plus" size={13} />
                {t("新增")}{t(current.label)}
              </button>
            </div>
          </div>
        ) : (
          <div className="lore-grid stagger">
            {entries.map((e, i) => (
              <article className="lcard" key={e.id} style={{ animationDelay: `${Math.min(i, 8) * 35}ms` }}>
                <div className="lavatar">{Array.from(e.name)[0] ?? "？"}</div>
                <div className="lcard-body">
                  <div className="lname">{e.name || t("未命名")}</div>
                  <div className="lkind">{t(LORE_KINDS.find((k) => k.key === e.kind)?.label ?? "")}</div>
                  <div className="lfields">
                    {e.fields.slice(0, 3).map((f, fi) => (
                      <div key={`${f.k}-${fi}`} title={`${f.k || t("备注")}：${f.v}`}>
                        <span>{f.k || t("备注")}</span>
                        {f.v}
                      </div>
                    ))}
                    {e.note && (
                      <div style={{ color: "var(--text-3)" }} title={e.note}>
                        {e.note}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                    <button className="btn btn-ghost" style={{ height: 24, padding: "0 6px", fontSize: 10.5 }} onClick={() => onInsert(e)}>
                      <Icon name="arrow" size={11} />
                      {t("插入正文")}
                    </button>
                  </div>
                </div>
                <div className="lacts">
                  <button className="icon-btn" style={{ width: 24, height: 24 }} title={t("编辑")} onClick={() => onEdit(e)}>
                    <Icon name="edit" size={13} />
                  </button>
                  <button className="icon-btn" style={{ width: 24, height: 24 }} title={t("删除")} onClick={() => onDelete(e)}>
                    <Icon name="close" size={13} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
