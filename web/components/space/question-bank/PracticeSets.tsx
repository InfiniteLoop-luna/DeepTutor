"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ClipboardList, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import { notify } from "@/lib/notifications";
import {
  createPracticeSet,
  deletePracticeSet,
  listPracticeSets,
  renamePracticeSet,
  type SavedPracticeSet,
} from "@/lib/practice-api";

const BUTTON =
  "rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50";
const INPUT = "min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm";

export function SavePracticeSet({ ids, onSaved }: { ids: number[]; onSaved: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !name.trim() || !ids.length) return;
    setPending(true);
    try {
      await createPracticeSet(name, ids);
      setName("");
      setOpen(false);
      notify(t("Practice set saved"), { tone: "success" });
      onSaved();
    } catch (error) {
      notify(String(error instanceof Error ? error.message : error), { tone: "error" });
    } finally {
      setPending(false);
    }
  }

  if (!ids.length) return null;
  if (!open) {
    return (
      <button type="button" className={BUTTON} onClick={() => setOpen(true)}>
        {t("Save practice set")}
      </button>
    );
  }
  return (
    <form onSubmit={save} className="flex max-w-full items-center gap-2">
      <input
        autoFocus
        className={INPUT}
        aria-label={t("Practice set name")}
        placeholder={t("Practice set name")}
        value={name}
        maxLength={100}
        onChange={event => setName(event.target.value)}
      />
      <button type="submit" disabled={pending || !name.trim()} className={BUTTON}>
        {t("Save")}
      </button>
      <button type="button" className={BUTTON} onClick={() => setOpen(false)}>
        {t("Cancel")}
      </button>
    </form>
  );
}

export function PracticeSets({ onStart }: { onStart: (ids: number[]) => void }) {
  const { t } = useTranslation();
  const [sets, setSets] = useState<SavedPracticeSet[] | null>(null);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const reload = useCallback(async () => {
    try {
      setError("");
      setSets(await listPracticeSets());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function update(action: () => Promise<unknown>) {
    setPending(true);
    try {
      await action();
      setEditing(null);
      await reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), { tone: "error" });
    } finally {
      setPending(false);
    }
  }

  if (error) {
    return (
      <div role="alert" className="rounded-xl border border-border bg-card p-4">
        <p className="mb-2 text-sm">{error}</p>
        <button type="button" className={BUTTON} onClick={() => void reload()}>
          {t("Retry")}
        </button>
      </div>
    );
  }
  if (!sets)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t("Loading…")}
      </p>
    );
  if (!sets.length) {
    return (
      <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        {t("Select questions in the bank to save your first practice set.")}
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {sets.map(item => (
        <li
          key={item.id}
          className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4"
        >
          <ClipboardList size={18} className="shrink-0 text-primary" />
          {editing === item.id ? (
            <form
              className="flex min-w-0 flex-1 gap-2"
              onSubmit={event => {
                event.preventDefault();
                if (!pending && title.trim()) void update(() => renamePracticeSet(item.id, title));
              }}
            >
              <input
                autoFocus
                className={INPUT}
                aria-label={t("Practice set name")}
                value={title}
                maxLength={100}
                onChange={event => setTitle(event.target.value)}
              />
              <button type="submit" className={BUTTON} disabled={pending || !title.trim()}>
                {t("Save")}
              </button>
              <button type="button" className={BUTTON} onClick={() => setEditing(null)}>
                {t("Cancel")}
              </button>
            </form>
          ) : (
            <>
              <div className="min-w-[8rem] flex-1">
                <h3 className="break-words text-sm font-semibold">{item.name}</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {item.entry_ids.length} {t("questions.count.suffix")}
                </p>
              </div>
              <button
                type="button"
                className={BUTTON}
                disabled={pending}
                onClick={() => {
                  setTitle(item.name);
                  setEditing(item.id);
                }}
              >
                {t("Rename")}
              </button>
              <button
                type="button"
                className={BUTTON}
                disabled={pending}
                onClick={() => {
                  if (window.confirm(t("Delete this practice set?")))
                    void update(() => deletePracticeSet(item.id));
                }}
              >
                {t("Delete")}
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-40"
                disabled={!item.entry_ids.length}
                onClick={() => onStart(item.entry_ids)}
              >
                <Play size={14} />
                {t("Start practice set")}
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
