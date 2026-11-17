"""Saved, ordered practice sets referencing existing question bank entries."""

from __future__ import annotations

import sqlite3
import time
import uuid

from .storage import PracticeStore


class PracticeSetStore(PracticeStore):
    @staticmethod
    def _initialize(conn: sqlite3.Connection) -> None:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS practice_sets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS practice_set_items (
                set_id TEXT NOT NULL REFERENCES practice_sets(id) ON DELETE CASCADE,
                entry_id INTEGER NOT NULL REFERENCES notebook_entries(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                PRIMARY KEY (set_id, entry_id)
            );
        """)

    def list_sets(self) -> list[dict]:
        with self.connect() as conn:
            self._initialize(conn)
            rows = conn.execute("""
                SELECT p.id, p.name,
                       CASE WHEN n.session_id IS NULL OR s.deleted_at IS NULL
                           THEN i.entry_id END AS entry_id
                FROM practice_sets p
                LEFT JOIN practice_set_items i ON p.id = i.set_id
                LEFT JOIN notebook_entries n ON n.id = i.entry_id
                LEFT JOIN sessions s ON s.id = n.session_id
                ORDER BY p.created_at DESC, p.id, i.position
            """).fetchall()
        sets: dict[str, dict] = {}
        for row in rows:
            item = sets.setdefault(
                row["id"], {"id": row["id"], "name": row["name"], "entry_ids": []}
            )
            if row["entry_id"] is not None:
                item["entry_ids"].append(row["entry_id"])
        return list(sets.values())

    def create_set(self, name: str, entry_ids: list[int]) -> dict:
        set_id = uuid.uuid4().hex
        unique_ids = list(dict.fromkeys(entry_ids))
        with self.connect() as conn:
            self._initialize(conn)
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("INSERT INTO practice_sets VALUES (?, ?, ?)", (set_id, name, time.time()))
            result = conn.executemany(
                """
                INSERT INTO practice_set_items (set_id, entry_id, position)
                SELECT ?, n.id, ? FROM notebook_entries n
                LEFT JOIN sessions s ON s.id = n.session_id
                WHERE n.id = ? AND (n.session_id IS NULL OR s.deleted_at IS NULL)
                """,
                [(set_id, position, entry_id) for position, entry_id in enumerate(unique_ids)],
            )
            if result.rowcount != len(unique_ids):
                raise LookupError("One or more questions are no longer available")
        return {"id": set_id, "name": name, "entry_ids": unique_ids}

    def rename_set(self, set_id: str, name: str) -> bool:
        with self.connect() as conn:
            self._initialize(conn)
            result = conn.execute(
                "UPDATE practice_sets SET name = ? WHERE id = ?", (name, set_id)
            )
            return bool(result.rowcount)

    def delete_set(self, set_id: str) -> bool:
        with self.connect() as conn:
            self._initialize(conn)
            return bool(conn.execute("DELETE FROM practice_sets WHERE id = ?", (set_id,)).rowcount)
