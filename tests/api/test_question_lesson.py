"""Question lessons preserve their source and retry narration independently."""

from __future__ import annotations

import asyncio
from base64 import b64decode
from io import BytesIO
import json
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
import pymupdf
import pytest

from deeptutor.agents.video_lesson import question_solution
from deeptutor.agents.video_lesson.narration import Clip
from deeptutor.agents.video_lesson.question_storyboard import build_storyboard
from deeptutor.api.routers import question_lesson
from deeptutor.services.practice.pdf_import import PdfImportStore
from deeptutor.services.practice.storage import PracticeStore
from deeptutor.services.session.sqlite_store import SQLiteSessionStore


@pytest.fixture
def lessons(tmp_path, monkeypatch):
    store = SQLiteSessionStore(tmp_path / "student.db")
    selected_store = [store]
    monkeypatch.setattr(question_lesson, "get_sqlite_session_store", lambda: selected_store[0])
    batches = []

    async def speak(lines, language):
        batches.append([line.id for line in lines])
        return {
            line.id: Clip(line.text, 47, [(0, line.text)], None if line.id == "s2-1" else b"mp3")
            for line in lines
        }

    monkeypatch.setattr(question_lesson, "narrate", speak)
    app = FastAPI()
    app.include_router(question_lesson.router, prefix="/lessons")
    with TestClient(app) as client:
        yield client, store, selected_store, batches


def _import(store, **fields):
    from deeptutor.services.practice.importing import normalize_question

    raw = {
        "question": r"求函数 $x^2-1$ 的零点。",
        "correct_answer": r"$-1,1$",
        "explanation": r"令 $x^2-1=0$。所以 $x=-1$ 或 $x=1$。",
        "textbook_section_id": "b1-4.5.1",
        **fields,
    }
    repo = PracticeStore(store.db_path)
    repo.commit_import(repo.stage_import("math.json", "bank", [normalize_question(raw)]))
    with repo.connect() as db:
        return db.execute("SELECT MAX(id) FROM notebook_entries").fetchone()[0]


def test_question_lesson_keeps_formulas_and_retries_only_one_scene(lessons):
    client, store, selected_store, batches = lessons
    entry = _import(store)
    root = f"/lessons/{entry}"
    assert client.get(root).json()["lesson"] is None
    response = client.post(root)
    assert response.status_code == 202
    lesson = client.get(root).json()["lesson"]
    assert len(batches) == 1
    assert lesson["textbook"] == "必修第一册 · 4.5.1 函数的零点与方程的解"
    first, solution, answer = lesson["scenes"]
    assert solution["state"] == "caption"
    assert [beat["markdown"] for beat in solution["beats"]] == [
        r"令 $x^2-1=0$。",
        r"所以 $x=-1$ 或 $x=1$。",
    ]
    assert solution["beats"][0]["narration"] == "令 x的平方减1等于0。"
    assert answer["beats"][0]["markdown"] == r"$-1,1$"

    version = lesson["version"]
    path = f"{root}/{version}"
    assert client.post(root).json()["lesson"]["version"] == version
    assert len(batches) == 1
    assert client.post(path + "/scenes/s2/narration").status_code == 202
    assert batches[-1] == ["s2-1", "s2-2"]
    assert client.get(root).json()["lesson"]["scenes"][0] == first
    recording = first["beats"][0]["recording"]
    audio_path = path + f"/audio/s1-1/{recording}"
    assert client.get(audio_path).content == b"mp3"
    part = client.get(audio_path, headers={"Range": "bytes=1-"})
    assert part.status_code == 206
    assert part.content == b"p3"
    assert part.headers["Content-Range"] == "bytes 1-2/3"
    assert client.get(audio_path, headers={"Range": "bytes=-1"}).content == b"3"
    assert client.get(audio_path, headers={"Range": "bytes=3-"}).status_code == 416
    # A wrong/correct attempt does not change the source snapshot.
    assert asyncio.run(store.update_notebook_entry(entry, {"bookmarked": True}))
    assert client.get(root).json()["lesson"]["version"] == version
    with PracticeStore(store.db_path).connect() as db:
        db.execute("UPDATE notebook_entries SET explanation=? WHERE id=?", ("New proof.", entry))
    assert client.get(root).json()["stale"]
    assert client.get(audio_path).status_code == 404
    assert client.post(path + "/scenes/s2/narration").status_code == 409
    assert client.post(root).status_code == 202
    assert client.get(root).json()["lesson"]["version"] != version

    selected_store[0] = SQLiteSessionStore(store.db_path.with_name("another-student.db"))
    assert client.get(root).status_code == 404
    assert client.get(audio_path).status_code == 404


