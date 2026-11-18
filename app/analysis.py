"""Análisis a nivel de caso: fotos de perfil repetidas, confianza de identidad y verificación con IA."""

import asyncio
import io
import json
import re
import time
import unicodedata
from collections import Counter, defaultdict

import httpx
from PIL import Image, ImageStat

from .config import settings
from .db import db
from .models import ENTITY_TYPES

CASE_EID = "case"
PHOTO_REL = "misma foto de perfil"
DEFAULT_AVATAR = re.compile(
    r"default|placeholder|no[-_]?avatar|blank|anonymous|silhouette|/avatar_default|d=mp|d=identicon|sticky/default_profile",
    re.I,
)
NAME_KEYS = ("Nombre", "Nombre visible", "Nombre real")


def _emit_entity(job, ent: dict | None) -> None:
    if ent:
        job.emit({"type": "entity", "entity": ent, "created": False})


def _record(job, module: str, status: str, message: str, found: int, started: float) -> None:
    run = db.add_run(job.case_id, CASE_EID, module, status, message, found, started)
    job.emit({"type": "run", "run": run})


# ---------------------------------------------------------------- fotos


def dhash(data: bytes) -> int | None:
    img = Image.open(io.BytesIO(data))
    img.seek(0)
    gray = img.convert("L")
    if ImageStat.Stat(gray).stddev[0] < 6:  # imagen casi plana: avatar genérico
        return None
    px = list(gray.resize((9, 8), Image.LANCZOS).getdata())
    bits = 0
    for row in range(8):
        for col in range(8):
            bits = (bits << 1) | int(px[row * 9 + col] > px[row * 9 + col + 1])
    return bits


async def _hash_avatar(http: httpx.AsyncClient, url: str) -> str:
    try:
        r = await http.get(url, timeout=12)
        if r.status_code != 200 or len(r.content) > 6_000_000 or "image" not in r.headers.get("content-type", "image"):
            return ""
        h = dhash(r.content)
        return f"{h:016x}" if h is not None else ""
    except Exception:  # noqa: BLE001  (formatos no soportados, errores de red...)
        return ""


async def photo_match(engine, job) -> None:
    started = time.time()
    graph = db.graph(job.case_id)
    targets = [
        e for e in graph["entities"]
        if isinstance(e["attrs"].get("_avatar"), str) and e["attrs"]["_avatar"].startswith("http")
        and not DEFAULT_AVATAR.search(e["attrs"]["_avatar"])
    ]
    todo = [e for e in targets if e["attrs"].get("_phash_src") != e["attrs"]["_avatar"]]
    sem = asyncio.Semaphore(8)

    async def one(e):
        async with sem:
            h = await _hash_avatar(engine.http, e["attrs"]["_avatar"])
            ent = db.update_attrs(job.case_id, e["id"], {"_phash": h, "_phash_src": e["attrs"]["_avatar"]}, replace=True)
            e["attrs"]["_phash"] = h
            _emit_entity(job, ent)

    await asyncio.gather(*(one(e) for e in todo))
    hashed = [(e, int(e["attrs"]["_phash"], 16)) for e in targets if e["attrs"].get("_phash")]
    if len(hashed) < 2:
        if todo:
            _record(job, "photo_match", "empty", f"{len(hashed)} fotos comparables", 0, started)
        return
    # Un mismo hash repetido en muchísimas cuentas suele ser una imagen genérica de la plataforma.
    counts = Counter(h for _, h in hashed)
    pairs = []
    for i in range(len(hashed)):
        for j in range(i + 1, len(hashed)):
            (a, ha), (b, hb) = hashed[i], hashed[j]
            if counts[ha] > 6 or counts[hb] > 6:
                continue
            # la misma URL de imagen en dos usuarios distintos de un sitio es la imagen genérica de ese sitio
            if a["attrs"]["_avatar"] == b["attrs"]["_avatar"] and a["attrs"].get("Plataforma") == b["attrs"].get("Plataforma"):
                continue
            dist = bin(ha ^ hb).count("1")
            if dist <= 6:
                pairs.append((a, b, dist))
    new = 0
    with db.batch():
        for a, b, dist in pairs:
            if db.add_edge(job.case_id, a["id"], b["id"], PHOTO_REL, "photo_match"):
                new += 1
                job.emit({"type": "edge", "edge": {"src": a["id"], "dst": b["id"], "label": PHOTO_REL, "source": "photo_match"}})
            sim = round(100 - dist * 100 / 64)
            for x, y in ((a, b), (b, a)):
                ent = db.update_attrs(job.case_id, x["id"], {"Foto coincide con": [f"{y['label']} ({sim}%)"]})
                _emit_entity(job, ent)
    if todo or new:
        _record(job, "photo_match", "ok" if pairs else "empty",
                f"{len(hashed)} fotos comparadas · {len(pairs)} coincidencias" + (f" ({new} nuevas)" if new else ""),
                len(pairs), started)


