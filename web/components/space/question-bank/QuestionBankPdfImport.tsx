"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, FileUp, Loader2, Plus, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getTextbookCatalog, type TextbookCatalog } from "@/lib/notebook-api";
import {
  getPdfImport,
  listPdfImports,
  pdfImportSourceUrl,
  updatePdfImport,
  uploadPdfImport,
  type PdfImportBatch,
  type PdfImportQuestion,
  type PdfImportSummary,
} from "@/lib/question-bank-pdf-api";
import { randomUuid } from "@/lib/random-uuid";
import { isApiError } from "@/shared/api/errors";
import PdfImportPreview from "./PdfImportPreview";
import PdfQuestionEditor, {
  pdfQuestionCanBeApproved,
  pdfQuestionHasValidPages,
  pdfQuestionHasValidTags,
} from "./PdfQuestionEditor";

const PDF_SIZE_LIMIT = 50 * 1024 * 1024;
const POLL_INTERVAL = 3000;
const PDF_QUESTION_LIMIT = 500;
const button = "inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-40";
const primaryButton = "inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40";

function batchStatus(batch: PdfImportSummary) {
  if (batch.status === "processing") return "Recognizing PDF";
  return batch.status === "imported" ? "Imported" : "Draft";
}

function questionStatus(question: PdfImportQuestion) {
  if (question.status === "imported") return "Imported";
  if (question.status === "duplicate") return "Duplicate";
  return question.approved ? "Approved" : "Pending review";
}

function firstQuestion(batch: PdfImportBatch) {
  return batch.questions.find(question => question.status === "pending") ?? batch.questions[0];
}

