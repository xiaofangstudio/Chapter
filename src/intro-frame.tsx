import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/mobile.css";
import "./styles/ui-flat.css";
import { BookIntroPage } from "./components/BookIntroPage";
import type { BookMeta, Outline } from "./types";

const q = new URLSearchParams(location.search);
document.documentElement.dataset.theme = q.get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.accent = q.get("accent") || "amber";
document.documentElement.dataset.ui = q.get("ui") === "wood" ? "wood" : "flat";
document.documentElement.dataset.motion = "full";

function Frame() {
  const meta = (window as unknown as { __introBook?: BookMeta }).__introBook as BookMeta;
  const outline = (window as unknown as { __introOutline?: Outline }).__introOutline as Outline;
  return (
    <div className="app">
      <BookIntroPage
        meta={meta}
        outline={outline}
        coverUrl="/intro-cover.png"
        activeId={meta.lastChapterId ?? null}
        theme="light"
        onBack={() => {}}
        onSelectChapter={() => {}}
        onBookSettings={() => {}}
        onMatter={() => {}}
        onPickCover={() => {}}
        onToggleTheme={() => {}}
        onSettings={() => {}}
        onAddVolume={() => {}}
        onAddChapter={() => {}}
      />
    </div>
  );
}

void Promise.all([
  fetch("/editor-book.json").then((r) => r.json()),
  fetch("/intro-outline.json").then((r) => r.json()),
]).then(([book, outline]) => {
  (window as unknown as { __introBook?: BookMeta }).__introBook = book;
  (window as unknown as { __introOutline?: Outline }).__introOutline = outline;
  createRoot(document.getElementById("root")!).render(<Frame />);
});
