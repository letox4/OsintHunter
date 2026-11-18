from contextlib import contextmanager
import json
import sqlite3
import threading
import time

from .config import DATA_DIR
from .models import display_label, entity_id, normalize

CURRENT_SCHEMA_VERSION = 2

SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_version(
    version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cases(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    notes TEXT DEFAULT '',
    layout TEXT DEFAULT '{}',
    created REAL,
    updated REAL
);
CREATE TABLE IF NOT EXISTS entities(
    case_id INTEGER,
    id TEXT,
    type TEXT,
    value TEXT,
    attrs TEXT,
    root INTEGER DEFAULT 0,
    pivot INTEGER DEFAULT 1,
    created REAL,
    PRIMARY KEY(case_id, id)
);
CREATE TABLE IF NOT EXISTS edges(
    case_id INTEGER,
    src TEXT,
    dst TEXT,
    label TEXT,
    source TEXT,
    PRIMARY KEY(case_id, src, dst, label)
);
CREATE TABLE IF NOT EXISTS runs(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER,
    entity_id TEXT,
    module TEXT,
    status TEXT,
    message TEXT,
    found INTEGER,
    started REAL,
    finished REAL
);
CREATE INDEX IF NOT EXISTS runs_case ON runs(case_id, entity_id);
"""


def merge_attrs(old: dict, new: dict) -> dict:
    out = dict(old)
    for k, v in (new or {}).items():
        if v is None or v == "" or v == [] or v == {}:
            continue
        cur = out.get(k)
        if isinstance(v, list) and isinstance(cur, list):
            seen = {json.dumps(x, sort_keys=True, default=str) for x in cur}
            merged = list(cur)
            for x in v:
                s = json.dumps(x, sort_keys=True, default=str)
                if s not in seen:
                    seen.add(s)
                    merged.append(x)
            out[k] = merged
        elif isinstance(v, dict) and isinstance(cur, dict):
            out[k] = {**cur, **v}
        else:
            out[k] = v
    return out


class DB:
    def __init__(self, path=DATA_DIR / "osint.db"):
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self._batch_depth = 0
        with self.lock:
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA synchronous=NORMAL")
            self.conn.executescript(SCHEMA)
            self._migrate()
            self.conn.commit()

    def _migrate(self) -> None:
        row = self.conn.execute("SELECT version FROM schema_version LIMIT 1").fetchone()
        if row is None:
            ver = 0
            self.conn.execute("INSERT INTO schema_version(version) VALUES(0)")
        else:
            ver = int(row["version"])

        if ver < 1:
            cols = {r[1] for r in self.conn.execute("PRAGMA table_info(cases)")}
            if "layout" not in cols:
                self.conn.execute("ALTER TABLE cases ADD COLUMN layout TEXT DEFAULT '{}'")
            ver = 1
            self.conn.execute("UPDATE schema_version SET version=?", (ver,))

        if ver < 2:
            self.conn.executescript("""
                CREATE INDEX IF NOT EXISTS entities_case_type ON entities(case_id, type);
                CREATE INDEX IF NOT EXISTS edges_case_src ON edges(case_id, src);
                CREATE INDEX IF NOT EXISTS edges_case_dst ON edges(case_id, dst);
                CREATE INDEX IF NOT EXISTS runs_case_module ON runs(case_id, module, status);
            """)
            ver = 2
            self.conn.execute("UPDATE schema_version SET version=?", (ver,))

    def schema_version(self) -> int:
        with self.lock:
            row = self.conn.execute("SELECT version FROM schema_version LIMIT 1").fetchone()
            return int(row["version"]) if row else 0

    def _commit(self) -> None:
        if self._batch_depth == 0:
            self.conn.commit()

    @contextmanager
    def batch(self):
        """Agrupa múltiples escrituras SQLite en un único commit al salir del bloque."""
        with self.lock:
            self._batch_depth += 1
            try:
                yield
            except Exception:
                self._batch_depth -= 1
                if self._batch_depth == 0:
                    self.conn.rollback()
                raise
            else:
                self._batch_depth -= 1
                if self._batch_depth == 0:
                    self.conn.commit()

    # ---------- casos ----------
    def list_cases(self) -> list[dict]:
        with self.lock:
            rows = self.conn.execute(
                "SELECT c.*, (SELECT COUNT(*) FROM entities e WHERE e.case_id = c.id) AS entities "
                "FROM cases c ORDER BY updated DESC"
            ).fetchall()
        return [{k: v for k, v in dict(r).items() if k != "layout"} for r in rows]

    def create_case(self, name: str) -> dict:
        now = time.time()
        with self.lock:
            cur = self.conn.execute(
                "INSERT INTO cases(name, created, updated) VALUES(?,?,?)", (name.strip() or "Caso sin nombre", now, now)
            )
            self._commit()
        return self.get_case(cur.lastrowid)

    def get_case(self, case_id: int) -> dict | None:
        with self.lock:
            row = self.conn.execute("SELECT * FROM cases WHERE id=?", (case_id,)).fetchone()
        if not row:
            return None
        case = dict(row)
        try:
            case["layout"] = json.loads(case.get("layout") or "{}")
        except ValueError:
            case["layout"] = {}
        return case

    def update_case(self, case_id: int, name: str | None = None, notes: str | None = None,
                    layout: dict | None = None) -> dict | None:
        with self.lock:
            if layout is not None:
                self.conn.execute("UPDATE cases SET layout=? WHERE id=?", (json.dumps(layout, ensure_ascii=False), case_id))
            if name is not None:
                self.conn.execute("UPDATE cases SET name=? WHERE id=?", (name.strip() or "Caso sin nombre", case_id))
            if notes is not None:
                self.conn.execute("UPDATE cases SET notes=? WHERE id=?", (notes, case_id))
            self.touch(case_id)
        return self.get_case(case_id)

    def touch(self, case_id: int) -> None:
        with self.lock:
            self.conn.execute("UPDATE cases SET updated=? WHERE id=?", (time.time(), case_id))
            self._commit()

    def delete_case(self, case_id: int) -> None:
        with self.batch():
            for table in ("entities", "edges", "runs"):
                self.conn.execute(f"DELETE FROM {table} WHERE case_id=?", (case_id,))
            self.conn.execute("DELETE FROM cases WHERE id=?", (case_id,))

    # ---------- entidades ----------
    @staticmethod
    def _entity(row) -> dict:
        attrs = json.loads(row["attrs"] or "{}") if isinstance(row["attrs"], str) else (row["attrs"] or {})
        return {
            "id": row["id"],
            "type": row["type"],
            "value": row["value"],
            "attrs": attrs,
            "root": bool(row["root"]),
            "pivot": bool(row["pivot"]),
            "label": display_label(row["type"], row["value"], attrs),
        }

    def get_entity(self, case_id: int, eid: str) -> dict | None:
        with self.lock:
            row = self.conn.execute("SELECT * FROM entities WHERE case_id=? AND id=?", (case_id, eid)).fetchone()
        return self._entity(row) if row else None

    def upsert_entity(
        self, case_id: int, etype: str, value: str, attrs: dict | None = None, root: bool = False, pivot: bool = True
    ) -> tuple[dict, bool]:
        value = normalize(etype, value)
        eid = entity_id(etype, value)
        with self.lock:
            row = self.conn.execute("SELECT * FROM entities WHERE case_id=? AND id=?", (case_id, eid)).fetchone()
            if row:
                merged = merge_attrs(json.loads(row["attrs"] or "{}"), attrs or {})
                new_root = max(int(row["root"]), int(root))
                new_pivot = max(int(row["pivot"]), int(pivot))
                self.conn.execute(
                    "UPDATE entities SET attrs=?, root=?, pivot=? WHERE case_id=? AND id=?",
                    (json.dumps(merged, ensure_ascii=False), new_root, new_pivot, case_id, eid),
                )
                created = False
            else:
                merged = dict(attrs or {})
                new_root = int(root)
                new_pivot = int(pivot)
                self.conn.execute(
                    "INSERT INTO entities(case_id, id, type, value, attrs, root, pivot, created) VALUES(?,?,?,?,?,?,?,?)",
                    (case_id, eid, etype, value, json.dumps(merged, ensure_ascii=False), new_root, new_pivot, time.time()),
                )
                created = True
            self._commit()
        ent = {
            "id": eid,
            "type": etype,
            "value": value,
            "attrs": merged,
            "root": bool(new_root),
            "pivot": bool(new_pivot),
            "label": display_label(etype, value, merged),
        }
        return ent, created

    def update_attrs(self, case_id: int, eid: str, attrs: dict, replace: bool = False) -> dict | None:
        """Fusiona atributos; con replace=True las claves dadas se sobrescriben (o se borran si valen None)."""
        with self.lock:
            row = self.conn.execute("SELECT * FROM entities WHERE case_id=? AND id=?", (case_id, eid)).fetchone()
            if not row:
                return None
            current = json.loads(row["attrs"] or "{}")
            if replace:
                merged = dict(current)
                for k, v in attrs.items():
                    if v is None:
                        merged.pop(k, None)
                    else:
                        merged[k] = v
            else:
                merged = merge_attrs(current, attrs)
            self.conn.execute(
                "UPDATE entities SET attrs=? WHERE case_id=? AND id=?", (json.dumps(merged, ensure_ascii=False), case_id, eid)
            )
            self._commit()
        return {
            "id": row["id"],
            "type": row["type"],
            "value": row["value"],
            "attrs": merged,
            "root": bool(row["root"]),
            "pivot": bool(row["pivot"]),
            "label": display_label(row["type"], row["value"], merged),
        }

    def delete_entity(self, case_id: int, eid: str) -> None:
        with self.batch():
            self.conn.execute("DELETE FROM entities WHERE case_id=? AND id=?", (case_id, eid))
            self.conn.execute("DELETE FROM edges WHERE case_id=? AND (src=? OR dst=?)", (case_id, eid, eid))
            self.conn.execute("DELETE FROM runs WHERE case_id=? AND entity_id=?", (case_id, eid))

    def delete_entities(self, case_id: int, ids: list[str]) -> int:
        if not ids:
            return 0
        n = 0
        with self.batch():
            for i in range(0, len(ids), 400):
                chunk = ids[i:i + 400]
                ph = ",".join("?" for _ in chunk)
                n += self.conn.execute(f"DELETE FROM entities WHERE case_id=? AND id IN ({ph})", (case_id, *chunk)).rowcount
                self.conn.execute(
                    f"DELETE FROM edges WHERE case_id=? AND (src IN ({ph}) OR dst IN ({ph}))",
                    (case_id, *chunk, *chunk),
                )
                self.conn.execute(f"DELETE FROM runs WHERE case_id=? AND entity_id IN ({ph})", (case_id, *chunk))
        return n

    # ---------- relaciones y ejecuciones ----------
    def add_edge(self, case_id: int, src: str, dst: str, label: str, source: str) -> bool:
        with self.lock:
            cur = self.conn.execute(
                "INSERT OR IGNORE INTO edges(case_id, src, dst, label, source) VALUES(?,?,?,?,?)",
                (case_id, src, dst, label, source),
            )
            self._commit()
        return cur.rowcount > 0

    def delete_edge(self, case_id: int, src: str, dst: str, label: str) -> bool:
        with self.lock:
            cur = self.conn.execute("DELETE FROM edges WHERE case_id=? AND src=? AND dst=? AND label=?",
                                    (case_id, src, dst, label))
            self._commit()
        return cur.rowcount > 0

    def add_run(self, case_id: int, eid: str, module: str, status: str, message: str, found: int, started: float) -> dict:
        now = time.time()
        with self.lock:
            cur = self.conn.execute(
                "INSERT INTO runs(case_id, entity_id, module, status, message, found, started, finished) VALUES(?,?,?,?,?,?,?,?)",
                (case_id, eid, module, status, message, found, started, now),
            )
            self._commit()
            rid = cur.lastrowid
        return {
            "id": rid,
            "case_id": case_id,
            "entity_id": eid,
            "module": module,
            "status": status,
            "message": message,
            "found": found,
            "started": started,
            "finished": now,
        }

    def completed_modules(self, case_id: int, eid: str, statuses: tuple[str, ...] = ("ok", "empty")) -> set[str]:
        """Consultas puntuales (D4): devuelve los módulos ya ejecutados sobre una entidad."""
        ph = ",".join("?" for _ in statuses)
        with self.lock:
            rows = self.conn.execute(
                f"SELECT DISTINCT module FROM runs WHERE case_id=? AND entity_id=? AND status IN ({ph})",
                (case_id, eid, *statuses),
            ).fetchall()
        return {r["module"] for r in rows}

    def entities_without_run(
        self, case_id: int, module: str, statuses: tuple[str, ...] = ("ok", "empty", "skipped")
    ) -> list[dict]:
        """Consultas puntuales (D4): entidades del caso que aún no ejecutaron el módulo dado."""
        ph = ",".join("?" for _ in statuses)
        with self.lock:
            rows = self.conn.execute(
                f"SELECT * FROM entities WHERE case_id=? AND id NOT IN ("
                f"SELECT entity_id FROM runs WHERE case_id=? AND module=? AND status IN ({ph})"
                f") ORDER BY created",
                (case_id, case_id, module, *statuses),
            ).fetchall()
        return [self._entity(r) for r in rows]

    def graph(self, case_id: int) -> dict:
        with self.lock:
            ents = self.conn.execute("SELECT * FROM entities WHERE case_id=? ORDER BY created", (case_id,)).fetchall()
            edges = self.conn.execute("SELECT src, dst, label, source FROM edges WHERE case_id=?", (case_id,)).fetchall()
            runs = self.conn.execute("SELECT * FROM runs WHERE case_id=? ORDER BY id", (case_id,)).fetchall()
        return {
            "entities": [self._entity(r) for r in ents],
            "edges": [dict(r) for r in edges],
            "runs": [dict(r) for r in runs],
        }


db = DB()