# ---------------------------------------------------------------- confianza de identidad


def _tokens(name: str) -> set[str]:
    name = unicodedata.normalize("NFKC", name or "")
    return {t for t in re.findall(r"[a-záéíóúñüçàèìòùâêîôûäëïöü]+", name.lower()) if len(t) >= 3}


def _overlap(toks: set[str], ref: set[str]) -> bool:
    """Palabras en común; un apodo cuenta si es el comienzo de la otra palabra («santi» → «santiago»)."""
    return any(t == r or (min(len(t), len(r)) >= 4 and (t.startswith(r) or r.startswith(t))) for t in toks for r in ref)


def score_identities(job) -> int:
    graph = db.graph(job.case_id)
    ents = {e["id"]: e for e in graph["entities"]}
    adj: dict[str, set[tuple[str, str]]] = defaultdict(set)
    for ed in graph["edges"]:
        adj[ed["src"]].add((ed["dst"], ed["label"]))
        adj[ed["dst"]].add((ed["src"], ed["label"]))
    accounts = [e for e in ents.values() if e["type"] == "account"]
    usernames = {e["value"].lower() for e in ents.values() if e["type"] == "username"}

    confirmed = {a["id"] for a in accounts if a["attrs"].get("_verdict") == "confirmada"}
    discarded = {a["id"] for a in accounts if a["attrs"].get("_verdict") == "descartada"}

    names: dict[str, tuple[str, set[str]]] = {}
    for a in accounts:
        for k in NAME_KEYS + ("Nombres en commits",):
            v = a["attrs"].get(k)
            if isinstance(v, list):
                v = v[0] if v else None
            if isinstance(v, str) and v.strip():
                toks = _tokens(v) - usernames
                if toks:
                    names[a["id"]] = (v.strip(), toks)
                break
    token_accounts = Counter(t for aid, (_, toks) in names.items() if aid not in discarded for t in toks)
    ref_tokens = {t for t, n in token_accounts.items() if n >= 2}
    ref_tokens |= {t for e in ents.values() if e["type"] == "person" and e.get("root") for t in _tokens(e["value"])}
    confirmed_tokens = {t for aid in confirmed if aid in names for t in names[aid][1]}
    linked_from = {ed["dst"]: ed["src"] for ed in graph["edges"] if ed["label"] in ("enlaza a", "misma clave SSH")}
    marks = {"confirmed": confirmed, "discarded": discarded, "confirmed_tokens": confirmed_tokens}

    scores: dict[str, int] = {}
    reasons: dict[str, list[str]] = {}
    # Dos pasadas: una cuenta enlazada desde otra hereda la confianza de la que la enlaza.
    for _ in range(2):
        for a in accounts:
            scores[a["id"]], reasons[a["id"]] = _score_account(a, ents, adj, names, ref_tokens, linked_from, scores, marks)

    changed = 0
    with db.batch():
        for a in accounts:
            at = a["attrs"]
            score, why = scores[a["id"]], reasons[a["id"]]
            level = "Alta" if score >= 70 else "Media" if score >= 40 else "Baja"
            if at.get("Confianza") != score or at.get("Señales") != why:
                ent = db.update_attrs(job.case_id, a["id"], {"Confianza": score, "Nivel de confianza": level, "Señales": why},
                                      replace=True)
                _emit_entity(job, ent)
                changed += 1
    return changed


