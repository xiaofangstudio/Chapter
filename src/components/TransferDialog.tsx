import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import QRCode from "qrcode";
import type { Outline, TransferComparison, TransferItem, TransferSnapshot } from "../types";
import { api, errText } from "../lib/api";
import { t } from "../lib/i18n";
import { Icon } from "./Icon";

interface Props {
  bookPath: string | null;
  outline?: Outline | null;
  onClose: () => void;
  onApplied: (path: string) => void;
}

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

function fmtSpeed(n: number): string {
  return `${fmtBytes(n)}/s`;
}

function itemLabel(path: string, chapterTitles: Record<string, string>): string {
  if (path === "book.json") return "书籍信息 · 书名/作者/简介/目标";
  if (path === "outline.json") return "章节大纲 · 卷/章/场景";
  if (path === "lore.json") return "世界观/设定/地图";
  if (path.startsWith("chapters/")) {
    const id = path.slice("chapters/".length, -".md".length);
    const title = chapterTitles[id];
    return title ? `正文 · ${title}` : `正文 · ${id}`;
  }
  if (path.startsWith("notes/")) return `灵感笔记 · ${path.slice("notes/".length)}`;
  if (path === "comic/project.json") return "漫画工程 · 页面顺序/尺寸/阅读方向";
  if (path.startsWith("comic/pages/")) {
    const parts = path.split("/");
    const pageId = parts[2] ?? "";
    const file = parts.slice(3).join("/");
    if (file === "page.json") return `漫画页 · ${pageId}`;
    if (file.startsWith("layers/")) return `漫画图层 · ${pageId} / ${file.slice("layers/".length)}`;
    if (file.startsWith("assets/")) return `漫画素材 · ${pageId} / ${file.slice("assets/".length)}`;
    if (file.startsWith("thumbs/")) return `漫画缩略图 · ${pageId}`;
    return `漫画 · ${pageId} / ${file}`;
  }
  if (path.startsWith("assets/")) return `图片 · ${path.slice("assets/".length)}`;
  return path;
}

function stateLabel(state: TransferItem["state"]): string {
  if (state === "pcNewer") return "电脑较新";
  if (state === "phoneNewer") return "手机较新";
  if (state === "pcOnly") return "只在电脑";
  if (state === "phoneOnly") return "只在手机";
  return "时间相同";
}

function phaseTitle(snap: TransferSnapshot): string {
  if (snap.phase === "waiting") return t("等待手机扫码");
  if (snap.phase === "ready") return t("手机已绑定");
  if (snap.phase === "preparing") return t("正在准备要传的内容");
  if (snap.phase === "transferring") return t("正在传输");
  if (snap.phase === "applying") return t("电脑正在写入书稿");
  if (snap.phase === "done") return t("传输完成");
  if (snap.phase === "cancelled") return t("已取消");
  return t("互传出错");
}

function phonePhaseTitle(snap: TransferSnapshot): string {
  if (snap.phase === "waiting") return t("等待电脑扫码");
  if (snap.phase === "ready") return t("电脑已连接");
  if (snap.phase === "preparing") return t("正在准备要传的内容");
  if (snap.phase === "transferring") return t("正在传输");
  if (snap.phase === "applying") return t("电脑正在接收书稿");
  if (snap.phase === "done") return t("已经发到电脑");
  if (snap.phase === "cancelled") return t("已取消");
  return t("互传出错");
}

function countText(c: TransferComparison, direction: "pc_to_phone" | "phone_to_pc") {
  if (direction === "pc_to_phone") {
    return { count: c.changedPcToPhone, bytes: c.changedBytesPcToPhone };
  }
  return { count: c.changedPhoneToPc, bytes: c.changedBytesPhoneToPc };
}