export default function QuestionBankPdfImport({
  onImported,
  onClose,
  onBrowseSource,
}: {
  onImported: () => void | Promise<void>;
  onClose?: () => void;
  onBrowseSource?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const writing = useRef(false);
  const [summaries, setSummaries] = useState<PdfImportSummary[]>([]);
  const [batch, setBatch] = useState<PdfImportBatch | null>(null);
  const [catalog, setCatalog] = useState<TextbookCatalog | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewPage, setPreviewPage] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"upload" | "open" | "save" | "commit" | null>(null);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [pollError, setPollError] = useState(false);
  const [notice, setNotice] = useState("");
  const processingId = batch?.status === "processing" ? batch.id : null;

  useEffect(() => {
    const controller = new AbortController();
    void listPdfImports(controller.signal).then(next => {
      if (controller.signal.aborted) return;
      setSummaries(current => [...current, ...next.filter(item => !current.some(existing => existing.id === item.id))]);
    }).catch((err: unknown) => {
      if (!controller.signal.aborted) setLoadError(err instanceof Error ? err.message : String(err));
    });
    void getTextbookCatalog().then(next => {
      if (!controller.signal.aborted) setCatalog(next);
    }).catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!processingId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    async function poll(id: string) {
      try {
        const next = await getPdfImport(id, controller.signal);
        if (controller.signal.aborted) return;
        setPollError(false);
        setBatch(next);
        setSummaries(current => current.map(item => item.id === id ? next : item));
        if (next.status !== "processing") {
          const first = firstQuestion(next);
          setSelectedId(first?.id ?? null);
          setPreviewPage(first?.page || 1);
          return;
        }
      } catch {
        if (controller.signal.aborted) return;
        setPollError(true);
      }
      timer = setTimeout(() => void poll(id), POLL_INTERVAL);
    }

    timer = setTimeout(() => void poll(processingId), POLL_INTERVAL);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [processingId]);

  function selectQuestion(question?: PdfImportQuestion) {
    setSelectedId(question?.id ?? null);
    setPreviewPage(question?.page || 1);
  }

  function receive(next: PdfImportBatch, keepSelection = false) {
    setBatch(next);
    setSummaries(current => [next, ...current.filter(item => item.id !== next.id)]);
    setDirty(false);
    setPollError(false);
    if (!keepSelection || !next.questions.some(question => question.id === selectedId)) {
      selectQuestion(firstQuestion(next));
    }
  }

  async function run(action: NonNullable<typeof busy>, operation: () => Promise<void>) {
    if (writing.current) return;
    writing.current = true;
    setBusy(action);
    setError("");
    setStale(false);
    setNotice("");
    try {
      await operation();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStale(isApiError(err) && err.status === 409 && (action === "save" || action === "commit"));
    } finally {
      writing.current = false;
      setBusy(null);
    }
  }

  function allowLeaving() {
    return !dirty || window.confirm(t("Discard unsaved PDF review edits?"));
  }

  function openBatch(id: string) {
    if (!allowLeaving()) return;
    if (!id) {
      setBatch(null);
      setDirty(false);
      setError("");
      setNotice("");
      return;
    }
    void run("open", async () => receive(await getPdfImport(id)));
  }

  function upload(file: File) {
    if (!/\.pdf$/i.test(file.name)) {
      setError(t("Choose a PDF file."));
      return;
    }
    if (!file.size || file.size > PDF_SIZE_LIMIT) {
      setError(t("Choose a non-empty PDF up to 50 MB."));
      return;
    }
    if (allowLeaving()) void run("upload", async () => receive(await uploadPdfImport(file)));
  }

  function changeQuestion(id: string, patch: Partial<PdfImportQuestion>) {
    setBatch(current => current ? {
      ...current,
      questions: current.questions.map(question => question.id === id ? { ...question, approved: false, ...patch } : question),
    } : current);
    setDirty(true);
    setNotice("");
  }

  function addQuestion() {
    if (!batch) return;
    const page = Math.max(1, Math.min(previewPage, batch.page_count));
    const question: PdfImportQuestion = {
      id: randomUuid(), page, end_page: page, number: "", question: "", correct_answer: "",
      question_type: "short_answer", options: {}, explanation: "", difficulty: "", tags: [],
      textbook_section_id: "", approved: false, status: "pending", entry_id: null,
    };
    setBatch({ ...batch, questions: [...batch.questions, question] });
    selectQuestion(question);
    setDirty(true);
    setNotice("");
  }

  function removeQuestion() {
    if (!row || !batch || row.status !== "pending" || !window.confirm(t("Remove this question from the draft?"))) return;
    const questions = batch.questions.filter(question => question.id !== row.id);
    setBatch({ ...batch, questions });
    selectQuestion(questions[index] ?? questions[index - 1]);
    setDirty(true);
    setNotice("");
  }

  function submit(commit: boolean) {
    if (!batch) return;
    void run(commit ? "commit" : "save", async () => {
      const next = await updatePdfImport(batch, commit);
      receive(next, !commit);
      if (commit) await onImported();
      else setNotice(t("PDF draft saved."));
    });
  }

  const rows = batch?.questions ?? [];
  const index = rows.findIndex(question => question.id === selectedId);
  const row = rows[index];
  const approved = rows.filter(question => question.status === "pending" && question.approved).length;
  const pending = rows.filter(question => question.status === "pending" && !question.approved).length;
  const canEdit = batch?.status === "draft" && !busy;
  const canApprove = row && batch && pdfQuestionCanBeApproved(row, batch.page_count);
  const hasInvalidMetadata = batch && rows.some(question => question.status === "pending" && (
    !pdfQuestionHasValidPages(question, batch.page_count) || !pdfQuestionHasValidTags(question)
  ));

  return (
    <section aria-labelledby={titleId} className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold">
          <FileUp size={18} aria-hidden="true" />
          {t("Import PDF questions")}
        </h2>
        {onClose && (
          <button
            type="button"
            onClick={() => { if (allowLeaving()) onClose(); }}
            disabled={Boolean(busy)}
            aria-label={t("Close import")}
            className="rounded-lg p-2 hover:bg-muted disabled:opacity-40"
          >
            <X size={17} />
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          aria-label={t("Choose PDF")}
          hidden
          disabled={Boolean(busy)}
          onChange={event => {
            const file = event.target.files?.[0];
            if (file) upload(file);
            event.target.value = "";
          }}
        />
        <button type="button" onClick={() => inputRef.current?.click()} disabled={Boolean(busy)} className={batch ? button : primaryButton}>
          <FileUp size={15} aria-hidden="true" />
          {t("Choose PDF")}
        </button>
        {!!summaries.length && (
          <select
            aria-label={t("PDF import batches")}
            value={batch?.id ?? ""}
            disabled={Boolean(busy)}
            onChange={event => openBatch(event.target.value)}
            className="min-w-0 max-w-full flex-1 rounded-lg border border-border bg-background px-2.5 py-2 text-sm disabled:opacity-40"
          >
            <option value="">{t("Open a saved PDF import")}</option>
            {summaries.map(item => (
              <option key={item.id} value={item.id}>
                {item.filename} · {t(batchStatus(item))}
              </option>
            ))}
          </select>
        )}
      </div>
      {!batch && !busy && (
        <p className="text-sm text-muted-foreground">
          {t("Upload a PDF up to 50 MB and 250 pages. Review the recognized questions against the original pages, then import the ones you approve.")}
        </p>
      )}
      {loadError && <p className="text-sm text-muted-foreground" role="status">{t("Could not load saved PDF imports.")} {loadError}</p>}
      {busy && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={15} className="animate-spin" />
          {busy === "upload" ? t("Uploading PDF…") : t("Processing…")}
        </p>
      )}
      {error && (
        <div className="space-y-2 break-words rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          <p role="alert">{error}</p>
          {stale && batch && (
            <button type="button" className={button} disabled={Boolean(busy)} onClick={() => openBatch(batch.id)}>
              {t("Reload saved draft")}
            </button>
          )}
        </div>
      )}
      {notice && <p role="status" className="text-sm text-foreground">{notice}</p>}
      {batch && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <p className="min-w-0 break-all text-sm font-medium" title={batch.filename}>{batch.filename}</p>
            {batch.status !== "processing" && (
              <p aria-live="polite" className="shrink-0 text-xs text-muted-foreground">
                {t("{{pending}} pending · {{approved}} approved", { pending, approved })}
              </p>
            )}
          </div>
          {batch.result && (
            <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm">
              <span>{t("Imported {{created}} questions; skipped {{duplicates}} duplicates.", { created: batch.result.imported, duplicates: batch.result.duplicates })}</span>
              {onBrowseSource && batch.result.imported + batch.result.duplicates > 0 && (
                <button type="button" className="rounded-md px-2 py-1 text-sm font-medium text-primary hover:bg-primary/10" onClick={() => { if (allowLeaving()) onBrowseSource(batch.id); }}>
                  {t("Browse imported questions")}
                </button>
              )}
            </div>
          )}
          {!!batch.warnings.length && (
            <ul className="space-y-1 rounded-lg bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
              {batch.warnings.map((warning, i) => <li className="break-words" key={`${i}:${warning}`}>{warning}</li>)}
            </ul>
          )}
          <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)]">
            <PdfImportPreview
              key={batch.id}
              url={pdfImportSourceUrl(batch.id)}
              page={previewPage}
              pageCount={batch.page_count}
              onPageChange={setPreviewPage}
            />
            <div className="min-w-0 space-y-3 rounded-xl border border-border p-3 sm:p-4">
              {batch.status === "processing" ? (
                <div className="space-y-2 text-sm">
                  <p role="status" className="flex items-center gap-2 font-medium">
                    <Loader2 size={15} className="animate-spin" />
                    {t("Recognizing PDF")}
                  </p>
                  <p className="text-muted-foreground">{t("You can close this view and return to the saved import later.")}</p>
                  {pollError && <p role="status" className="text-muted-foreground">{t("Waiting to reconnect to the PDF import.")}</p>}
                </div>
              ) : (
                <>
                  {!!rows.length && (
                    <div className="flex items-center gap-1.5">
                      <button type="button" disabled={index <= 0 || Boolean(busy)} onClick={() => selectQuestion(rows[index - 1])} aria-label={t("Previous question")} className="shrink-0 rounded-md p-1.5 hover:bg-muted disabled:opacity-40">
                        <ChevronLeft size={17} />
                      </button>
                      <select
                        aria-label={t("Select a question to review")}
                        value={selectedId ?? ""}
                        disabled={Boolean(busy)}
                        onChange={event => selectQuestion(rows.find(question => question.id === event.target.value))}
                        className="w-full min-w-0 rounded-lg border border-border bg-background px-2 py-2 text-xs"
                      >
                        {rows.map((question, i) => (
                          <option key={question.id} value={question.id}>
                            {t("Original PDF page {{page}}", { page: question.page || 1 })} · {question.number || i + 1} · {t(questionStatus(question))} · {question.question.trim().slice(0, 34)}
                          </option>
                        ))}
                      </select>
                      <button type="button" disabled={index >= rows.length - 1 || Boolean(busy)} onClick={() => selectQuestion(rows[index + 1])} aria-label={t("Next question")} className="shrink-0 rounded-md p-1.5 hover:bg-muted disabled:opacity-40">
                        <ChevronRight size={17} />
                      </button>
                    </div>
                  )}
                  {row ? (
                    <>
                      <p className="text-xs font-medium text-muted-foreground">{t(questionStatus(row))}</p>
                      <PdfQuestionEditor
                        key={`${batch.id}:${batch.revision}:${row.id}`}
                        question={row}
                        pageCount={batch.page_count}
                        catalog={catalog}
                        disabled={!canEdit || row.status !== "pending"}
                        onChange={changes => {
                          changeQuestion(row.id, changes);
                          if (changes.page && changes.page >= 1 && changes.page <= batch.page_count) setPreviewPage(changes.page);
                        }}
                      />
                      {row.status === "pending" && (
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => changeQuestion(row.id, { approved: !row.approved })}
                            disabled={!canEdit || (!row.approved && !canApprove)}
                            className={row.approved ? button : primaryButton}
                          >
                            <Check size={15} aria-hidden="true" />
                            {row.approved ? t("Revoke approval") : t("Approve question")}
                          </button>
                          <button type="button" onClick={removeQuestion} disabled={!canEdit} className={`${button} text-destructive`}>
                            <Trash2 size={15} aria-hidden="true" />
                            {t("Remove")}
                          </button>
                          {!canApprove && (
                            <p className="w-full text-xs text-muted-foreground">{t("Check the page range, question and answer before approving. Choice questions need matching options and answers.")}</p>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t(batch.status === "draft" ? "No questions were recognized. Add a question from the original PDF." : "No questions in this import.")}</p>
                  )}
                  {batch.status === "draft" && rows.length < PDF_QUESTION_LIMIT && (
                    <button type="button" onClick={addQuestion} disabled={!canEdit} className={button}>
                      <Plus size={15} aria-hidden="true" />
                      {t("Add question")}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
          {batch.status === "draft" && (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
              {hasInvalidMetadata && (
                <p className="flex-1 text-xs text-destructive">{t("Fix the invalid page range or tags before saving this draft.")}</p>
              )}
              <button type="button" className={button} disabled={!canEdit || !dirty || Boolean(hasInvalidMetadata)} onClick={() => submit(false)}>{t("Save draft")}</button>
              <button type="button" className={primaryButton} disabled={!canEdit || !approved || Boolean(hasInvalidMetadata)} onClick={() => submit(true)}>
                {t("Import approved questions ({{count}})", { count: approved })}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