def test_question_lesson_requires_and_keeps_actual_figure(lessons):
    client, store, _, batches = lessons
    entry = _import(store, question="如图，计算线段 AB 的长度。")
    root = f"/lessons/{entry}"
    assert client.get(root).json()["needs_figure"]
    assert client.post(root).json()["detail"] == "figure_required"
    assert client.post(root, files={"figure": ("diagram.png", b"broken")}).status_code == 422
    assert not batches

    png = BytesIO()
    Image.new("RGB", (24, 24), "white").save(png, format="PNG")
    files = {"figure": ("diagram.png", png.getvalue(), "image/png")}
    assert client.post(root, files=files).status_code == 202
    result = client.get(root).json()
    assert not result["needs_figure"]
    lesson = result["lesson"]
    assert lesson["has_figure"]
    figure = client.get(f"{root}/{lesson['version']}/figure")
    assert figure.headers["content-type"] == "image/jpeg"
    assert figure.content.startswith(b"\xff\xd8")
    assert client.post(root, files=files).json()["lesson"]["version"] == lesson["version"]
    assert len(batches) == 1


def test_number_line_uses_exact_source_bounds_and_preserves_endpoint_type():
    explanation = r"当 $\frac34<a\le1$ 时满足要求。"
    story = build_storyboard({"question": "求实数 a 的范围。", "explanation": explanation}, "zh")
    beat = story["scenes"][1]["beats"][0]
    assert beat["markdown"] == explanation
    assert beat["interval"] == {
        "low": r"\frac34",
        "high": "1",
        "variable": "a",
        "low_closed": False,
        "high_closed": True,
    }


def test_figure_can_use_the_associated_pdf_page(lessons):
    client, store, _, _ = lessons
    entry_id = _import(store, question="如图，求线段 CD 的长度。")
    sources = PdfImportStore(store.db_path)
    with pymupdf.open() as pdf:
        pdf.new_page(width=200, height=100)
        pdf.new_page(width=100, height=200)
        source = sources.create("diagram.pdf", pdf.tobytes())
    with sources.connect() as db:
        db.execute(
            "INSERT INTO practice_pdf_sources VALUES (?,?,?,?,?)",
            (entry_id, source["id"], 2, 2, "4"),
        )
    root = f"/lessons/{entry_id}"
    lesson = client.post(root, data={"use_original": "true"}).json()["lesson"]
    assert lesson["figure_page"] == 2
    assert lesson["pdf_sources"][0]["document_id"] == source["id"]
    media = client.get(f"{root}/{lesson['version']}/figure")
    with Image.open(BytesIO(media.content)) as image:
        assert image.size == (800, 1600)


