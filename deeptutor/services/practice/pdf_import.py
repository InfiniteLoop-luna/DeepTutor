"""Reviewable PDF intake for the scoped practice question bank."""

from __future__ import annotations

import json
import logging
from pathlib import Path, PureWindowsPath
import re
import sqlite3
import time
import uuid

from .importing import MAX_CELL, MAX_ROWS, normalize_question
from .storage import PracticeStore

MAX_PDF_BYTES = 50 * 1024 * 1024
MAX_PDF_PAGES = 250
MAX_OCR_PAGES = 50
_PROCESSING_TIMEOUT = 12 * 60
_EXTRACTION_BUDGET = 8 * 60
_PAGE_TEXT_LIMIT = 40_000
_HEADING = re.compile(
    r"^(?P<name>[【\[]?(?:例题|例|练习|变式|真题)\s*[1-9]\d{0,2}\s*[】\]]?)[.．、:：]?\s*"
    r"|^(?P<number>[1-9]\d{0,2})[.．、)）]\s*(?=[^\d\s]|$)"
)
_EXAM_REFERENCE = re.compile(
    r"^(?:(?P<number>[1-9]\d{0,2})[.．、)）]\s*)?20\d{2}.*?第\s*(?P<exam_number>\d{1,3})\s*题"
)
_EXERCISE_LABEL = re.compile(r"^(?:真题|经典|强化|基础|课后)?练习$")
_THEORY_LABEL = re.compile(r"^(?:知识梳理|知识回顾|基础知识|知识精讲|对数概念及其运算)$")
_THEORY_ITEM = re.compile(r"^(?:零点定义|零点存在定理)(?:\s|$)")
_SECTION_DIVIDER = re.compile(r"^(?:PART|目录)(?:\s+\d{1,3})?$", re.IGNORECASE)
_TEXTBOOK_HINTS = (
    (re.compile(r"^(?:换底公式|对数的运算)\s*(?:进阶|基础|提高|综合)?$"), "b1-4.3.2"),
    (re.compile(r"^.*函数(?:的)?零点(?:与方程的解|个数问题)?$"), "b1-4.5.1"),
    (re.compile(r"^(?:指对应用大题|指数应用题|对数应用题|函数模型的应用)$"), "b1-4.5.3"),
)
_ANSWER = re.compile(
    r"^\s*(?:[【\[]?(?:参考)?答案[】\]]?(?:\s*[:：]\s*|\s+(?=\S))|[【\[]答案[】\]]\s*)"
)
_EXPLANATION = re.compile(
    r"^\s*(?:[【\[]?(?:解析|解答)[】\]]?(?:\s*[:：]\s*|\s+(?=\S))|[【\[](?:解析|解答)[】\]]\s*)"
)
_OPTIONS = re.compile(r"(?<!\w)([A-J])[.．、]\s*(?=\S)")
_FOOTER = re.compile(r"^\s*(?:第\s*)?\d{1,3}\s*(?:/\s*\d{1,3}|页)?\s*$")
_logger = logging.getLogger(__name__)


class PdfImportConflict(ValueError):
    """The draft revision or state no longer accepts this update."""


def pdf_filename(filename: str) -> str:
    name = PureWindowsPath(filename).name
    if not name.lower().endswith(".pdf"):
        raise ValueError("Choose a PDF file")
    if any(ord(char) < 32 for char in name):
        raise ValueError("The PDF filename contains a control character")
    return name[:-4][:236] + ".pdf"


def pdf_page_count(data: bytes) -> int:
    import pymupdf

    if not data or len(data) > MAX_PDF_BYTES:
        raise ValueError("Choose a non-empty PDF up to 50 MiB")
    if b"%PDF-" not in data[:1024]:
        raise ValueError("The file is not a PDF")
    try:
        with pymupdf.open(stream=data, filetype="pdf") as document:
            if document.needs_pass:
                raise ValueError("Unlock the PDF before importing")
            pages = len(document)
    except (pymupdf.FileDataError, RuntimeError) as exc:
        raise ValueError("The PDF could not be opened") from exc
    if not 1 <= pages <= MAX_PDF_PAGES:
        raise ValueError(f"Choose a PDF with 1–{MAX_PDF_PAGES} pages")
    return pages


def _ocr_rows(page, engine) -> str:
    import pymupdf

    # Limit raster size even for PDFs with an unusually large page box.
    dimension = max(page.rect.width, page.rect.height)
    scale = min(160 / 72, 1800 / dimension) if dimension > 0 else 1
    raster = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
    result, _ = engine(raster.tobytes("png"))
    return "\n".join(row[1] for row in (result or []))


