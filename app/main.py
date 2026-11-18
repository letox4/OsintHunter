import json
import secrets
import time
from contextlib import asynccontextmanager
from urllib.parse import urlparse

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .analysis import score_identities
from .config import WEB_DIR, settings
from .db import db
from .engine import engine
from .exif import analyze_image
from .models import ENTITY_TYPES, detect_type
from .modules import REGISTRY
from .modules.username import PROFILE_URLS as MANUAL_PROFILE_URLS

SESSION_TOKEN = secrets.token_urlsafe(32)
STATE_CHANGING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def _validate_ai_base_url(url: str) -> str:
    val = (url or "").strip()
    if not val:
        return ""
    if any(c.isspace() for c in val):
        raise HTTPException(400, "URL base de IA no válida")
    parsed = urlparse(val)
    if parsed.scheme.lower() not in ("http", "https") or not parsed.netloc:
        raise HTTPException(400, "URL base de IA no válida: solo se permiten esquemas http o https")
    return val


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await engine.start()
    yield
    await engine.stop()


app = FastAPI(title="OsintHunter", lifespan=lifespan)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"], www_redirect=False)


class CaseIn(BaseModel):
    name: str = ""
    notes: str | None = None
    layout: dict | None = None


class EntityIn(BaseModel):
    value: str
    type: str | None = None
    parent: str | None = None
    rel: str | None = None
    attrs: dict | None = None


class EdgeIn(BaseModel):
    src: str
    dst: str
    label: str = "relacionado"


class IdsIn(BaseModel):
    ids: list[str]


class VerdictIn(BaseModel):
    verdict: str | None = None


class ManualCheckIn(BaseModel):
    site: str
    exists: bool


class _Collector:
    """Recoge los eventos de un cálculo síncrono para devolverlos en la respuesta HTTP."""

    def __init__(self, case_id: int):
        self.case_id = case_id
        self.entities: dict[str, dict] = {}

    def emit(self, ev: dict) -> None:
        if ev.get("type") == "entity" and ev.get("entity"):
            self.entities[ev["entity"]["id"]] = ev["entity"]


class ScanIn(BaseModel):
    entity_id: str
    modules: list[str] | None = None
    depth: int = 0


class DetectIn(BaseModel):
    value: str


class AnalyzeIn(BaseModel):
    ai: bool = False


def _case(case_id: int) -> dict:
    c = db.get_case(case_id)
    if not c:
        raise HTTPException(404, "Caso no encontrado")
    return c


@app.get("/api/meta")
def meta():
    return {
        "entity_types": ENTITY_TYPES,
        "modules": [
            {**m.meta(), "ready": all(settings.key(k) for k in m.keys)}
            for m in REGISTRY.values()
        ] + [
            {"name": "photo_match", "title": "Comparación de fotos de perfil", "description": "", "inputs": [],
             "keys": [], "optional_keys": [], "sources": [], "ready": True},
            {"name": "ai_verify", "title": "Verificación con IA", "description": "", "inputs": [],
             "keys": [], "optional_keys": [], "sources": [], "ready": True},
        ],
        "ai_ready": bool(settings.get("ai_base_url") and settings.get("ai_model")),
    }


@app.post("/api/detect")
def detect(body: DetectIn):
    return {"type": detect_type(body.value)}


@app.get("/api/settings")
def get_settings():
    return settings.public()


@app.put("/api/settings")
def put_settings(body: dict):
    changes = dict(body)
    if "ai_base_url" in changes:
        if not isinstance(changes["ai_base_url"], str):
            raise HTTPException(400, "URL base de IA no válida")
        changes["ai_base_url"] = _validate_ai_base_url(changes["ai_base_url"])
    settings.update(changes)
    return settings.public()


@app.get("/api/cases")
def list_cases():
    return db.list_cases()


@app.post("/api/cases")
def create_case(body: CaseIn):
    return db.create_case(body.name)


@app.get("/api/cases/{case_id}")
def get_case(case_id: int):
    return {"case": _case(case_id), **db.graph(case_id)}


@app.patch("/api/cases/{case_id}")
def update_case(case_id: int, body: CaseIn):
    _case(case_id)
    return db.update_case(case_id, name=body.name or None, notes=body.notes, layout=body.layout)


@app.delete("/api/cases/{case_id}")
def delete_case(case_id: int):
    db.delete_case(case_id)
    return {"ok": True}


