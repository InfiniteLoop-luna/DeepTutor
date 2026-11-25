"""Save question lesson snapshots and independently retryable narration."""

from __future__ import annotations

from dataclasses import dataclass
import json
import sqlite3
import time
from uuid import uuid4

from deeptutor.services.practice.storage import PracticeStore

from .narration import Clip, NarrationLine, estimate

_LEASE_SECONDS = 300


class LessonChanged(ValueError):
    """The current story was replaced before an audio action could start."""


@dataclass(frozen=True)
class VoiceJob:
    token: str
    language: str
    lines: list[NarrationLine]


def _initialize(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS question_lesson_plans (
            entry_id INTEGER PRIMARY KEY REFERENCES notebook_entries(id) ON DELETE CASCADE,
            digest TEXT NOT NULL,
            version TEXT NOT NULL,
            storyboard TEXT NOT NULL,
            figure BLOB,
            jobs TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS question_lesson_clips (
            entry_id INTEGER NOT NULL REFERENCES question_lesson_plans(entry_id) ON DELETE CASCADE,
            beat_id TEXT NOT NULL,
            frames INTEGER NOT NULL,
            captions TEXT NOT NULL,
            audio BLOB,
            recording TEXT NOT NULL,
            PRIMARY KEY (entry_id, beat_id)
        );
    """)


def _plan(conn: sqlite3.Connection, entry_id: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT entry_id, digest, version, storyboard, figure IS NOT NULL AS has_figure, jobs "
        "FROM question_lesson_plans WHERE entry_id = ?",
        (entry_id,),
    ).fetchone()


def _active_jobs(row: sqlite3.Row) -> dict:
    return {
        key: job for key, job in json.loads(row["jobs"]).items() if job["expires"] > time.time()
    }


class QuestionLessonStore(PracticeStore):
    def has_current(self, entry_id: int, digest: str, version: str) -> bool:
        with self.connect() as conn:
            _initialize(conn)
            return (
                conn.execute(
                    "SELECT 1 FROM question_lesson_plans WHERE entry_id=? AND digest=? AND version=?",
                    (entry_id, digest, version),
                ).fetchone()
                is not None
            )

    def get(self, entry_id: int, digest: str) -> tuple[dict | None, bool]:
        with self.connect() as conn:
            _initialize(conn)
            conn.execute("BEGIN")
            row = _plan(conn, entry_id)
            if row is None or row["digest"] != digest:
                return None, row is not None
            clips = {
                clip["beat_id"]: clip
                for clip in conn.execute(
                    "SELECT beat_id, frames, captions, audio IS NOT NULL AS has_audio, recording "
                    "FROM question_lesson_clips WHERE entry_id = ?",
                    (entry_id,),
                )
            }
        body = json.loads(row["storyboard"])
        jobs = _active_jobs(row)
        for scene in body["scenes"]:
            state = "recording" if scene["id"] in jobs else "pending"
            for beat in scene["beats"]:
                clip = clips.get(beat["id"])
                if clip is None:
                    fallback = estimate(beat["narration"], body["language"])
                    beat.update(frames=fallback.frames, captions=fallback.captions, recording="")
                else:
                    beat.update(
                        frames=clip["frames"],
                        captions=json.loads(clip["captions"]),
                        recording=clip["recording"] if clip["has_audio"] else "",
                    )
            if state == "pending" and all(beat["id"] in clips for beat in scene["beats"]):
                state = "ready" if all(beat["recording"] for beat in scene["beats"]) else "caption"
            scene["state"] = state
        return {
            **body,
            "entry_id": entry_id,
            "version": row["version"],
            "has_figure": bool(row["has_figure"]),
        }, False

    def prepare(
        self,
        entry_id: int,
        digest: str,
        storyboard: dict,
        figure: bytes | None,
        *,
        replace_version: str | None = None,
    ) -> str:
        with self.connect() as conn:
            _initialize(conn)
            conn.execute("BEGIN IMMEDIATE")
            row = _plan(conn, entry_id)
            if replace_version and (
                not row or row["digest"] != digest or row["version"] != replace_version
            ):
                raise LessonChanged
            if row and row["digest"] == digest and not replace_version:
                if (
                    figure is None
                    or figure
                    == conn.execute(
                        "SELECT figure FROM question_lesson_plans WHERE entry_id=?", (entry_id,)
                    ).fetchone()["figure"]
                ):
                    return row["version"]
            if row:
                conn.execute("DELETE FROM question_lesson_plans WHERE entry_id = ?", (entry_id,))
            version = uuid4().hex
            conn.execute(
                "INSERT INTO question_lesson_plans(entry_id,digest,version,storyboard,figure) "
                "VALUES (?,?,?,?,?)",
                (entry_id, digest, version, json.dumps(storyboard, ensure_ascii=False), figure),
            )
            return version

    def claim(
        self, entry_id: int, digest: str, version: str, scene_id: str | None = None
    ) -> VoiceJob | None:
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = _plan(conn, entry_id)
            if not row or row["digest"] != digest or row["version"] != version:
                raise LessonChanged
            body = json.loads(row["storyboard"])
            scenes = {scene["id"]: scene for scene in body["scenes"]}
            if scene_id is not None and scene_id not in scenes:
                raise LookupError("Lesson scene not found")
            jobs = _active_jobs(row)
            completed = {
                clip[0]
                for clip in conn.execute(
                    "SELECT beat_id FROM question_lesson_clips WHERE entry_id = ?", (entry_id,)
                )
            }
            token = uuid4().hex
            lines = []
            for key in [scene_id] if scene_id else scenes:
                if key in jobs:
                    continue
                beats = scenes[key]["beats"]
                if not scene_id and all(beat["id"] in completed for beat in beats):
                    continue
                jobs[key] = {"token": token, "expires": time.time() + _LEASE_SECONDS}
                lines.extend(NarrationLine(beat["id"], beat["narration"]) for beat in beats)
            if not lines:
                return None
            conn.execute(
                "UPDATE question_lesson_plans SET jobs = ? WHERE entry_id = ?",
                (json.dumps(jobs), entry_id),
            )
            return VoiceJob(token, body["language"], lines)

    def finish(self, entry_id: int, version: str, job: VoiceJob, clips: dict[str, Clip]) -> None:
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = _plan(conn, entry_id)
            if not row or row["version"] != version:
                return
            jobs = _active_jobs(row)
            claimed = {key for key, lease in jobs.items() if lease["token"] == job.token}
            for line in job.lines:
                if line.id.split("-", 1)[0] not in claimed:
                    continue
                clip = clips.get(line.id) or estimate(line.text, job.language)
                # Keep previously usable audio if a new attempt fails.
                conn.execute(
                    """
                    INSERT INTO question_lesson_clips VALUES (?,?,?,?,?,?)
                    ON CONFLICT (entry_id, beat_id) DO UPDATE SET
                        frames=excluded.frames,captions=excluded.captions,audio=excluded.audio,
                        recording=excluded.recording
                    WHERE excluded.audio IS NOT NULL OR question_lesson_clips.audio IS NULL
                    """,
                    (
                        entry_id,
                        line.id,
                        clip.frames,
                        json.dumps(clip.captions),
                        clip.audio,
                        job.token,
                    ),
                )
            for key in claimed:
                jobs.pop(key)
            conn.execute(
                "UPDATE question_lesson_plans SET jobs = ? WHERE entry_id = ?",
                (json.dumps(jobs), entry_id),
            )

    def audio(self, entry_id: int, version: str, beat_id: str, recording: str) -> bytes | None:
        with self.connect() as conn:
            _initialize(conn)
            row = conn.execute(
                """SELECT c.audio FROM question_lesson_clips c JOIN question_lesson_plans p
                    ON p.entry_id=c.entry_id
                    WHERE c.entry_id=? AND p.version=? AND c.beat_id=? AND c.recording=?""",
                (entry_id, version, beat_id, recording),
            ).fetchone()
            return row["audio"] if row else None

    def figure(self, entry_id: int, version: str) -> bytes | None:
        with self.connect() as conn:
            _initialize(conn)
            row = conn.execute(
                "SELECT figure FROM question_lesson_plans WHERE entry_id=? AND version=?",
                (entry_id, version),
            ).fetchone()
            return row["figure"] if row else None
