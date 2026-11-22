import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type {
  AccentTheme,
  GitBranch,
  GitCommit,
  GitStatus,
  HomeMode,
  LightEffect,
  McpStatus,
  MotionMode,
  PaperTexture,
  ThemeMode,
  UiLanguage,
} from "../types";
import { ACCENTS, LANGUAGES } from "../types";
import { t } from "../lib/i18n";
import { api, errText } from "../lib/api";
import { readScanRules, writeScanRules } from "../lib/split";
import { Icon } from "./Icon";
import { LanguagePicker } from "./LanguagePicker";
import { Logo } from "./Logo";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";

const MCP_PORT = 18765;
const GIT_URL = "https://git-scm.com/download/win";

/** Git 的技术名别吓到作者：默认分支显示成“主线”。 */
function lineLabel(name: string): string {
  if (!name) return t("主线");
  return name === "master" || name === "main" ? t("主线") : name;
}

export interface SettingsDialogProps {
  initialSection?: "appearance" | "writing" | "ai" | "git" | "about";
  themeMode: ThemeMode;
  accent: AccentTheme;
  motion: MotionMode;
  lightEffect: LightEffect;
  homeMode: HomeMode;
  language: UiLanguage;
  paper: PaperTexture;
  bgPath: string;
  library: string;
  targetWords?: number;
  dailyGoal?: number;
  mcpEnabled: boolean;
  projectPath?: string | null;
  onTheme: (v: ThemeMode) => void;
  onAccent: (v: AccentTheme) => void;
  onMotion: (v: MotionMode) => void;
  onLightEffect: (v: LightEffect) => void;
  onHomeMode: (v: HomeMode) => void;
  onLanguage: (v: UiLanguage) => void;
  onPaper: (v: PaperTexture) => void;
  onPickBg: () => void;
  onClearBg: () => void;
  onSaveGoals: (target: number, goal: number) => void;
  onChangeLibrary: () => void;
  onMcpEnabled: (v: boolean) => void;
  onReloadProject?: () => Promise<void> | void;
  onSaveCurrent?: () => Promise<void> | void;
  onClose: () => void;
}

type Section = "appearance" | "writing" | "ai" | "git" | "about";

const SECTIONS: { key: Section; label: string; icon: "settings" | "book" | "users" | "clock" | "file" }[] = [
  { key: "appearance", label: "个性化", icon: "settings" },
  { key: "writing", label: "写作与纸面", icon: "book" },
  { key: "ai", label: "AI 与 MCP", icon: "users" },
  { key: "git", label: "版本与回档", icon: "clock" },
  { key: "about", label: "关于 Chapter", icon: "file" },
];

const PAPERS: { key: PaperTexture; label: string }[] = [
  { key: "none", label: "素纸" },
  { key: "grain", label: "细纹" },
  { key: "rice", label: "宣纸" },
  { key: "ruled", label: "横线" },
  { key: "dots", label: "点阵" },
];

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try {
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      area.remove();
      return false;
    }
  }
}