export function TransferDialog({ bookPath, outline = null, onClose, onApplied }: Props) {
  const [snap, setSnap] = useState<TransferSnapshot | null>(null);
  const [qr, setQr] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const [showAll, setShowAll] = useState(false);
  const alive = useRef(true);
  const callbacks = useRef({ onClose, onApplied });
  callbacks.current = { onClose, onApplied };
  const isPhone = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

  useEffect(() => {
    alive.current = true;
    let unlisten: (() => void) | undefined;
    let unlistenApplied: (() => void) | undefined;
    (async () => {
      try {
        let first = await api.transferStart(bookPath);
        if (!alive.current) return;
        // 手机上默认是手机 → 电脑；电脑端打开时保持电脑 → 手机。
        if (isPhone && first.direction === "pc_to_phone") {
          try {
            /* direction request */
            first = await api.transferDirection("phone_to_pc");
          } catch {
            /* 反向失败时保留原方向，仍可在页内切换 */
          }
        }
        if (!alive.current) return;
        setSnap(first);
        unlisten = await listen<TransferSnapshot>("transfer-update", (event) => {
          if (alive.current) setSnap(event.payload);
        });
        unlistenApplied = await listen<{ path: string }>("transfer-applied", (event) => {
          if (!alive.current) return;
          const path = event.payload?.path;
          if (path) {
            callbacks.current.onApplied(path);
            callbacks.current.onClose();
          }
        });
      } catch (e) {
        if (alive.current) setLocalError(`启动互传失败：${errText(e)}`);
      }
    })();
    return () => {
      alive.current = false;
      unlisten?.();
      unlistenApplied?.();
      void api.transferClose().catch(() => undefined);
    };
  }, [bookPath]);

  useEffect(() => {
    if (!snap) return;
    let stopped = false;
    const tick = async () => {
      try {
        const next = await api.transferStatus();
        if (!stopped && alive.current) setSnap(next);
      } catch {
        /* 会话已经关掉时忽略 */
      }
    };
    const timer = window.setInterval(tick, 700);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [snap?.id]);

  useEffect(() => {
    if (!snap?.url) {
      setQr("");
      return;
    }
    let live = true;
    QRCode.toDataURL(snap.url, {
      width: 238,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#3b2a1a", light: "#fffaf3" },
    })
      .then((url) => live && setQr(url))
      .catch(() => live && setQr(""));
    return () => {
      live = false;
    };
  }, [snap?.url]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (snap && ["preparing", "transferring", "applying"].includes(snap.phase)) {
        e.preventDefault();
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [snap, onClose]);

  const locked = !!snap && ["preparing", "transferring", "applying"].includes(snap.phase);
  const comparison = snap?.comparison ?? null;
  const chosen = comparison ? countText(comparison, snap?.direction ?? "pc_to_phone") : null;
  const chapterTitles = useMemo(() => {
    const map: Record<string, string> = {};
    for (const volume of outline?.volumes ?? []) {
      for (const chapter of volume.chapters ?? []) {
        if (chapter.id) map[chapter.id] = chapter.title || "未命名章节";
      }
    }
    return map;
  }, [outline]);
  const visibleItems = useMemo(() => {
    if (!comparison) return [];
    const items = comparison.items.filter((item) => item.state !== "conflict");
    return showAll ? items : items.slice(0, 24);
  }, [comparison, showAll]);

  const doClose = () => {
    if (locked) {
      setLocalError("传输中请不要退出 Chapter，等进度走完再关。");
      return;
    }
    onClose();
  };

  const flip = async (direction: "pc_to_phone" | "phone_to_pc") => {
    if (!snap || busy) return;
    setBusy(true);
    setLocalError("");
    try {
      const next = await api.transferDirection(direction);
      setSnap(next);
    } catch (e) {
      setLocalError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!snap || busy) return;
    setBusy(true);
    setLocalError("");
    try {
      const next = await api.transferConfirm();
      setSnap(next);
    } catch (e) {
      setLocalError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      const next = await api.transferCancel();
      setSnap(next);
    } catch (e) {
      setLocalError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const errorText = localError || snap?.error || "";

  return (
    <div
      className="backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) doClose();
      }}
    >
      <div className="modal glass transfer-modal" role="dialog" aria-modal="true">
        <div className="modal-head transfer-head">
          <div>
            <span className="transfer-eyebrow">CHAPTER / LOCAL TRANSFER</span>
            <h3>{snap ? (isPhone ? phonePhaseTitle(snap) : phaseTitle(snap)) : "手机互传"}</h3>
            <p>
              {isPhone
                ? "同一个 Wi-Fi，用电脑浏览器扫码连上这台手机；先选方向，再只传有变化的内容。"
                : "同一个 Wi-Fi，书稿不经过云端。先绑定手机，再由电脑确认方向；只传有变化的内容。"}
            </p>
          </div>
          <button className="icon-btn" onClick={doClose} title={locked ? "传输中不能退出" : "关闭"}>
            <Icon name="close" size={16} />
          </button>
        </div>

        {!snap ? (
          <div className="transfer-loading">
            <span className="transfer-spinner" />
            {localError || "正在开启局域网服务…"}
          </div>
        ) : (
          <>
            <div className="transfer-steps">
              {[
                ["1", isPhone ? "电脑扫码" : "手机扫码"],
                ["2", isPhone ? "电脑连接" : "电脑确认"],
                ["3", "只传变化"],
                ["4", "真实进度"],
              ].map(([n, label], i) => {
                const active =
                  (i === 0 && snap.phase === "waiting") ||
                  (i === 1 && snap.phase === "ready") ||
                  (i === 2 && (snap.phase === "preparing" || snap.phase === "transferring")) ||
                  (i === 3 && ["applying", "done"].includes(snap.phase));
                const done =
                  (i === 0 && snap.phase !== "waiting") ||
                  (i === 1 && !["waiting", "ready"].includes(snap.phase)) ||
                  (i === 2 && ["applying", "done"].includes(snap.phase));
                return (
                  <div key={n} className={`transfer-step${active ? " on" : ""}${done ? " done" : ""}`}>
                    <i>{done ? <Icon name="check" size={11} /> : n}</i>
                    <span>{label}</span>
                  </div>
                );
              })}
            </div>

            {snap.phase === "done" ? (
              <div className="transfer-done">
                <div className="transfer-done-mark">
                  <Icon name="check" size={30} />
                </div>
                <h4>{snap.direction === "pc_to_phone" ? "电脑已经发完" : "手机书稿已经写进电脑"}</h4>
                <p>
                  {snap.direction === "pc_to_phone"
                    ? "手机页面会收到 .chapterpack；下载后回到 Chapter 书架，点“导入同步包”读入即可。"
                    : "电脑已经按同步包更新了这本书，界面偏好没有被覆盖。"}
                </p>
                <div className="transfer-done-stats">
                  <span>{snap.progress.filesTotal || chosen?.count || 0} 个文件</span>
                  <span>{fmtBytes(snap.progress.totalBytes || chosen?.bytes || 0)}</span>
                  <span>{(snap.progress.speed || 0) > 0 ? `平均 ${fmtSpeed(snap.progress.speed)}` : "已完成"}</span>
                </div>
                <button className="btn btn-primary" onClick={doClose}>
                  完成
                </button>
              </div>
            ) : snap.phase === "error" || snap.phase === "cancelled" ? (
              <div className="transfer-error">
                <p>{errorText || "这次互传没有完成。"}</p>
                <div className="transfer-error-actions">
                  <button className="btn" onClick={doClose}>
                    关闭
                  </button>
                </div>
              </div>
            ) : (
              <div className="transfer-grid">
                <aside className="transfer-qr-card">
                  <div className="transfer-qr-frame">
                    {qr ? <img src={qr} alt="手机扫码" /> : <div className="transfer-qr-placeholder">生成二维码中…</div>}
                  </div>
                  <div className="transfer-qr-caption">
                    <b>{isPhone ? "用电脑浏览器扫这个码" : "用手机相机扫这个码"}</b>
                    <span>
                      {isPhone
                        ? "电脑和这台手机必须在同一个 Wi-Fi。二维码 10 分钟内有效。"
                        : "手机和电脑必须在同一个 Wi-Fi。二维码 10 分钟内有效。"}
                    </span>
                  </div>
                  <div className="transfer-url">
                    <span>{isPhone ? "电脑打不开？手动输入" : "打不开？手动输入"}</span>
                    <code>{snap.url}</code>
                  </div>
                  <div className="transfer-net">
                    <span className={`transfer-dot${snap.device ? " on" : ""}`} />
                    {snap.device
                      ? `已连接：${snap.device.name}`
                      : isPhone
                        ? "等待电脑扫码…"
                        : "等待手机扫码…"}
                  </div>
                </aside>

                <section className="transfer-main">
                  <div className="transfer-book-row">
                    <div className="transfer-book-card">
                      <span className="transfer-kicker">电脑这本书</span>
                      <b>{snap.book?.title || "还没有选书"}</b>
                      <span>
                        {snap.book
                          ? `${snap.book.chapters} 章 · ${fmtBytes(snap.book.bytes)}`
                          : "手机传过来时会新建一本"}
                      </span>
                    </div>
                    <div className={`transfer-arrow${snap.direction === "phone_to_pc" ? " back" : ""}`}>
                      <Icon name="arrow" size={20} />
                      <em>{snap.direction === "pc_to_phone" ? "电脑 → 手机" : "手机 → 电脑"}</em>
                    </div>
                    <div className="transfer-book-card phone">
                      <span className="transfer-kicker">手机这本书</span>
                      <b>{snap.device?.manifest?.title || (snap.device ? "还没有这本书" : "还没绑定")}</b>
                      <span>
                        {snap.device?.manifest
                          ? `${snap.device.manifest.chapterCount} 章 · ${fmtBytes(snap.device.manifest.totalBytes)}`
                          : snap.device
                            ? "第一次传会收到整本"
                            : "扫码后自动读取"}
                      </span>
                    </div>
                  </div>

                  {snap.phase === "waiting" ? (
                    <div className="transfer-waiting">
                      <span className="transfer-spinner small" />
                      <div>
                        <b>{isPhone ? "等电脑打开并绑定这台手机" : "等手机点“绑定这台手机”"}</b>
                        <p>
                          {isPhone
                            ? "电脑网页会先显示“已连接”，然后这里才会出现确认按钮。"
                            : "手机页面会先显示“已绑定”，然后电脑这边才会出现确认按钮。"}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="transfer-summary-row">
                        <div>
                          <span>比较结果</span>
                          <b>
                            {comparison
                              ? `电脑较新 ${comparison.pcNewer + comparison.pcOnly} · 手机较新 ${comparison.phoneNewer + comparison.phoneOnly}`
                              : "正在读取书目"}
                          </b>
                        </div>
                        <div>
                          <span>本次要传</span>
                          <b>
                            {chosen ? `${chosen.count} 项 · ${fmtBytes(chosen.bytes)}` : "—"}
                          </b>
                        </div>
                        <div>
                          <span>不参与同步</span>
                          <b>主题 / 语言 / 窗口 / 界面设置</b>
                        </div>
                      </div>

                      <div className="transfer-direction">
                        <button
                          className={snap.direction === "pc_to_phone" ? "on" : ""}
                          disabled={busy || !comparison || snap.phase !== "ready"}
                          onClick={() => void flip("pc_to_phone")}
                        >
                          电脑 → 手机
                        </button>
                        <button
                          className={snap.direction === "phone_to_pc" ? "on" : ""}
                          disabled={busy || !comparison || snap.phase !== "ready"}
                          onClick={() => void flip("phone_to_pc")}
                        >
                          手机 → 电脑
                        </button>
                        <span>
                          {comparison?.suggestedDirection === snap.direction
                            ? "系统判断的方向"
                            : "已手动翻转，确认后按这个方向覆盖"}
                        </span>
                      </div>

                      {comparison && (
                        <div className="transfer-note">
                          {comparison.confidence}
                          {comparison.conflicts > 0 ? `；${comparison.conflicts} 项时间相同按电脑` : ""}
                          {comparison.pcNewer > 0 && comparison.phoneNewer > 0
                            ? "；两边都有改动，只传变化项，不会把整本重写。"
                            : ""}
                        </div>
                      )}

                      <div className="transfer-items">
                        <div className="transfer-items-head">
                          <b>变化清单</b>
                          <span>{comparison ? `${comparison.items.length} 项` : "—"}</span>
                        </div>
                        {visibleItems.length === 0 ? (
                          <div className="transfer-empty">两边内容一致，没有需要传的变化。</div>
                        ) : (
                          <div className="transfer-item-list">
                            {visibleItems.map((item) => (
                              <div className="transfer-item" key={item.path}>
                                <span className={`transfer-item-dot ${item.state}`} />
                                <div>
                                  <b>{itemLabel(item.path, chapterTitles)}</b>
                                  <em>
                                    {stateLabel(item.state)} · 电脑 {fmtBytes(item.pcSize)} / 手机{" "}
                                    {fmtBytes(item.phoneSize)}
                                  </em>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                        {comparison && comparison.items.length > 24 && (
                          <button className="transfer-more" onClick={() => setShowAll((v) => !v)}>
                            {showAll ? "收起" : `再看 ${comparison.items.length - 24} 项`}
                          </button>
                        )}
                      </div>

                      {["preparing", "transferring", "applying"].includes(snap.phase) && (
                        <div className="transfer-progress">
                          <div className="transfer-progress-top">
                            <span>{snap.phase === "applying" ? "写入书稿" : "真实传输"}</span>
                            <b>{snap.progress.percent.toFixed(1)}%</b>
                          </div>
                          <div className="transfer-bar">
                            <i style={{ width: `${Math.max(0.5, snap.progress.percent)}%` }} />
                          </div>
                          <div className="transfer-progress-meta">
                            <span>
                              {fmtBytes(snap.progress.bytesDone)} / {fmtBytes(snap.progress.totalBytes)}
                            </span>
                            <span>{fmtSpeed(snap.progress.speed)}</span>
                            <span>{snap.progress.currentFile || "等待手机开始"}</span>
                          </div>
                          <div className="transfer-warning">
                            <b>传输中请不要退出 Chapter</b>
                            <span>不要锁屏，不要切走 Wi-Fi。进度按实际字节走，不会假装到 100%。</span>
                          </div>
                          {snap.phase === "transferring" && (
                            <button className="btn transfer-cancel" disabled={busy} onClick={() => void cancel()}>
                              取消这次互传
                            </button>
                          )}
                        </div>
                      )}

                      {snap.phase === "ready" && (
                        <div className="transfer-actions">
                          <div>
                            <b>确认后只传上面这些变化</b>
                            <span>
                              {snap.direction === "pc_to_phone"
                                ? "手机页面会收到 .chapterpack，导入后只合并变化。"
                                : "手机会把变化包上传到电脑，电脑只覆盖这些内容。"}
                            </span>
                          </div>
                          <button className="btn" onClick={doClose}>
                            先不传
                          </button>
                          <button
                            className="btn btn-primary"
                            disabled={busy || !chosen || chosen.count === 0}
                            onClick={() => void confirm()}
                          >
                            {chosen && chosen.count === 0 ? "没有变化" : "确认传输"}
                          </button>
                        </div>
                      )}

                      {snap.phase === "transferring" && snap.direction === "phone_to_pc" && (
                        <div className="transfer-hint">手机页面现在会出现“把手机书稿传给电脑”的按钮。</div>
                      )}
                    </>
                  )}
                </section>
              </div>
            )}

            {errorText && snap.phase !== "error" && snap.phase !== "cancelled" && (
              <div className="transfer-inline-error">{errorText}</div>
            )}

            {locked && (
              <div className="transfer-lock-note">
                <Icon name="clock" size={13} />
                正在传输，关闭按钮暂时锁住。
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
