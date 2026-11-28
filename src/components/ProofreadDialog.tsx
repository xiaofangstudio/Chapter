import { useEffect, useMemo, useRef, useState } from "react";
import type { ProofreadConfig, ProofreadIssue, ProofreadTerm } from "../types";
import { pinyinPreview } from "../lib/proofread";
import { t } from "../lib/i18n";
import { Icon } from "./Icon";
import { Modal, ConfirmDialog } from "./Modals";

const TERM_LIMIT = 300;

function uid() {
  return `term_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export function ProofreadDialog({
  config,
  issues,
  onSave,
  onClose,
  onRescan,
  onReplace,
  onIgnore,
}: {
  config: ProofreadConfig;
  issues: ProofreadIssue[];
  onSave: (next: ProofreadConfig) => void;
  onClose: () => void;
  onRescan: () => void;
  onReplace?: (issue: ProofreadIssue, value: string) => void;
  onIgnore?: (issue: ProofreadIssue) => void;
}) {
  const [tab, setTab] = useState<"terms" | "punctuation" | "ignored">("terms");
  const [enabled, setEnabled] = useState(config.enabled !== false);
  const [terms, setTerms] = useState<ProofreadTerm[]>(() => config.terms.map((x) => ({ ...x })));
  const [punctuation, setPunctuation] = useState(() => structuredClone(config.punctuation));
  const [ignored, setIgnored] = useState(config.ignored);
  const [search, setSearch] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [askClose, setAskClose] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return terms;
    return terms.filter((x) => x.text.toLowerCase().includes(q) || x.note.toLowerCase().includes(q));
  }, [terms, search]);

  useEffect(() => {
    if (!focusId) return;
    const el = listRef.current?.querySelector<HTMLInputElement>(`[data-term-id="${focusId}"]`);
    el?.focus();
  }, [focusId]);

  const touch = () => setDirty(true);

  const addTerm = () => {
    if (terms.length >= TERM_LIMIT) return;
    const term: ProofreadTerm = {
      id: uid(),
      text: "",
      enabled: true,
      note: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setTerms((prev) => [...prev, term]);
    setFocusId(term.id);
    touch();
  };

  const updateTerm = (id: string, patch: Partial<ProofreadTerm>) => {
    setTerms((prev) =>
      prev.map((x) => (x.id === id ? { ...x, ...patch, updatedAt: Date.now() } : x)),
    );
    touch();
  };

  const removeTerm = (id: string) => {
    if (pendingDelete !== id) {
      setPendingDelete(id);
      window.setTimeout(() => setPendingDelete((x) => (x === id ? null : x)), 2600);
      return;
    }
    setTerms((prev) => prev.filter((x) => x.id !== id));
    setIgnored((prev) => prev.filter((x) => x.termId !== id));
    setPendingDelete(null);
    touch();
  };

  const submit = () => {
    const cleaned = terms
      .map((x) => ({ ...x, text: x.text.trim() }))
      .filter((x) => x.text.length > 0)
      .slice(0, TERM_LIMIT);
    onSave({ ...config, enabled, terms: cleaned, punctuation, ignored });
  };

  const close = () => {
    if (dirty) {
      setAskClose(true);
      return;
    }
    onClose();
  };

  return (
    <>
    <Modal
      title={t("本书词库")}
      subtitle={t("本地校对，只按这本书的词库提示；不联网，不改正文。")}
      onClose={close}
      wide
      actions={
        <>
          <button className="btn btn-ghost" onClick={close}>
            {t("取消")}
          </button>
          <button className="btn btn-primary" onClick={submit}>
            {t("保存词库")}
          </button>
        </>
      }
    >
      <div className="proof-dialog">
        <div className="proof-master">
          <span>
            <b>{t("校对总开关")}</b>
            <em>{enabled ? t("正在标出可能的问题，正文不会自动改。") : t("已关闭，所有标记消失。")}</em>
          </span>
          <label className="proof-switch">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
                touch();
              }}
            />
            <i />
          </label>
        </div>
        <div className="proof-tabs" role="tablist">
          <button className={tab === "terms" ? "on" : ""} onClick={() => setTab("terms")}>
            {t("词语")} <b>{terms.filter((x) => x.text.trim()).length}</b>
          </button>
          <button className={tab === "punctuation" ? "on" : ""} onClick={() => setTab("punctuation")}>
            {t("标点")}
          </button>
          <button className={tab === "ignored" ? "on" : ""} onClick={() => setTab("ignored")}>
            {t("忽略记录")} <b>{ignored.length}</b>
          </button>
        </div>

        {tab === "terms" && (
          <div className="proof-term-pane">
            <div className="proof-term-tools">
              <input
                className="input"
                value={search}
                placeholder={t("搜索词库")}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button className="btn btn-outline btn-sm" disabled={terms.length >= TERM_LIMIT} onClick={addTerm}>
                <Icon name="plus" size={13} /> {t("新增")}
              </button>
            </div>
            <div className="proof-term-head">
              <span>{t("词")}</span>
              <span>{t("拼音")}</span>
              <span>{t("启用")}</span>
              <span />
            </div>
            {issues.length > 0 && (
              <div className="proof-now">
                <div className="proof-now-head">
                  <span>{t("当前正文的问题")}</span>
                  <b>{issues.length}</b>
                </div>
                <div className="proof-now-list">
                  {issues.slice(0, 24).map((issue) => (
                    <div className="proof-now-row" key={issue.id}>
                      <span className={issue.kind}>{issue.text}</span>
                      <em>{t(issue.message)}</em>
                      {issue.suggestions[0] && onReplace ? (
                        <button
                          className="proof-now-btn"
                          onClick={() => onReplace(issue, issue.suggestions[0])}
                        >
                          {t("改为")} {issue.suggestions[0]}
                        </button>
                      ) : onIgnore ? (
                        <button className="proof-now-btn ghost" onClick={() => onIgnore(issue)}>
                          {t("忽略")}
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="proof-term-list" ref={listRef}>
              {shown.length === 0 && (
                <div className="proof-empty">
                  {terms.length ? t("没有匹配的词。") : t("还没有词。先加「廿七」「小方」这类专名。")}
                </div>
              )}
              {shown.map((term) => (
                <div className="proof-term-row" key={term.id}>
                  <input
                    className="input"
                    data-term-id={term.id}
                    value={term.text}
                    maxLength={12}
                    placeholder={t("例如 廿七")}
                    onChange={(e) => updateTerm(term.id, { text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (!term.text.trim() && term.note === "") removeTerm(term.id);
                        else addTerm();
                      }
                    }}
                  />
                  <span className="proof-py">{term.text.trim() ? pinyinPreview(term.text) : "—"}</span>
                  <label className="proof-switch" title={t("启用这一条")}>
                    <input
                      type="checkbox"
                      checked={term.enabled}
                      onChange={(e) => updateTerm(term.id, { enabled: e.target.checked })}
                    />
                    <i />
                  </label>
                  <button
                    className={`proof-del${pendingDelete === term.id ? " confirm" : ""}`}
                    onClick={() => removeTerm(term.id)}
                    title={pendingDelete === term.id ? t("再点一次删除") : t("删除")}
                  >
                    {pendingDelete === term.id ? t("确认") : <Icon name="trash" size={13} />}
                  </button>
                </div>
              ))}
            </div>
            <div className="proof-term-note">{t("最多 300 条；空白词直接删，已有词删前要点两次。")}</div>
          </div>
        )}

        {tab === "punctuation" && (
          <div className="proof-punct-pane">
            <label className="proof-rule">
              <span>
                <b>{t("总开关")}</b>
                <em>{t("关掉后词语检查仍可用，只停止标点提示。")}</em>
              </span>
              <input
                type="checkbox"
                checked={punctuation.enabled}
                onChange={(e) => {
                  setPunctuation((p) => ({ ...p, enabled: e.target.checked }));
                  touch();
                }}
              />
            </label>
            {(
              [
                ["halfWidth", "中文半角标点", "逗号、句号、问号等改成全角"],
                ["quotes", "引号与括号配对", "不配对的引号、括号给提示"],
                ["ellipsis", "省略号", "... 或 。。。 改成 ……"],
                ["duplicates", "连续重复标点", "！！、，，合并成一个"],
              ] as const
            ).map(([key, label, desc]) => (
              <label className="proof-rule" key={key}>
                <span>
                  <b>{t(label)}</b>
                  <em>{t(desc)}</em>
                </span>
                <input
                  type="checkbox"
                  checked={punctuation.rules[key]}
                  disabled={!punctuation.enabled}
                  onChange={(e) => {
                    setPunctuation((p) => ({ ...p, rules: { ...p.rules, [key]: e.target.checked } }));
                    touch();
                  }}
                />
              </label>
            ))}
            <div className="proof-rule-foot">
              <span>{t("当前本章问题")}</span>
              <b>{issues.length}</b>
              <button className="link" onClick={onRescan}>
                {t("重新扫描")}
              </button>
            </div>
          </div>
        )}

        {tab === "ignored" && (
          <div className="proof-ignored-pane">
            {ignored.length === 0 ? (
              <div className="proof-empty">{t("还没有忽略记录。")}</div>
            ) : (
              <>
                <div className="proof-ignored-head">
                  <span>{t("这条只忽略当前上下文，不会删词。")}</span>
                  <button
                    className="link danger"
                    onClick={() => {
                      setIgnored([]);
                      touch();
                    }}
                  >
                    {t("全部恢复")}
                  </button>
                </div>
                <div className="proof-ignored-list">
                  {ignored.map((x, i) => {
                    const term = terms.find((v) => v.id === x.termId);
                    return (
                      <div className="proof-ignored-row" key={`${x.termId}_${x.contextHash}`}>
                        <span>{term?.text || x.termId}</span>
                        <em>#{x.contextHash}</em>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            setIgnored((prev) => prev.filter((_, idx) => idx !== i));
                            touch();
                          }}
                        >
                          {t("恢复提示")}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
    {askClose && (
      <ConfirmDialog
        title={t("关闭词库？")}
        message={t("词库还有未保存的改动，关闭后这次修改会丢失。")}
        confirmText={t("关闭")}
        danger
        onClose={() => setAskClose(false)}
        onOk={() => {
          setAskClose(false);
          onClose();
        }}
      />
    )}
    </>
  );
}

export function ProofreadPopover({
  issue,
  anchor,
  onReplace,
  onIgnore,
  onClose,
  onOpenDictionary,
}: {
  issue: ProofreadIssue;
  anchor: { x: number; y: number; w: number; h: number };
  onReplace: (value: string) => void;
  onIgnore: () => void;
  onClose: () => void;
  onOpenDictionary: () => void;
}) {
  const width = 320;
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, anchor.x - 12));
  const top = Math.max(12, anchor.y - 82);
  return (
    <div className="proof-pop" style={{ left, top, width }} role="dialog">
      <div className="proof-pop-head">
        <span>{issue.kind === "term" ? t("词语") : t("标点")}</span>
        <button className="icon-btn" onClick={onClose}>
          <Icon name="close" size={12} />
        </button>
      </div>
      <div className="proof-pop-body">
        <b className={issue.confidence === "high" ? "high" : ""}>{issue.text}</b>
        <em>{t(issue.message)}</em>
      </div>
      <div className="proof-pop-actions">
        <button className="btn btn-ghost btn-sm" onClick={onIgnore}>
          {t("忽略")}
        </button>
        <div className="proof-pop-sugs">
          {issue.suggestions.slice(0, 3).map((sug) => (
            <button className="proof-sug" key={sug} onClick={() => onReplace(sug)}>
              <small>{t("猜你想写")}</small>
              <span>{sug}</span>
            </button>
          ))}
          {issue.suggestions.length === 0 && (
            <button className="btn btn-ghost btn-sm" onClick={onOpenDictionary}>
              {t("看词库")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
