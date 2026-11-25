"""Generate illustrated solutions and play lessons in the current workspace."""

from __future__ import annotations

import asyncio
from hashlib import sha256
from io import BytesIO
import logging
import re
import sqlite3
from typing import Annotated, Literal

from fastapi import (
    APIRouter,
    BackgroundTasks,
    File,
    Form,
    Header,
    HTTPException,
    Path,
    Response,
    UploadFile,
)
from starlette.concurrency import run_in_threadpool

from deeptutor.agents.video_lesson.narration import narrate
from deeptutor.agents.video_lesson.question_lesson_store import (
    LessonChanged,
    QuestionLessonStore,
    VoiceJob,
)
from deeptutor.agents.video_lesson.question_solution import (
    SolutionInvalid,
    SolutionNeedsDetails,
    SolutionNeedsVision,
    generate_solution,
)
from deeptutor.agents.video_lesson.question_storyboard import (
    build_storyboard,
    can_create_lesson,
    needs_figure,
    source_digest,
)
from deeptutor.services.llm import LLMConfigError, LLMError, LLMTimeoutError
from deeptutor.services.practice.pdf_import import PdfImportStore
from deeptutor.services.session import get_sqlite_session_store

router = APIRouter()
logger = logging.getLogger(__name__)
Token = Annotated[str, Path(pattern=r"^[a-f0-9]{32}$")]
SceneId = Annotated[str, Path(pattern=r"^s[1-9]\d{0,3}$")]
BeatId = Annotated[str, Path(pattern=r"^s[1-9]\d{0,3}-[1-9]$")]
MAX_FIGURE_BYTES = 8 * 1024 * 1024
MAX_QUESTION_CHARS = 20_000
_SOLVE_WORKERS = asyncio.Semaphore(2)
_VOICE_WORKERS = asyncio.Semaphore(2)


async def _question(entry_id: int) -> tuple[QuestionLessonStore, dict]:
    sessions = get_sqlite_session_store()
    store = QuestionLessonStore(sessions.db_path)
    if not await asyncio.to_thread(store.is_visible, entry_id):
        raise HTTPException(404, "Question not found")
    entry = await sessions.get_notebook_entry(entry_id)
    if entry is None:
        raise HTTPException(404, "Question not found")
    return store, entry


async def _view(store: QuestionLessonStore, entry: dict) -> dict:
    lesson, stale = await asyncio.to_thread(store.get, entry["id"], source_digest(entry))
    return {
        "lesson": lesson,
        "stale": stale,
        "has_explanation": can_create_lesson(entry),
        "needs_figure": needs_figure(entry) and not (lesson and lesson["has_figure"]),
        "pdf_sources": entry.get("pdf_sources") or [],
    }


async def _record(store: QuestionLessonStore, entry_id: int, version: str, job: VoiceJob) -> None:
    clips = {}
    try:
        async with asyncio.timeout(240), _VOICE_WORKERS:
            clips = await narrate(job.lines, job.language)
    except Exception:
        logger.warning("Question lesson narration fell back to captions", exc_info=True)
    finally:
        await asyncio.to_thread(store.finish, entry_id, version, job, clips)


async def _schedule(
    background: BackgroundTasks,
    store: QuestionLessonStore,
    entry: dict,
    version: str,
    scene_id: str | None = None,
) -> dict:
    try:
        job = await asyncio.to_thread(
            store.claim, entry["id"], source_digest(entry), version, scene_id
        )
    except LessonChanged as exc:
        raise HTTPException(409, "lesson_changed") from exc
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    if job:
        background.add_task(_record, store, entry["id"], version, job)
    return await _view(store, entry)


def _normalized_figure(data: bytes) -> bytes:
    from PIL import Image, ImageOps, UnidentifiedImageError

    try:
        with Image.open(BytesIO(data)) as image:
            if (
                image.format not in {"JPEG", "PNG", "WEBP"}
                or image.width * image.height > 24_000_000
            ):
                raise ValueError("invalid_figure")
            corrected = ImageOps.exif_transpose(image)
            corrected.thumbnail((1600, 1600))
            layer = corrected.convert("RGBA")
            paper = Image.new("RGB", layer.size, "white")
            paper.paste(layer, mask=layer.getchannel("A"))
            output = BytesIO()
            paper.save(output, format="JPEG", quality=92)
            return output.getvalue()
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
        raise ValueError("invalid_figure") from exc


