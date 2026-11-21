import type { ReactNode } from "react";

export type IconName =
  | "plus"
  | "folder"
  | "chevron"
  | "more"
  | "focus"
  | "shrink"
  | "export"
  | "clock"
  | "sun"
  | "moon"
  | "settings"
  | "book"
  | "outline"
  | "users"
  | "bold"
  | "italic"
  | "quote"
  | "hr"
  | "undo"
  | "redo"
  | "close"
  | "trash"
  | "edit"
  | "check"
  | "image"
  | "arrow"
  | "grip"
  | "panel"
  | "pin"
  | "box"
  | "user"
  | "file"
  | "type"
  | "download"
  | "refresh";

const paths: Record<IconName, ReactNode> = {
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  folder: (
    <>
      <path d="M3.5 7.8A2.3 2.3 0 0 1 5.8 5.5h3.7l2 2h6.7a2.3 2.3 0 0 1 2.3 2.3v6.4a2.3 2.3 0 0 1-2.3 2.3H5.8A2.3 2.3 0 0 1 3.5 16.2z" />
    </>
  ),
  chevron: <path d="M9.5 6.5 15 12l-5.5 5.5" />,
  more: <><circle cx="6" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="18" cy="12" r="1.3" /></>,
  focus: (
    <>
      <path d="M8 3.5H5.5a2 2 0 0 0-2 2V8" />
      <path d="M16 3.5h2.5a2 2 0 0 1 2 2V8" />
      <path d="M20.5 16v2.5a2 2 0 0 1-2 2H16" />
      <path d="M8 20.5H5.5a2 2 0 0 1-2-2V16" />
    </>
  ),
  shrink: (
    <>
      <path d="M9 3.5v5.5H3.5" />
      <path d="M15 20.5V15h5.5" />
      <path d="M20.5 9H15V3.5" />
      <path d="M3.5 15H9v5.5" />
    </>
  ),
  export: (
    <>
      <path d="M12 3.5v11" />
      <path d="m7.5 8.5 4.5-5 4.5 5" />
      <path d="M5 14.5v2.5a2.5 2.5 0 0 0 2.5 2.5h9A2.5 2.5 0 0 0 19 17v-2.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 1.8" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
    </>
  ),
  moon: <path d="M20.5 13.2A8.7 8.7 0 1 1 10.8 3.5a6.9 6.9 0 0 0 9.7 9.7z" />,
  settings: (
    <>
      <path d="M4 7h10M18 7h2M4 12h3M11 12h9M4 17h8M16 17h4" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="14" cy="17" r="2" />
    </>
  ),
  book: (
    <>
      <path d="M3.5 5.8A2.4 2.4 0 0 1 5.9 3.5h13.8a1 1 0 0 1 1 1v13.8a1 1 0 0 1-1 1H6.4A2.9 2.9 0 0 0 3.5 19.3" transform="translate(0 0)" />
      <path d="M3.5 5.8v13.5" />
    </>
  ),
  outline: (
    <>
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="M3.5 9h17M8.5 9v11" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19c0-3 2.4-5 5.5-5s5.5 2 5.5 5" />
      <path d="M15.5 6.2a3 3 0 0 1 0 5.6" />
      <path d="M17.5 14.4c2 .5 3.3 2.2 3.3 4.6" />
    </>
  ),
  bold: (
    <>
      <path d="M8 5h5.2a3.4 3.4 0 0 1 0 6.8H8z" />
      <path d="M8 11.8h6.2a3.6 3.6 0 0 1 0 7.2H8z" />
      <path d="M8 5v14" />
    </>
  ),
  italic: <><path d="M10.5 5h7M6.5 19h7M14.5 5l-4 14" /></>,
  quote: (
    <>
      <path d="M9.5 7.5H6.2A2.2 2.2 0 0 0 4 9.7v2.3a2.2 2.2 0 0 0 2.2 2.2h1.3V7.5z" transform="translate(0 2)" />
      <path d="M19.5 7.5h-3.3A2.2 2.2 0 0 0 14 9.7v2.3a2.2 2.2 0 0 0 2.2 2.2H17.5V7.5z" transform="translate(0 2)" />
      <path d="M6.2 7.5v14M16.2 7.5v14" opacity="0" />
    </>
  ),
  hr: <><path d="M4 12h16" /><path d="M8 8.5v1M16 14.5v1" opacity=".55" /></>,
  undo: (
    <>
      <path d="M4 9.5h9.5a5 5 0 0 1 0 10H9" />
      <path d="M7.5 6 4 9.5 7.5 13" />
    </>
  ),
  redo: (
    <>
      <path d="M20 9.5h-9.5a5 5 0 0 0 0 10H15" />
      <path d="M16.5 6 20 9.5 16.5 13" />
    </>
  ),
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  trash: (
    <>
      <path d="M4 7h16M9.5 7V4.8h5V7M6 7l.8 13h10.4L18 7" />
      <path d="M10 10.5v6M14 10.5v6" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20l.8-4.4 10.3-10.3 3.6 3.6L8.4 19.2z" />
      <path d="m13.8 6.8 3.4 3.4" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 6.5" />,
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m4.5 17.5 4.7-4.7 3.3 3.3 2.6-2.4 4.4 4.4" />
    </>
  ),
  arrow: <><path d="M4.5 12h15" /><path d="m14 6.5 5.5 5.5-5.5 5.5" /></>,
  grip: (
    <>
      <circle cx="8" cy="7" r="1.2" /><circle cx="16" cy="7" r="1.2" />
      <circle cx="8" cy="12" r="1.2" /><circle cx="16" cy="12" r="1.2" />
      <circle cx="8" cy="17" r="1.2" /><circle cx="16" cy="17" r="1.2" />
    </>
  ),
  panel: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9 4.5v15" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s6.5-6.4 6.5-11.2A6.5 6.5 0 0 0 5.5 9.8C5.5 14.6 12 21 12 21z" />
      <circle cx="12" cy="9.6" r="2.2" />
    </>
  ),
  box: (
    <>
      <path d="m4 8 8-4 8 4v8l-8 4-8-4z" />
      <path d="M4 8l8 4 8-4M12 12v8" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.6" />
      <path d="M5 20c0-3.4 3.1-5.6 7-5.6s7 2.2 7 5.6" />
    </>
  ),
  file: (
    <>
      <path d="M6 3.5h7.5L19 9v11.5H6z" />
      <path d="M13.5 3.5V9H19" />
      <path d="M9 13h6M9 16h4" />
    </>
  ),
  type: (
    <>
      <path d="M5 6.5V5h14v1.5M12 5v14M9 19h6" />
    </>
  ),
  download: (
    <>
      <path d="M12 3.5v11" />
      <path d="m7.5 10 4.5 4.5L16.5 10" />
      <path d="M5 15v2.5a2.5 2.5 0 0 0 2.5 2.5h9A2.5 2.5 0 0 0 19 17V15" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11a8 8 0 1 1-2.4-6" />
      <path d="M20 4.5V10h-5.5" />
    </>
  ),
};

export function Icon({
  name,
  size = 18,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: "0 0 auto" }}
    >
      {paths[name]}
    </svg>
  );
}