function Switch({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      className={`set-switch${on ? " on" : ""}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
    >
      <i />
    </button>
  );
}

function Seg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { key: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmini set-seg">
      {options.map((o) => (
        <button key={o.key} className={value === o.key ? "on" : ""} onClick={() => onChange(o.key)}>
          {t(o.label)}
        </button>
      ))}
    </div>
  );
}

function Row({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row-label">
        <strong>{t(label)}</strong>
        {note && <span>{t(note)}</span>}
      </div>
      <div className="set-row-control">{children}</div>
    </div>
  );
}

function McpPanel({ enabled, onEnabled, projectPath }: {
  enabled: boolean;
  onEnabled: (v: boolean) => void;
  projectPath?: string | null;
}) {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [endpointCopied, setEndpointCopied] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    try {
      setStatus(await api.mcpStatus());
      setError("");
    } catch (e) {
      setError(errText(e));
    }
  };

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    void api.mcpSetProject(projectPath ?? null).then(() => refresh()).catch(() => undefined);
  }, [projectPath]);

  const toggle = () => {
    setBusy(true);
    onEnabled(!enabled);
    window.setTimeout(() => {
      setBusy(false);
      void refresh();
    }, 600);
  };

  const copyConfig = async () => {
    try {
      const cfg = await api.mcpConfig();
      if (await copyText(cfg)) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      }
    } catch (e) {
      setError(errText(e));
    }
  };

  const endpoint = status?.endpoint || `http://127.0.0.1:${MCP_PORT}/mcp`;

  const copyEndpoint = async () => {
    if (await copyText(endpoint)) {
      setEndpointCopied(true);
      window.setTimeout(() => setEndpointCopied(false), 1800);
    }
  };

  return (
    <div className="set-section">
      <div className="set-hero">
        <div>
          <span className="set-kicker">{t("本机 AI 助手")}</span>
          <h2>{t("让 AI 帮你动手，而不是只给建议")}</h2>
          <p>{t("Chapter 自带一个本机 MCP 服务。AI 能新建/修改卷章、改封面、改大纲、写 Markdown；删除与回档必须经过你确认。")}</p>
        </div>
        <div className={`set-status ${status?.running ? "ok" : ""}`}>
          <i />
          {status?.running ? t("运行中") : t("未开启")}
        </div>
      </div>

      <div className="set-tool-card">
        <div className="set-tool-head">
          <div>
            <strong>{t("启用 MCP 服务")}</strong>
            <span>{t("只监听本机 127.0.0.1，不对外网开放。")}</span>
          </div>
          <Switch on={enabled} onClick={toggle} label={t("启用 MCP 服务")} />
        </div>
        <div className="set-kv">
          <span>{t("连接地址")}</span>
          <code>{endpoint}</code>
        </div>
        <div className="set-kv">
          <span>{t("当前工程")}</span>
          <code title={projectPath || ""}>{projectPath || t("还没有打开书")}</code>
        </div>
        {error && <p className="set-error">{error}</p>}
        {busy && <p className="set-note">{t("正在启动本机服务…")}</p>}
        <div className="set-actions">
          <button className="btn btn-primary btn-sm" onClick={() => void copyConfig()} disabled={!status?.running}>
            <Icon name="file" size={14} />
            {copied ? t("已复制配置") : t("复制 AI 接入配置")}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => void copyEndpoint()} disabled={!status?.running}>
            <Icon name="arrow" size={14} />
            {endpointCopied ? t("已复制地址") : t("复制连接地址")}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => void refresh()}>
            <Icon name="refresh" size={14} />
            {t("检查连接")}
          </button>
        </div>
      </div>

      <div className="set-steps">
        <h3>{t("三步接上（不用填代码）")}</h3>
        <ol>
          <li>
            <b>1</b>
            <span>{t("打开支持 MCP 的 AI 客户端，选择「添加本地 MCP」，粘贴上方复制的配置。")}</span>
          </li>
          <li>
            <b>2</b>
            <span>{t("保持 Chapter 打开，并在书里点开要操作的那本小说。")}</span>
          </li>
          <li>
            <b>3</b>
            <span>{t("直接对 AI 说：帮我新建一卷、改第三章、写一份大纲。删除卷章和回档时，Chapter 会弹确认，只有你允许才执行。")}</span>
          </li>
        </ol>
      </div>

      <div className="set-chips">
        {[
          "新建小说",
          "新建卷 / 章",
          "修改章节",
          "修改整书大纲",
          "更换封面",
          "写 Markdown 文件",
          "存档 / 回档",
          "删除卷 / 章（需确认）",
        ].map((x) => (
          <span key={x}>{t(x)}</span>
        ))}
      </div>
    </div>
  );
}