def _score_account(a, ents, adj, names, ref_tokens, linked_from, prev_scores, marks) -> tuple[int, list[str]]:
    at = a["attrs"]
    if at.get("_verdict") == "confirmada":
        return 100, ["Confirmada por ti como cuenta de la persona investigada"]
    if at.get("_verdict") == "descartada":
        return 0, ["Descartada por ti: no es la persona investigada"]
    confirmed, discarded = marks["confirmed"], marks["discarded"]
    verif = str(at.get("Verificación") or "")
    why: list[str] = []
    if at.get("Registro"):
        score = 80
        why.append("El email investigado está registrado en este servicio")
    elif verif.startswith("Indicada en Wikidata"):
        score = 80
        why.append("Cuenta oficial según Wikidata")
    elif verif.startswith(("Enlazada desde", "Misma clave")) and a["id"] in linked_from:
        base = prev_scores.get(linked_from[a["id"]], 35)
        score = base + 10
        how = "comparten clave SSH" if verif.startswith("Misma clave") else "el propio dueño puso el enlace"
        src = linked_from[a["id"]]
        state = ("la confirmaste" if src in confirmed else "la descartaste" if src in discarded
                 else f"tiene confianza {base}")
        why.append(f"{verif} ({how}; esa cuenta {state})")
    elif verif.startswith("Existe"):
        score = 25
        why.append("Sólo se comprobó que el nombre de usuario existe")
    elif verif.startswith("Búsqueda web: perfil con el nombre completo"):
        score = 35
        why.append("Encontrada buscando el nombre completo: puede ser un homónimo")
    elif verif.startswith("Búsqueda web: coincidencia parcial"):
        score = 20
        why.append("Sólo coincide parte del nombre: revisa que sea la misma persona")
    elif verif.startswith("Sólo vista en archivo"):
        score = 25
        why.append("Sólo aparece en Internet Archive")
    else:
        score = 35
        why.append("Perfil con datos públicos")
    if a["id"] in names:
        v, toks = names[a["id"]]
        conf_toks = marks["confirmed_tokens"]
        if conf_toks and _overlap(toks, conf_toks):
            score += 25
            why.append(f"El nombre «{v}» coincide con el de una cuenta confirmada")
        elif conf_toks and len(toks) >= 2 and not _overlap(toks, ref_tokens):
            score -= 30
            why.append(f"El nombre «{v}» no coincide con el de las cuentas confirmadas")
        elif ref_tokens and _overlap(toks, ref_tokens):
            score += 20
            why.append(f"El nombre «{v}» coincide con otras cuentas")
        elif ref_tokens and len(toks) >= 2:
            score -= 25
            why.append(f"El nombre «{v}» no coincide con el resto de cuentas")
    if str(at.get("Página del perfil") or "").startswith("No existe"):
        score -= 15
        why.append("La página del perfil responde «no existe»: puede ser un falso positivo")
    photo_peers = [x for x, lbl in adj[a["id"]] if lbl == PHOTO_REL and x not in discarded]
    if any(x in confirmed for x in photo_peers):
        score += 40
        why.append("Usa la misma foto de perfil que una cuenta confirmada")
    elif photo_peers:
        score += 30
        why.append("Usa la misma foto de perfil que otra cuenta")
    shared, shared_confirmed = [], []
    for nb, _ in adj[a["id"]]:
        ne = ents.get(nb)
        if not ne or ne["type"] not in ("email", "url", "domain", "location", "phone"):
            continue
        others = [x for x, _ in adj[nb]
                  if x != a["id"] and x not in discarded and ents.get(x, {}).get("type") == "account"]
        label = f"{ENTITY_TYPES[ne['type']]['label'].lower()} {ne['label']}"
        if any(x in confirmed for x in others):
            shared_confirmed.append(label)
        elif others:
            shared.append(label)
    if shared_confirmed:
        score += min(40, 25 * len(shared_confirmed))
        why.append("Comparte " + ", ".join(shared_confirmed[:3]) + " con una cuenta confirmada")
    if shared:
        score += min(20, 10 * len(shared))
        why.append("Comparte " + ", ".join(shared[:3]) + " con otras cuentas")
    verdict = str(at.get("IA: veredicto") or "").lower()
    if verdict:
        if "otra persona" in verdict:
            score -= 30
        elif "misma persona" in verdict:
            score += 15
        why.append(f"IA: {at['IA: veredicto']}")
    # 100 queda reservado a lo que confirma el analista
    return max(0, min(95, score)), why


# ---------------------------------------------------------------- IA


AI_SYSTEM = (
    "Eres un analista OSINT riguroso. Recibes un objetivo y una lista de cuentas encontradas en Internet que podrían "
    "pertenecerle. Decide para cada cuenta si es la misma persona basándote sólo en los datos dados (nombre, bio, "
    "ubicación, fechas, enlaces, señales). Un nombre de usuario igual NO basta: es frecuente que otras personas usen el "
    "mismo alias. Las cuentas con confirmada_por_el_analista son de la persona con seguridad: úsalas como referencia "
    "para juzgar las demás. Responde exclusivamente con JSON válido, sin texto adicional, con esta forma: "
    '{"resumen": "perfil breve de la persona en {idioma} con lo que se puede afirmar con seguridad", '
    '"cuentas": [{"n": 0, "veredicto": "misma persona|probable|dudosa|otra persona", "motivo": "frase corta en {idioma}"}]}'
    " Los valores de «veredicto» van siempre tal cual, en español."
)


