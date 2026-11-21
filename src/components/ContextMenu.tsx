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

  useEffect(() => {
    const close = () => onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
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
    <div
      ref={ref}
      className="menu"
      style={{ left: x, top: y, minWidth }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => (
        <button
          key={`${it.label}-${i}`}
          className={`menu-item${it.danger ? " danger" : ""}`}
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
    </div>,
    document.body,
  );
}
