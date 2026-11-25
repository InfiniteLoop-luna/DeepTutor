"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { BookOpen, Clapperboard, Loader2, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import Modal from "@/components/common/Modal";
import {
  type QuestionLessonView,
  createQuestionLesson,
  getQuestionLesson,
  retryQuestionLessonScene,
  solveQuestionLesson,
  startQuestionLessonNarration,
} from "@/lib/question-lesson-api";
import { pdfImportSourceUrl } from "@/lib/question-bank-pdf-api";
import QuestionLessonReader from "./QuestionLessonReader";

const QuestionLessonPlayer = dynamic(() => import("./QuestionLessonPlayer"), { ssr: false });

const ERRORS: Record<string, string> = {
  explanation_required: "Save an explanation for this question first.",
  figure_required: "This question refers to a figure. Add the figure to continue.",
  figure_too_large: "Choose an image up to 8 MB.",
  invalid_figure: "Choose a readable PNG, JPEG, or WebP image.",
  original_figure_unavailable:
    "The original page could not be loaded. Upload the figure to continue.",
  lesson_changed: "The question or lesson has changed. Reload the lesson.",
  invalid_question_text: "Enter a question of up to 20,000 characters.",
  solution_needs_vision: "Choose a model with image support in Settings to solve this question.",
  solution_invalid: "The model returned an incomplete solution. Try generating again.",
  solution_timed_out: "The model took too long to solve the problem. Try again.",
  solution_model_unconfigured: "Choose a language model in Settings to generate a solution.",
  solution_model_failed: "The configured model could not generate the solution. Check the model in Settings or try again.",
  question_save_failed: "The solved question could not be saved. Try again.",
};

const BUTTON =
  "inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted aria-pressed:border-primary/40 aria-pressed:bg-primary/10 aria-pressed:text-primary disabled:opacity-40";

