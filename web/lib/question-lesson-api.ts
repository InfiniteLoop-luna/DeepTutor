import { apiUrl, requestJson } from "@/shared/api/client";
import type { QuestionPdfSource } from "@/lib/notebook-api";

const ROOT = "/api/question-notebook/practice/question-lessons";

export interface LessonCurve {
  label: string;
  function: "polynomial" | "abs" | "sin" | "cos" | "exp" | "log" | "sqrt" | "reciprocal";
  coefficients?: number[] | null;
  a: number;
  b: number;
  h: number;
  k: number;
}

export interface LessonCoordinates {
  kind: "coordinates";
  x_range: [number, number];
  y_range: [number, number];
  axes: boolean;
  curves: LessonCurve[];
  points: { label: string; x: number; y: number }[];
  segments: [string, string][];
}

export interface LessonBeat {
  id: string;
  markdown: string;
  narration: string;
  frames: number;
  captions: [number, string][];
  recording: string;
  visual?: LessonCoordinates | { kind: "flow"; nodes: string[] } | null;
  interval?: {
    low: string;
    high: string;
    variable: string;
    low_closed: boolean;
    high_closed: boolean;
  } | null;
}

export interface LessonScene {
  id: string;
  kind: "question" | "step" | "answer";
  state: "pending" | "recording" | "ready" | "caption";
  beats: LessonBeat[];
  title?: string;
}

export interface QuestionLesson {
  entry_id: number;
  version: string;
  language: "zh" | "en";
  source?: "ai" | "saved";
  reference_answer?: string;
  textbook: string;
  has_figure: boolean;
  figure_page?: number | null;
  pdf_sources: QuestionPdfSource[];
  scenes: LessonScene[];
}

export interface QuestionLessonView {
  lesson: QuestionLesson | null;
  stale: boolean;
  has_explanation: boolean;
  needs_figure: boolean;
  pdf_sources: QuestionPdfSource[];
}

export function getQuestionLesson(entryId: number, signal?: AbortSignal) {
  return requestJson<QuestionLessonView>(apiUrl(ROOT + "/" + entryId), {
    signal,
    cache: "no-store",
  });
}

function lessonForm(language: string, figure?: File, useOriginal = false) {
  const body = new FormData();
  body.set("language", language.startsWith("zh") ? "zh" : "en");
  if (figure) body.set("figure", figure);
  if (useOriginal) body.set("use_original", "true");
  return body;
}

export function createQuestionLesson(
  entryId: number,
  language: string,
  figure?: File,
  useOriginal = false,
) {
  const body = lessonForm(language, figure, useOriginal);
  return requestJson<QuestionLessonView>(apiUrl(ROOT + "/" + entryId), { method: "POST", body });
}

export function solveQuestionLesson(
  source: { entryId: number } | { question: string },
  language: string,
  figure?: File,
  useOriginal = false,
) {
  const body = lessonForm(language, figure, useOriginal);
  const path = "entryId" in source ? ROOT + "/" + source.entryId + "/solve" : ROOT + "/solve";
  if ("question" in source) body.set("question", source.question);
  return requestJson<QuestionLessonView>(apiUrl(path), { method: "POST", body });
}

function lessonPath(lesson: QuestionLesson) {
  return ROOT + "/" + lesson.entry_id + "/" + lesson.version;
}

export function startQuestionLessonNarration(lesson: QuestionLesson) {
  return requestJson<QuestionLessonView>(apiUrl(lessonPath(lesson) + "/narration"), { method: "POST" });
}

export function retryQuestionLessonScene(lesson: QuestionLesson, sceneId: string) {
  return requestJson<QuestionLessonView>(
    apiUrl(lessonPath(lesson) + "/scenes/" + sceneId + "/narration"),
    {
      method: "POST",
    },
  );
}

export function questionLessonFigureUrl(lesson: QuestionLesson) {
  return apiUrl(lessonPath(lesson) + "/figure");
}

export function questionLessonAudioUrl(lesson: QuestionLesson, beat: LessonBeat) {
  return apiUrl(lessonPath(lesson) + "/audio/" + beat.id + "/" + beat.recording);
}
