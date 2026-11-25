import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_BRUSH,
  Stroke,
  type BrushSettings,
  type BrushTexture,
  type BrushTip,
} from "../lib/paint/paint";
import "../styles/brush-studio.css";

type NumericKey = {
  [K in keyof BrushSettings]-?: NonNullable<BrushSettings[K]> extends number ? K : never;
}[keyof BrushSettings];

type BoolKey = {
  [K in keyof BrushSettings]-?: NonNullable<BrushSettings[K]> extends boolean ? K : never;
}[keyof BrushSettings];

type NumField = {
  key: NumericKey;
  label: string;
  hint?: string;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
};

type BoolField = { key: BoolKey; label: string; hint?: string };

const TIP_FIELDS: NumField[] = [
  { key: "size", label: "笔尖大小", min: 1, max: 500, suffix: "px" },
  { key: "hardness", label: "硬度", min: 0, max: 100, suffix: "%" },
  { key: "spacing", label: "间距", min: 1, max: 50, suffix: "%" },
  { key: "opacity", label: "不透明度", min: 1, max: 100, suffix: "%" },
  { key: "roundness", label: "圆度", min: 10, max: 100, suffix: "%" },
  { key: "angle", label: "笔尖角度", min: 0, max: 360, suffix: "°" },
];

const SHAPE_FIELDS: NumField[] = [
  { key: "sizeJitter", label: "大小抖动", min: 0, max: 100, suffix: "%" },
  { key: "sizeMin", label: "最小大小", min: 0, max: 100, suffix: "%" },
  { key: "angleJitter", label: "角度抖动", min: 0, max: 100, suffix: "%" },
  { key: "roundnessJitter", label: "圆度抖动", min: 0, max: 100, suffix: "%" },
  { key: "roundnessMin", label: "最小圆度", min: 10, max: 100, suffix: "%" },
];

const SHAPE_TOGGLES: BoolField[] = [
  { key: "flipX", label: "水平翻转", hint: "每个笔尖随机左右镜像" },
  { key: "flipY", label: "垂直翻转", hint: "每个笔尖随机上下镜像" },
];

const SCATTER_FIELDS: NumField[] = [
  { key: "jitter", label: "散布", min: 0, max: 100, suffix: "%" },
  { key: "scatterCount", label: "每点笔尖数", min: 1, max: 16 },
  { key: "scatterCountJitter", label: "数量抖动", min: 0, max: 100, suffix: "%" },
];

const SCATTER_TOGGLES: BoolField[] = [
  { key: "scatterBothAxes", label: "双轴散布", hint: "关掉后只沿笔迹法线甩开" },
];

const TEXTURE_FIELDS: NumField[] = [
  { key: "textureScale", label: "纹理缩放", min: 50, max: 400, suffix: "%" },
  { key: "textureDepth", label: "纹理深度", min: 0, max: 100, suffix: "%" },
  { key: "textureBrightness", label: "纹理亮度", min: -100, max: 100 },
  { key: "textureContrast", label: "纹理对比", min: -100, max: 100 },
];

const TEXTURE_TOGGLES: BoolField[] = [
  { key: "textureInvert", label: "反转纹理" },
];

const COLOR_FIELDS: NumField[] = [
  { key: "hueJitter", label: "色相抖动", min: 0, max: 100, suffix: "%" },
  { key: "saturationJitter", label: "饱和度抖动", min: 0, max: 100, suffix: "%" },
  { key: "brightnessJitter", label: "明度抖动", min: 0, max: 100, suffix: "%" },
];

const TRANSFER_FIELDS: NumField[] = [
  { key: "flow", label: "流量", min: 1, max: 100, suffix: "%" },
  { key: "opacityJitter", label: "不透明度抖动", min: 0, max: 100, suffix: "%" },
  { key: "opacityMin", label: "最小不透明度", min: 0, max: 100, suffix: "%" },
  { key: "flowJitter", label: "流量抖动", min: 0, max: 100, suffix: "%" },
  { key: "flowMin", label: "最小流量", min: 0, max: 100, suffix: "%" },
];

const TIP_OPTIONS: { value: BrushTip; label: string }[] = [
  { value: "round", label: "圆头" },
  { value: "pencil", label: "铅笔" },
  { value: "chalk", label: "粉笔" },
  { value: "bristle", label: "排毛" },
  { value: "spray", label: "喷雾" },
  { value: "willow", label: "柳叶" },
];

const TEXTURE_OPTIONS: { value: BrushTexture; label: string }[] = [
  { value: "none", label: "无" },
  { value: "paper", label: "纸纹" },
  { value: "canvas", label: "画布" },
  { value: "grain", label: "颗粒" },
  { value: "dots", label: "斑点" },
];

type TabId = "tip" | "shape" | "scatter" | "texture" | "color" | "transfer" | "smoothing" | "symmetry";