@app.post("/api/cases/{case_id}/entities")
def add_entity(case_id: int, body: EntityIn):
    _case(case_id)
    value = body.value.strip()
    if not value:
        raise HTTPException(400, "Valor vacío")
    etype = body.type or detect_type(value)
    if etype not in ENTITY_TYPES:
        raise HTTPException(400, "Tipo desconocido")
    parent = db.get_entity(case_id, body.parent) if body.parent else None
    ent, _ = db.upsert_entity(case_id, etype, value, body.attrs or {}, root=not parent)
    if parent:
        db.add_edge(case_id, parent["id"], ent["id"], body.rel or "relacionado", "manual")
    db.touch(case_id)
    return ent


@app.post("/api/cases/{case_id}/entities/delete")
def delete_entities(case_id: int, body: IdsIn):
    _case(case_id)
    n = db.delete_entities(case_id, body.ids[:20000])
    db.touch(case_id)
    return {"deleted": n}


@app.post("/api/cases/{case_id}/edges")
def add_manual_edge(case_id: int, body: EdgeIn):
    _case(case_id)
    label = " ".join(body.label.split())[:60] or "relacionado"
    if body.src == body.dst or not db.get_entity(case_id, body.src) or not db.get_entity(case_id, body.dst):
        raise HTTPException(400, "Entidades no válidas")
    db.add_edge(case_id, body.src, body.dst, label, "manual")
    db.touch(case_id)
    return {"src": body.src, "dst": body.dst, "label": label, "source": "manual"}


@app.post("/api/cases/{case_id}/edges/delete")
def delete_manual_edge(case_id: int, body: EdgeIn):
    _case(case_id)
    return {"ok": db.delete_edge(case_id, body.src, body.dst, body.label)}


@app.put("/api/cases/{case_id}/verdict/{eid:path}")
def set_verdict(case_id: int, eid: str, body: VerdictIn):
    _case(case_id)
    if body.verdict not in (None, "confirmada", "descartada"):
        raise HTTPException(400, "Veredicto no válido")
    ent = db.update_attrs(case_id, eid, {"_verdict": body.verdict}, replace=True)
    if not ent:
        raise HTTPException(404, "Entidad no encontrada")
    job = _Collector(case_id)
    score_identities(job)
    job.entities.setdefault(ent["id"], db.get_entity(case_id, ent["id"]))
    db.touch(case_id)
    return {"entities": list(job.entities.values())}


@app.post("/api/cases/{case_id}/manual-check/{eid:path}")
def manual_check(case_id: int, eid: str, body: ManualCheckIn):
    """Resultado de un sitio bloqueado que el usuario comprobó en su navegador."""
    _case(case_id)
    ent = db.get_entity(case_id, eid)
    if not ent or ent["type"] != "username":
        raise HTTPException(404, "Entidad no encontrada")
    a = ent["attrs"]
    if body.site == "*":
        out = db.update_attrs(case_id, eid, {"_bloq_sitios": {}, "_bloq_perfiles": []}, replace=True)
        return {"entities": [out], "edge": None}
    sites = dict(a.get("_bloq_sitios") or {})
    url = sites.pop(body.site, None)
    platforms = [p for p in a.get("_bloq_perfiles") or [] if p != body.site]
    if url is None and body.site in (a.get("_bloq_perfiles") or []):
        url = MANUAL_PROFILE_URLS.get(body.site, "").format(ent["value"]) or None
    out = [db.update_attrs(case_id, eid, {"_bloq_sitios": sites, "_bloq_perfiles": platforms}, replace=True)]
    edge = None
    if body.exists and url:
        acc, _ = db.upsert_entity(case_id, "account", url, {
            "Plataforma": body.site, "Usuario": ent["value"], "Verificación": "Comprobado a mano en el navegador",
            "_links": [["Abrir perfil", url]], "_fuentes": ["Comprobación manual"]}, pivot=False)
        db.add_edge(case_id, eid, acc["id"], "cuenta", "manual")
        edge = {"src": eid, "dst": acc["id"], "label": "cuenta", "source": "manual"}
        out.append(acc)
    db.touch(case_id)
    return {"entities": out, "edge": edge}


@app.delete("/api/cases/{case_id}/entities/{eid:path}")
def delete_entity(case_id: int, eid: str):
    db.delete_entity(case_id, eid)
    return {"ok": True}


