"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TextbookCatalog } from "@/lib/notebook-api";
import type { PdfImportQuestion, PdfQuestionType } from "@/lib/question-bank-pdf-api";
import { TextbookSectionOptions } from "./BankCurriculum";

const OPTION_KEYS = "ABCDEFGHIJ".split("");

const field = "w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 disabled:opacity-70";
const label = "block space-y-1 text-xs font-medium";

function isChoice(type: PdfQuestionType) {
  return type === "single_choice" || type === "multi_choice";
}

export function pdfQuestionHasValidPages(question: PdfImportQuestion, pageCount: number) {
  return Number.isInteger(question.page) && Number.isInteger(question.end_page) &&
    question.page >= 1 && question.end_page >= question.page && question.end_page <= pageCount;
}

export function pdfQuestionHasValidTags(question: PdfImportQuestion) {
  return question.tags.length <= 20 && question.tags.every(tag => Array.from(tag).length <= 100);
}

export function pdfQuestionCanBeApproved(question: PdfImportQuestion, pageCount: number) {
  const answer = question.correct_answer.trim();
  if (
    !question.question.trim() || !answer || !pdfQuestionHasValidPages(question, pageCount) ||
    !pdfQuestionHasValidTags(question)
  ) return false;
  if (question.question_type === "true_false") {
    return /^(true|false|正确|错误|对|错|是|否|t|f|0|1)$/i.test(answer);
  }
  if (!isChoice(question.question_type)) return true;

  const choices = Object.entries(question.options).filter(([, value]) => value.trim());
  if (choices.length < 2) return false;
  if (choices.some(([, value]) => value.trim() === answer)) return true;

  const labels = new Set(choices.map(([key]) => key.toUpperCase()));
  let keys = answer.toUpperCase().split(/[,;，；\s]+/).filter(Boolean);
  if (question.question_type === "multi_choice" && keys.length === 1 && !labels.has(keys[0])) {
    keys = Array.from(keys[0]);
  }
  return keys.length > 0 && (question.question_type === "multi_choice" || keys.length === 1) &&
    keys.every(key => labels.has(key));
}

export default function PdfQuestionEditor({
  question,
  pageCount,
  catalog,
  disabled,
  onChange,
}: {
  question: PdfImportQuestion;
  pageCount: number;
  catalog: TextbookCatalog | null;
  disabled: boolean;
  onChange: (changes: Partial<PdfImportQuestion>) => void;
}) {
  const { t } = useTranslation();
  const [tagsText, setTagsText] = useState(question.tags.join("，"));
  const options: Record<string, string> = Object.keys(question.options).length ? question.options : { A: "", B: "" };
  const nextOption = OPTION_KEYS.find(key => !Object.prototype.hasOwnProperty.call(options, key));
  const displaySection = catalog || question.textbook_section_id;

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <label className={label}>
          <span>{t("Question number")}</span>
          <input maxLength={80} value={question.number} onChange={event => onChange({ number: event.target.value })} className={field} />
        </label>
        <label className={label}>
          <span>{t("Start page")}</span>
          <input
            type="number"
            min={1}
            max={pageCount}
            value={question.page || ""}
            onChange={event => {
              const page = event.target.valueAsNumber || 0;
              onChange({ page, end_page: Math.max(page, question.end_page) });
            }}
            className={field}
          />
        </label>
        <label className={label}>
          <span>{t("End page")}</span>
          <input
            type="number"
            min={question.page || 1}
            max={pageCount}
            value={question.end_page || ""}
            onChange={event => onChange({ end_page: event.target.valueAsNumber || 0 })}
            className={field}
          />
        </label>
      </div>
      <label className={label}>
        <span>{t("Question")}</span>
        <textarea
          rows={5}
          maxLength={20000}
          value={question.question}
          onChange={event => onChange({ question: event.target.value })}
          className={field}
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className={label}>
          <span>{t("Question type")}</span>
          <select
            value={question.question_type}
            onChange={event => {
              const type = event.target.value as PdfQuestionType;
              onChange({ question_type: type, options: isChoice(type) ? question.options : {} });
            }}
            className={field}
          >
            <option value="single_choice">{t("Single Choice")}</option>
            <option value="multi_choice">{t("Multiple Select")}</option>
            <option value="true_false">{t("True or False")}</option>
            <option value="fill_blank">{t("Fill in the Blank")}</option>
            <option value="short_answer">{t("Short Answer")}</option>
          </select>
        </label>
        <label className={label}>
          <span>{t("Difficulty")}</span>
          <input maxLength={100} value={question.difficulty} onChange={event => onChange({ difficulty: event.target.value })} className={field} />
        </label>
      </div>
      {isChoice(question.question_type) && (
        <div className="space-y-2">
          {Object.entries(options).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => (
            <div key={key} className="flex items-center gap-2">
              <span aria-hidden="true" className="w-4 shrink-0 text-center text-xs font-medium text-muted-foreground">{key}</span>
              <input
                aria-label={t("Option {{key}}", { key })}
                maxLength={20000}
                value={value}
                onChange={event => onChange({ options: { ...options, [key]: event.target.value } })}
                className={field}
              />
              <button
                type="button"
                aria-label={t("Remove option {{key}}", { key })}
                onClick={() => {
                  const next = { ...options };
                  delete next[key];
                  onChange({ options: next });
                }}
                disabled={Object.keys(options).length <= 2}
                className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
              >
                <X size={14} />
              </button>
            </div>
          ))}
          {nextOption && Object.keys(options).length < 10 && (
            <button
              type="button"
              onClick={() => onChange({ options: { ...options, [nextOption]: "" } })}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-primary hover:bg-primary/10"
            >
              <Plus size={14} />
              {t("Add option")}
            </button>
          )}
        </div>
      )}
      <label className={label}>
        <span>{t("Correct answer")}</span>
        <textarea
          rows={2}
          maxLength={20000}
          value={question.correct_answer}
          onChange={event => onChange({ correct_answer: event.target.value })}
          placeholder={isChoice(question.question_type) ? t("Enter option letters, for example A or A,C.") : undefined}
          className={field}
        />
      </label>
      <label className={label}>
        <span>{t("Explanation")}</span>
        <textarea
          rows={3}
          maxLength={20000}
          value={question.explanation}
          onChange={event => onChange({ explanation: event.target.value })}
          className={field}
        />
      </label>
      {displaySection && (
        <label className={label}>
          <span>{t("Textbook section")}</span>
          <select
            value={question.textbook_section_id}
            onChange={event => onChange({ textbook_section_id: event.target.value })}
            className={field}
          >
            <option value="">{t("Unassigned")}</option>
            {catalog ? (
              <TextbookSectionOptions catalog={catalog} />
            ) : (
              <option value={question.textbook_section_id}>{question.textbook_section_id}</option>
            )}
          </select>
        </label>
      )}
      <label className={label}>
        <span>{t("Tags")}</span>
        <input
          value={tagsText}
          onChange={event => {
            const value = event.target.value;
            setTagsText(value);
            onChange({ tags: Array.from(new Set(value.split(/[,，;；]/).map(tag => tag.trim()).filter(Boolean))) });
          }}
          placeholder={t("Separate tags with commas.")}
          className={field}
        />
        {!pdfQuestionHasValidTags(question) && (
          <span className="text-destructive">{t("Use up to 20 tags with a maximum of 100 characters each.")}</span>
        )}
      </label>
    </fieldset>
  );
}
