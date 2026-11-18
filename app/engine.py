import asyncio
import logging
import time
import traceback
import uuid

import httpx

from .config import API_KEYS, settings
from .db import db
from .models import AUTO_PIVOT_TYPES
from .modules import REGISTRY, Module, Skip

log = logging.getLogger("osint")

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


def make_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=httpx.Timeout(20.0, connect=10.0),
        follow_redirects=True,
        headers={"User-Agent": USER_AGENT, "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"},
        limits=httpx.Limits(max_connections=80, max_keepalive_connections=40),
    )


class Job:
    def __init__(self, case_id: int):
        self.id = uuid.uuid4().hex[:12]
        self.case_id = case_id
        self.events: list[dict] = []
        self.created: list[str] = []
        self.done = False
        self.cancelled = False
        self._new = asyncio.Event()
        self.task: asyncio.Task | None = None

    def emit(self, event: dict) -> None:
        self.events.append(event)
        self._new.set()

    def cancel(self) -> bool:
        if self.done:
            return False
        self.cancelled = True
        if self.task and not self.task.done():
            self.task.cancel()
        return True

    def finish(self) -> None:
        self.done = True
        self._new.set()

    async def stream(self):
        i = 0
        while True:
            if i < len(self.events):
                ev = self.events[i]
                i += 1
                yield ev
                continue
            if self.done:
                return
            self._new.clear()
            try:
                await asyncio.wait_for(self._new.wait(), 15)
            except asyncio.TimeoutError:
                yield None  # keep-alive


class Context:
    """Lo que ve un módulo mientras se ejecuta sobre una entidad."""

    def __init__(self, engine: "Engine", job: Job, entity: dict, module: Module):
        self.engine = engine
        self.job = job
        self.case_id = job.case_id
        self.entity = entity
        self.value: str = entity["value"]
        self.module = module
        self.http = engine.http
        self.settings = settings
        self.found = 0
        self.enriched = False
        self.message = ""
        self.new_pivots: list[str] = []

    def key(self, name: str) -> str | None:
        return settings.key(name)

    def require_key(self, name: str) -> str:
        k = settings.key(name)
        if not k:
            label, url = API_KEYS[name]
            raise Skip(f"Requiere clave de {label}: añádela en Ajustes ({url})")
        return k

    def add(
        self,
        etype: str,
        value: str,
        attrs: dict | None = None,
        rel: str = "relacionado",
        parent: str | None = None,
        pivot: bool = True,
    ) -> str | None:
        if not value or not str(value).strip():
            return None
        attrs = dict(attrs or {})
        attrs["_fuentes"] = [self.module.title]
        src = parent or self.entity["id"]
        with db.batch():
            ent, created = db.upsert_entity(self.case_id, etype, str(value), attrs, pivot=pivot)
            edge_added = src != ent["id"] and db.add_edge(self.case_id, src, ent["id"], rel, self.module.name)
        self.job.emit({"type": "entity", "entity": ent, "created": created})
        if created:
            self.job.created.append(ent["id"])
        if edge_added:
            self.job.emit({"type": "edge", "edge": {"src": src, "dst": ent["id"], "label": rel, "source": self.module.name}})
        self.found += 1
        if pivot and etype in AUTO_PIVOT_TYPES:
            self.new_pivots.append(ent["id"])
        return ent["id"]

    def enrich(self, attrs: dict, eid: str | None = None, replace: bool = False) -> None:
        """Con replace=True las claves dadas se sobrescriben tal cual (las que valen None se borran)."""
        if replace:
            ent = db.update_attrs(self.case_id, eid or self.entity["id"], attrs, replace=True)
            if ent:
                self.job.emit({"type": "entity", "entity": ent, "created": False})
            return
        attrs = {k: v for k, v in attrs.items() if v not in (None, "", [], {})}
        if not attrs:
            return
        attrs["_fuentes"] = [self.module.title]
        ent = db.update_attrs(self.case_id, eid or self.entity["id"], attrs)
        if ent:
            self.job.emit({"type": "entity", "entity": ent, "created": False})
            self.enriched = True

    async def get_json(self, url: str, **kw):
        """GET que devuelve (status, json o None) sin lanzar excepción por códigos HTTP."""
        r = await self.http.get(url, **kw)
        try:
            data = r.json()
        except ValueError:
            data = None
        return r.status_code, data


