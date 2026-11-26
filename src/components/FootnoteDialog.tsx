import { useState } from "react";
import type { Footnote } from "../types";
import { t } from "../lib/i18n";
import { Icon } from "./Icon";
import { Modal } from "./Modals";

function uid() {
  return `fn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export function FootnoteDialog({
  footnotes,
  onClose,
  onSave,
  onInsert,
}: {
  footnotes: Footnote[];
  onClose: () => void;
  onSave: (next: Footnote[]) => void;
  onInsert: (n: number) => void;
}) {
  const [rows, setRows] = useState<Footnote[]>(() => footnotes.map((x) => ({ ...x })));
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);

  const add = () => {
    const row: Footnote = { id: uid(), text: "", createdAt: Date.now() };
    setRows((prev) => [...prev, row]);
    setFocusId(row.id);
    window.setTimeout(() => {
      document.querySelector<HTMLTextAreaElement>(`[data-fn-id="${row.id}"]`)?.focus();
    }, 30);
  };

  const remove = (id: string) => {
    if (pendingDelete !== id) {
      setPendingDelete(id);
      window.setTimeout(() => setPendingDelete((x) => (x === id ? null : x)), 2600);
      return;
    }
    setRows((prev) => prev.filter((x) => x.id !== id));
    setPendingDelete(null);
  };

  const submit = () => {
    onSave(rows.map((x) => ({ ...x, text: x.text.trim() })).filter((x) => x.text));
  };

  return (
    <Modal
      title={t("章内脚注")}
      subtitle={t("脚注只属于这一章；正文里显示上标，章末统一列出。")}
      wide
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {t("取消")}
          </button>
          <button className="btn btn-primary" onClick={submit}>
            {t("保存脚注")}
          </button>
        </>
      }
    >
      <div className="fn-dialog">
        <div className="fn-note">
          <Icon name="book" size={14} />
          <span>{t("纯文本导出会退化成 [1]；网页、打印和 EPUB 保留上标。")}</span>
        </div>
        <div className="fn-list">
          {rows.length === 0 && (
            <div className="fn-empty">{t("这一章还没有脚注。")}</div>
          )}
          {rows.map((row, i) => (
            <div className="fn-row" key={row.id}>
              <span className="fn-no">{i + 1}</span>
              <textarea
                className="input fn-text"
                data-fn-id={row.id}
                value={row.text}
                rows={2}
                maxLength={600}
                placeholder={t("这条脚注写什么？例如：出自《……》第三卷。")}
                autoFocus={focusId === row.id}
                onChange={(e) =>
                  setRows((prev) => prev.map((x) => (x.id === row.id ? { ...x, text: e.target.value } : x)))
                }
              />
              <div className="fn-actions">
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => onInsert(i + 1)}
                  disabled={!row.text.trim()}
                  title={t("把编号插到刚才的光标位置")}
                >
                  {t("插入正文")}
                </button>
                <button
                  className={`btn btn-ghost btn-sm fn-del${pendingDelete === row.id ? " danger" : ""}`}
                  onClick={() => remove(row.id)}
                >
                  {pendingDelete === row.id ? t("确认删") : <Icon name="trash" size={12} />}
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="fn-foot">
          <button className="btn btn-outline" onClick={add}>
            <Icon name="plus" size={12} /> {t("新增一条")}
          </button>
          <span>{t("插入后再保存；编号会按这里的顺序重排。")}</span>
        </div>
      </div>
    </Modal>
  );
}
