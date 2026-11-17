"""Scoped PDF imports and original-source access for the question bank."""

from __future__ import annotations

from typing import Annotated, Literal

from anyio import CapacityLimiter, to_thread
from fastapi import APIRouter, BackgroundTasks, File, HTTPException, Path, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, StringConstraints

from deeptutor.services.practice.importing import MAX_CELL, MAX_ROWS
from deeptutor.services.practice.pdf_import import MAX_PDF_BYTES, PdfImportConflict, PdfImportStore
from deeptutor.services.session import get_sqlite_session_store

router = APIRouter()
_extraction_limiter = CapacityLimiter(1)

ImportId = Annotated[str, Path(pattern=r"^[a-f0-9]{32}$")]
Cell = Annotated[str, StringConstraints(max_length=MAX_CELL)]
Tag = Annotated[str, StringConstraints(max_length=100)]
QuestionType = Literal["single_choice", "multi_choice", "true_false", "fill_blank", "short_answer"]


class DraftQuestion(BaseModel):
    id: str = Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")
    page: int = Field(ge=1)
    end_page: int = Field(ge=1)
    number: str = Field(default="", max_length=80)
    question: Cell = ""
    correct_answer: Cell = ""
    question_type: QuestionType = "short_answer"
    options: dict[str, Cell] = Field(default_factory=dict, max_length=10)
    explanation: Cell = ""
    difficulty: str = Field(default="", max_length=100)
    tags: list[Tag] = Field(default_factory=list, max_length=20)
    textbook_section_id: str = Field(default="", max_length=80)
    approved: bool = False


class ReviewedQuestion(DraftQuestion):
    status: Literal["pending", "imported", "duplicate"]
    entry_id: int | None


class PdfReview(BaseModel):
    questions: list[DraftQuestion] = Field(max_length=MAX_ROWS)
    revision: int | None = Field(default=None, ge=0)


class ImportResult(BaseModel):
    imported: int
    duplicates: int
    total: int


class PdfImportSummary(BaseModel):
    id: str
    filename: str
    page_count: int
    created_at: float
    status: Literal["processing", "draft", "imported"]
    revision: int
    warnings: list[str]
    result: ImportResult | None


class PdfImportDetail(PdfImportSummary):
    questions: list[ReviewedQuestion]


def _store() -> PdfImportStore:
    return PdfImportStore(get_sqlite_session_store().db_path)


async def _extract_pdf(store: PdfImportStore, source_id: str) -> None:
    # Queue scans without occupying the threads that serve review requests.
    await to_thread.run_sync(store.extract, source_id, limiter=_extraction_limiter)


@router.get("", response_model=list[PdfImportSummary])
def list_pdf_imports():
    return _store().list_imports()


@router.post("", response_model=PdfImportDetail, status_code=202)
async def upload_pdf(background: BackgroundTasks, file: UploadFile = File(...)):
    from starlette.concurrency import run_in_threadpool

    try:
        data = await file.read(MAX_PDF_BYTES + 1)
        if len(data) > MAX_PDF_BYTES:
            raise HTTPException(413, "Choose a PDF up to 50 MiB")
        store = _store()
        draft = await run_in_threadpool(store.create, file.filename or "", data)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    finally:
        await file.close()
    background.add_task(_extract_pdf, store, draft["id"])
    return draft


@router.get("/{source_id}", response_model=PdfImportDetail)
def read_pdf_import(source_id: ImportId):
    try:
        return _store().get(source_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/{source_id}/source", response_class=FileResponse)
def read_pdf_source(source_id: ImportId):
    try:
        source, filename = _store().source_path(source_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    return FileResponse(
        source,
        filename=filename,
        media_type="application/pdf",
        content_disposition_type="inline",
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
        },
    )


def _save(source_id: str, data: PdfReview, *, commit: bool):
    try:
        return _store().save(
            source_id,
            [question.model_dump() for question in data.questions],
            data.revision,
            commit=commit,
        )
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except PdfImportConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.put("/{source_id}", response_model=PdfImportDetail)
def save_pdf_review(source_id: ImportId, data: PdfReview):
    return _save(source_id, data, commit=False)


@router.post("/{source_id}/commit", response_model=PdfImportDetail)
def commit_pdf_review(source_id: ImportId, data: PdfReview):
    return _save(source_id, data, commit=True)
