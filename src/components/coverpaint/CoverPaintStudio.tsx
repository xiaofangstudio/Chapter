import { useState } from "react";
import "../../styles/cover-paint.css";
import { CoverRasterEditor } from "./CoverRasterEditor";
import { CoverVectorEditor } from "./CoverVectorEditor";

export type PaintMode = "png" | "svg";
export type PaintRatio = "portrait" | "landscape";

export type PaintDims = { w: number; h: number; label: string };

export function paintDims(ratio: PaintRatio): PaintDims {
  return ratio === "portrait"
    ? { w: 1200, h: 1600, label: "3:4 竖版封面" }
    : { w: 1600, h: 1200, label: "4:3 横版" };
}

export function CoverPaintStudio({
  title,
  author,
  onClose,
  onApply,
}: {
  title: string;
  author: string;
  onClose: () => void;
  onApply: (dataUrl: string, mode: PaintMode) => Promise<void> | void;
}) {
  const [mode, setMode] = useState<PaintMode>("png");
  const [ratio, setRatio] = useState<PaintRatio>("portrait");
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const dims = paintDims(ratio);

  const finish = async (dataUrl: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await onApply(dataUrl, mode);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  if (started) {
    return mode === "png" ? (
      <CoverRasterEditor
        title={title}
        author={author}
        dims={dims}
        onClose={() => setStarted(false)}
        onDone={finish}
      />
    ) : (
      <CoverVectorEditor
        title={title}
        author={author}
        dims={dims}
        onClose={() => setStarted(false)}
        onDone={finish}
      />
    );
  }

  return (
    <div className="cps-root" role="dialog" aria-modal="true">
      <header className="cps-choose-head">
        <button className="cps-icon-btn" onClick={onClose} aria-label="关闭">
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
        <div>
          <span>CHAPTER / COVER STUDIO</span>
          <h2>手绘封面</h2>
        </div>
      </header>

      <main className="cps-choose-body">
        <p className="cps-kicker">先定画布类型，再进画室。选好之后不可中途换，避免线条和图层丢失。</p>

        <section className="cps-mode-grid">
          <button
            className={`cps-mode-card${mode === "png" ? " on" : ""}`}
            onClick={() => setMode("png")}
          >
            <div className="cps-mode-top">
              <strong>位图 PNG</strong>
              <span className="cps-recommend">推荐</span>
            </div>
            <p>画笔、橡皮、填充、图片、图层、滤镜、选区，画世界 Pro 常用能力都在。</p>
            <ul>
              <li>可导入照片，可做像素级涂抹</li>
              <li>导出 PNG，肉眼几乎看不出与矢量差别</li>
              <li>手机端更稳、更省内存</li>
            </ul>
          </button>

          <button
            className={`cps-mode-card${mode === "svg" ? " on" : ""}`}
            onClick={() => setMode("svg")}
          >
            <div className="cps-mode-top">
              <strong>矢量 SVG</strong>
              <span className="cps-limit">限制更多</span>
            </div>
            <p>线稿、字标、几何封面最合适；每一笔都是可无限放大的路径。</p>
            <ul>
              <li>不支持导入图片</li>
              <li>没有像素橡皮与滤镜，只能整笔删除</li>
              <li>导出真实 SVG；字体可能被替换</li>
            </ul>
          </button>
        </section>

        <section className="cps-ratio">
          <label>画布比例</label>
          <div className="cps-seg">
            <button className={ratio === "portrait" ? "on" : ""} onClick={() => setRatio("portrait")}>
              3:4 竖版
            </button>
            <button className={ratio === "landscape" ? "on" : ""} onClick={() => setRatio("landscape")}>
              4:3 横版
            </button>
          </div>
          <span className="cps-ratio-note">
            {dims.label} · 工作画布 {dims.w}×{dims.h} · 导出按封面尺寸放大
          </span>
        </section>

        <div className="cps-choose-tip">
          <strong>建议</strong>
          <span>普通封面选 PNG；只有需要无限放大、后期改色的线稿才选 SVG。PNG 与 SVG 在最终封面上看不出差别。</span>
        </div>
      </main>

      <footer className="cps-choose-foot">
        <button className="cps-btn ghost" onClick={onClose}>取消</button>
        <button
          className="cps-btn primary"
          disabled={busy}
          onClick={() => setStarted(true)}
        >
          进入画室
        </button>
      </footer>
    </div>
  );
}