class Engine:
    def __init__(self):
        self.http: httpx.AsyncClient | None = None
        self.jobs: dict[str, Job] = {}

    async def start(self) -> None:
        self.http = make_client()

    async def stop(self) -> None:
        if self.http:
            await self.http.aclose()

    def modules_for(self, entity: dict) -> list[Module]:
        return [m for m in REGISTRY.values() if m.applies(entity)]

    def _new_job(self, case_id: int) -> Job:
        job = Job(case_id)
        self.jobs[job.id] = job
        for jid in [j for j, jb in self.jobs.items() if jb.done and jb is not job][:-20]:
            self.jobs.pop(jid, None)
        return job

    def start_scan(self, case_id: int, entity_id: str, modules: list[str] | None, depth: int) -> Job:
        job = self._new_job(case_id)
        job.task = asyncio.create_task(self._scan(job, entity_id, modules, max(0, min(depth, 3))))
        return job

    def start_batch(self, case_id: int, module: str) -> Job:
        job = self._new_job(case_id)
        job.task = asyncio.create_task(self._batch(job, REGISTRY[module]))
        return job

    def cancel_job(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if not job:
            return False
        return job.cancel()

    async def _gather_CancelSafe(self, coros) -> list:
        tasks = [asyncio.create_task(c) for c in coros]
        if not tasks:
            return []
        try:
            return list(await asyncio.gather(*tasks))
        except asyncio.CancelledError:
            for t in tasks:
                if not t.done():
                    t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise

    async def _batch(self, job: Job, m: Module) -> None:
        """Pasa un módulo por todas las entidades del caso a las que aplica y que aún no lo tienen; luego reanaliza."""
        from . import analysis

        ents: list[dict] = []
        try:
            ents = [e for e in db.entities_without_run(job.case_id, m.name) if m.applies(e)]
            if ents:
                job.emit({"type": "scan_plan", "total": len(ents)})
            sem = asyncio.Semaphore(8)

            async def one(e):
                async with sem:
                    await self._run_module(job, e, m)

            await self._gather_CancelSafe([one(e) for e in ents])
            await analysis.run(self, job, use_ai=False)
            job.emit({"type": "done", "scanned": len(ents)})
        except asyncio.CancelledError:
            job.emit({"type": "cancelled", "scanned": len(ents)})
        except Exception as e:  # noqa: BLE001
            log.error("batch failed: %s", traceback.format_exc())
            job.emit({"type": "error", "message": str(e)})
        finally:
            db.touch(job.case_id)
            job.finish()

    def start_analysis(self, case_id: int, use_ai: bool) -> Job:
        job = self._new_job(case_id)
        job.task = asyncio.create_task(self._analysis_job(job, use_ai))
        return job

    async def _analysis_job(self, job: Job, use_ai: bool) -> None:
        from . import analysis

        try:
            job.emit({"type": "scan_plan", "total": 2 if use_ai else 1})
            await analysis.run(self, job, use_ai=use_ai)
            job.emit({"type": "done", "scanned": 0, "analysis": True})
        except asyncio.CancelledError:
            job.emit({"type": "cancelled", "scanned": 0, "analysis": True})
        except Exception as e:  # noqa: BLE001
            log.error("analysis failed: %s", traceback.format_exc())
            job.emit({"type": "error", "message": str(e)})
        finally:
            db.touch(job.case_id)
            job.finish()

    async def _enrich_new(self, job: Job) -> None:
        """Ejecuta los enriquecedores automáticos sobre las entidades creadas en este trabajo."""
        auto = [m for m in REGISTRY.values() if m.auto]
        done: set[str] = set()
        for _ in range(2):
            pending = [eid for eid in job.created if eid not in done]
            if not pending:
                return
            coros = []
            for eid in pending:
                done.add(eid)
                ent = db.get_entity(job.case_id, eid)
                if not ent:
                    continue
                coros += [self._run_module(job, ent, m) for m in auto if m.applies(ent)]
            if coros:
                job.emit({"type": "scan_plan", "total": len(coros)})
                await self._gather_CancelSafe(coros)

    async def _scan(self, job: Job, entity_id: str, modules: list[str] | None, depth: int) -> None:
        seen = {entity_id}
        try:
            limit = int(settings.get("max_pivot_entities", 25))
            queue: list[tuple[str, int]] = [(entity_id, 0)]
            while queue:
                # cada nivel se procesa en paralelo
                level = queue
                queue = []
                results = await self._gather_CancelSafe(
                    [self._scan_entity(job, eid, modules if d == 0 else None, rerun=d == 0) for eid, d in level]
                )
                for (eid, d), new in zip(level, results):
                    if d >= depth:
                        continue
                    for n in new:
                        if n not in seen and len(seen) < limit:
                            seen.add(n)
                            queue.append((n, d + 1))
            await self._enrich_new(job)
            from . import analysis

            await analysis.run(self, job, use_ai=False)
            job.emit({"type": "done", "scanned": len(seen)})
        except asyncio.CancelledError:
            job.emit({"type": "cancelled", "scanned": len(seen)})
        except Exception as e:  # noqa: BLE001
            log.error("scan failed: %s", traceback.format_exc())
            job.emit({"type": "error", "message": str(e)})
        finally:
            db.touch(job.case_id)
            job.finish()

    async def _scan_entity(self, job: Job, eid: str, modules: list[str] | None, rerun: bool) -> list[str]:
        ent = db.get_entity(job.case_id, eid)
        if not ent:
            return []
        mods = self.modules_for(ent)
        if modules is not None:
            mods = [m for m in mods if m.name in modules]
        else:
            mods = [m for m in mods if not m.deep]
        if not rerun:
            done = db.completed_modules(job.case_id, eid, ("ok", "empty"))
            mods = [m for m in mods if m.name not in done]
        if not mods:
            return []
        job.emit({"type": "scan_entity", "entity_id": eid, "modules": [m.name for m in mods]})
        ctxs = await self._gather_CancelSafe([self._run_module(job, ent, m) for m in mods])
        new: list[str] = []
        for c in ctxs:
            new.extend(x for x in c.new_pivots if x not in new and x != eid)
        return new

    async def _run_module(self, job: Job, ent: dict, m: Module) -> Context:
        ctx = Context(self, job, ent, m)
        job.emit({"type": "run_start", "entity_id": ent["id"], "module": m.name})
        started = time.time()
        try:
            for k in m.keys:
                ctx.require_key(k)
            await asyncio.wait_for(m.run(ctx), m.timeout)
            status = "ok" if (ctx.found or ctx.enriched) else "empty"
            msg = ctx.message or (f"{ctx.found} hallazgos" if ctx.found else ("Datos añadidos" if ctx.enriched else "Sin resultados"))
        except asyncio.CancelledError:
            status = "cancelled"
            msg = "Cancelado" + (f" · {ctx.found} hallazgos parciales" if ctx.found else "")
            run = db.add_run(job.case_id, ent["id"], m.name, status, msg, ctx.found, started)
            job.emit({"type": "run", "run": run})
            raise
        except Skip as e:
            status, msg = "skipped", str(e)
        except asyncio.TimeoutError:
            status, msg = "error", f"Tiempo agotado ({int(m.timeout)} s)" + (f" · {ctx.found} hallazgos parciales" if ctx.found else "")
        except httpx.HTTPError as e:
            status, msg = "error", f"Error de red: {type(e).__name__}"
        except Exception as e:  # noqa: BLE001
            log.error("module %s failed: %s", m.name, traceback.format_exc())
            status, msg = "error", f"{type(e).__name__}: {e}"
        run = db.add_run(job.case_id, ent["id"], m.name, status, msg, ctx.found, started)
        job.emit({"type": "run", "run": run})
        return ctx


engine = Engine()
