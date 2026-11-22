import { useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { t } from "../lib/i18n";
import { Icon } from "./Icon";
import { Modal } from "./Modals";

const STAGE_W = 285;
const STAGE_H = 380;

interface Props {
  src: string;
  fileName?: string;
  onClose: () => void;
  onConfirm: (dataUrl: string) => Promise<void> | void;
}

/** 封面裁切预览：固定 3:4 画框，其他比例居中裁切，可缩放和挪动取景。 */
export function CoverCropDialog({ src, fileName, onClose, onConfirm }: Props) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const base = natural.w && natural.h ? Math.max(STAGE_W / natural.w, STAGE_H / natural.h) : 1;
  const drawnW = natural.w * base * zoom;
  const drawnH = natural.h * base * zoom;

  const clamp = (x: number, y: number, z: number) => {
    const bw = natural.w * base * z;
    const bh = natural.h * base * z;
    const mx = Math.max(0, (bw - STAGE_W) / 2);
    const my = Math.max(0, (bh - STAGE_H) / 2);
    return {
      x: Math.max(-mx, Math.min(mx, x)),
      y: Math.max(-my, Math.min(my, y)),
    };
  };

  const changeZoom = (z: number) => {
    const next = Math.max(1, Math.min(2.5, z));
    setZoom(next);
    setOffset((o) => clamp(o.x, o.y, next));
  };

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (busy) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  };

  const moveDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setOffset(
      clamp(
        drag.current.ox + (e.clientX - drag.current.x),
        drag.current.oy + (e.clientY - drag.current.y),
        zoom,
      ),
    );
  };

  const endDrag = () => {
    drag.current = null;
  };

  const confirm = async () => {
    const img = imgRef.current;
    if (!img || busy || !natural.w) return;
    setBusy(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 900;
      canvas.height = 1200;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const k = canvas.width / STAGE_W;
      ctx.fillStyle = "#fffdf8";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // 与预览使用完全相同的 cover + zoom + offset，不再出现“预览和落盘不一样”。
      ctx.drawImage(
        img,
        ((STAGE_W - drawnW) / 2 + offset.x) * k,
        ((STAGE_H - drawnH) / 2 + offset.y) * k,
        drawnW * k,
        drawnH * k,
      );
      await onConfirm(canvas.toDataURL("image/png"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("设置封面…")}
      subtitle={t("拖动画面取景，右侧滑杆可以放大。")}
      wide
      onClose={busy ? () => undefined : onClose}
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {t("取消")}
          </button>
          <button className="btn btn-primary" onClick={() => void confirm()} disabled={busy || !natural.w}>
            {busy ? t("正在保存…") : t("使用这张封面")}
          </button>
        </>
      }
    >
      <div className="cover-crop-dialog">
        <div
          className="cover-crop-stage"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <img
            ref={imgRef}
            src={src}
            alt=""
            draggable={false}
            onLoad={(e) =>
              setNatural({
                w: (e.currentTarget as HTMLImageElement).naturalWidth,
                h: (e.currentTarget as HTMLImageElement).naturalHeight,
              })
            }
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            }}
          />
          <span className="cover-crop-grid" aria-hidden="true" />
          <span className="cover-crop-badge">3 : 4</span>
        </div>

        <div className="cover-crop-side">
          <label className="cover-crop-zoom">
            <span>{t("缩放")}</span>
            <input
              type="range"
              min={1}
              max={2.5}
              step={0.01}
              value={zoom}
              style={{ "--range-fill": `${((zoom - 1) / 1.5) * 100}%` } as CSSProperties}
              onChange={(e) => changeZoom(Number(e.target.value))}
            />
            <b>{Math.round(zoom * 100)}%</b>
          </label>
          <p className="cover-crop-hint">
            {t("建议使用 3:4 封面；其他比例也可以，会按 3:4 居中裁切。")}
          </p>
          <p className="cover-crop-file" title={fileName}>
            <Icon name="image" size={13} />
            {fileName || t("本地图片")}
          </p>
        </div>
      </div>
    </Modal>
  );
}
