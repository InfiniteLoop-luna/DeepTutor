import assert from "node:assert/strict";
import test from "node:test";

import { buildQuestionBankFilter } from "@/components/space/question-bank/useQuestionBank";

test("the unresolved view combines wrong answers with review state", () => {
  const filter = buildQuestionBankFilter(
    { kind: "category", categoryId: 3 },
    {
      source: "mastery_path",
      materialId: "path-1",
      scoreTrend: "declined",
      reviewStatus: "unresolved",
      textbookNode: "b1-4.3",
      questionType: "single_choice",
      difficulty: "hard",
      pdfSourceId: "document-id",
    },
    "equation",
    "oldest",
  );

  assert.deepEqual(filter, {
    category_id: 3,
    uncategorized: undefined,
    bookmarked: undefined,
    mistakes_only: true,
    source: "mastery_path",
    material_id: "path-1",
    resolved: false,
    score_trend: "declined",
    textbook_section_id: "b1-4.3",
    textbook_unassigned: undefined,
    question_type: "single_choice",
    difficulty: "hard",
    pdf_source_id: "document-id",
    search: "equation",
    sort: "oldest",
    limit: 60,
  });
});

test("review filters preserve the selected source and material", () => {
  const filter = buildQuestionBankFilter(
    { kind: "all" },
    { source: "book", materialId: "book-1", scoreTrend: "" },
    "",
    "recent",
  );

  assert.equal(filter.source, "book");
  assert.equal(filter.material_id, "book-1");
});
