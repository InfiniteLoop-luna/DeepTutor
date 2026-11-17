"""PDF review writes canonical questions and private source evidence together."""

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pymupdf

from deeptutor.api.routers import question_bank_pdf
from deeptutor.services.practice.importing import normalize_question
from deeptutor.services.practice.pdf_import import pdf_sources_for_entries
from deeptutor.services.practice.storage import PracticeStore
from deeptutor.services.session.sqlite_store import SQLiteSessionStore


def test_pdf_review_reuses_existing_question_and_commits_only_approved_rows(tmp_path, monkeypatch):
    store = SQLiteSessionStore(tmp_path / "student.db")
    other = SQLiteSessionStore(tmp_path / "other.db")
    practice = PracticeStore(store.db_path)
    existing = normalize_question({"question": "How many sides has a triangle?", "answer": "3"})
    token = practice.stage_import("prior.csv", "bank", [existing])
    assert practice.commit_import(token)["created"] == 1
    original_id = practice.queue("UTC")[0]

    active = [store]
    monkeypatch.setattr(question_bank_pdf, "get_sqlite_session_store", lambda: active[0])
    app = FastAPI()
    app.include_router(question_bank_pdf.router, prefix="/pdf-imports")
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_textbox(
            (60, 60, 550, 300),
            "1. How many sides has a triangle?\n2. How many sides has a square?",
        )
        data = document.tobytes()
    with TestClient(app) as client:
        response = client.post("/pdf-imports", files={"file": ("worksheet.pdf", data)})
        assert response.status_code == 202
        import_path = f"/pdf-imports/{response.json()['id']}"
        draft = client.get(import_path).json()
        assert draft["status"] == "draft"
        first, second = draft["questions"]
        assert (first["page"], first["number"], first["approved"]) == (1, "1", False)
        first.update(approved=True, correct_answer="3")
        rejected = client.post(
            import_path + "/commit",
            json={
                "revision": draft["revision"],
                "questions": [first, {**second, "approved": True}],
            },
        )
        assert rejected.status_code == 422
        with practice.connect() as conn:
            assert pdf_sources_for_entries(conn, [original_id]) == {}

        partial = client.post(
            import_path + "/commit",
            json={"revision": draft["revision"], "questions": [first, second]},
        ).json()
        assert partial["status"] == "draft"
        assert partial["result"] == {"imported": 0, "duplicates": 1, "total": 1}
        assert partial["questions"][0]["entry_id"] == original_id
        with practice.connect() as conn:
            assert pdf_sources_for_entries(conn, [original_id])[original_id] == [
                dict(
                    document_id=draft["id"],
                    filename="worksheet.pdf",
                    page=1,
                    end_page=1,
                    number="1",
                )
            ]
        second.update(approved=True, correct_answer="4")
        request = {"revision": partial["revision"], "questions": [second]}
        finished = client.post(import_path + "/commit", json=request).json()
        assert finished["status"] == "imported"
        assert finished["result"] == {"imported": 1, "duplicates": 1, "total": 2}
        assert client.post(import_path + "/commit", json=request).json() == finished

        source = client.get(import_path + "/source", headers={"Range": "bytes=0-9"})
        assert source.status_code == 206
        assert source.content == data[:10]

        uploaded_again = client.post("/pdf-imports", files={"file": ("worksheet.pdf", data)})
        second_id = uploaded_again.json()["id"]
        assert second_id != draft["id"]
        repeat_path = f"/pdf-imports/{second_id}"
        repeat_draft = client.get(repeat_path).json()
        repeat_first = {**repeat_draft["questions"][0], "approved": True, "correct_answer": "3"}
        repeated = client.post(repeat_path + "/commit", json={"questions": [repeat_first]}).json()
        assert repeated["result"] == {"imported": 0, "duplicates": 1, "total": 1}
        with practice.connect() as conn:
            assert {
                item["document_id"]
                for item in pdf_sources_for_entries(conn, [original_id])[original_id]
            } == {draft["id"], second_id}

        active[0] = other
        assert client.get("/pdf-imports").json() == []
        assert client.get(import_path + "/source").status_code == 404
