import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../lib/i18n";
import { Icon } from "./Icon";

type Choice = { value: string; label: string; disabled: boolean };

type Session = {
  select: HTMLSelectElement;
  choices: Choice[];
  title: string;
  value: string;
};

/**
 * 手机上所有 <select> 都会被这里接住，换成应用内的底部选择面板。
 * 这样不用逐个重写业务下拉，也不会再弹 Android 原生列表。
 */
export function MobileSelectBridge() {
  const [session, setSession] = useState<Session | null>(null);
  const [isPhone, setIsPhone] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 820px)");
    const sync = () => setIsPhone(query.matches);
    sync();
    query.addEventListener?.("change", sync);
    return () => query.removeEventListener?.("change", sync);
  }, []);

  useEffect(() => {
    if (!isPhone) return;
    const open = (e: Event) => {
      const target = e.target as HTMLElement | null;
      const select = target?.closest?.("select") as HTMLSelectElement | null;
      if (!select || select.disabled) return;
      e.preventDefault();
      e.stopPropagation();
      const choices = Array.from(select.options)
        .filter((o) => !o.disabled)
        .map((o) => ({ value: o.value, label: o.textContent?.trim() || o.value, disabled: o.disabled }));
      if (!choices.length) return;
      const labelledBy =
        select.getAttribute("aria-label") ||
        select.closest("label")?.querySelector("span")?.textContent?.trim() ||
        select.closest("label")?.textContent?.trim();
      setSession({
        select,
        choices,
        title: labelledBy ? labelledBy.slice(0, 18) : t("选择"),
        value: select.value,
      });
    };
    document.addEventListener("pointerdown", open, true);
    document.addEventListener("touchstart", open, { capture: true, passive: false });
    document.addEventListener("mousedown", open, true);
    // 部分 WebView 仍会在 touchend 后补一个 click 去唤起原生列表，这里再拦一次。
    const blockClick = (e: Event) => {
      const select = (e.target as HTMLElement | null)?.closest?.("select");
      if (!select) return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("click", blockClick, true);
    return () => {
      document.removeEventListener("pointerdown", open, true);
      document.removeEventListener("touchstart", open, true);
      document.removeEventListener("mousedown", open, true);
      document.removeEventListener("click", blockClick, true);
    };
  }, [isPhone]);

  if (!session) return null;

  const close = () => setSession(null);
  const pick = (value: string) => {
    const el = session.select;
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    close();
    el.blur();
  };

  return createPortal(
    <div className="mobile-choice-layer" role="dialog" aria-modal="true" aria-label={session.title}>
      <div className="mobile-choice-scrim" onClick={close} />
      <div className="mobile-choice-sheet">
        <div className="mobile-choice-head">
          <b>{session.title}</b>
          <button onClick={close} aria-label={t("关闭")}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="mobile-choice-list">
          {session.choices.map((choice) => (
            <button
              key={choice.value}
              className={`mobile-choice-row${choice.value === session.value ? " on" : ""}`}
              onClick={() => pick(choice.value)}
            >
              <span>{choice.label}</span>
              {choice.value === session.value && <Icon name="check" size={16} />}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