def extract_pdf_draft(path: Path) -> tuple[list[dict], list[str]]:
    """Extract numbered candidates. The original page always remains the authority."""
    import pymupdf

    question_blocks = []
    current = None
    pages_without_text = 0
    engine = None
    ocr_enabled = True
    ocr_pages = 0
    budget_end = time.monotonic() + _EXTRACTION_BUDGET
    warnings = []
    with pymupdf.open(path) as document:
        for page_index, page in enumerate(document, 1):
            page_text = page.get_text(sort=True)[:_PAGE_TEXT_LIMIT]
            if not page_text.strip() and ocr_enabled and ocr_pages < MAX_OCR_PAGES:
                if time.monotonic() >= budget_end:
                    ocr_enabled = False
                else:
                    try:
                        if engine is None:
                            from rapidocr_onnxruntime import RapidOCR

                            engine = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1)
                        page_text = _ocr_rows(page, engine)[:_PAGE_TEXT_LIMIT]
                        ocr_pages += 1
                    except Exception:
                        _logger.warning(
                            "Local OCR could not read a practice PDF page", exc_info=True
                        )
                        ocr_enabled = False
            if not page_text.strip():
                pages_without_text += 1
                # A blank OCR result is not evidence of a cross-page continuation.
                current = None
                continue
            lines = [line.strip() for line in page_text.splitlines() if line.strip()]
            section_id = next(
                (
                    section
                    for line in lines[:10]
                    for pattern, section in _TEXTBOOK_HINTS
                    if pattern.fullmatch(line)
                ),
                "",
            )
            exercise_page = any(_EXERCISE_LABEL.fullmatch(line) for line in lines[:10])
            theory_page = not exercise_page and any(
                _THEORY_LABEL.fullmatch(line) for line in lines[:10]
            )
            if (
                exercise_page
                or theory_page
                or section_id
                or any(_SECTION_DIVIDER.fullmatch(line) for line in lines[:10])
            ):
                current = None
            for line in lines:
                if _FOOTER.fullmatch(line):
                    continue
                heading = _HEADING.match(line)
                reference = _EXAM_REFERENCE.match(line)
                if heading and not exercise_page and _THEORY_ITEM.match(line[heading.end() :]):
                    current = None
                    continue
                if (
                    reference
                    and not reference["number"]
                    and current
                    and current["page"] == page_index
                    and not any(current["lines"])
                ):
                    # Scans may put the printed number and exam attribution on separate lines.
                    continue
                if heading and theory_page and not heading["name"]:
                    heading = None
                if reference or heading:
                    if len(question_blocks) >= MAX_ROWS:
                        warnings.append("Only the first 500 numbered candidates were extracted.")
                        break
                    number = (
                        (reference["number"] or reference["exam_number"])
                        if reference
                        else (heading["name"] or heading["number"]).strip("【】[]")
                    )
                    current = {
                        "number": number,
                        "page": page_index,
                        "end_page": page_index,
                        "lines": [] if reference else [line[heading.end() :].strip()],
                        "textbook_section_id": section_id,
                    }
                    question_blocks.append(current)
                elif current is not None and page_index - current["page"] <= 1:
                    current["lines"].append(line)
                    current["end_page"] = page_index
            else:
                continue
            break
    if ocr_pages:
        warnings.append(
            "Local OCR was used. Check symbols, diagrams, and page ranges against the PDF."
        )
    if pages_without_text:
        warnings.append(
            f"{pages_without_text} page(s) yielded no text. Add missing questions from the source."
        )
    questions = [candidate for block in question_blocks if (candidate := _candidate(block))]
    if not questions:
        warnings.append(
            "No numbered questions were detected. Add questions from the source manually."
        )
    return questions, warnings


def _candidate(block: dict) -> dict | None:
    fields: dict[str, list[str]] = {"question": [], "correct_answer": [], "explanation": []}
    field = "question"
    for line in block["lines"]:
        field_match = _ANSWER.match(line)
        if field_match:
            field = "correct_answer"
            line = line[field_match.end() :]
        else:
            field_match = _EXPLANATION.match(line)
            if field_match:
                field = "explanation"
                line = line[field_match.end() :]
        fields[field].append(line)
    stem, answer, explanation = ("\n".join(lines)[:MAX_CELL].strip() for lines in fields.values())
    if not stem:
        return None
    choices = list(_OPTIONS.finditer(stem))
    options = {}
    letters = sorted(item[1] for item in choices)
    if 2 <= len(letters) <= 10 and letters == list("ABCDEFGHIJ"[: len(letters)]):
        options = {
            item[1]: stem[item.end() : next_item.start() if next_item else len(stem)].strip()
            for item, next_item in zip(choices, [*choices[1:], None], strict=True)
        }
        stem = stem[: choices[0].start()].strip()
    if not stem:
        return None
    return {
        "id": uuid.uuid4().hex,
        "number": block["number"],
        "page": block["page"],
        "end_page": block["end_page"],
        "question": stem,
        "question_type": "single_choice" if options else "short_answer",
        "correct_answer": answer,
        "options": options,
        "explanation": explanation,
        "difficulty": "",
        "tags": [],
        "textbook_section_id": block["textbook_section_id"],
        "approved": False,
        "status": "pending",
        "entry_id": None,
    }