const TABS: { id: TabId; label: string }[] = [
  { id: "tip", label: "笔尖" },
  { id: "shape", label: "形状" },
  { id: "scatter", label: "散布" },
  { id: "texture", label: "纹理" },
  { id: "color", label: "颜色" },
  { id: "transfer", label: "传递" },
  { id: "smoothing", label: "稳定" },
  { id: "symmetry", label: "对称" },
];

const SYMMETRY_OPTIONS: { value: NonNullable<BrushSettings["symmetry"]>; label: string; hint: string }[] = [
  { value: "none", label: "关", hint: "正常单笔" },
  { value: "vertical", label: "左右", hint: "沿画布竖中轴镜像" },
  { value: "horizontal", label: "上下", hint: "沿画布横中轴镜像" },
  { value: "both", label: "四向", hint: "左右 + 上下，一笔四落" },
];

function Slider({
  field,
  brush,
  onChange,
}: {
  field: NumField;
  brush: BrushSettings;
  onChange: (patch: Partial<BrushSettings>) => void;
}) {
  const value = Number(brush[field.key] ?? field.min);
  return (
    <label className="bp-slider" title={field.hint}>
      <span>{field.label}</span>
      <strong>{Math.round(value)}{field.suffix ?? ""}</strong>
      <input
        type="range"
        min={field.min}
        max={field.max}
        step={field.step ?? 1}
        value={value}
        onChange={(e) => onChange({ [field.key]: Number(e.target.value) } as Partial<BrushSettings>)}
      />
    </label>
  );
}

function Check({
  field,
  brush,
  onChange,
}: {
  field: BoolField;
  brush: BrushSettings;
  onChange: (patch: Partial<BrushSettings>) => void;
}) {
  const on = Boolean(brush[field.key]);
  return (
    <label className="bp-check" title={field.hint}>
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => onChange({ [field.key]: e.target.checked } as Partial<BrushSettings>)}
      />
      <span>{field.label}</span>
    </label>
  );
}

function StrokePreview({ brush }: { brush: BrushSettings }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const W = 620;
    const H = 104;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const off = document.createElement("canvas");
    off.width = canvas.width;
    off.height = canvas.height;
    const offCtx = off.getContext("2d");
    if (!offCtx) return;

    const sample: BrushSettings = {
      ...brush,
      size: Math.max(2, Math.min(brush.size, 150)) * dpr,
    };
    const stroke = new Stroke(off.width, off.height, sample, false);
    const x0 = 54 * dpr;
    const x1 = (W - 54) * dpr;
    const midY = (H * dpr) / 2;
    const amp = 20 * dpr * Math.sin((Math.min(brush.size, 150) / 150) * Math.PI * 0.5 + 0.35);
    const steps = 110;
    const t0 = 1000;
    stroke.begin(x0, midY, 1, t0);
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      stroke.extend(
        x0 + (x1 - x0) * t,
        midY + Math.sin(t * Math.PI * 2.4) * amp * Math.sin(t * Math.PI),
        0.45 + 0.55 * Math.sin(t * Math.PI),
        t0 + i * 8,
      );
    }
    stroke.finish(off);
    ctx.drawImage(off, 0, 0, W, H);
  }, [brush]);

  return <canvas ref={ref} className="bp-preview" width={620} height={104} />;
}

