import { apiUrl, requestJson } from "@/shared/api/client";

const ROOT = "/api/question-notebook/practice/pdf-imports";

export type PdfQuestionType =
  | "single_choice"
  | "multi_choice"
  | "true_false"
  | "fill_blank"
  | "short_answer";

export interface PdfImportQuestion {
  id: string;
  page: number;
  end_page: number;
  number: string;
  question: string;
  correct_answer: string;
  question_type: PdfQuestionType;
  options: Record<string, string>;
  explanation: string;
  difficulty: string;
  tags: string[];
  textbook_section_id: string;
  approved: boolean;
  status: "pending" | "imported" | "duplicate";
  entry_id: number | null;
}

export interface PdfImportSummary {
  id: string;
  filename: string;
  page_count: number;
  created_at: number;
  status: "processing" | "draft" | "imported";
  warnings: string[];
  result: { imported: number; duplicates: number; total: number } | null;
}

export interface PdfImportBatch extends PdfImportSummary {
  questions: PdfImportQuestion[];
  revision: number;
}

function batchUrl(id: string, suffix = "") {
  return apiUrl(`${ROOT}/${encodeURIComponent(id)}${suffix}`);
}

export function listPdfImports(signal?: AbortSignal) {
  return requestJson<PdfImportSummary[]>(apiUrl(ROOT), { cache: "no-store", signal });
}

export function uploadPdfImport(file: File) {
  const body = new FormData();
  body.append("file", file);
  return requestJson<PdfImportBatch>(apiUrl(ROOT), { method: "POST", body });
}

export function getPdfImport(id: string, signal?: AbortSignal) {
  return requestJson<PdfImportBatch>(batchUrl(id), { cache: "no-store", signal });
}

export function pdfImportSourceUrl(id: string) {
  return batchUrl(id, "/source");
}

export function updatePdfImport(batch: PdfImportBatch, commit = false) {
  // The API owns final status and entry IDs. Send only rows that can still change.
  const questions = batch.questions.filter(question => question.status === "pending").map(question => {
    const { status, entry_id, ...draft } = question;
    return draft;
  });
  return requestJson<PdfImportBatch>(batchUrl(batch.id, commit ? "/commit" : ""), {
    method: commit ? "POST" : "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision: batch.revision, questions }),
  });
}
