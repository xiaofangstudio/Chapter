import { useEffect, useMemo, useRef, useState } from "react";
import type { TransferSnapshot } from "../types";
import { api, errText } from "../lib/api";
import { Icon } from "./Icon";

function fmtBytes(n: number): string {
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function splitPair(url: string): { apiBase: string; display: string } | null {
  try {
    const u = new URL(url);
    // 电脑端二维码走 /t/{token}；旧配对页与手工粘贴可能仍然给 /pair/{token}。
    const m = u.pathname.match(/\/(?:pair|t)\/([^/]+)\/?$/);
    if (!m) return null;
    return {
      apiBase: `${u.origin}/api/${m[1]}`,
      display: `${u.host}/t/${m[1]}`,
    };
  } catch {
    return null;
  }
}

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function phaseLabel(phase: string): string {
  return (
    {
      waiting: "等待电脑配对",
      ready: "等待电脑确认方向",
      preparing: "电脑正在准备书稿",
      transferring: "正在传输",
      applying: "正在写入手机",
      done: "已完成",
      error: "出错了",
    }[phase] || phase
  );
}

export function PhonePairPage({
  url,
  bookPath,
  onClose,
  onImported,
}: {
  url: string;
  bookPath?: string | null;
  onClose: () => void;
  onImported: (path: string) => void;
}) {
  const pair = useMemo(() => splitPair(url), [url]);
  const [snap, setSnap] = useState<TransferSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState(0);
  const [imported, setImported] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState(false);
  const pairedOnce = useRef(false);

  useEffect(() => {
    if (!pair) {
      setError("这个二维码不是 Chapter 配对地址");
      return;
    }
    let alive = true;
    const run = async () => {
      try {
        const stateRes = await fetch(`${pair.apiBase}/state`, { cache: "no-store" });
        if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`);
        const state = (await stateRes.json()) as TransferSnapshot;
        if (!alive) return;
        setSnap(state);
        setError("");
        if (!state.device && !pairedOnce.current) {
          pairedOnce.current = true;
          let manifest: unknown = null;
          if (bookPath) {
            manifest = await api.syncManifest(bookPath).catch(() => null);
          }
          const res = await fetch(`${pair.apiBase}/pair`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "Chapter 手机",
              platform: "android",
              model: "Android",
              appVersion: "chapter-app/1.9.10",
              manifest,
            }),
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(body.error || "绑定失败");
          }
          const next = (await res.json()) as TransferSnapshot;
          if (alive) setSnap(next);
        }
      } catch (e) {
        if (alive) setError(errText(e));
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), 1200);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [bookPath, pair]);

  const directionText = snap?.direction === "phone_to_pc" ? "手机 → 电脑" : "电脑 → 手机";
  const comparison = snap?.comparison;
  const count =
    snap?.direction === "phone_to_pc"
      ? comparison?.changedPhoneToPc ?? 0
      : comparison?.changedPcToPhone ?? 0;
  const bytes =
    snap?.direction === "phone_to_pc"
      ? comparison?.changedBytesPhoneToPc ?? 0
      : comparison?.changedBytesPcToPhone ?? 0;

  const receive = async () => {
    if (!pair || busy || !snap) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${pair.apiBase}/download`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `下载失败：HTTP ${res.status}`);
      }
      const total = Number(res.headers.get("Content-Length") || 0);
      const reader = res.body?.getReader();
      if (!reader) throw new Error("这个 WebView 不支持流式下载");
      const chunks: Uint8Array[] = [];
      let got = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        chunks.push(value);
        got += value.length;
        setPercent(total ? Math.min(100, (got / total) * 100) : 0);
      }
      const merged = new Uint8Array(got);
      let at = 0;
      for (const chunk of chunks) {
        merged.set(chunk, at);
        at += chunk.length;
      }
      const path = await api.importChapterpack(bytesToBase64(merged.buffer));
      setImported(path);
      setPercent(100);
      onImported(path);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!pair || busy || !snap) return;
    if (!bookPath) {
      setError("先在 Chapter 里打开要传的那本书，再扫码配对。");
      return;
    }
    setBusy(true);
    setError("");
    setPercent(8);
    try {
      const data = await api.exportChapterpack(bookPath);
      setPercent(34);
      const bytes = base64ToBytes(data);
      const res = await fetch(`${pair.apiBase}/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: bytes.buffer as ArrayBuffer,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `上传失败：HTTP ${res.status}`);
      }
      setUploaded(true);
      setPercent(100);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="backdrop transfer-phone phone-pair">
      <div className="modal glass phone-pair-modal" role="dialog" aria-modal="true">
        <div className="modal-head transfer-head">
          <div>
            <span className="transfer-eyebrow">CHAPTER / LOCAL TRANSFER</span>
            <h3>{imported ? "已经收进手机" : uploaded ? "已经传给电脑" : snap ? phaseLabel(snap.phase) : "正在连接电脑"}</h3>
            <p>这次是在 Chapter 里接收，不再跳到系统浏览器。</p>
          </div>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="phone-pair-body">
          {!pair ? (
            <p className="phone-pair-error">{error || "二维码地址不完整"}</p>
          ) : (
            <>
              <div className="phone-pair-route">
                <span>本次方向</span>
                <b>{directionText}</b>
                <em>{snap?.book?.title || "等待电脑选书"}</em>
              </div>

              <div className="phone-pair-grid">
                <div>
                  <span>比较结果</span>
                  <b>
                    {comparison
                      ? `电脑较新 ${comparison.pcNewer + comparison.pcOnly} · 手机较新 ${comparison.phoneNewer + comparison.phoneOnly}`
                      : "正在读取"}
                  </b>
                </div>
                <div>
                  <span>这次要传</span>
                  <b>
                    {comparison
                      ? count === 0
                        ? "完全一致 · 可全量重传"
                        : `${count} 项 · ${fmtBytes(bytes)}`
                      : "—"}
                  </b>
                </div>
              </div>

              {(snap?.phase === "preparing" || snap?.phase === "transferring" || busy) && (
                <div className="phone-pair-progress">
                  <span style={{ width: `${percent}%` }} />
                </div>
              )}

              {error && <p className="phone-pair-error">{error}</p>}

              {snap?.phase === "ready" && (
                <p className="phone-pair-note">
                  电脑端已绑定。等电脑点“确认传输”后，这里会出现接收按钮；如果两边一样，电脑也会按全量重传，不会直接跳过。
                </p>
              )}

              {snap?.phase === "transferring" && snap.direction === "pc_to_phone" && !imported && (
                <button className="btn btn-primary phone-pair-action" disabled={busy} onClick={() => void receive()}>
                  {busy ? `正在接收 ${Math.round(percent)}%` : "接收电脑书稿"}
                </button>
              )}

              {snap?.phase === "transferring" && snap.direction === "phone_to_pc" && !uploaded && (
                <>
                  <button
                    className="btn btn-primary phone-pair-action"
                    disabled={busy}
                    onClick={() => void send()}
                  >
                    {busy ? "正在打包并上传…" : "把手机书稿传给电脑"}
                  </button>
                  <p className="phone-pair-note">
                    手机这边会在应用内把当前书打成完整 .chapterpack 直接上传，不需要先导出到文件管理器。
                    {count === 0 ? "两边完全一致也会全量重传一遍。" : ""}
                  </p>
                </>
              )}

              {uploaded && (
                <p className="phone-pair-note ok">
                  手机书稿已经写到电脑。等电脑端落盘完成，就可以在电脑上的 Chapter 打开这本书。
                </p>
              )}

              {snap?.phase === "transferring" && snap.direction === "pc_to_phone" && busy && (
                <p className="phone-pair-note">正在接收，保持屏幕亮着，不要切走 Wi-Fi。</p>
              )}

              {imported && (
                <p className="phone-pair-note ok">
                  书稿已经写进手机书库。可以关闭这里，回书架打开《{snap?.book?.title || "这本书"}》。
                </p>
              )}

              <p className="phone-pair-url">{pair.display}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
