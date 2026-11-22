import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LanguageOption, UiLanguage } from "../types";
import { countryLabel, LANGUAGES } from "../types";
import { t } from "../lib/i18n";
import { Icon } from "./Icon";

interface Props {
  value: UiLanguage;
  language: UiLanguage;
  onChange: (value: UiLanguage) => void;
}

const norm = (text: string) => text.toLowerCase().replace(/[\s\-_/·，,。.()（）]/g, "");

function haystack(item: LanguageOption) {
  return {
    label: norm(item.label),
    english: norm(item.english),
    country: norm(item.country),
    countryZh: norm(item.countryZh),
    countryHant: norm(item.countryHant ?? ""),
    codes: item.codes.map(norm),
    key: norm(item.key),
  };
}

function score(item: LanguageOption, query: string) {
  if (!query) return 0;
  const h = haystack(item);
  if (h.label.startsWith(query) || h.english.startsWith(query)) return 0;
  if (h.codes.some((c) => c === query)) return 1;
  if (h.country.split("/").some((part) => part.startsWith(query))) return 2;
  if (h.countryZh.split("/").some((part) => part.startsWith(query))) return 2;
  if (h.countryHant.split("/").some((part) => part.startsWith(query))) return 2;
  if (h.key === query) return 3;
  const joined = `${h.label} ${h.english} ${h.country} ${h.countryZh} ${h.countryHant} ${h.codes.join(" ")}`;
  return joined.includes(query) ? 4 : -1;
}

export function LanguagePicker({ value, language, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null);

  const current = LANGUAGES.find((item) => item.key === value) ?? LANGUAGES[0];

  const filtered = useMemo(() => {
    const q = norm(query.trim());
    if (!q) return LANGUAGES;
    return LANGUAGES
      .map((item) => ({ item, rank: score(item, q) }))
      .filter((row) => row.rank >= 0)
      .sort((a, b) => a.rank - b.rank)
      .map((row) => row.item);
  }, [query]);

  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const edge = 12;
    const gap = 8;
    const width = Math.min(390, Math.max(318, rect.width + 96));
    const left = Math.min(Math.max(edge, rect.right - width), window.innerWidth - width - edge);
    const below = window.innerHeight - rect.bottom - edge - gap;
    const above = rect.top - edge - gap;
    const openUp = below < 330 && above > below;
    const span = Math.min(424, openUp ? above : below);
    setPlace({
      left,
      width,
      maxHeight: Math.max(214, span),
      ...(openUp ? { bottom: window.innerHeight - rect.top + gap } : { top: rect.bottom + gap }),
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const index = Math.max(0, LANGUAGES.findIndex((item) => item.key === value));
    setActive(index);
    measure();
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    const onOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onResize = () => measure();
    window.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", onOutside, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [open, measure, value]);

  useEffect(() => {
    if (active >= filtered.length) setActive(Math.max(0, filtered.length - 1));
  }, [active, filtered.length]);

  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const closeAndFocus = () => {
    setOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const commit = (item: LanguageOption) => {
    onChange(item.key);
    closeAndFocus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeAndFocus();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(filtered.length - 1, index + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActive(Math.max(0, filtered.length - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = filtered[active];
      if (item) commit(item);
    }
  };

  const toggle = () => {
    setQuery("");
    setOpen((prev) => !prev);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`lang-trigger${open ? " is-open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setQuery("");
            setOpen(true);
          }
        }}
      >
        <span className="lang-trigger-main" dir={current.dir}>{current.label}</span>
        <span className="lang-trigger-meta">{countryLabel(current, language)}</span>
        <Icon name="chevron" size={12} />
      </button>

      {open &&
        place &&
        createPortal(
          <div
            ref={popRef}
            className="lang-pop"
            style={{
              left: place.left,
              width: place.width,
              maxHeight: place.maxHeight,
              ...(place.top !== undefined ? { top: place.top } : { bottom: place.bottom }),
            }}
            role="dialog"
            aria-label={t("语言")}
            onKeyDown={onKeyDown}
          >
            <div className="lang-search">
              <Icon name="search" size={13} />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                placeholder={t("搜索语言")}
                aria-label={t("搜索语言")}
                spellCheck={false}
                autoComplete="off"
              />
              {query && (
                <button type="button" className="lang-clear" onMouseDown={(event) => event.preventDefault()} onClick={() => setQuery("")} aria-label={t("清除")}>
                  ×
                </button>
              )}
            </div>

            <div className="lang-list" role="listbox" aria-activedescendant={filtered[active] ? `lang-opt-${filtered[active].key}` : undefined} ref={listRef}>
              {filtered.map((item, index) => (
                <button
                  key={item.key}
                  id={`lang-opt-${item.key}`}
                  data-index={index}
                  type="button"
                  role="option"
                  aria-selected={item.key === value}
                  className={`lang-option${index === active ? " is-active" : ""}${item.key === value ? " is-current" : ""}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => commit(item)}
                >
                  <span className="lang-option-main" dir={item.dir}>{item.label}</span>
                  <span className="lang-option-meta">
                    {countryLabel(item, language)}
                    <i>{item.english}</i>
                  </span>
                  {item.key === value && <Icon name="check" size={13} />}
                </button>
              ))}
              {filtered.length === 0 && <div className="lang-empty">{t("未找到语言")}</div>}
            </div>

            <div className="lang-pop-foot">Art has no borders</div>
          </div>,
          document.body,
        )}
    </>
  );
}
