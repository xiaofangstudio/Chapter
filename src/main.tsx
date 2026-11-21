import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";
import "./styles/app.css";
import { LANGUAGES, type UiLanguage } from "./types";
import { ensureUiPack, setUiLanguage } from "./lib/i18n";

const root = createRoot(document.getElementById("root")!);

// 中文用户不加载 100KB+ 的自动翻译包；其他语言在首屏前异步取一次，避免闪一下中文。
let stored = "";
try {
  stored = localStorage.getItem("chapter.lang") ?? "";
} catch {
  stored = "";
}
const lang = (LANGUAGES.some((l) => l.key === stored) ? stored : "zh") as UiLanguage;
setUiLanguage(lang);

void (lang === "zh" ? Promise.resolve() : ensureUiPack(lang))
  .catch(() => undefined)
  .finally(() => root.render(<App />));