def test_ai_solves_from_the_question_and_narrates_only_on_request(lessons, monkeypatch):
    client, store, _, batches = lessons
    entry_id = _import(store, explanation="", correct_answer="Reference answer from the bank")
    graph = {
        "kind": "coordinates",
        "x_range": [-3, 3],
        "y_range": [-2, 5],
        "curves": [{"label": "y=x²−1", "coefficients": [-1, 0, 1]}],
        "points": [{"label": "A", "x": -1, "y": 0}, {"label": "B", "x": 1, "y": 0}],
    }
    model_answer = {
        "steps": [
            {"title": "找横轴交点", "markdown": r"零点满足 $x^2-1=0$。", "visual": graph},
            {"title": "因式分解", "markdown": r"由 $(x-1)(x+1)=0$ 得 $x=\pm 1$。"},
        ],
        "answer": r"零点为 $-1$ 和 $1$。",
    }

    async def complete(prompt, **kwargs):
        source = json.loads(prompt)
        assert set(source) == {"language", "question", "options", "textbook_topic"}
        assert "x^2-1" in source["question"]
        assert "函数的零点" in source["textbook_topic"]
        assert not kwargs["allow_image_fallback"]
        return json.dumps(model_answer)

    monkeypatch.setattr(question_solution, "complete", complete)
    root = f"/lessons/{entry_id}"
    assert not client.get(root).json()["has_explanation"]
    response = client.post(root + "/solve")
    assert response.status_code == 200
    lesson = response.json()["lesson"]
    assert lesson["source"] == "ai"
    assert lesson["scenes"][1]["title"] == "找横轴交点"
    assert lesson["scenes"][1]["beats"][0]["visual"]["curves"][0]["coefficients"] == [-1, 0, 1]
    assert lesson["scenes"][-1]["beats"][0]["markdown"] == model_answer["answer"]
    assert lesson["reference_answer"] == "Reference answer from the bank"
    assert all(scene["state"] == "pending" for scene in lesson["scenes"])
    assert not batches

    assert client.post(f"{root}/{lesson['version']}/narration").status_code == 202
    assert batches == [["s1-1", "s2-1", "s3-1", "s4-1"]]
    assert client.get(root).json()["lesson"]["scenes"][0]["state"] == "ready"

    model_answer.clear()
    failure = client.post(root + "/solve")
    assert failure.json()["detail"] == "solution_invalid"
    assert client.get(root).json()["lesson"]["version"] == lesson["version"]
    assert asyncio.run(store.get_notebook_entry(entry_id))["explanation"] == ""


def test_pasted_question_requires_its_figure_and_is_saved_only_after_solving(lessons, monkeypatch):
    client, store, selected_store, _ = lessons
    calls = []
    question = "如图，直角三角形两条直角边长分别为 3 和 4，求斜边。"

    async def complete(prompt, **kwargs):
        assert kwargs["image_mime_type"] == "image/jpeg"
        assert b64decode(kwargs["image_data"]).startswith(b"\xff\xd8")
        calls.append(prompt)
        answer = (
            {"missing_information": "请补全图中的标记。"}
            if len(calls) == 1
            else {
                "steps": [
                    {
                        "title": "用勾股定理",
                        "markdown": "斜边平方为 $3^2+4^2=25$。",
                        "visual": {"kind": "coordinates", "x_range": [2, 1], "y_range": [0, 3]},
                    }
                ],
                "answer": "斜边长为 $5$。",
            }
        )
        return json.dumps(answer)

    monkeypatch.setattr(question_solution, "complete", complete)
    monkeypatch.setattr(
        question_solution, "get_llm_config", lambda: SimpleNamespace(binding="test", model="test")
    )
    monkeypatch.setattr(question_solution, "supports_vision", lambda *_: False)
    data = {"question": question}
    assert client.post("/lessons/solve", data=data).json()["detail"] == "figure_required"
    png = BytesIO()
    Image.new("RGB", (32, 24), "white").save(png, format="PNG")
    files = {"figure": ("diagram.png", png.getvalue(), "image/png")}
    assert (
        client.post("/lessons/solve", data=data, files=files).json()["detail"]
        == "solution_needs_vision"
    )
    assert not calls
    monkeypatch.setattr(question_solution, "supports_vision", lambda *_: True)
    assert (
        client.post("/lessons/solve", data=data, files=files).json()["detail"]
        == "请补全图中的标记。"
    )
    with PracticeStore(store.db_path).connect() as db:
        assert db.execute("SELECT COUNT(*) FROM notebook_entries").fetchone()[0] == 0
    lesson = client.post("/lessons/solve", data=data, files=files).json()["lesson"]
    assert lesson["has_figure"]
    assert lesson["scenes"][1]["beats"][0]["visual"]["kind"] == "flow"
    assert (
        client.post("/lessons/solve", data=data, files=files).json()["lesson"]["version"]
        == lesson["version"]
    )
    assert len(calls) == 2
    root = f"/lessons/{lesson['entry_id']}"
    assert client.get(root).json()["lesson"] == lesson
    entry = asyncio.run(store.get_notebook_entry(lesson["entry_id"]))
    assert entry["result"] == "ungraded"
    assert entry["correct_answer"] == ""
    selected_store[0] = SQLiteSessionStore(store.db_path.with_name("another-student.db"))
    assert client.get(root).status_code == 404
