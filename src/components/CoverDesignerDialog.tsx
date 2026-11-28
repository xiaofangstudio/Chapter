import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../lib/i18n";
import { Icon } from "./Icon";
import { Modal } from "./Modals";
import { CoverPaintStudio } from "./coverpaint/CoverPaintStudio";

type Template = "solid" | "image" | "block" | "wordmark";
type Fit = "cover" | "contain";

const W = 1600;
const H = 2133;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

export function CoverDesignerDialog({
  title,
  author,
  spineColor,
  onClose,
  onApply,
}: {
  title: string;
  author: string;
  spineColor: string;
  onClose: () => void;
  onApply: (dataUrl: string, spineColor: string) => Promise<void> | void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [template, setTemplate] = useState<Template>("solid");
  const [bg, setBg] = useState("#1f2a22");
  const [ink, setInk] = useState("#f2ede2");
  const [accent, setAccent] = useState("#c9a96b");
  const [spine, setSpine] = useState(spineColor || "#6d4a2a");
  const [bookTitle, setBookTitle] = useState(title);
  const [subtitle, setSubtitle] = useState("");
  const [writer, setWriter] = useState(author);
  const [series, setSeries] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [fit, setFit] = useState<Fit>("cover");
  const [focalX, setFocalX] = useState(50);
  const [focalY, setFocalY] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const [paintOpen, setPaintOpen] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let cancelled = false;

    const draw = async () => {
      ctx.clearRect(0, 0, W, H);
      if (template === "image" || template === "block") {
        if (image) {
          try {
            const img = await loadImage(image);
            if (cancelled) return;
            const area = template === "block"
              ? { x: 0, y: 0, w: W, h: H * 0.62 }
              : { x: 0, y: 0, w: W, h: H };
            const base = fit === "cover"
              ? Math.max(area.w / img.width, area.h / img.height)
              : Math.min(area.w / img.width, area.h / img.height);
            const scale = base * zoom;
            const dw = img.width * scale;
            const dh = img.height * scale;
            const dx = area.x + (area.w - dw) * (focalX / 100);
            const dy = area.y + (area.h - dh) * (focalY / 100);
            ctx.save();
            ctx.beginPath();
            ctx.rect(area.x, area.y, area.w, area.h);
            ctx.clip();
            ctx.drawImage(img, dx, dy, dw, dh);
            ctx.restore();
            if (template === "image") {
              const g = ctx.createLinearGradient(0, H * 0.38, 0, H);
              g.addColorStop(0, "rgba(10,12,10,0)");
              g.addColorStop(1, "rgba(10,12,10,.80)");
              ctx.fillStyle = g;
              ctx.fillRect(0, H * 0.38, W, H * 0.62);
            }
          } catch {
            ctx.fillStyle = bg;
            ctx.fillRect(0, 0, W, H);
          }
        } else {
          ctx.fillStyle = bg;
          ctx.fillRect(0, 0, W, H);
        }
      } else {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);
      }

      if (template !== "image" && template !== "block") {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 6;
        ctx.strokeRect(74, 74, W - 148, H - 148);
        ctx.lineWidth = 2;
        ctx.strokeRect(94, 94, W - 188, H - 188);
      }

      if (template === "block") {
        ctx.fillStyle = bg;
        ctx.fillRect(0, H * 0.62, W, H * 0.38);
        ctx.fillStyle = accent;
        ctx.fillRect(84, H * 0.66, W - 168, 8);
      }

      const textTop = template === "block" ? H * 0.665 : H * 0.56;
      ctx.textAlign = "center";
      ctx.fillStyle = template === "wordmark" ? accent : ink;

      if (series) {
        ctx.font = "500 46px 'Noto Serif SC', serif";
        ctx.fillStyle = accent;
        ctx.fillText(series, W / 2, H * 0.16);
      }

      if (template === "wordmark") {
        const mark = Array.from(bookTitle.trim())[0] ?? "书";
        ctx.font = "700 560px 'Noto Serif SC', serif";
        ctx.fillText(mark, W / 2, H * 0.56);
        ctx.strokeStyle = accent;
        ctx.lineWidth = 10;
        ctx.beginPath();
        ctx.arc(W / 2, H * 0.42, 480, 0, Math.PI * 2);
        ctx.stroke();
        ctx.font = "600 92px 'Noto Serif SC', serif";
        ctx.fillStyle = ink;
        ctx.fillText(bookTitle, W / 2, H * 0.70);
      } else {
        const chars = Array.from(bookTitle.trim() || "未命名");
        const size = chars.length <= 5 ? 180 : chars.length <= 9 ? 140 : 106;
        ctx.font = `700 ${size}px 'Noto Serif SC', serif`;
        const maxW = W - 260;
        const lines: string[] = [];
        let line = "";
        for (const ch of chars) {
          if (ctx.measureText(line + ch).width > maxW && line) {
            lines.push(line);
            line = ch;
          } else line += ch;
        }
        if (line) lines.push(line);
        const lh = size * 1.32;
        const startY = textTop - (lines.length - 1) * lh * 0.5 + (template === "block" ? 120 : 0);
        ctx.fillStyle = ink;
        lines.slice(0, 4).forEach((l, i) => ctx.fillText(l, W / 2, startY + i * lh));
        if (subtitle.trim()) {
          ctx.font = "500 54px 'Noto Serif SC', serif";
          ctx.fillStyle = ink;
          ctx.globalAlpha = 0.72;
          ctx.fillText(subtitle.trim(), W / 2, startY + lines.length * lh + 18);
          ctx.globalAlpha = 1;
        }
        ctx.font = "500 58px 'Noto Serif SC', serif";
        ctx.fillStyle = accent;
        ctx.fillText(writer.trim() || " ", W / 2, H - 180);
      }

      if (template === "image" || template === "block") {
        ctx.fillStyle = accent;
        ctx.fillRect(W - 246, H - 246, 170, 8);
      }
    };
    void draw();
    return () => {
      cancelled = true;
    };
  }, [template, bg, ink, accent, bookTitle, subtitle, writer, series, image, fit, focalX, focalY, zoom]);

  const upload = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        setImage(String(reader.result));
        if (template === "solid" || template === "wordmark") setTemplate("image");
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  const apply = async () => {
    const canvas = canvasRef.current;
    if (!canvas || busy) return;
    setBusy(true);
    try {
      const dataUrl = canvas.toDataURL("image/png", 1);
      await onApply(dataUrl, spine);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  if (paintOpen) {
    return createPortal(
      <CoverPaintStudio
        title={bookTitle || title}
        author={writer || author}
        onClose={() => setPaintOpen(false)}
        onApply={async (dataUrl) => {
          await onApply(dataUrl, spine);
        }}
      />,
      document.body,
    );
  }

  return (
    <Modal
      title={t("封面设计器")}
      subtitle={t("1600 × 2133 · 3:4 · 本地生成，不联网；导出后写回这本书的封面。")}
      wider
      wide
      onClose={busy ? () => undefined : onClose}
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {t("取消")}
          </button>
          <button className="btn btn-primary" onClick={() => void apply()} disabled={busy}>
            {busy ? t("正在写回…") : t("导出并用作封面")}
          </button>
        </>
      }
    >
      <div className="cover-designer">
        <div className="cover-design-preview">
          <canvas ref={canvasRef} width={W} height={H} />
          <span>{W} × {H} PNG</span>
        </div>
        <div className="cover-design-panel">
          <div className="cover-design-templates">
            {(
              [
                ["solid", "纯色"],
                ["image", "整图"],
                ["block", "图上块下"],
                ["wordmark", "字标"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} className={template === k ? "on" : ""} onClick={() => setTemplate(k)}>
                {t(label)}
              </button>
            ))}
          </div>
          <button className="btn btn-outline cover-design-upload" onClick={upload}>
            <Icon name="image" size={13} />
            {image ? t("换一张图") : t("上传封面图")}
          </button>
          <button className="btn btn-primary cover-design-paint" onClick={() => setPaintOpen(true)}>
            <Icon name="edit" size={13} />
            {t("自己画封面")}
          </button>
          <p className="cover-design-paint-note">
            {t("进画室先选 PNG 位图或 SVG 矢量：PNG 推荐，功能全；SVG 更清晰但限制多。")}
          </p>
          {(template === "image" || template === "block") && image && (
            <div className="cover-design-focus">
              <label>
                <span>{t("横向焦点")}</span>
                <input type="range" min={0} max={100} value={focalX} onChange={(e) => setFocalX(Number(e.target.value))} />
              </label>
              <label>
                <span>{t("纵向焦点")}</span>
                <input type="range" min={0} max={100} value={focalY} onChange={(e) => setFocalY(Number(e.target.value))} />
              </label>
              <label>
                <span>{t("缩放")}</span>
                <input type="range" min={0.7} max={2.4} step={0.02} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
              </label>
              <div className="cover-design-fit">
                <button className={fit === "cover" ? "on" : ""} onClick={() => setFit("cover")}>{t("铺满")}</button>
                <button className={fit === "contain" ? "on" : ""} onClick={() => setFit("contain")}>{t("留白")}</button>
              </div>
            </div>
          )}
          <div className="cover-design-fields">
            <label><span>{t("书名")}</span><input className="input" value={bookTitle} maxLength={40} onChange={(e) => setBookTitle(e.target.value)} /></label>
            <label><span>{t("副标题")}</span><input className="input" value={subtitle} maxLength={30} placeholder={t("可以留空")} onChange={(e) => setSubtitle(e.target.value)} /></label>
            <label><span>{t("作者")}</span><input className="input" value={writer} maxLength={24} onChange={(e) => setWriter(e.target.value)} /></label>
            <label><span>{t("系列标")}</span><input className="input" value={series} maxLength={18} placeholder={t("例如 方岛文库")} onChange={(e) => setSeries(e.target.value)} /></label>
          </div>
          <div className="cover-design-colors">
            <label><span>{t("底色")}</span><input type="color" value={bg} onChange={(e) => setBg(e.target.value)} /></label>
            <label><span>{t("文字")}</span><input type="color" value={ink} onChange={(e) => setInk(e.target.value)} /></label>
            <label><span>{t("强调")}</span><input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} /></label>
            <label><span>{t("书脊")}</span><input type="color" value={spine} onChange={(e) => setSpine(e.target.value)} /></label>
          </div>
        </div>
      </div>
    </Modal>
  );
}