@app.post("/api/cases/{case_id}/scan")
async def scan(case_id: int, body: ScanIn):
    _case(case_id)
    if not db.get_entity(case_id, body.entity_id):
        raise HTTPException(404, "Entidad no encontrada")
    job = engine.start_scan(case_id, body.entity_id, body.modules, body.depth)
    return {"job_id": job.id}


@app.post("/api/cases/{case_id}/read-accounts")
async def read_accounts(case_id: int):
    _case(case_id)
    return {"job_id": engine.start_batch(case_id, "account_page").id}


@app.post("/api/cases/{case_id}/analyze")
async def analyze(case_id: int, body: AnalyzeIn):
    _case(case_id)
    job = engine.start_analysis(case_id, body.ai)
    return {"job_id": job.id}


@app.get("/api/jobs/{job_id}/events")
async def job_events(job_id: str):
    job = engine.jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Trabajo no encontrado")

    async def gen():
        async for ev in job.stream():
            if ev is None:
                yield ": ping\n\n"
            else:
                yield f"data: {json.dumps(ev, ensure_ascii=False, default=str)}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@app.post("/api/cases/{case_id}/image")
async def upload_image(case_id: int, file: UploadFile = File(...)):
    _case(case_id)
    data = await file.read()
    if len(data) > 40 * 1024 * 1024:
        raise HTTPException(413, "Imagen demasiado grande (máx. 40 MB)")
    try:
        info = analyze_image(data, file.filename or "imagen")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"No se pudo leer la imagen: {e}") from e
    info["_fuentes"] = ["Metadatos EXIF"]
    with db.batch():
        img, _ = db.upsert_entity(case_id, "image", info["SHA256"], info, root=True)
        h, _ = db.upsert_entity(case_id, "hash", info["SHA256"], {"_fuentes": ["Metadatos EXIF"]})
        db.add_edge(case_id, img["id"], h["id"], "sha256", "exif")
        if "_lat" in info:
            lat, lon = info["_lat"], info["_lon"]
            loc, _ = db.upsert_entity(case_id, "location", f"{lat}, {lon}", {
                "_lat": lat, "_lon": lon, "Precisión": "GPS de la foto",
                "_links": [["Google Maps", f"https://www.google.com/maps?q={lat},{lon}"],
                           ["OpenStreetMap", f"https://www.openstreetmap.org/?mlat={lat}&mlon={lon}#map=17/{lat}/{lon}"]],
                "_fuentes": ["Metadatos EXIF"],
            }, pivot=False)
            db.add_edge(case_id, img["id"], loc["id"], "tomada en", "exif")
        for key, rel in (("Autor", "autor"), ("Propietario cámara", "propietario"), ("Autor (Windows)", "autor")):
            if info.get(key) and len(info[key]) > 2:
                p, _ = db.upsert_entity(case_id, "person", info[key], {"_fuentes": ["Metadatos EXIF"]}, pivot=False)
                db.add_edge(case_id, img["id"], p["id"], rel, "exif")
        db.touch(case_id)
    return {"entity": img}


