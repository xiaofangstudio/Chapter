import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { UiLanguage } from "../types";
import { t } from "../lib/i18n";
import { Icon } from "./Icon";
import xiaofangButt from "../assets/xiaofang-butt.gif";

const RICK_YOUTUBE = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const RICK_BILIBILI = "https://www.bilibili.com/video/BV1GJ411x7h7";

type Stage = "ready" | "shaking" | "safe" | "going";

/**
 * 设置页“百宝箱”里的唯一一件东西。
 * 点了就放小方抖屁股；1.6 秒后有 50% 概率按界面语言把浏览器带走。
 */
export function TreasureChest({ language, onClose }: { language: UiLanguage; onClose: () => void }) {
  const [stage, setStage] = useState<Stage>("ready");
  const [runId, setRunId] = useState(0);
  const timer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );

  const launch = () => {
    if (stage === "shaking" || stage === "going") return;
    setRunId((n) => n + 1);
    setStage("shaking");
    timer.current = window.setTimeout(() => {
      if (Math.random() >= 0.5) {
        const url = language === "zh" || language === "zhTW" ? RICK_BILIBILI : RICK_YOUTUBE;
        setStage("going");
        void openUrl(url).catch(() => undefined);
        timer.current = window.setTimeout(onClose, 260);
        return;
      }
      setStage("safe");
    }, 1600);
  };

  return createPortal(
    <div className="treasure-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="treasure-modal" role="dialog" aria-modal="true" aria-label={t("百宝箱")}>
        <button className="treasure-close" onClick={onClose} aria-label={t("关掉")}>
          <Icon name="close" size={15} />
        </button>

        <span className="treasure-kicker">THE TREASURE CHEST</span>
        <h2 className="treasure-title">
          {stage === "ready" ? t("百宝箱") : stage === "safe" ? t("这次没跳。") : stage === "going" ? t("跳转中…") : t("你点了。")}
        </h2>
        <p className="treasure-copy">
          {stage === "ready"
            ? t("小方工作室的抽屉。里面只有一件东西，而且千万别点。")
            : stage === "safe"
              ? t("这次算你走运。小方还在抖。")
              : t("小方正在抖屁股。50% 的概率，会发生一些事。")}
        </p>

        <div className={`xf-stage${stage === "shaking" || stage === "safe" ? " shaking" : ""}`} aria-hidden="true">
          <span className="xf-spark s1" />
          <span className="xf-spark s2" />
          <span className="xf-spark s3" />
          {stage === "ready" ? (
            <>
              <div className="xf-butt" />
              <div className="xf-body">
                <i className="xf-eye e1" />
                <i className="xf-eye e2" />
              </div>
            </>
          ) : (
            <img key={runId} className="xf-gif" src={xiaofangButt} alt="" draggable={false} />
          )}
          <div className="xf-floor" />
        </div>

        <div className="treasure-actions">
          {stage === "ready" && (
            <button className="btn treasure-danger" onClick={launch}>
              {t("千万别点")}
            </button>
          )}
          {stage === "safe" && (
            <button className="btn treasure-danger" onClick={launch}>
              {t("再点一次")}
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            {t("关掉")}
          </button>
        </div>
        <p className="treasure-foot">Art has no borders</p>
      </div>
    </div>,
    document.body,
  );
}

/** About 页里的百宝箱卡片。 */
export function TreasureCard({ language, onOpen }: { language: UiLanguage; onOpen: () => void }) {
  return (
    <div className="treasure-card">
      <div className="treasure-card-mark" aria-hidden="true">
        <span />
        <i />
      </div>
      <div className="treasure-card-copy">
        <b>{t("百宝箱")}</b>
        <span>{t("小方工作室的抽屉。里面只有一件东西，而且千万别点。")}</span>
      </div>
      <button className="treasure-card-btn" onClick={onOpen} data-language={language}>
        {t("千万别点")}
        <Icon name="arrow" size={13} />
      </button>
    </div>
  );
}
