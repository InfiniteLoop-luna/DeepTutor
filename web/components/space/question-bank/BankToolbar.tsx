"use client";

import { useTranslation } from "react-i18next";
import { ArrowDownWideNarrow, Loader2, Search, SlidersHorizontal, X } from "lucide-react";
import type {
  AssessmentSource,
  NotebookCategory,
  QuestionBankMaterial,
  ScoreTrend,
} from "@/lib/notebook-api";
import type { BankScope, BankSort, ReviewFilters } from "./useQuestionBank";
import Tooltip from "@/shared/ui/Tooltip";

interface BankToolbarProps {
  search: string;
  sort: BankSort;
  refreshing: boolean;
  managerOpen: boolean;
  filters: ReviewFilters;
  materials: QuestionBankMaterial[];
  categories: NotebookCategory[];
  scope: BankScope;
  mistakesOnly: boolean;
  onSearchChange: (value: string) => void;
  onSortChange: (sort: BankSort) => void;
  onToggleManager: () => void;
  onFiltersChange: (filters: ReviewFilters) => void;
  onScopeChange: (scope: BankScope) => void;
  onClearPdfSource?: () => void;
}

const SELECT =
  "h-[34px] max-w-full rounded-lg border border-border bg-card px-2 text-xs text-foreground disabled:opacity-50";
const TYPES = [
  ["single_choice", "Single Choice"],
  ["multi_choice", "Multiple Select"],
  ["true_false", "True or False"],
  ["fill_blank", "Fill in the Blank"],
  ["short_answer", "Short Answer"],
];
const DIFFICULTIES = [
  ["easy", "Easy"],
  ["medium", "Medium"],
  ["hard", "Hard"],
];
const SCOPES = [
  ["", "Any practice status"],
  ["wrong", "Wrong Only"],
  ["unresolved", "Needs Review"],
  ["bookmarked", "Marked"],
] as const;