function GitPanel({ projectPath, onReloadProject, onSaveCurrent }: {
  projectPath?: string | null;
  onReloadProject?: () => Promise<void> | void;
  onSaveCurrent?: () => Promise<void> | void;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [history, setHistory] = useState<GitCommit[]>([]);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [message, setMessage] = useState("");
  const [branchName, setBranchName] = useState("");
  const [confirmHash, setConfirmHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = async () => {
    if (!projectPath) {
      try {
        const s = await api.gitStatus("");
        setStatus(s);
      } catch (e) {
        setError(errText(e));
      }
      return;
    }
    try {
      const s = await api.gitStatus(projectPath);
      setStatus(s);
      if (s.isRepo) {
        const [h, b] = await Promise.all([api.gitHistory(projectPath), api.gitBranches(projectPath)]);
        setHistory(h);
        setBranches(b);
      } else {
        setHistory([]);
        setBranches([]);
      }
      setError("");
    } catch (e) {
      setError(errText(e));
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError("");
    try {
      await onSaveCurrent?.();
      await fn();
      setNotice(done);
      window.setTimeout(() => setNotice(""), 1800);
      await refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const snapshot = () =>
    run(
      () => api.gitSnapshot(projectPath!, message.trim() || t("手动存档")),
      t("已保存一版"),
    ).then(() => setMessage(""));

  const restore = (hash: string) =>
    run(async () => {
      await api.gitRestore(projectPath!, hash);
      await onReloadProject?.();
      setConfirmHash(null);
    }, t("已回档，当前状态也自动存了一版"));

  const createBranch = () =>
    run(async () => {
      await api.gitCreateBranch(projectPath!, branchName.trim() || `存档线-${new Date().toISOString().slice(0, 10)}`);
      setBranchName("");
    }, t("存档线已创建"));

  const switchBranch = (name: string) =>
    run(async () => {
      await api.gitSwitchBranch(projectPath!, name);
      await onReloadProject?.();
    }, t("已切换存档线"));

  if (!status) {
    return (
      <div className="set-section">
        <div className="set-empty">{t("正在检查 Git 环境…")}</div>
      </div>
    );
  }

  if (!status.installed) {
    return (
      <div className="set-section">
        <div className="set-hero">
          <div>
            <span className="set-kicker">{t("版本与回档")}</span>
            <h2>{t("先装一个 Git，之后全部点按钮")}</h2>
            <p>{t("Git 是一个免费的版本工具。你不需要敲命令，也不用手动建仓库；装好回来点一下，Chapter 会替你处理。")}</p>
          </div>
          <div className="set-status warn"><i />{t("未安装")}</div>
        </div>
        <div className="set-tool-card">
          <div className="set-tool-head">
            <div>
              <strong>{t("下载 Git for Windows")}</strong>
              <span>{t("官方地址：git-scm.com。一路点「下一步」安装即可。")}</span>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => void openUrl(GIT_URL)}>
              <Icon name="download" size={14} />
              {t("打开下载页")}
            </button>
          </div>
          <div className="set-kv"><span>{t("下载网址")}</span><code>{GIT_URL}</code></div>
          <div className="set-kv"><span>{t("安装完成后")}</span><code>{t("回到这里点「重新检查」")}</code></div>
          <div className="set-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => void refresh()} disabled={busy}>
              <Icon name="refresh" size={14} />
              {t("重新检查")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const gitDownload = (
    <div className="set-tool-card">
      <div className="set-tool-head">
        <div>
          <strong>{t("Git 下载地址")}</strong>
          <span>{t("换电脑或重装时，回到这里重新下载安装。")}</span>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => void openUrl(GIT_URL)}>
          <Icon name="download" size={14} />
          {t("打开下载页")}
        </button>
      </div>
      <div className="set-kv"><span>{t("下载网址")}</span><code>{GIT_URL}</code></div>
    </div>
  );

  if (!projectPath) {
    return (
      <div className="set-section">
        <div className="set-hero">
          <div>
            <span className="set-kicker">{t("版本与回档")}</span>
            <h2>{t("Git 已就绪")}</h2>
            <p>{t("打开一本书之后，就能在这本书里开启版本管理。每本书是独立仓库，互不影响。")}</p>
          </div>
          <div className="set-status ok"><i />{t("已安装")} {status.version}</div>
        </div>
        <div className="set-empty">{t("先打开一本书，再回来这里。")}</div>
        {gitDownload}
      </div>
    );
  }

  if (!status.isRepo) {
    return (
      <div className="set-section">
        <div className="set-hero">
          <div>
            <span className="set-kicker">{t("版本与回档")}</span>
            <h2>{t("把这本书变成可回档的工程")}</h2>
            <p>{t("只影响当前这本书：会在工程目录里建一个本机 Git 仓库，不联网、不上传，也不会动别的书。")}</p>
          </div>
          <div className="set-status ok"><i />{t("Git 已安装")}</div>
        </div>
        <div className="set-tool-card">
          <div className="set-tool-head">
            <div>
              <strong>{t("开启版本管理")}</strong>
              <span>{t("第一次开启会自动存下当前版本，之后你想存档就点「存一版」。")}</span>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => void run(() => api.gitInit(projectPath), t("版本管理已开启"))} disabled={busy}>
              <Icon name="check" size={14} />
              {t("开启版本管理")}
            </button>
          </div>
          {error && <p className="set-error">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="set-section">
      <div className="set-hero">
        <div>
          <span className="set-kicker">{t("版本与回档")}</span>
          <h2>{t("写坏了就回来，不回不来就白写了")}</h2>
          <p>{t("每次存档都会留一个完整版本。回档不会删掉现在，系统会先把当前状态再存一版，然后才回到旧版本。")}</p>
        </div>
        <div className="set-status ok"><i />{lineLabel(status.branch)} · {status.dirty ? t("有未存档改动") : t("已存档")}</div>
      </div>

      <div className="set-tool-card">
        <div className="set-tool-head">
          <div>
            <strong>{t("存一版")}</strong>
            <span>{t("可以写一句说明，也可以留空。")}</span>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => void snapshot()} disabled={busy}>
            <Icon name="check" size={14} />
            {t("保存当前进度")}
          </button>
        </div>
        <input
          className="input set-message"
          value={message}
          maxLength={80}
          placeholder={t("例如：第三章重写前的版本")}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>

      {notice && <p className="set-notice">{notice}</p>}
      {error && <p className="set-error">{error}</p>}

      <div className="set-subhead">
        <h3>{t("版本时间线")}</h3>
        <span>{t("最近 60 个版本")}</span>
      </div>
      <div className="set-commit-list">
        {history.length === 0 && <div className="set-empty">{t("还没有版本。先点「保存当前进度」。")}</div>}
        {history.map((h) => (
          <div className="set-commit" key={h.hash}>
            <div className="set-commit-dot"><i /></div>
            <div className="set-commit-main">
              <strong>{h.subject || t("未命名存档")}</strong>
              <span>{h.date} · {h.short}</span>
            </div>
            {confirmHash === h.hash ? (
              <div className="set-inline-confirm">
                <span>{t("回到这一版？当前会先自动存一版。")}</span>
                <button className="btn btn-ghost btn-xs" onClick={() => setConfirmHash(null)}>{t("取消")}</button>
                <button className="btn btn-primary btn-xs" onClick={() => void restore(h.hash)} disabled={busy}>{t("确认回档")}</button>
              </div>
            ) : (
              <button className="btn btn-ghost btn-xs" onClick={() => setConfirmHash(h.hash)}>
                {t("回到这一版")}
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="set-subhead">
        <h3>{t("存档线（不是剧情分支）")}</h3>
        <span>{t("可选的进阶功能")}</span>
      </div>
      <div className="set-branch-note">
        <Icon name="outline" size={14} />
        <span>{t("这里的「分支」是版本存档线，像同一本书的不同草稿线，不是故事里的剧情分支。普通写作只用一条线就够了。")}</span>
      </div>
      <div className="set-branches">
        {branches.map((b) => (
          <div className={`set-branch${b.current ? " on" : ""}`} key={b.name}>
            <Icon name="clock" size={13} />
            <span>{lineLabel(b.name)}</span>
            {b.current ? (
              <em>{t("当前存档线")}</em>
            ) : (
              <button className="btn btn-ghost btn-xs" onClick={() => void switchBranch(b.name)} disabled={busy}>
                {t("切到这条")}
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="set-branch-create">
        <input
          className="input"
          value={branchName}
          placeholder={t("新存档线名称（可留空自动命名）")}
          maxLength={40}
          onChange={(e) => setBranchName(e.target.value)}
        />
        <button className="btn btn-outline btn-sm" onClick={() => void createBranch()} disabled={busy}>
          <Icon name="plus" size={14} />
          {t("新建存档线")}
        </button>
      </div>
      {gitDownload}
    </div>
  );
}

function AboutPanel() {
  const [version, setVersion] = useState("1.3.3");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);
  const copyQQ = async () => {
    if (await copyText("1079937215")) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  };
  return (
    <div className="set-section">
      <div className="set-about">
        <div className="about-identity">
          <span className="about-logo"><Logo size={54} /></span>
          <div className="about-name">
            <div><strong>Chapter</strong><span className="about-version">v{version}</span></div>
            <p>{t("小方工作室 · 长篇小说写作工作台")}</p>
          </div>
        </div>
        <p className="about-desc">
          {t("把卷、章、场景、人物设定、字数目标和 EPUB 导出收在一张书桌上。本地优先，零账号，正文只留在这台电脑。")}
        </p>
        <div className="about-links">
          <button className="about-link" onClick={() => void copyQQ()}>
            <Icon name="users" size={13} />
            <span>QQ {t("群")}</span>
            <b>{copied ? t("已复制") : "1079937215"}</b>
          </button>
          <button className="about-link" onClick={() => void openUrl("https://fanggame.company")}>
            <Icon name="arrow" size={13} />
            <span>{t("官网")}</span>
            <b>fanggame.company</b>
          </button>
        </div>
        <p className="set-about-foot">{t("本地优先 · 零账号 · 零联网 · 正文永远只在这台电脑上。")} · MIT</p>
      </div>
    </div>
  );
}

export function SettingsDialog(props: SettingsDialogProps) {
  const [section, setSection] = useState<Section>(props.initialSection ?? "appearance");
  const [version, setVersion] = useState("1.3.3");
  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);
  const [target, setTarget] = useState(String(props.targetWords ?? 200000));
  const [goal, setGoal] = useState(String(props.dailyGoal ?? 2000));
  const [scan, setScan] = useState(() => {
    const r = readScanRules();
    return {
      chapterWords: r.chapterWords.join("、"),
      volumeWords: r.volumeWords.join("、"),
      specialWords: r.specialWords.join("、"),
    };
  });
  const [scanSaved, setScanSaved] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  const label = useMemo(() => {
    if (!props.language || props.language === "zh") return "简体中文";
    return LANGUAGES.find((l) => l.key === props.language)?.label ?? "English";
  }, [props.language]);

  const saveScan = () => {
    const split = (v: string) => v.split(/[，,、；;\s]+/).map((x) => x.trim()).filter(Boolean);
    const next = {
      chapterWords: split(scan.chapterWords),
      volumeWords: split(scan.volumeWords),
      specialWords: split(scan.specialWords),
    };
    const clean = writeScanRules(next);
    setScan({
      chapterWords: clean.chapterWords.join("、"),
      volumeWords: clean.volumeWords.join("、"),
      specialWords: clean.specialWords.join("、"),
    });
    setScanSaved(true);
    window.setTimeout(() => setScanSaved(false), 1600);
  };

  return (
    <div className="settings-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="settings-shell glass" role="dialog" aria-modal="true" aria-label={t("偏好设置")}>
        <header className="settings-head">
          <div>
            <h1>{t("偏好设置")}</h1>
            <p>{t("仅影响这台电脑上的 Chapter。")}</p>
          </div>
          <button className="icon-btn" onClick={props.onClose} title={t("关闭")}>
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="settings-main">
          <nav className="settings-rail" aria-label={t("设置栏目")}>
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                className={`set-nav-item${section === s.key ? " on" : ""}`}
                onClick={() => setSection(s.key)}
              >
                <Icon name={s.icon} size={15} />
                <span>{t(s.label)}</span>
              </button>
            ))}
            <div className="set-rail-foot">
              <span>{label}</span>
              <em>v{version}</em>
            </div>
          </nav>

          <div className="settings-scroll">
            {section === "appearance" && (
              <div className="set-section">
                <div className="set-title">
                  <h2>{t("个性化")}</h2>
                  <p>{t("界面长什么样、动效多快、用什么语言，都在这里。")}</p>
                </div>

                <div className="set-group">
                  <Row label="首页" note="进入 Chapter 时先看到哪种首页">
                    <Seg value={props.homeMode} options={[{ key: "minimal", label: "极简" }, { key: "workspace", label: "工作台" }]} onChange={props.onHomeMode} />
                  </Row>
                  <Row label="主题" note="夕阳是亮色纸，夜幕是暗色纸">
                    <Seg value={props.themeMode} options={[{ key: "light", label: "夕阳" }, { key: "dark", label: "夜幕" }, { key: "system", label: "跟随" }]} onChange={props.onTheme} />
                  </Row>
                  <Row label="主题色" note="背景、按钮和丝带会一起变">
                    <div className="accent-picks">
                      {ACCENTS.map((a) => (
                        <button
                          key={a.key}
                          className={`accent-pick${props.accent === a.key ? " on" : ""}`}
                          style={{ background: a.css }}
                          title={t(a.label)}
                          aria-label={t(a.label)}
                          onClick={() => props.onAccent(a.key)}
                        >
                          {props.accent === a.key && <Icon name="check" size={11} />}
                        </button>
                      ))}
                    </div>
                  </Row>
                  <Row label="背景光效" note="常驻一直亮；流动从左扫到右；分光跟鼠标走">
                    <Seg
                      value={props.lightEffect}
                      options={[{ key: "still", label: "常驻" }, { key: "flow", label: "流动" }, { key: "spot", label: "分光" }]}
                      onChange={props.onLightEffect}
                    />
                  </Row>
                  <Row label="动效" note="关掉后最省电、最跟手">
                    <Seg value={props.motion} options={[{ key: "full", label: "完整" }, { key: "reduced", label: "精简" }, { key: "off", label: "关" }]} onChange={props.onMotion} />
                  </Row>
                  <Row label="语言" note="国家名、英文名、简写都能搜">
                    <LanguagePicker value={props.language} language={props.language} onChange={props.onLanguage} />
                  </Row>
                </div>
              </div>
            )}

            {section === "writing" && (
              <div className="set-section">
                <div className="set-title">
                  <h2>{t("写作与纸面")}</h2>
                  <p>{t("纸、背景、目标、章节识别词和书库位置。")}</p>
                </div>

                <div className="set-group">
                  <Row label="纸张" note="正文纸面始终干净，背景只铺在界面底层">
                    <div className="paper-picks">
                      {PAPERS.map((p) => (
                        <button key={p.key} className={`paper-pick${props.paper === p.key ? " on" : ""}`} data-paper-preview={p.key} onClick={() => props.onPaper(p.key)} title={t(p.label)}>
                          <i />
                          <em>{t(p.label)}</em>
                        </button>
                      ))}
                    </div>
                  </Row>
                  <Row label="背景图" note={props.bgPath ? props.bgPath.split(/[\\/]/).pop() : "没有背景图，使用夕阳渐变"}>
                    <div className="set-actions">
                      <button className="btn btn-ghost btn-xs" onClick={props.onPickBg}><Icon name="image" size={13} />{t("选择")}</button>
                      {props.bgPath && <button className="btn btn-ghost btn-xs" onClick={props.onClearBg}>{t("清除")}</button>}
                    </div>
                  </Row>
                </div>

                {props.targetWords !== undefined && (
                  <div className="set-group">
                    <div className="set-subhead"><h3>{t("写作目标")}</h3></div>
                    <div className="set-two">
                      <label>
                        <span>{t("全书字数")}</span>
                        <input className="input" value={target} inputMode="numeric" onChange={(e) => setTarget(e.target.value.replace(/\D/g, ""))} />
                      </label>
                      <label>
                        <span>{t("每日目标")}</span>
                        <input className="input" value={goal} inputMode="numeric" onChange={(e) => setGoal(e.target.value.replace(/\D/g, ""))} />
                      </label>
                    </div>
                    <button className="btn btn-outline btn-sm" onClick={() => props.onSaveGoals(Math.max(0, Number(target) || 0), Math.max(0, Number(goal) || 0))}>
                      {t("保存目标")}
                    </button>
                  </div>
                )}

                <div className="set-group">
                  <div className="set-subhead">
                    <h3>{t("章节识别")}</h3>
                    {scanSaved && <span className="scan-saved">{t("已保存")}</span>}
                  </div>
                  <p className="set-note">{t("导入书稿时按这些词分章。用顿号分隔。")}</p>
                  <div className="set-three">
                    <label><span>{t("章标记词")}</span><input className="input" value={scan.chapterWords} onChange={(e) => setScan((s) => ({ ...s, chapterWords: e.target.value }))} /></label>
                    <label><span>{t("卷标记词")}</span><input className="input" value={scan.volumeWords} onChange={(e) => setScan((s) => ({ ...s, volumeWords: e.target.value }))} /></label>
                    <label><span>{t("特殊标题")}</span><input className="input" value={scan.specialWords} onChange={(e) => setScan((s) => ({ ...s, specialWords: e.target.value }))} /></label>
                  </div>
                  <div className="set-actions">
                    <button className="btn btn-ghost btn-xs" onClick={() => setScan({ chapterWords: "", volumeWords: "", specialWords: "" })}>{t("清空")}</button>
                    <button className="btn btn-xs" onClick={saveScan}>{t("保存识别词")}</button>
                  </div>
                </div>

                <div className="set-group">
                  <Row label="书库位置" note={props.library || "（读取中）"}>
                    <button className="btn btn-ghost btn-xs" onClick={props.onChangeLibrary}><Icon name="folder" size={13} />{t("更换书库…")}</button>
                  </Row>
                </div>
              </div>
            )}

            {section === "ai" && (
              <McpPanel enabled={props.mcpEnabled} onEnabled={props.onMcpEnabled} projectPath={props.projectPath} />
            )}

            {section === "git" && (
              <GitPanel projectPath={props.projectPath} onReloadProject={props.onReloadProject} onSaveCurrent={props.onSaveCurrent} />
            )}

            {section === "about" && <AboutPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}