def pdf_sources_for_entries(
    conn: sqlite3.Connection, entry_ids: list[int]
) -> dict[int, list[dict]]:
    if (
        not entry_ids
        or not conn.execute(
            "SELECT 1 FROM sqlite_master WHERE name='practice_pdf_sources'"
        ).fetchone()
    ):
        return {}
    placeholders = ",".join("?" for _ in entry_ids)
    rows = conn.execute(
        f"""SELECT s.entry_id, s.document_id, d.filename, s.page, s.end_page, s.number
            FROM practice_pdf_sources s JOIN practice_pdf_imports d ON d.id=s.document_id
            WHERE s.entry_id IN ({placeholders})
            ORDER BY s.document_id, s.page, s.end_page, s.number""",  # nosec B608 - placeholders only
        entry_ids,
    )
    result: dict[int, list[dict]] = {}
    for row in rows:
        entry_id, document_id, filename, page, end_page, number = row
        result.setdefault(entry_id, []).append(
            dict(
                document_id=document_id,
                filename=filename,
                page=page,
                end_page=end_page,
                number=number,
            )
        )
    return result


def initialize_pdf_imports(conn: sqlite3.Connection) -> None:
    conn.executescript("""
                CREATE TABLE IF NOT EXISTS practice_pdf_imports (
                    id TEXT PRIMARY KEY,
                    filename TEXT NOT NULL,
                    page_count INTEGER NOT NULL,
                    created_at REAL NOT NULL,
                    status TEXT NOT NULL,
                    revision INTEGER NOT NULL DEFAULT 0,
                    warnings_json TEXT NOT NULL DEFAULT '[]',
                    questions_json TEXT NOT NULL DEFAULT '[]',
                    result_json TEXT
                );
                CREATE TABLE IF NOT EXISTS practice_pdf_sources (
                    entry_id INTEGER NOT NULL REFERENCES notebook_entries(id) ON DELETE CASCADE,
                    document_id TEXT NOT NULL REFERENCES practice_pdf_imports(id) ON DELETE CASCADE,
                    page INTEGER NOT NULL,
                    end_page INTEGER NOT NULL,
                    number TEXT NOT NULL,
                    PRIMARY KEY (entry_id, document_id, page, end_page, number)
                );
                CREATE INDEX IF NOT EXISTS idx_practice_pdf_document
                    ON practice_pdf_sources(document_id, entry_id);
            """)