def _original_page(store: QuestionLessonStore, source: dict) -> bytes | None:
    try:
        import pymupdf

        pdf, _ = PdfImportStore(store.db_path).source_path(source["document_id"])
        with pymupdf.open(pdf) as document:
            page = document[source["page"] - 1]
            scale = 1600 / max(page.rect.width, page.rect.height)
            return page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False).tobytes("jpeg")
    except (ImportError, OSError, LookupError, RuntimeError, ValueError, sqlite3.Error):
        return None


async def _read_figure(figure: UploadFile | None) -> bytes | None:
    if figure is None:
        return None
    try:
        raw = await figure.read(MAX_FIGURE_BYTES + 1)
        if len(raw) > MAX_FIGURE_BYTES:
            raise HTTPException(413, "figure_too_large")
        return await run_in_threadpool(_normalized_figure, raw)
    except ValueError as exc:
        raise HTTPException(422, "invalid_figure") from exc
    finally:
        await figure.close()


async def _lesson_figure(
    store: QuestionLessonStore,
    entry: dict,
    existing: dict | None,
    figure: UploadFile | None,
    use_original: bool,
) -> tuple[bytes | None, int | None]:
    if figure is not None:
        return await _read_figure(figure), None
    if use_original:
        sources = entry.get("pdf_sources") or []
        if len(sources) == 1 and sources[0]["page"] == sources[0]["end_page"]:
            data = await asyncio.to_thread(_original_page, store, sources[0])
            if data:
                return data, sources[0]["page"]
        if not (existing and existing["has_figure"]):
            raise HTTPException(422, "original_figure_unavailable")
    if existing and existing["has_figure"]:
        data = await asyncio.to_thread(store.figure, entry["id"], existing["version"])
        return data, existing.get("figure_page")
    return None, None


async def _solve(entry: dict, language: str, figure: bytes | None) -> dict:
    question = entry["question"].strip()
    if not question or len(question) > MAX_QUESTION_CHARS:
        raise HTTPException(422, "invalid_question_text")
    if needs_figure(entry) and not figure:
        raise HTTPException(422, "figure_required")
    try:
        async with asyncio.timeout(180), _SOLVE_WORKERS:
            return await generate_solution(entry, language, figure)
    except SolutionNeedsDetails as exc:
        raise HTTPException(422, str(exc)) from exc
    except SolutionNeedsVision as exc:
        raise HTTPException(422, "solution_needs_vision") from exc
    except SolutionInvalid as exc:
        raise HTTPException(502, "solution_invalid") from exc
    except (TimeoutError, LLMTimeoutError) as exc:
        raise HTTPException(504, "solution_timed_out") from exc
    except LLMConfigError as exc:
        raise HTTPException(503, "solution_model_unconfigured") from exc
    except LLMError as exc:
        logger.warning("Question solution model request failed (%s)", type(exc).__name__)
        raise HTTPException(502, "solution_model_failed") from exc


@router.post("/solve")
async def solve_pasted_question(
    question: str = Form(max_length=MAX_QUESTION_CHARS),
    language: Literal["zh", "en"] = Form("zh"),
    figure: UploadFile | None = File(None),
):
    """Give pasted questions an ordinary notebook entry once a solution is ready."""
    sessions = get_sqlite_session_store()
    store = QuestionLessonStore(sessions.db_path)
    question = question.strip()
    figure_data = await _read_figure(figure)
    key = sha256(question.encode() + b"\0" + (figure_data or b"")).hexdigest()
    origin, ref = "external_import", "manual:ai-solution"
    entry = await sessions.find_notebook_entry_by_origin(origin, ref, key)
    if entry:
        view = await _view(store, entry)
        if view["lesson"]:
            return view

    board = await _solve({"question": question}, language, figure_data)
    if entry is None:
        await sessions.upsert_notebook_entries(
            None,
            [
                {
                    "origin_type": origin,
                    "origin_ref": ref,
                    "question_id": key,
                    "question": question,
                    "question_type": "short_answer",
                    "source": "import",
                    "result": "ungraded",
                    "attempt_count": 0,
                }
            ],
        )
        entry = await sessions.find_notebook_entry_by_origin(origin, ref, key)
        if entry is None:
            raise HTTPException(500, "question_save_failed")
    try:
        await asyncio.to_thread(
            store.prepare, entry["id"], source_digest(entry), board, figure_data
        )
    except sqlite3.IntegrityError as exc:
        raise HTTPException(409, "lesson_changed") from exc
    return await _view(store, entry)