def _ai_system() -> str:
    return AI_SYSTEM.replace("{idioma}", "inglés" if settings.get("lang") == "en" else "español")


def _extract_json(text: str) -> dict:
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("La IA no devolvió JSON")
    return json.loads(text[start:end + 1])


async def ai_verify(engine, job) -> None:
    started = time.time()
    base = (settings.get("ai_base_url") or "").strip().rstrip("/")
    model = (settings.get("ai_model") or "").strip()
    if not base or not model:
        _record(job, "ai_verify", "skipped", "Configura un proveedor de IA en Ajustes (Ollama local, Groq, Gemini, OpenAI…)", 0, started)
        return
    graph = db.graph(job.case_id)
    roots = [e for e in graph["entities"] if e["root"]]
    accounts = sorted((e for e in graph["entities"] if e["type"] == "account" and e["attrs"].get("_verdict") != "descartada"),
                      key=lambda e: -(e["attrs"].get("Confianza") or 0))[:60]
    if not accounts:
        _record(job, "ai_verify", "empty", "No hay cuentas que verificar", 0, started)
        return

    def clip(v, n=220):
        return str(v)[:n] if v not in (None, "", []) else None

    items = []
    for i, a in enumerate(accounts):
        at = a["attrs"]
        item = {
            "n": i, "plataforma": at.get("Plataforma"), "usuario": at.get("Usuario"),
            "nombre": clip(at.get("Nombre") or at.get("Nombre visible") or at.get("Nombre real"), 80),
            "bio": clip(at.get("Bio") or at.get("Resumen")), "creada": clip(at.get("Creada") or at.get("Miembro desde"), 20),
            "señales": at.get("Señales"), "confianza_reglas": at.get("Confianza"),
            "fotos_iguales": at.get("Foto coincide con"),
            "confirmada_por_el_analista": True if at.get("_verdict") == "confirmada" else None,
        }
        items.append({k: v for k, v in item.items() if v not in (None, "", [])})
    target = [{"tipo": ENTITY_TYPES[r["type"]]["label"], "valor": r["value"]} for r in roots]
    persons = sorted({e["value"] for e in graph["entities"] if e["type"] == "person"})[:10]
    locations = sorted({e["value"] for e in graph["entities"] if e["type"] == "location"})[:10]
    user_msg = json.dumps({"objetivo": target, "nombres_vistos": persons, "ubicaciones_vistas": locations, "cuentas": items},
                          ensure_ascii=False)
    headers = {"Authorization": f"Bearer {settings.key('ai')}"} if settings.key("ai") else {}
    try:
        r = await engine.http.post(f"{base}/chat/completions", headers=headers, timeout=180, json={
            "model": model, "temperature": 0.1,
            "messages": [{"role": "system", "content": _ai_system()}, {"role": "user", "content": user_msg}],
        })
    except httpx.HTTPError as e:
        _record(job, "ai_verify", "error", f"No se pudo contactar con la IA ({type(e).__name__}). ¿Está en marcha?", 0, started)
        return
    if r.status_code != 200:
        _record(job, "ai_verify", "error", f"La IA respondió {r.status_code}: {r.text[:200]}", 0, started)
        return
    try:
        data = _extract_json(r.json()["choices"][0]["message"]["content"])
    except (ValueError, KeyError, IndexError, TypeError) as e:
        _record(job, "ai_verify", "error", f"Respuesta de IA no válida: {e}", 0, started)
        return
    n = 0
    for c in data.get("cuentas") or []:
        try:
            a = accounts[int(c.get("n"))]
        except (TypeError, ValueError, IndexError):
            continue
        ent = db.update_attrs(job.case_id, a["id"], {"IA: veredicto": str(c.get("veredicto") or "")[:40],
                                                     "IA: motivo": str(c.get("motivo") or "")[:300]}, replace=True)
        _emit_entity(job, ent)
        n += 1
    if data.get("resumen") and roots:
        ent = db.update_attrs(job.case_id, roots[0]["id"], {"IA: resumen": str(data["resumen"])[:2000], "IA: modelo": model},
                              replace=True)
        _emit_entity(job, ent)
    _record(job, "ai_verify", "ok", f"{n} cuentas evaluadas por {model}", n, started)


# ---------------------------------------------------------------- orquestación


async def run(engine, job, use_ai: bool) -> None:
    await photo_match(engine, job)
    score_identities(job)
    if use_ai:
        await ai_verify(engine, job)
        score_identities(job)