export default function BankToolbar({
  search,
  sort,
  refreshing,
  managerOpen,
  filters,
  materials,
  categories,
  scope,
  mistakesOnly,
  onSearchChange,
  onSortChange,
  onToggleManager,
  onFiltersChange,
  onScopeChange,
  onClearPdfSource,
}: BankToolbarProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted-foreground)]" />
          <input
            value={search}
            aria-label={t("Search questions and answers…")}
            onChange={event => onSearchChange(event.target.value)}
            placeholder={t("Search questions and answers…")}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--card)] py-1.5 pl-8 pr-8 text-[12.5px] text-[var(--foreground)] outline-none transition-colors placeholder:text-[var(--muted-foreground)] focus:border-[var(--primary)]/50"
          />
          {refreshing ? (
            <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-[var(--muted-foreground)]" />
          ) : search ? (
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2">
              <Tooltip label={t("Clear")}>
                <button
                  type="button"
                  onClick={() => onSearchChange("")}
                  aria-label={t("Clear")}
                  className="rounded p-0.5 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            </span>
          ) : null}
        </div>

        <Tooltip label={t("Toggle sort order")}>
          <button
            type="button"
            onClick={() => onSortChange(sort === "recent" ? "oldest" : "recent")}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2.5 py-1.5 text-[12px] text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)]/60 hover:text-[var(--foreground)]"
          >
            <ArrowDownWideNarrow
              className={`h-3.5 w-3.5 transition-transform ${sort === "oldest" ? "rotate-180" : ""}`}
            />
            {sort === "recent" ? t("Newest first") : t("Oldest first")}
          </button>
        </Tooltip>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={filters.reviewStatus ?? ""}
          onChange={event =>
            onFiltersChange({
              ...filters,
              reviewStatus: event.target.value as ReviewFilters["reviewStatus"],
            })
          }
          aria-label={t("Practice status")}
          className={SELECT}
        >
          {SCOPES.filter(([kind]) => !mistakesOnly || kind !== "wrong").map(([kind, label]) => (
            <option value={kind} key={kind}>
              {t(label)}
            </option>
          ))}
        </select>
        <select
          value={filters.questionType ?? ""}
          onChange={event => onFiltersChange({ ...filters, questionType: event.target.value })}
          aria-label={t("Question type")}
          className={SELECT}
        >
          <option value="">{t("All question types")}</option>
          {TYPES.map(([value, label]) => (
            <option key={value} value={value}>
              {t(label)}
            </option>
          ))}
        </select>
        <select
          value={filters.difficulty ?? ""}
          onChange={event => onFiltersChange({ ...filters, difficulty: event.target.value })}
          aria-label={t("Difficulty")}
          className={SELECT}
        >
          <option value="">{t("All difficulties")}</option>
          {DIFFICULTIES.map(([value, label]) => (
            <option key={value} value={value}>
              {t(label)}
            </option>
          ))}
        </select>
        <select
          value={filters.materialId}
          onChange={event => onFiltersChange({ ...filters, materialId: event.target.value })}
          aria-label={t("Material")}
          disabled={materials.length === 0}
          className={`${SELECT} max-w-[200px]`}
        >
          <option value="">{t("All Materials")}</option>
          {materials
            .filter(item => !filters.source || item.source === filters.source)
            .map(item => (
              <option key={`${item.source}:${item.material_id}`} value={item.material_id}>
                {item.material_title}
              </option>
            ))}
        </select>
        {filters.pdfSourceId && (
          <button
            type="button"
            onClick={onClearPdfSource ?? (() => onFiltersChange({ ...filters, pdfSourceId: "" }))}
            className="inline-flex items-center gap-1 rounded-lg bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary"
          >
            {t("Selected PDF source")} <X size={13} />
          </button>
        )}
      </div>

      <details className="text-xs text-muted-foreground">
        <summary className="w-fit cursor-pointer py-0.5">{t("More filters")}</summary>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            value={scope.kind === "category" ? String(scope.categoryId) : scope.kind}
            onChange={event => {
              const value = event.target.value;
              if (value === "all" || value === "uncategorized") onScopeChange({ kind: value });
              else onScopeChange({ kind: "category", categoryId: Number(value) });
            }}
            aria-label={t("Tags")}
            className={SELECT}
          >
            <option value="all">{t("All tags")}</option>
            <option value="uncategorized">{t("Untagged")}</option>
            {categories.map(category => (
              <option value={category.id} key={category.id}>
                {category.name}
              </option>
            ))}
          </select>

          <select
            value={filters.source}
            onChange={event =>
              onFiltersChange({
                ...filters,
                source: event.target.value as AssessmentSource | "",
                materialId: "",
              })
            }
            aria-label={t("Source")}
            className="h-[34px] rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 text-[12px] text-[var(--foreground)] outline-none"
          >
            <option value="">{t("All Sources")}</option>
            <option value="deep_question">{t("Deep Question")}</option>
            <option value="mastery_path">{t("Mastery Path")}</option>
            <option value="immersive_reading">{t("Immersive Reading")}</option>
            <option value="book">{t("Book")}</option>
            <option value="partner_chat">{t("Partner Chat")}</option>
            <option value="import">{t("Imported")}</option>
          </select>

          <select
            value={filters.scoreTrend}
            onChange={event =>
              onFiltersChange({
                ...filters,
                scoreTrend: event.target.value as ScoreTrend | "",
              })
            }
            aria-label={t("Score Trend")}
            className="h-[34px] rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 text-[12px] text-[var(--foreground)] outline-none"
          >
            <option value="">{t("All Trends")}</option>
            <option value="new">{t("First Attempt")}</option>
            <option value="improved">{t("Improved")}</option>
            <option value="declined">{t("Declined")}</option>
            <option value="unchanged">{t("Unchanged")}</option>
          </select>

          <button
            type="button"
            onClick={onToggleManager}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors ${
              managerOpen
                ? "border-[var(--primary)]/40 bg-[var(--primary)]/10 text-[var(--primary)]"
                : "border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] hover:bg-[var(--muted)]/60 hover:text-[var(--foreground)]"
            }`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            {t("Manage tags")}
          </button>
        </div>
      </details>
    </div>
  );
}