@router.get("/{entry_id}")
async def get_question_lesson(entry_id: int):
    store, entry = await _question(entry_id)
    return await _view(store, entry)


@router.post("/{entry_id}/solve")
async def solve_question_lesson(
    entry_id: int,
    language: Literal["zh", "en"] = Form("zh"),
    use_original: bool = Form(False),
    figure: UploadFile | None = File(None),
):
    store, entry = await _question(entry_id)
    digest = source_digest(entry)
    existing, _ = await asyncio.to_thread(store.get, entry_id, digest)
    figure_data, figure_page = await _lesson_figure(store, entry, existing, figure, use_original)
    board = await _solve(entry, language, figure_data)
    board["figure_page"] = figure_page
    _, current = await _question(entry_id)
    if source_digest(current) != digest:
        raise HTTPException(409, "lesson_changed")
    try:
        await asyncio.to_thread(
            store.prepare,
            entry_id,
            digest,
            board,
            figure_data,
            replace_version=existing["version"] if existing else None,
        )
    except (LessonChanged, sqlite3.IntegrityError) as exc:
        raise HTTPException(409, "lesson_changed") from exc
    return await _view(store, current)


@router.post("/{entry_id}", status_code=202)
async def create_question_lesson(
    entry_id: int,
    background: BackgroundTasks,
    language: Literal["zh", "en"] = Form("zh"),
    use_original: bool = Form(False),
    figure: UploadFile | None = File(None),
):
    store, entry = await _question(entry_id)
    if not can_create_lesson(entry):
        raise HTTPException(422, "explanation_required")
    digest = source_digest(entry)
    existing, _ = await asyncio.to_thread(store.get, entry_id, digest)
    figure_data, figure_page = await _lesson_figure(store, entry, existing, figure, use_original)
    if needs_figure(entry) and not figure_data:
        raise HTTPException(422, "figure_required")
    board = build_storyboard(entry, language)
    board["figure_page"] = figure_page
    version = await asyncio.to_thread(store.prepare, entry_id, digest, board, figure_data)
    return await _schedule(background, store, entry, version)


@router.post("/{entry_id}/{version}/narration", status_code=202)
async def start_question_lesson_narration(
    entry_id: int, version: Token, background: BackgroundTasks
):
    store, entry = await _question(entry_id)
    return await _schedule(background, store, entry, version)


@router.post("/{entry_id}/{version}/scenes/{scene_id}/narration", status_code=202)
async def retry_question_lesson_scene(
    entry_id: int, version: Token, scene_id: SceneId, background: BackgroundTasks
):
    store, entry = await _question(entry_id)
    return await _schedule(background, store, entry, version, scene_id)


async def _current(entry_id: int, version: str) -> QuestionLessonStore:
    store, entry = await _question(entry_id)
    if not await asyncio.to_thread(store.has_current, entry_id, source_digest(entry), version):
        raise HTTPException(404, "Question lesson not found")
    return store


def _audio_response(data: bytes, byte_range: str | None) -> Response:
    headers = {"Cache-Control": "private, no-store", "Accept-Ranges": "bytes"}
    match = re.fullmatch(r"bytes=(\d{0,20})-(\d{0,20})", byte_range or "")
    if not match or not any(match.groups()):
        return Response(data, media_type="audio/mpeg", headers=headers)
    first, last = match.groups()
    size = len(data)
    start = int(first) if first else max(0, size - int(last))
    end = min(int(last), size - 1) if first and last else size - 1
    if start > end:
        return Response(status_code=416, headers={**headers, "Content-Range": f"bytes */{size}"})
    headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return Response(
        data[start : end + 1], status_code=206, media_type="audio/mpeg", headers=headers
    )


@router.get("/{entry_id}/{version}/audio/{beat_id}/{recording}")
async def get_question_lesson_audio(
    entry_id: int,
    version: Token,
    beat_id: BeatId,
    recording: Token,
    byte_range: Annotated[str | None, Header(alias="Range")] = None,
):
    store = await _current(entry_id, version)
    data = await asyncio.to_thread(store.audio, entry_id, version, beat_id, recording)
    if data is None:
        raise HTTPException(404, "Question lesson narration not found")
    return _audio_response(data, byte_range)


@router.get("/{entry_id}/{version}/figure")
async def get_question_lesson_figure(entry_id: int, version: Token):
    store = await _current(entry_id, version)
    data = await asyncio.to_thread(store.figure, entry_id, version)
    if data is None:
        raise HTTPException(404, "Question lesson figure not found")
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "private, no-store"})
