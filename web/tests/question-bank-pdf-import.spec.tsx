import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import QuestionBankPdfImport from "@/components/space/question-bank/QuestionBankPdfImport";
import { initI18n } from "@/i18n/init";
import type { PdfImportBatch, PdfImportQuestion } from "@/lib/question-bank-pdf-api";

vi.mock("@/components/space/question-bank/PdfImportPreview", () => ({
  default: ({ page }: { page: number }) => <span>{`Preview page ${page}`}</span>,
}));

initI18n("en");

function question(id: string, page: number): PdfImportQuestion {
  return {
    id, page, end_page: page, number: id, question: `Question ${id}`, correct_answer: "42",
    question_type: "short_answer", options: {}, explanation: "", difficulty: "", tags: [],
    textbook_section_id: "", approved: false, status: "pending", entry_id: null,
  };
}

it("commits only reviewed questions and keeps the rest available for editing", async () => {
  const first = question("1", 1);
  const second = question("2", 3);
  const draft: PdfImportBatch = {
    id: "source", created_at: 1, page_count: 4, filename: "paper.pdf", status: "draft",
    warnings: [], result: null, questions: [first, second], revision: 1,
  };
  const imported: PdfImportBatch = {
    ...draft, questions: [{ ...first, approved: true, status: "imported", entry_id: 12 }, second],
    result: { imported: 1, duplicates: 0, total: 1 }, revision: 2,
  };
  const send = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path.endsWith("/curriculum")) return Response.json({ edition: "", volumes: [] });
    if (path.endsWith("/commit")) return Response.json(imported);
    if (options?.method === "PUT") return Response.json({ ...imported, revision: 3 });
    return Response.json(options?.method === "POST" ? draft : []);
  });
  const onImported = vi.fn();
  render(<QuestionBankPdfImport onImported={onImported} />);
  fireEvent.change(screen.getByLabelText("Choose PDF"), {
    target: { files: [new File(["test"], "paper.pdf", { type: "application/pdf" })] },
  });

  expect(await screen.findByText("Preview page 1")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Import approved questions (0)" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Approve question" }));
  expect(send.mock.calls.some(([url]) => String(url).includes("/commit"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Import approved questions (1)" }));

  expect(await screen.findByText("Imported 1 questions; skipped 0 duplicates.")).toBeInTheDocument();
  expect(onImported).toHaveBeenCalledTimes(1);
  const commitRequest = send.mock.calls.find(([url]) => String(url).includes("/commit"))?.[1];
  const commitBody = JSON.parse(String(commitRequest?.body));
  expect(commitBody.questions.filter((row: PdfImportQuestion) => row.approved).map((row: PdfImportQuestion) => row.id)).toEqual([first.id]);
  expect(commitBody.revision).toBe(1);
  expect(screen.getByText("Preview page 3")).toBeInTheDocument();
  expect(screen.getByDisplayValue("Question 2")).toBeEnabled();

  fireEvent.change(screen.getByLabelText("Correct answer"), { target: { value: "43" } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(await screen.findByText("PDF draft saved.")).toBeInTheDocument();
  const saveRequest = send.mock.calls.find(([, options]) => options?.method === "PUT")?.[1];
  const saveBody = JSON.parse(String(saveRequest?.body));
  expect(saveBody.questions).toHaveLength(1);
  expect(saveBody.questions[0]).toMatchObject({ id: second.id, correct_answer: "43", approved: false });
});
