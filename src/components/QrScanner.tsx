import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { Icon } from "./Icon";

interface Props {
  onClose: () => void;
  onResult: (url: string) => void;
}

const PRIVACY =
  "Chapter 不会上传你的任何数据，摄像头仅供您与您的另一台设备之间传输使用";

export function QrScanner({ onClose, onResult }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const [cameraError, setCameraError] = useState("");
  const [manual, setManual] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };

    const tick = () => {
      if (stopped) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState >= 2) {
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (width && height) {
          if (canvas.width !== width) canvas.width = width;
          if (canvas.height !== height) canvas.height = height;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(video, 0, 0, width, height);
            const image = ctx.getImageData(0, 0, width, height);
            const found = jsQR(image.data, width, height, { inversionAttempts: "dontInvert" });
            if (found?.data) {
              stop();
              onResult(found.data.trim());
              return;
            }
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError("这台设备没有可用的摄像头接口，可以手动填写电脑上的地址。");
        return;
      }
      // Android 包内先向系统申请相机权限；不在启动时骚扰，只在扫码页申请。
      const bridge = (
        window as unknown as {
          ChapterAndroid?: { hasCamera?: () => boolean; requestCamera?: () => void };
        }
      ).ChapterAndroid;
      if (bridge?.requestCamera && !bridge.hasCamera?.()) {
        try {
          sessionStorage.setItem("chapter.scan.pending", "1");
        } catch {
          /* ignore */
        }
        bridge.requestCamera();
        for (let i = 0; i < 24; i += 1) {
          await new Promise((r) => setTimeout(r, 250));
          if (stopped || bridge.hasCamera?.()) break;
        }
      }
      try {
        const media = navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new DOMException("camera timeout", "TimeoutError")), 8000),
        );
        const stream = await Promise.race([media, timeout]);
        media
          .then((late) => {
            if (late !== stream) late.getTracks().forEach((t) => t.stop());
          })
          .catch(() => undefined);
        if (stopped) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        setReady(true);
        try {
          sessionStorage.removeItem("chapter.scan.pending");
        } catch {
          /* ignore */
        }
        rafRef.current = requestAnimationFrame(tick);
      } catch (e) {
        const name = e instanceof DOMException ? e.name : "";
        if (name === "NotAllowedError" || name === "SecurityError") {
          setCameraError("摄像头权限没有开启。Chapter 不会申请后台拍摄，你可以手动填写电脑上的地址。");
        } else if (name === "NotFoundError" || name === "OverconstrainedError") {
          setCameraError("没有找到可用的摄像头，可以手动填写电脑上的地址。");
        } else {
          setCameraError("摄像头没有启动，可以手动填写电脑上的地址。");
        }
      }
    })();

    return stop;
  }, [onResult]);

  return (
    <div className="qrscan-backdrop" role="dialog" aria-modal="true">
      <div className="qrscan-panel">
        <div className="qrscan-head">
          <div>
            <span className="transfer-eyebrow">CHAPTER / IN-APP SCAN</span>
            <h3>扫电脑上的二维码</h3>
          </div>
          <button className="icon-btn" onClick={onClose} title="关闭扫码">
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className={`qrscan-camera${ready ? " live" : ""}`}>
          <video ref={videoRef} playsInline muted />
          <div className="qrscan-frame" aria-hidden="true">
            <i /><i /><i /><i />
          </div>
          {cameraError && (
            <div className="qrscan-camera-error">
              <b>无法打开摄像头</b>
              <p>{cameraError}</p>
            </div>
          )}
          <p className="qrscan-privacy">{PRIVACY}</p>
        </div>
        <canvas ref={canvasRef} className="qrscan-canvas" />

        <label className="qrscan-manual">
          <span>电脑上的地址</span>
          <div>
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="http://192.168.1.8:端口/t/…"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
            />
            <button
              className="btn btn-primary btn-sm"
              disabled={!manual.trim()}
              onClick={() => onResult(manual.trim())}
            >
              打开
            </button>
          </div>
        </label>

        <p className="qrscan-note">不用手机系统相机；扫码后只在同一 Wi-Fi 内打开电脑的配对页。</p>
      </div>
    </div>
  );
}