export function BrushStudio({
  brush,
  isEraser,
  onChange,
  onClose,
}: {
  brush: BrushSettings;
  isEraser: boolean;
  onChange: (patch: Partial<BrushSettings>) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<TabId>("tip");
  const textureOff = brush.texture === "none" || brush.textureDepth === 0;

  return (
    <div className="bp-mask" onClick={onClose}>
      <div className="bp-modal" onClick={(e) => e.stopPropagation()}>
        <header className="bp-head">
          <div>
            <strong>画笔工作室</strong>
            <span>Strata 同一套内核 · {isEraser ? "橡皮" : "画笔"}</span>
          </div>
          <button className="bp-close" onClick={onClose} title="关闭">
            ×
          </button>
        </header>

        <div className="bp-preview-wrap">
          <StrokePreview brush={brush} />
          <p>预览走的就是落笔那一套 Stroke，参数改了会当场变。</p>
        </div>

        <div className="bp-tabs" role="tablist">
          {TABS.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={tab === item.id}
              className={`bp-tab${tab === item.id ? " on" : ""}`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="bp-pane">
          {tab === "tip" && (
            <>
              <div className="bp-wide">
                <span className="bp-label">笔尖材质</span>
                <div className="bp-seg">
                  {TIP_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      className={brush.tip === opt.value ? "on" : ""}
                      onClick={() =>
                        onChange({ tip: opt.value, alignToStroke: opt.value === "willow" })
                      }
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="bp-fields">
                {TIP_FIELDS.map((field) => (
                  <Slider key={field.key} field={field} brush={brush} onChange={onChange} />
                ))}
              </div>
              <div className="bp-checks">
                <Check
                  field={{ key: "penPressure", label: "压感控制大小" }}
                  brush={brush}
                  onChange={onChange}
                />
                <Check
                  field={{ key: "penTilt", label: "倾斜控制笔锋" }}
                  brush={brush}
                  onChange={onChange}
                />
                <Check
                  field={{ key: "alignToStroke", label: "叶尖跟随运笔" }}
                  brush={brush}
                  onChange={onChange}
                />
              </div>
              <p className="bp-note">间距越小越顺滑，但每帧笔尖更多；卡顿时先把间距调到 6%–10%。</p>
            </>
          )}

          {tab === "shape" && (
            <>
              <div className="bp-fields">
                {SHAPE_FIELDS.map((field) => (
                  <Slider key={field.key} field={field} brush={brush} onChange={onChange} />
                ))}
              </div>
              <div className="bp-checks">
                {SHAPE_TOGGLES.map((field) => (
                  <Check key={field.key} field={field} brush={brush} onChange={onChange} />
                ))}
              </div>
            </>
          )}

          {tab === "scatter" && (
            <>
              <div className="bp-fields">
                {SCATTER_FIELDS.map((field) => (
                  <Slider key={field.key} field={field} brush={brush} onChange={onChange} />
                ))}
              </div>
              <div className="bp-checks">
                {SCATTER_TOGGLES.map((field) => (
                  <Check key={field.key} field={field} brush={brush} onChange={onChange} />
                ))}
              </div>
            </>
          )}

          {tab === "texture" && (
            <>
              <div className="bp-wide">
                <span className="bp-label">纹理</span>
                <div className="bp-seg">
                  {TEXTURE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      className={brush.texture === opt.value ? "on" : ""}
                      onClick={() => onChange({ texture: opt.value })}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="bp-fields">
                {TEXTURE_FIELDS.map((field) => (
                  <Slider key={field.key} field={field} brush={brush} onChange={onChange} />
                ))}
              </div>
              <div className="bp-checks">
                {TEXTURE_TOGGLES.map((field) => (
                  <Check key={field.key} field={field} brush={brush} onChange={onChange} />
                ))}
              </div>
              {textureOff && <p className="bp-note warn">纹理选了「无」或深度为 0 时，纹理参数不会落笔。</p>}
            </>
          )}

          {tab === "color" && (
            <>
              <div className="bp-fields">
                {COLOR_FIELDS.map((field) => (
                  <Slider key={field.key} field={field} brush={brush} onChange={onChange} />
                ))}
              </div>
              <p className="bp-note">颜色抖动是每个笔尖在色相环上随机偏移，画颗粒、彩铅和水彩时用。</p>
            </>
          )}

          {tab === "transfer" && (
            <div className="bp-fields">
              {TRANSFER_FIELDS.map((field) => (
                <Slider key={field.key} field={field} brush={brush} onChange={onChange} />
              ))}
            </div>
          )}

          {tab === "smoothing" && (
            <>
              <div className="bp-fields">
                <Slider
                  field={{ key: "smoothing", label: "防抖", min: 0, max: 100, suffix: "%" }}
                  brush={brush}
                  onChange={onChange}
                />
              </div>
              <div className="bp-checks">
                <Check
                  field={{ key: "pulledString", label: "拉绳模式" }}
                  brush={brush}
                  onChange={onChange}
                />
                <Check
                  field={{ key: "catchUp", label: "停笔追线" }}
                  brush={brush}
                  onChange={onChange}
                />
                <Check
                  field={{ key: "catchUpOnEnd", label: "抬笔吸附末端" }}
                  brush={brush}
                  onChange={onChange}
                />
              </div>
              <p className="bp-note">想最跟手就把防抖拉到 0；手抖厉害再往 10–20 加。</p>
            </>
          )}

          {tab === "symmetry" && (
            <>
              <div className="bp-wide">
                <span className="bp-label">对称落笔</span>
                <div className="bp-seg">
                  {SYMMETRY_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      className={(brush.symmetry ?? "none") === opt.value ? "on" : ""}
                      title={opt.hint}
                      onClick={() => onChange({ symmetry: opt.value })}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="bp-note">
                镜像轴是当前画布中线：格内聚焦按单格算，多格并集按并集外框算。一笔落下会同时补镜像点，仍只占一步撤销。
              </p>
            </>
          )}
        </div>

        <footer className="bp-foot">
          <button
            onClick={() => onChange({ ...DEFAULT_BRUSH, color: brush.color, smoothing: 0 })}
            className="bp-reset"
          >
            恢复默认
          </button>
          <button onClick={onClose} className="bp-done">
            好
          </button>
        </footer>
      </div>
    </div>
  );
}
