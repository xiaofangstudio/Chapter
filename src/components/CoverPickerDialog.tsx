import { useState } from "react";
import { COVER_TEMPLATES, resolveCoverTemplate } from "../lib/coverLibrary";
import { t } from "../lib/i18n";
import { Icon } from "./Icon";
import { Modal } from "./Modals";
import { NovelCover } from "./NovelCover";

const SPINE_SWATCHES = ["#6d4a2a", "#8a2f2a", "#26456b", "#2f5a44", "#4a3a63", "#1f1d1b", "#b89a67"];

interface Props {
  title: string;
  author?: string;
  coverMode?: "custom" | "default" | null;
  coverStyle?: string | null;
  spineColor?: string | null;
  /** 已上传的自定义封面，即使当前使用默认封面也要保留，方便切回去。 */
  customCoverUrl?: string;
  onClose: () => void;
  onApply: (value: {
    mode: "custom" | "default";
    style: string;
    spineColor: string;
  }) => Promise<void> | void;
  /** 打开系统选图，并进入 3:4 裁切。 */
  onPickFile: () => void;
}

export function CoverPickerDialog({
  title,
  author,
  coverMode,
  coverStyle,
  spineColor,
  customCoverUrl,
  onClose,
  onApply,
  onPickFile,
}: Props) {
  const fallbackStyle = resolveCoverTemplate(coverStyle, title);
  // 以书里真实保存的模式打开，而不是看封面图是否加载完成：
  // 自定义封面是异步读出来的，若等 customCoverUrl 再决定，弹窗会先停在默认封面，
  // 用户看到的就是一排没有意义的书脊色板。
  const [mode, setMode] = useState<"default" | "custom">(
    coverMode === "custom" ? "custom" : "default",
  );
  const [style, setStyle] = useState(fallbackStyle.id);
  const [spine, setSpine] = useState(spineColor || fallbackStyle.spine);
  const [busy, setBusy] = useState(false);

  const previewUrl = mode === "custom" ? customCoverUrl : undefined;
  const canUse = mode === "default" || Boolean(customCoverUrl);

  const apply = async () => {
    if (busy || !canUse) return;
    setBusy(true);
    try {
      await onApply({ mode, style, spineColor: spine });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("选择封面")}
      subtitle={t("默认封面有整套模板；也可以使用自己上传的 3:4 图片。")}
      wide
      wider
      onClose={busy ? () => undefined : onClose}
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {t("取消")}
          </button>
          <button className="btn btn-primary" onClick={() => void apply()} disabled={busy || !canUse}>
            {busy ? t("正在保存…") : t("使用这个封面")}
          </button>
        </>
      }
    >
      <div className="cover-picker">
        <aside className="cover-picker-preview">
          <div className="cover-picker-book">
            <NovelCover
              title={title}
              author={author}
              coverUrl={previewUrl}
              template={style}
              loading="eager"
            />
          </div>
          <span className="cover-picker-tag">
            {mode === "custom" ? t("自定义封面") : `${t("默认封面")} · ${COVER_TEMPLATES.find((c) => c.id === style)?.name ?? ""}`}
          </span>
          <p>{t("封面会同时用在书架、切书页和介绍页，不需要再换一次。")}</p>
          <div className="cover-picker-uses">
            <span><i>01</i>{t("工作台 · 今日封面")}</span>
            <span><i>02</i>{t("切书页 · 立体书")}</span>
            <span><i>03</i>{t("介绍页 · 左上封面")}</span>
          </div>
        </aside>

        <div className="cover-picker-main">
          <div className="cover-picker-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "default"}
              className={mode === "default" ? "on" : ""}
              onClick={() => setMode("default")}
            >
              {t("默认封面")}
              <em>{COVER_TEMPLATES.length}</em>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "custom"}
              className={mode === "custom" ? "on" : ""}
              onClick={() => setMode("custom")}
            >
              {t("自定义封面")}
              {customCoverUrl && <em>1</em>}
            </button>
          </div>

          {mode === "default" ? (
            <div className="cover-picker-grid" role="tabpanel">
              {COVER_TEMPLATES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`cover-picker-cell${style === item.id ? " on" : ""}`}
                  onClick={() => {
                    setStyle(item.id);
                    if (!spineColor) setSpine(item.spine);
                  }}
                  title={item.name}
                >
                  <span className="cover-picker-thumb">
                    <NovelCover
                      title={title}
                      author={author}
                      template={item.id}
                      loading="lazy"
                    />
                  </span>
                  <b>{item.name}</b>
                  {style === item.id && (
                    <span className="cover-picker-check">
                      <Icon name="check" size={11} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <div className="cover-picker-custom" role="tabpanel">
              {customCoverUrl ? (
                <>
                  <div className="cover-picker-custom-frame">
                    <NovelCover
                      title={title}
                      author={author}
                      coverUrl={customCoverUrl}
                      template={style}
                      loading="eager"
                    />
                  </div>
                  <div className="cover-picker-custom-copy">
                    <b>{t("这张图片已经复制在小说目录里")}</b>
                    <p>{t("可以继续使用它，也可以重新选一张；重新选择会打开 3:4 裁切。")}</p>
                    <div>
                      <button className="btn btn-outline btn-sm" onClick={onPickFile}>
                        <Icon name="image" size={14} />
                        {t("重新选择图片")}
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="cover-picker-empty">
                  <Icon name="image" size={26} />
                  <b>{t("还没有自定义封面")}</b>
                  <p>{t("选一张本地图片，裁成 3:4 后会复制到小说目录。")}</p>
                  <button className="btn btn-primary btn-sm" onClick={onPickFile}>
                    <Icon name="image" size={14} />
                    {t("从本地选择图片")}
                  </button>
                </div>
              )}
            </div>
          )}

          <section className="cover-picker-spine">
            <div>
              <h3>{mode === "custom" ? t("书脊来自封面") : t("书脊颜色")}</h3>
              <p>
                {mode === "custom"
                  ? t("自定义封面会自动裁左侧一竖列做书脊，并保留竖排书名，不再需要单独选颜色。")
                  : t("默认封面自带书脊色；也可以在这里统一改。")}
              </p>
            </div>
            {mode === "custom" ? (
              <span className="cover-spine-auto">
                <Icon name="image" size={13} />
                {t("左侧一列 · 自动")}
              </span>
            ) : (
              <div className="spine-swatches">
                {SPINE_SWATCHES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`spine-swatch${spine === c ? " on" : ""}`}
                    style={{ background: c }}
                    title={c}
                    onClick={() => setSpine(c)}
                  />
                ))}
                <label className="spine-swatch custom" title={t("自定义颜色")}>
                  <input type="color" value={spine} onChange={(e) => setSpine(e.target.value)} />
                </label>
              </div>
            )}
          </section>
        </div>
      </div>
    </Modal>
  );
}
