import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  onClick: () => void;
  disabled?: boolean;
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
  minWidth = 172,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  minWidth?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    prevFocus.current = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.querySelector<HTMLButtonElement>(".menu-item:not(:disabled)")?.focus({ preventScroll: true });
    return () => {
      const back = prevFocus.current;
      if (back && document.contains(back)) back.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const close = () => onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab") {
        onClose();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const el = ref.current;
      if (!el) return;
      const list = Array.from(el.querySelectorAll<HTMLButtonElement>(".menu-item:not(:disabled)"));
      if (!list.length) return;
      e.preventDefault();
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        e.key === "ArrowDown"
          ? list[(at + 1 + list.length) % list.length]
          : list[(at - 1 + list.length) % list.length];
      next?.focus();
    };
    const id = window.setTimeout(() => {
      document.addEventListener("mousedown", close);
      document.addEventListener("keydown", key);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - 12) left = window.innerWidth - rect.width - 12;
    if (top + rect.height > window.innerHeight - 12) top = y - rect.height - 6;
    el.style.left = `${Math.max(10, left)}px`;
    el.style.top = `${Math.max(10, top)}px`;
  }, [x, y]);

  return createPortal(
    <>
      <div
        className="menu-scrim"
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
        onTouchStart={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
      />
      <div
        ref={ref}
        className="menu"
        role="menu"
        aria-label="menu"
        style={{ left: x, top: y, minWidth }}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((it, i) => (
          <button
            key={`${it.label}-${i}`}
            role="menuitem"
            className={`menu-item${it.danger ? " danger" : ""}`}
            disabled={it.disabled}
            style={it.disabled ? { opacity: 0.4, pointerEvents: "none" } : undefined}
            onClick={(e) => {
              e.stopPropagation();
              onClose();
              it.onClick();
            }}
          >
            {it.icon && <Icon name={it.icon} size={15} />}
            <span>{it.label}</span>
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
}