export default function QuestionLessonDialog({
  entryId,
  onClose,
  onQuestionSaved,
}: {
  entryId?: number;
  onClose: () => void;
  onQuestionSaved?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<QuestionLessonView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"ai" | "saved" | "voice" | null>(null);
  const [reload, setReload] = useState(0);
  const [question, setQuestion] = useState("");
  const [display, setDisplay] = useState<"read" | "video">("read");
  const [editing, setEditing] = useState(false);
  const [figure, setFigure] = useState<File>();
  const [useOriginal, setUseOriginal] = useState(false);
  const current = useRef(0);
  const lesson = view?.lesson;
  const targetId = lesson?.entry_id ?? entryId;
  const needsFigure = view?.needs_figure || error === "figure_required";
  const missingFigure = needsFigure && !useOriginal && !figure;
  const recording = lesson?.scenes.some(scene => scene.state === "recording") ?? false;
  const pending = lesson?.scenes.some(scene => scene.state === "pending") ?? false;
  const solveLabel = lesson?.source === "ai" ? "Regenerate solution" : "Generate AI solution";
  const source =
    view?.pdf_sources.length === 1 && view.pdf_sources[0].page === view.pdf_sources[0].end_page
      ? view.pdf_sources[0]
      : undefined;

  useEffect(() => {
    if (!targetId) return;
    const id = targetId;
    const controller = new AbortController();
    const request = ++current.current;
    void getQuestionLesson(id, controller.signal)
      .then(result => {
        if (request === current.current && !controller.signal.aborted) {
          setView(result);
          setError("");
        }
      })
      .catch(reason => {
        if (request === current.current && !controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => controller.abort();
  }, [targetId, reload]);

  useEffect(() => {
    if (!targetId || !recording || busy || display !== "video") return;
    const id = targetId;
    const controller = new AbortController();
    const request = current.current;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (controller.signal.aborted) return;
      try {
        const result = await getQuestionLesson(id, controller.signal);
        if (request !== current.current || controller.signal.aborted) return;
        setView(result);
        setError("");
        if (!result.lesson?.scenes.some(scene => scene.state === "recording")) return;
      } catch (reason) {
        if (request !== current.current || controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      }
      timer = setTimeout(() => void poll(), 1800);
    }
    timer = setTimeout(() => void poll(), 800);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [targetId, recording, busy, reload, display]);

  async function submit(action: "ai" | "saved" | "voice", sceneId?: string) {
    ++current.current;
    setBusy(action);
    setError("");
    try {
      const language = i18n.resolvedLanguage ?? i18n.language;
      if (action === "voice" && lesson) {
        const record = sceneId
          ? retryQuestionLessonScene(lesson, sceneId)
          : startQuestionLessonNarration(lesson);
        setView(await record);
      } else if (action === "saved" && targetId) {
        setView(await createQuestionLesson(targetId, language, figure, useOriginal));
        setDisplay("video");
        setEditing(false);
      } else if (action === "ai") {
        const result = await solveQuestionLesson(
          targetId ? { entryId: targetId } : { question },
          language,
          figure,
          useOriginal,
        );
        setView(result);
        setDisplay("read");
        setEditing(false);
        if (!targetId) onQuestionSaved?.();
      }
      if (action !== "voice") {
        setFigure(undefined);
        setUseOriginal(false);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  function openVideo() {
    setDisplay("video");
    if (pending && !recording) void submit("voice");
  }

  return createPortal(
    <Modal
      isOpen
      onClose={onClose}
      title={t("AI illustrated solution")}
      titleIcon={<Sparkles size={19} />}
      width="xl"
    >
      <div className="space-y-4 p-4 sm:p-5">
        {targetId && !view && !error && (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
            <Loader2 size={16} className="animate-spin" /> {t("Loading…")}
          </p>
        )}
        {error && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted p-3"
          >
            <p className="text-sm text-destructive">{ERRORS[error] ? t(ERRORS[error]) : error}</p>
            {targetId && (!view || error === "lesson_changed") && (
              <button
                type="button"
                onClick={() => setReload(value => value + 1)}
                className={BUTTON}
              >
                {t("Reload")}
              </button>
            )}
          </div>
        )}
        {busy === "ai" && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={15} className="animate-spin" /> {t("AI is solving and preparing diagrams…")}
          </p>
        )}
        {display === "video" && recording && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={15} className="animate-spin" /> {t("Recording narration…")}
          </p>
        )}
        {lesson && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
            <button type="button" className={BUTTON} aria-pressed={display === "read"} onClick={() => setDisplay("read")}>
              <BookOpen size={15} /> {t("Illustrated solution")}
            </button>
            <button type="button" className={BUTTON} disabled={!!busy} aria-pressed={display === "video"} onClick={openVideo}>
              <Clapperboard size={15} /> {t("Narrated lesson")}
            </button>
            <button type="button" className="ml-auto px-2 py-1.5 text-sm text-primary hover:underline disabled:opacity-40" disabled={!!busy} onClick={() => setEditing(value => !value)}>
              {t(editing ? "Cancel" : solveLabel)}
            </button>
          </div>
        )}
        {view?.stale && (
          <p role="status" className="rounded-lg bg-muted px-3 py-2 text-sm">
            {t("This question has changed. Generate a solution from the current question.")}
          </p>
        )}
        {(!targetId || view) && (!lesson || editing) && (
          <form
            className="space-y-3"
            onSubmit={event => {
              event.preventDefault();
              void submit("ai");
            }}
          >
            {!targetId && (
              <label className="block space-y-1.5 text-sm font-medium">
                <span>{t("Enter the complete question")}</span>
                <textarea
                  data-autofocus
                  required
                  rows={5}
                  maxLength={20000}
                  value={question}
                  disabled={!!busy}
                  onChange={event => setQuestion(event.target.value)}
                  className="block w-full resize-y rounded-lg border border-border bg-background p-3 text-sm font-normal"
                />
              </label>
            )}
            <details
              open={needsFigure || undefined}
              className="space-y-2 rounded-lg border border-border p-3 text-sm"
            >
              <summary className="cursor-pointer">{t("Question figure")}</summary>
              {needsFigure && (
                <p>{t("This question refers to a figure. Add the figure to continue.")}</p>
              )}
              {source && (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={useOriginal && !figure}
                    disabled={!!busy || !!figure}
                    onChange={event => setUseOriginal(event.target.checked)}
                  />
                  {t("Use the original PDF page as the figure")}
                </label>
              )}
              <label className="block text-sm text-muted-foreground">
                <span className="mb-1 block">{t("Upload question figure")}</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={!!busy}
                  onChange={event => setFigure(event.target.files?.[0])}
                  className="w-full text-sm file:mr-2 file:rounded file:border-0 file:bg-muted file:px-3 file:py-1.5"
                />
              </label>
            </details>
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={!!busy || (!targetId && !question.trim()) || missingFigure}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
              >
                <Sparkles size={15} />
                {t(targetId ? solveLabel : "Solve and save to question bank")}
              </button>
              {!lesson && view?.has_explanation && (
                <button type="button" onClick={() => void submit("saved")} disabled={!!busy || missingFigure} className={BUTTON}>
                  {t("Generate from saved explanation")}
                </button>
              )}
            </div>
          </form>
        )}
        {lesson && (
          display === "read" ? (
            <QuestionLessonReader lesson={lesson} />
          ) : (
            <>
              <QuestionLessonPlayer
                key={lesson.version}
                lesson={lesson}
                busy={!!busy}
                onRetry={id => void submit("voice", id)}
              />
              {pending && !recording && (
                <button type="button" className={BUTTON} onClick={() => void submit("voice")} disabled={!!busy}>
                  {t("Continue recording")}
                </button>
              )}
            </>
          )
        )}
        {view?.pdf_sources.map(original => (
          <a
            key={`${original.document_id}:${original.page}:${original.number}`}
            href={`${pdfImportSourceUrl(original.document_id)}#page=${original.page}`}
            target="_blank"
            rel="noreferrer"
            className="block w-fit break-words text-xs text-primary hover:underline"
          >
            {t("PDF p. {{page}}", { page: original.page })} · {original.filename}
          </a>
        ))}
      </div>
    </Modal>,
    document.body,
  );
}