class PdfImportStore(PracticeStore):
    @property
    def source_directory(self) -> Path:
        return self.db_path.with_name(self.db_path.name + "-pdf-imports")

    def create(self, filename: str, data: bytes) -> dict:
        filename = pdf_filename(filename)
        page_count = pdf_page_count(data)
        source_id = uuid.uuid4().hex
        self.source_directory.mkdir(parents=True, exist_ok=True)
        source = self.source_directory / (source_id + ".pdf")
        try:
            with source.open("xb") as file:
                file.write(data)
            with self.connect() as conn:
                conn.execute(
                    """INSERT INTO practice_pdf_imports(id, filename, page_count, created_at, status)
                    VALUES (?, ?, ?, ?, 'processing')""",
                    (source_id, filename, page_count, time.time()),
                )
        except Exception:
            source.unlink(missing_ok=True)
            raise
        return self.get(source_id)

    def extract(self, source_id: str) -> None:
        if self.get(source_id)["status"] != "processing":
            return
        try:
            questions, warnings = extract_pdf_draft(self.source_path(source_id)[0])
        except Exception:
            _logger.warning("Practice PDF candidate extraction failed", exc_info=True)
            questions, warnings = [], ["Extraction failed. Add questions from the original PDF."]
        with self.connect() as conn:
            conn.execute(
                """UPDATE practice_pdf_imports SET status='draft', revision=revision+1,
                       warnings_json=?, questions_json=? WHERE id=? AND status='processing'""",
                (
                    json.dumps(warnings, ensure_ascii=False),
                    json.dumps(questions, ensure_ascii=False),
                    source_id,
                ),
            )

    def _finish_interrupted(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            """UPDATE practice_pdf_imports SET status='draft', revision=revision+1,
                   warnings_json=? WHERE status='processing' AND created_at < ?""",
            (
                json.dumps(["Extraction was interrupted. Add questions from the original PDF."]),
                time.time() - _PROCESSING_TIMEOUT,
            ),
        )

    @staticmethod
    def _serialize(row: sqlite3.Row, *, include_questions: bool) -> dict:
        data = dict(row)
        data["warnings"] = json.loads(data.pop("warnings_json"))
        data["result"] = json.loads(data.pop("result_json") or "null")
        if include_questions:
            data["questions"] = json.loads(data.pop("questions_json"))
        return data

    def list_imports(self) -> list[dict]:
        with self.connect() as conn:
            self._finish_interrupted(conn)
            rows = conn.execute(
                """SELECT id, filename, page_count, created_at, status, revision, warnings_json, result_json
                   FROM practice_pdf_imports ORDER BY created_at DESC"""
            ).fetchall()
        return [self._serialize(row, include_questions=False) for row in rows]

    def _get(self, conn: sqlite3.Connection, source_id: str) -> dict:
        row = conn.execute("SELECT * FROM practice_pdf_imports WHERE id=?", (source_id,)).fetchone()
        if not row:
            raise LookupError("PDF import not found")
        return self._serialize(row, include_questions=True)

    def get(self, source_id: str) -> dict:
        with self.connect() as conn:
            self._finish_interrupted(conn)
            return self._get(conn, source_id)

    def source_path(self, source_id: str) -> tuple[Path, str]:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT filename FROM practice_pdf_imports WHERE id=?", (source_id,)
            ).fetchone()
        if not row:
            raise LookupError("PDF import not found")
        source = self.source_directory / (source_id + ".pdf")
        if not source.is_file():
            raise LookupError("The original PDF is unavailable")
        return source, row["filename"]

    def save(
        self, source_id: str, questions: list[dict], revision: int | None, *, commit: bool
    ) -> dict:
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self._finish_interrupted(conn)
            document = self._get(conn, source_id)
            if document["status"] == "processing":
                raise PdfImportConflict("PDF extraction is still running")
            recorded = {
                row["id"]: row for row in document["questions"] if row["status"] != "pending"
            }
            pending = [row for row in questions if row["id"] not in recorded]
            if (
                commit
                and not pending
                and any(row["id"] in recorded and row["approved"] for row in questions)
            ):
                # A repeat of a commit already processed does not re-import the same rows.
                return document
            if revision is not None and revision != document["revision"]:
                raise PdfImportConflict("PDF review changed. Reload the draft and try again.")
            if document["status"] == "imported":
                raise PdfImportConflict("This PDF review is complete")
            if len(pending) + len(recorded) > MAX_ROWS:
                raise ValueError(f"Review at most {MAX_ROWS} questions per PDF")
            self._validate_pages(pending, document["page_count"])
            if commit:
                self._commit_pdf_rows(conn, document, pending)
            updated = [*recorded.values(), *pending]
            imported = sum(item["status"] == "imported" for item in updated)
            duplicates = sum(item["status"] == "duplicate" for item in updated)
            result = {
                "imported": imported,
                "duplicates": duplicates,
                "total": imported + duplicates,
            }
            status = (
                "imported"
                if result["total"] and all(item["status"] != "pending" for item in updated)
                else "draft"
            )
            conn.execute(
                """UPDATE practice_pdf_imports SET status=?, revision=revision+1,
                       questions_json=?, result_json=? WHERE id=?""",
                (
                    status,
                    json.dumps(updated, ensure_ascii=False),
                    json.dumps(result) if result["total"] else None,
                    source_id,
                ),
            )
            return self._get(conn, source_id)

    @staticmethod
    def _validate_pages(questions: list[dict], page_count: int) -> None:
        ids = {row["id"] for row in questions}
        if len(ids) != len(questions):
            raise ValueError("Draft question IDs must be unique")
        for row in questions:
            if not 1 <= row["page"] <= row["end_page"] <= page_count:
                raise ValueError(
                    f"Question {row['number'] or row['id']} has an invalid source page range"
                )
            row.update(status="pending", entry_id=None)

    def _commit_pdf_rows(
        self, conn: sqlite3.Connection, document: dict, pending: list[dict]
    ) -> None:
        approved = [row for row in pending if row["approved"]]
        if not approved:
            raise ValueError("Approve at least one question to import")
        normalized = []
        for row in approved:
            try:
                normalized.append(normalize_question(row))
            except ValueError as exc:
                raise ValueError(
                    f"Page {row['page']}, question {row['number'] or row['id']}: {exc}"
                ) from exc
        outcomes = self._apply_import(
            conn,
            normalized,
            document["filename"],
            "bank",
            "pdf:" + document["id"],
            time.time(),
        )
        for row, (entry_id, created) in zip(approved, outcomes, strict=True):
            conn.execute(
                """INSERT OR IGNORE INTO practice_pdf_sources(entry_id, document_id, page, end_page, number)
                   VALUES(?, ?, ?, ?, ?)""",
                (entry_id, document["id"], row["page"], row["end_page"], row["number"]),
            )
            row.update(status="imported" if created else "duplicate", entry_id=entry_id)