@app.get("/api/cases/{case_id}/export")
def export_case(case_id: int):
    case = _case(case_id)
    payload = {"exported": time.strftime("%Y-%m-%d %H:%M:%S"), "case": case, **db.graph(case_id)}
    name = "".join(ch if ch.isalnum() else "_" for ch in case["name"])[:40] or "caso"
    return Response(
        json.dumps(payload, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="osint_{name}.json"'},
    )


MAX_IMPORT_BYTES = 25 * 1024 * 1024
MAX_IMPORT_ITEMS = 50000


@app.post("/api/import")
async def import_case(file: UploadFile = File(...)):
    raw = await file.read(MAX_IMPORT_BYTES + 1)
    if len(raw) > MAX_IMPORT_BYTES:
        raise HTTPException(413, "Archivo demasiado grande (máx. 25 MB)")
    try:
        data = json.loads(raw)
    except ValueError as e:
        raise HTTPException(400, "JSON no válido") from e
    if not isinstance(data, dict) or not isinstance(data.get("case"), dict):
        raise HTTPException(400, "Archivo de caso no válido")
    src_case = data["case"]
    raw_entities = data.get("entities", [])
    raw_edges = data.get("edges", [])
    if not isinstance(raw_entities, list) or not isinstance(raw_edges, list):
        raise HTTPException(400, "Formato de entidades o aristas no válido")
    if len(raw_entities) > MAX_IMPORT_ITEMS or len(raw_edges) > MAX_IMPORT_ITEMS:
        raise HTTPException(400, f"El archivo supera el máximo de {MAX_IMPORT_ITEMS} elementos")

    validated_entities: list[tuple[str, str, dict, bool, bool, str | None]] = []
    for e in raw_entities:
        if not isinstance(e, dict):
            raise HTTPException(400, "Entidad mal formada en el archivo")
        etype = e.get("type")
        val = e.get("value")
        attrs = e.get("attrs") or {}
        if not isinstance(etype, str) or etype not in ENTITY_TYPES:
            raise HTTPException(400, f"Tipo de entidad no válido: {etype}")
        if not isinstance(val, str) or not val.strip() or len(val) > 4096:
            raise HTTPException(400, "Valor de entidad vacío o demasiado largo")
        if not isinstance(attrs, dict):
            raise HTTPException(400, "Atributos de entidad no válidos")
        orig_id = e.get("id") if isinstance(e.get("id"), str) else None
        validated_entities.append((etype, val, attrs, bool(e.get("root", False)), bool(e.get("pivot", True)), orig_id))

    with db.batch():
        case_name = str(src_case.get("name") or "Importado").strip()[:120] or "Importado"
        case = db.create_case(case_name + " (importado)")
        id_map: dict[str, str] = {}
        valid_ids: set[str] = set()
        for etype, val, attrs, is_root, is_pivot, orig_id in validated_entities:
            ent, _ = db.upsert_entity(case["id"], etype, val, attrs, root=is_root, pivot=is_pivot)
            valid_ids.add(ent["id"])
            id_map[ent["id"]] = ent["id"]
            if orig_id:
                id_map[orig_id] = ent["id"]

        for ed in raw_edges:
            if not isinstance(ed, dict):
                raise HTTPException(400, "Arista mal formada en el archivo")
            raw_src = ed.get("src")
            raw_dst = ed.get("dst")
            if not isinstance(raw_src, str) or not isinstance(raw_dst, str):
                raise HTTPException(400, "Arista con identificadores no válidos")
            src = id_map.get(raw_src)
            dst = id_map.get(raw_dst)
            if not src or not dst or src not in valid_ids or dst not in valid_ids:
                raise HTTPException(400, "Arista apunta a una entidad inexistente en el caso")
            if src == dst:
                continue
            label = " ".join(str(ed.get("label") or "relacionado").split())[:60] or "relacionado"
            source = str(ed.get("source") or "import").strip()[:60] or "import"
            db.add_edge(case["id"], src, dst, label, source)

        if isinstance(src_case.get("notes"), str) and src_case["notes"]:
            db.update_case(case["id"], notes=src_case["notes"][:200000])
        if isinstance(src_case.get("layout"), dict):
            db.update_case(case["id"], layout=src_case["layout"])
    return case


@app.get("/")
def index():
    html = (WEB_DIR / "index.html").read_text(encoding="utf-8")
    for asset in ("app.js", "style.css", "i18n.js", "i18n-en.js"):
        version = int((WEB_DIR / asset).stat().st_mtime)
        html = html.replace(f'"{asset}"', f'"{asset}?v={version}"')
    meta_tag = f'  <meta name="osint-token" content="{SESSION_TOKEN}">\n</head>'
    html = html.replace("</head>", meta_tag, 1)
    resp = Response(html, media_type="text/html", headers={"Cache-Control": "no-cache"})
    resp.set_cookie("osint_token", SESSION_TOKEN, samesite="strict", httponly=False, path="/")
    return resp


@app.middleware("http")
async def revalidate_static(request: Request, call_next):
    if request.url.path.startswith("/api/") and request.method in STATE_CHANGING_METHODS:
        token = request.headers.get("x-osint-token") or ""
        if not token or not secrets.compare_digest(token, SESSION_TOKEN):
            return JSONResponse({"detail": "Token de sesión no válido o ausente"}, status_code=403)
    response = await call_next(request)
    if not request.url.path.startswith(("/api/", "/vendor/")):
        response.headers.setdefault("Cache-Control", "no-cache")
    return response


app.mount("/", StaticFiles(directory=WEB_DIR), name="web")
