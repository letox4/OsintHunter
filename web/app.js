"use strict";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
const link = (url, text) => {
  const u = safeUrl(url);
  return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(text ?? u)}</a>` : esc(text ?? url);
};

function getSessionToken() {
  const meta = document.querySelector('meta[name="osint-token"]')?.content;
  if (meta) return meta;
  const m = document.cookie.match(/(?:^|;\s*)osint_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

async function api(path, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const token = getSessionToken();
  const headers = {
    ...(opts.body && !isForm ? { "Content-Type": "application/json" } : {}),
    ...(token ? { "X-Osint-Token": token } : {}),
    ...(opts.headers || {}),
  };
  const res = await fetch(path, {
    ...opts,
    headers,
    body: opts.body && !isForm ? JSON.stringify(opts.body) : opts.body,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch { /* sin cuerpo */ }
    throw new Error(msg);
  }
  return res.json();
}

const S = {
  meta: null,
  types: {},
  modules: {},
  cases: [],
  caseId: null,
  entities: new Map(),
  edges: [],
  runs: [],
  running: new Map(), // "eid|module" -> true
  selected: null,
  hidden: new Set(),
  jobs: new Map(), // jobId -> caseId
  tab: "graph",
  hideLow: false,
  listSel: new Set(),
  layout: { groups: [], collapsed: [] },
  fold: new Map(), // nodo plegado -> nº de nodos escondidos
  hiddenBy: new Map(), // nodo escondido -> nodo o burbuja que lo representa
};
let cy = null;

// ---------------------------------------------------------------- utilidades UI
let toastTimer;
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 3500);
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const typeInfo = (t) => S.types[t] || { label: t, color: "#999", shape: "ellipse" };
const badge = (t) => `<span class="badge" style="background:${typeInfo(t).color}">${esc(typeInfo(t).label)}</span>`;
const short = (s, n = 30) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// ---------------------------------------------------------------- grafo
function initGraph() {
  cy = cytoscape({
    container: $("#cy"),
    wheelSensitivity: 0.25,
    minZoom: 0.08,
    maxZoom: 3,
    boxSelectionEnabled: true,
    style: [
      { selector: "node", style: {
        "background-color": "data(color)", shape: "data(shape)", label: "data(short)", color: "#e6dace",
        "font-size": 10, "text-valign": "bottom", "text-margin-y": 4, width: "data(size)", height: "data(size)",
        "text-outline-color": "#0a0806", "text-outline-width": 2, "border-width": 0, "min-zoomed-font-size": 6 } },
      { selector: 'node[conf = "Alta"]', style: { "border-width": 3, "border-color": "#4caf50" } },
      { selector: 'node[conf = "Media"]', style: { "border-width": 2, "border-color": "#ffb300" } },
      { selector: 'node[conf = "Baja"]', style: { "border-width": 1.5, "border-color": "#6e3b2c", opacity: 0.72 } },
      { selector: 'node[verdict = "confirmada"]', style: { "border-width": 4, "border-color": "#3ddc84", opacity: 1,
        color: "#9ff0c0", "underlay-color": "#3ddc84", "underlay-opacity": 0.22, "underlay-padding": 6 } },
      { selector: 'node[verdict = "descartada"]', style: { "border-width": 2, "border-color": "#5a5048", "border-style": "dashed",
        opacity: 0.3, color: "#8a7f75" } },
      { selector: "node.folded", style: { "border-width": 5, "border-style": "double", "border-color": "#ffd166" } },
      { selector: "node[?root]", style: { "border-width": 4, "border-color": "#ff7a1a", "font-weight": "bold", "font-size": 12,
        color: "#ffb066", "underlay-color": "#ff7a1a", "underlay-opacity": 0.18, "underlay-padding": 10, "underlay-shape": "ellipse" } },
      { selector: "node.scanning", style: { "border-width": 3, "border-color": "#ffd166", "border-style": "dashed" } },
      { selector: "node[?isGroup]", style: { shape: "round-rectangle", "background-color": "data(color)", "background-opacity": 0.07,
        "border-width": 1.5, "border-style": "dashed", "border-color": "data(color)", "border-opacity": 0.8, label: "data(short)",
        color: "data(color)", "font-size": 14, "font-weight": "bold", "text-valign": "top", "text-halign": "center", "text-margin-y": -6,
        padding: 24, "compound-sizing-wrt-labels": "include", "underlay-opacity": 0 } },
      { selector: "node[?isGroup].grp-collapsed", style: { "background-opacity": 0.4, "border-style": "double", "border-width": 5,
        "text-valign": "bottom", "text-margin-y": 6, "font-size": 12 } },
      { selector: "node:selected", style: { "border-width": 4, "border-color": "#ffa04d", "border-style": "solid",
        "underlay-color": "#ff7a1a", "underlay-opacity": 0.3, "underlay-padding": 8 } },
      { selector: "node[?isGroup]:selected", style: { "underlay-opacity": 0, "border-width": 3, "border-color": "data(color)", "background-opacity": 0.14 } },
      { selector: "edge", style: {
        width: 1.2, "line-color": "#3d2f22", "target-arrow-color": "#3d2f22", "target-arrow-shape": "triangle",
        "arrow-scale": 0.7, "curve-style": "bezier", label: "data(label)", "font-size": 8, color: "#c9a383",
        "text-rotation": "autorotate", "text-opacity": 0, "text-outline-color": "#0a0806", "text-outline-width": 2 } },
      { selector: "edge.hl", style: { "line-color": "#ff7a1a", "target-arrow-color": "#ff7a1a", "text-opacity": 1, width: 2 } },
      { selector: ".faded", style: { opacity: 0.12 } },
      { selector: "edge.meta", style: { "line-style": "dashed", "line-color": "#6b4a2c", "target-arrow-color": "#6b4a2c", width: 1.6 } },
      { selector: ".type-hidden, .low-hidden, .fold-hidden", style: { display: "none" } },
    ],
  });
  cy.on("tap", "node", (e) => {
    const oe = e.originalEvent;
    if (oe && (oe.ctrlKey || oe.metaKey || oe.shiftKey)) return;
    select(e.target.id());
  });
  cy.on("tap", (e) => { if (e.target === cy && !(e.originalEvent?.shiftKey || e.originalEvent?.ctrlKey)) select(null); });
  cy.on("select unselect", "node", () => updateSelBarSoon());
  let lastDbl = null;
  cy.on("dbltap", "node", (e) => {
    if (e.originalEvent && e.originalEvent === lastDbl) return;
    lastDbl = e.originalEvent;
    if (e.target.data("isGroup")) toggleGroup(e.target.id().slice(4));
    else openPivot(e.target.id());
  });
  cy.on("mouseover", "node", (e) => {
    if (e.target.data("isGroup")) return;
    const n = e.target.closedNeighborhood();
    cy.elements().not(n).addClass("faded");
    n.edges().addClass("hl");
  });
  cy.on("mouseout", "node", () => cy.elements().removeClass("faded hl"));
  new ResizeObserver(() => cy.resize()).observe($("#cy"));
}

function nodeData(ent) {
  const t = typeInfo(ent.type);
  const size = ent.root ? 46 : ent.type === "account" ? 24 : ent.type === "breach" ? 26 : 32;
  const conf = ent.attrs?.["Nivel de confianza"] || "";
  const verdict = ent.attrs?._verdict || "";
  const folded = S.fold.get(ent.id);
  const label = (verdict === "confirmada" ? "✔ " : "") + short(ent.label, 28) + (folded ? `  ⊕${folded}` : "");
  return { id: ent.id, color: t.color, shape: t.shape, short: label, size, root: ent.root, etype: ent.type, conf, verdict };
}

const applyLowFilter = (n) => n.toggleClass("low-hidden",
  S.hideLow && (n.data("conf") === "Baja" || n.data("verdict") === "descartada"));

function upsertNode(ent, parentHint) {
  S.entities.set(ent.id, ent);
  const existing = cy.getElementById(ent.id);
  if (existing.length) {
    existing.data(nodeData(ent));
    applyLowFilter(existing);
    return false;
  }
  let pos = { x: 0, y: 0 };
  const parent = parentHint && cy.getElementById(parentHint);
  if (parent && parent.length) {
    const p = parent.position();
    pos = { x: p.x + (Math.random() - 0.5) * 160, y: p.y + (Math.random() - 0.5) * 160 };
  } else if (cy.nodes().length) {
    const bb = cy.nodes().boundingBox();
    pos = { x: bb.x1 + Math.random() * bb.w, y: bb.y1 + Math.random() * bb.h };
  }
  const n = cy.add({ group: "nodes", data: nodeData(ent), position: pos });
  if (S.hidden.has(ent.type)) n.addClass("type-hidden");
  applyLowFilter(n);
  if (S.layout.groups.length || S.layout.collapsed.length) applyGroupingSoon();
  return true;
}

$("#hideLowChk").addEventListener("change", (ev) => {
  S.hideLow = ev.target.checked;
  cy.nodes().forEach(applyLowFilter);
  if (S.tab === "map") renderMap();
  if (S.tab === "timeline") renderTimeline();
});

function addEdge(e) {
  const id = `${e.src}→${e.dst}|${e.label}`;
  if (!S.edges.some((x) => `${x.src}→${x.dst}|${x.label}` === id)) S.edges.push(e);
  if (cy.getElementById(id).length) return;
  if (!cy.getElementById(e.src).length || !cy.getElementById(e.dst).length) return;
  cy.add({ group: "edges", data: { id, source: e.src, target: e.dst, label: I18N.tr(e.label) } });
}

let firstLayout = true;
const hasFcose = typeof cytoscapeFcose !== "undefined";
if (hasFcose) cytoscape.use(cytoscapeFcose);

function runLayout(fit, randomize = false) {
  const shown = cy.nodes().not(".fold-hidden, .type-hidden, .low-hidden");
  if (!shown.length) return;
  const many = shown.length > 300;
  const common = { animate: !many, animationDuration: 600, fit: fit ?? (firstLayout || shown.length < 40), padding: 40 };
  const layout = shown.union(shown.edgesWith(shown)).layout(hasFcose ? {
    ...common,
    name: "fcose",
    quality: many ? "draft" : "default",
    randomize,
    nodeSeparation: 90,
    nodeRepulsion: () => 9000,
    idealEdgeLength: (e) => (e.target().data("etype") === "account" ? 70 : 110),
    edgeElasticity: () => 0.45,
    gravity: 0.25,
    gravityRangeCompound: 1.5,
    numIter: 2500,
    packComponents: true,
  } : { ...common, name: "cose", randomize, nodeRepulsion: () => 12000, idealEdgeLength: () => 80 });
  cy.one("layoutstop", () => { if (cy.zoom() > 1.6) { cy.zoom(1.6); cy.center(); } });
  layout.run();
  firstLayout = false;
}
const scheduleLayout = debounce(() => runLayout(), 700);

function renderLegend() {
  const counts = {};
  for (const e of S.entities.values()) counts[e.type] = (counts[e.type] || 0) + 1;
  $("#legend").innerHTML = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `<span class="chip ${S.hidden.has(t) ? "off" : ""}" data-type="${esc(t)}"><span class="dot" style="background:${typeInfo(t).color}"></span><span>${esc(typeInfo(t).label)}</span> ${n}</span>`)
    .join("");
  $("#emptyState").classList.toggle("hidden", S.entities.size > 0);
}
const renderLegendSoon = debounce(renderLegend, 200);

$("#legend").addEventListener("click", (ev) => {
  const chip = ev.target.closest(".chip");
  if (!chip) return;
  const t = chip.dataset.type;
  S.hidden.has(t) ? S.hidden.delete(t) : S.hidden.add(t);
  cy.nodes().filter((n) => n.data("etype") === t).toggleClass("type-hidden", S.hidden.has(t));
  renderLegend();
});

// ---------------------------------------------------------------- casos
async function loadCases(selectId) {
  S.cases = await api("/api/cases");
  const sel = $("#caseSelect");
  sel.innerHTML = S.cases.length
    ? S.cases.map((c) => `<option value="${c.id}">${esc(c.name)} (${c.entities})</option>`).join("")
    : `<option value="">— Sin casos —</option>`;
  if (selectId) sel.value = String(selectId);
  else if (S.caseId) sel.value = String(S.caseId);
}

async function openCase(id) {
  S.caseId = id ? Number(id) : null;
  localStorage.setItem("osint-case", S.caseId ?? "");
  cy.elements().remove();
  S.entities.clear(); S.edges = []; S.runs = []; S.running.clear(); S.selected = null; S.listSel.clear();
  S.layout = { groups: [], collapsed: [] };
  firstLayout = true;
  mapFitted = false;
  renderDetails();
  if (!S.caseId) { renderAll(); return; }
  const data = await api(`/api/cases/${S.caseId}`);
  $("#caseSelect").value = String(S.caseId);
  $("#notesArea").value = data.case.notes || "";
  S.layout = { groups: [], collapsed: [], ...(data.case.layout || {}) };
  S.fold = new Map();
  S.hiddenBy = new Map();
  data.entities.forEach((e) => upsertNode(e));
  data.edges.forEach(addEdge);
  S.runs = data.runs;
  applyGrouping();
  renderAll();
  runLayout(true, true);
}

function renderAll() {
  renderLegend();
  renderSources();
  refreshView();
}

/** Cuentas de las que sólo se sabe que existen y cuya página aún no se leyó (misma regla que AccountPage.applies). */
const NO_PAGE_PLATFORMS = new Set(["Facebook", "LinkedIn", "Instagram", "TikTok", "X/Twitter", "Pinterest"]);
function unreadAccounts() {
  const done = new Set(S.runs.filter((r) => r.module === "account_page" && r.status !== "error").map((r) => r.entity_id));
  return [...S.entities.values()].filter((e) => e.type === "account" && !done.has(e.id)
    && !NO_PAGE_PLATFORMS.has(e.attrs?.Plataforma)
    && !["Nombre", "Nombre visible", "Nombre real", "_avatar"].some((k) => e.attrs?.[k]));
}
function updateReadBtn() {
  const n = S.caseId ? unreadAccounts().length : 0;
  const busy = [...S.running.keys()].some((k) => k.endsWith("|account_page"));
  $("#readBtn").classList.toggle("hidden", !n && !busy);
  $("#readBtn").disabled = busy;
  $("#readBtn").textContent = busy ? "Leyendo perfiles…" : `Leer perfiles (${n})`;
}

function refreshView() {
  updateReadBtn();
  if (S.tab === "list") renderList();
  if (S.tab === "map") renderMap();
  if (S.tab === "timeline") renderTimeline();
}
const refreshViewSoon = debounce(refreshView, 400);

async function ensureCase(defaultName) {
  if (S.caseId) return S.caseId;
  const c = await api("/api/cases", { method: "POST", body: { name: defaultName } });
  await loadCases(c.id);
  await openCase(c.id);
  return c.id;
}

$("#caseSelect").addEventListener("change", (e) => openCase(e.target.value));
$("#newCaseBtn").addEventListener("click", async () => {
  const name = prompt("Nombre del nuevo caso:", "Investigación " + new Date().toLocaleDateString());
  if (name === null) return;
  const c = await api("/api/cases", { method: "POST", body: { name } });
  await loadCases(c.id);
  await openCase(c.id);
  $("#searchInput").focus();
});
$("#renameCaseBtn").addEventListener("click", async () => {
  if (!S.caseId) return;
  const cur = S.cases.find((c) => c.id === S.caseId);
  const name = prompt("Nuevo nombre:", cur?.name || "");
  if (!name) return;
  await api(`/api/cases/${S.caseId}`, { method: "PATCH", body: { name } });
  await loadCases();
});
$("#deleteCaseBtn").addEventListener("click", async () => {
  if (!S.caseId) return;
  const cur = S.cases.find((c) => c.id === S.caseId);
  if (!confirm(`¿Eliminar el caso «${cur?.name}» y todos sus datos?`)) return;
  await api(`/api/cases/${S.caseId}`, { method: "DELETE" });
  await loadCases();
  await openCase(S.cases[0]?.id ?? null);
});

// ---------------------------------------------------------------- búsqueda
function fillTypeSelect(detected) {
  const opts = Object.entries(S.types).filter(([, v]) => v.input);
  const autoLabel = detected ? `Auto: ${typeInfo(detected).label}` : "Tipo: automático";
  const cur = $("#typeSelect").value;
  $("#typeSelect").innerHTML = `<option value="">${esc(autoLabel)}</option>` +
    opts.map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("");
  $("#typeSelect").value = cur;
}
const detectSoon = debounce(async () => {
  const v = $("#searchInput").value.trim();
  if (!v) return fillTypeSelect(null);
  try { fillTypeSelect((await api("/api/detect", { method: "POST", body: { value: v } })).type); } catch { /* ignorar */ }
}, 250);
$("#searchInput").addEventListener("input", detectSoon);

$("#searchForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const value = $("#searchInput").value.trim();
  if (!value) return;
  try {
    await ensureCase(value);
    const ent = await api(`/api/cases/${S.caseId}/entities`, { method: "POST", body: { value, type: $("#typeSelect").value || null } });
    upsertNode(ent);
    renderLegend();
    select(ent.id);
    scheduleLayout();
    await startScan(ent.id, null, Number($("#depthSelect").value));
    $("#searchInput").value = "";
    fillTypeSelect(null);
    loadCases();
  } catch (e) { toast(e.message, true); }
});

$("#imageInput").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  try {
    await ensureCase("Imagen " + file.name);
    const fd = new FormData();
    fd.append("file", file);
    const { entity } = await api(`/api/cases/${S.caseId}/image`, { method: "POST", body: fd });
    await openCase(S.caseId);
    select(entity.id);
    toast("Imagen analizada");
  } catch (e) { toast(e.message, true); }
});

// ---------------------------------------------------------------- escaneos en vivo
async function startScan(eid, modules, depth) {
  const { job_id } = await api(`/api/cases/${S.caseId}/scan`, { method: "POST", body: { entity_id: eid, modules, depth } });
  followJob(job_id);
}

function followJob(job_id) {
  S.jobs.set(job_id, S.caseId);
  updateJobStatus();
  const es = new EventSource(`/api/jobs/${job_id}/events`);
  const end = () => { es.close(); S.jobs.delete(job_id); updateJobStatus(); };
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (S.jobs.get(job_id) === S.caseId) handleEvent(ev);
    if (ev.type === "done") {
      end();
      toast(ev.analysis ? "Análisis del caso terminado"
        : `Investigación terminada (${ev.scanned} ${ev.scanned === 1 ? "entidad analizada" : "entidades analizadas"})`);
      loadCases();
    }
    if (ev.type === "error") { end(); toast("Error: " + ev.message, true); }
  };
  es.onerror = end;
}

$("#readBtn").addEventListener("click", async () => {
  if (!S.caseId) return;
  try {
    const { job_id } = await api(`/api/cases/${S.caseId}/read-accounts`, { method: "POST" });
    toast("Leyendo la página pública de cada cuenta sin datos…");
    followJob(job_id);
  } catch (e) { toast(e.message, true); }
});

$("#aiBtn").addEventListener("click", async () => {
  if (!S.caseId || !S.entities.size) return toast("Primero investiga algo");
  if (!S.meta.ai_ready) { toast("Configura un proveedor de IA en Ajustes (Ollama local, Groq o Gemini son gratis)"); return openSettings(); }
  try {
    const { job_id } = await api(`/api/cases/${S.caseId}/analyze`, { method: "POST", body: { ai: true } });
    toast("La IA está comparando las cuentas…");
    followJob(job_id);
  } catch (e) { toast(e.message, true); }
});

function updateJobStatus() {
  $("#jobStatus").innerHTML = S.jobs.size ? `<span class="st-running">● trabajando</span>` : "";
}

function handleEvent(ev) {
  switch (ev.type) {
    case "entity": {
      const created = upsertNode(ev.entity, S.lastParent);
      if (created) { scheduleLayout(); renderLegendSoon(); }
      if (S.selected === ev.entity.id) renderDetails();
      refreshViewSoon();
      break;
    }
    case "edge":
      addEdge(ev.edge);
      if (S.selected === ev.edge.src || S.selected === ev.edge.dst) renderDetailsSoon();
      break;
    case "scan_entity":
      S.lastParent = ev.entity_id;
      cy.getElementById(ev.entity_id).addClass("scanning");
      break;
    case "run_start":
      S.running.set(`${ev.entity_id}|${ev.module}`, true);
      renderSourcesSoon();
      break;
    case "run": {
      const r = ev.run;
      S.running.delete(`${r.entity_id}|${r.module}`);
      S.runs.push(r);
      if (![...S.running.keys()].some((k) => k.startsWith(r.entity_id + "|"))) cy.getElementById(r.entity_id).removeClass("scanning");
      renderSourcesSoon();
      if (S.selected === r.entity_id) renderDetailsSoon();
      if (r.module === "account_page") refreshViewSoon();
      break;
    }
  }
}

// ---------------------------------------------------------------- panel de fuentes
const STATUS = {
  ok: ["✔", "st-ok"], empty: ["○", "st-empty"], skipped: ["!", "st-skipped"], error: ["✖", "st-error"], running: ["●", "st-running"],
};
function renderSources() {
  const groups = new Map();
  const add = (eid, item) => { if (!groups.has(eid)) groups.set(eid, new Map()); groups.get(eid).set(item.module, item); };
  for (const r of S.runs) add(r.entity_id, r);
  for (const k of S.running.keys()) { const [eid, module] = splitKey(k); add(eid, { module, status: "running", message: "Consultando…" }); }
  if (!groups.size) { $("#sourcesList").innerHTML = `<div class="muted small">Aún no hay consultas.</div>`; return; }
  const order = [...groups.keys()].reverse();
  $("#sourcesList").innerHTML = order.map((eid) => {
    const ent = S.entities.get(eid);
    const items = [...groups.get(eid).values()].sort((a, b) => (a.status === "running" ? -1 : 0) - (b.status === "running" ? -1 : 0));
    const title = ent ? badge(ent.type) + " " + esc(ent.label) : eid === "case" ? "Análisis del caso" : esc(eid);
    return `<div><div class="src-group-title" data-eid="${esc(eid)}">${title}</div>` +
      items.map((r) => {
        const [icon, cls] = STATUS[r.status] || ["?", ""];
        const title = S.modules[r.module]?.title || r.module;
        return `<div class="src"><span class="${cls}">${icon}</span><span>${esc(title)}</span><span class="msg">${esc(r.message || "")}</span></div>`;
      }).join("") + `</div>`;
  }).join("");
}
function splitKey(k) { const i = k.lastIndexOf("|"); return [k.slice(0, i), k.slice(i + 1)]; }
const renderSourcesSoon = debounce(renderSources, 150);
$("#sourcesList").addEventListener("click", (ev) => {
  const t = ev.target.closest(".src-group-title");
  if (t && S.entities.has(t.dataset.eid)) select(t.dataset.eid, true);
});

// ---------------------------------------------------------------- panel de detalles
function select(id, center = false) {
  if (id && !isGroupId(id)) reveal(id);
  S.selected = id;
  cy.nodes().unselect();
  if (id) {
    const n = cy.getElementById(id);
    n.select();
    if (center && n.length) cy.animate({ center: { eles: n }, zoom: Math.max(cy.zoom(), 1) }, { duration: 300 });
  }
  renderDetails();
}

function fmtValue(v) {
  if (Array.isArray(v)) {
    if (!v.length) return "";
    const items = v.map((x) => `<li>${fmtValue(x)}</li>`).join("");
    return v.length > 12 ? `<details><summary>${v.length} elementos</summary><ul>${items}</ul></details>` : `<ul>${items}</ul>`;
  }
  if (v && typeof v === "object") return `<ul>${Object.entries(v).map(([k, x]) => `<li><b>${esc(k)}:</b> ${fmtValue(x)}</li>`).join("")}</ul>`;
  if (typeof v === "string" && safeUrl(v)) return link(v);
  return esc(v);
}

const ANALYSIS_KEYS = new Set(["Confianza", "Nivel de confianza", "Señales", "IA: veredicto", "IA: motivo", "IA: resumen", "IA: modelo"]);
const REVERSE_SEARCH = [
  ["Google Lens", "https://lens.google.com/uploadbyurl?url="],
  ["Yandex Imágenes (el mejor para caras)", "https://yandex.com/images/search?rpt=imageview&url="],
  ["Bing Visual Search", "https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:"],
  ["TinEye", "https://tineye.com/search?url="],
];

function renderDorks(dorks) {
  const groups = new Map();
  for (const [label, url, group] of dorks) {
    const g = group || "Búsquedas";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(link(url, label));
  }
  return [...groups].map(([g, links], i) =>
    `<details class="dork-group"${i === 0 ? " open" : ""}><summary>${esc(g)} <span class="muted">(${links.length})</span></summary><div class="linklist">${links.join("")}</div></details>`).join("");
}

const LINK_RELS = ["usa el alias", "alias de", "su cuenta", "es cuenta de", "es la misma persona", "familiar de",
  "pareja de", "amigo de", "trabaja en", "estudió en", "vive en", "relacionado con"];

function defaultRel(from, to) {
  if (!to) return "relacionado con";
  const pair = `${from.type}>${to.type}`;
  return { "person>username": "usa el alias", "username>person": "alias de", "person>account": "su cuenta",
    "account>person": "es cuenta de", "account>username": "es cuenta de", "person>person": "relacionado con",
    "person>organization": "trabaja en", "person>location": "vive en", "username>username": "es la misma persona" }[pair] || "relacionado con";
}

function linkBox(ent) {
  const others = [...S.entities.values()].filter((e) => e.id !== ent.id)
    .sort((a, b) => (b.root - a.root) || a.type.localeCompare(b.type) || a.label.localeCompare(b.label));
  if (!others.length) return "";
  const opts = others.map((e) => `<option value="${esc(e.id)}">${e.root ? "★ " : ""}${esc(typeInfo(e.type).label)} · ${esc(short(e.label, 50))}</option>`).join("");
  return `<details class="dork-group link-box"><summary>Vincular con otra entidad</summary>
    <div class="muted small" style="margin-bottom:6px">Une a mano dos nodos que sabes que están relacionados (por ejemplo, el nombre con su alias).</div>
    <label class="small">Con<select id="linkTarget">${opts}</select></label>
    <label class="small">Relación<input id="linkRel" list="linkRels" value="${esc(defaultRel(ent, others[0]))}"></label>
    <datalist id="linkRels">${LINK_RELS.map((r) => `<option value="${esc(r)}">`).join("")}</datalist>
    <button class="primary small" data-act="link" style="margin-top:6px">Vincular</button></details>`;
}

function verdictBox(verdict, isAccount) {
  const btn = (v, text, cls) => `<button class="small ${verdict === v ? `on ${cls}` : "ghost"}" data-verdict="${v}">${text}</button>`;
  const note = verdict === "confirmada"
    ? (isAccount ? "Confirmada: cuenta con 100 de confianza y referencia para juzgar las demás." : "Confirmado por ti.")
    : verdict === "descartada" ? "Descartada: queda atenuada y no cuenta en el análisis."
    : "¿Es de la persona que investigas? Tu decisión manda sobre la puntuación automática.";
  return `<div class="section verdict ${esc(verdict || "")}">
    <div class="verdict-btns">${btn("confirmada", "✔ Es la persona", "yes")}${btn("descartada", "✕ No es", "no")}${btn("", "Sin revisar", "")}</div>
    <div class="muted small">${note}</div></div>`;
}

function renderWebHits(hits, engine) {
  const exact = hits.filter((h) => h.kind === "exacta");
  const partial = hits.filter((h) => h.kind !== "exacta");
  const item = (h, i) => {
    const inGraph = h.platform && S.entities.has(`account:${h.url.replace(/\/+$/, "").toLowerCase()}`);
    return `<div class="web-hit">
      <div>${h.platform ? `<span class="tag">${esc(h.platform)}</span> ` : ""}${link(h.url, h.title || h.url)}</div>
      ${h.snippet ? `<div class="muted small">${esc(h.snippet)}</div>` : ""}
      <div class="web-hit-foot">
        ${h.kind !== "exacta" ? `<span class="muted small">Coincide: «${esc(h.variant)}»</span>` : "<span></span>"}
        ${h.platform ? (inGraph ? `<span class="muted small">En el grafo</span>`
          : `<button class="ghost small" data-webadd="${i}">Añadir al caso</button>`) : ""}
      </div></div>`;
  };
  const group = (title, list, note, open) => list.length ? `<details class="dork-group"${open ? " open" : ""}>
      <summary>${esc(title)} <span class="muted">(${list.length})</span></summary>
      ${note ? `<div class="muted small" style="margin:4px 0">${esc(note)}</div>` : ""}
      ${list.map((h) => item(h, hits.indexOf(h))).join("")}</details>` : "";
  return `<div class="section"><h4>Resultados web (${hits.length})</h4>
    ${group("Con el nombre completo", exact, "", true)}
    ${group("Coincidencias parciales", partial, "Aparece sólo una parte del nombre (por ejemplo, sin el segundo nombre). Puede ser la persona o un homónimo: revísalo antes de añadirlo.", !exact.length)}
    ${engine ? `<div class="muted small" style="margin-top:4px">Buscado con ${esc(engine)}</div>` : ""}</div>`;
}

function renderDetails() {
  const box = $("#details");
  if (isGroupId(S.selected) && groupById(S.selected.slice(4))) return renderGroupDetails(box, groupById(S.selected.slice(4)));
  const ent = S.selected && S.entities.get(S.selected);
  if (!ent) { box.innerHTML = `<div class="placeholder muted">Selecciona un nodo para ver sus datos.</div>`; return; }
  const a = ent.attrs || {};
  const avatar = safeUrl(a._avatar);
  const canScan = typeInfo(ent.type).input;
  const rows = Object.entries(a).filter(([k, v]) => !k.startsWith("_") && !ANALYSIS_KEYS.has(k) && v !== null && v !== "")
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${fmtValue(v)}</td></tr>`).join("");
  const level = a["Nivel de confianza"];
  const confBox = a.Confianza != null ? `<div class="section"><h4>¿Es la misma persona?</h4>
      <div>Confianza <b>${esc(a.Confianza)}</b>/100 <span class="conf ${esc(level)}">${esc(level)}</span></div>
      ${(a["Señales"] || []).length ? `<ul class="signals">${a["Señales"].map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
      ${a["IA: veredicto"] ? `<div class="ai-box" style="margin-top:6px"><b>IA:</b> ${esc(a["IA: veredicto"])}${a["IA: motivo"] ? ` — ${esc(a["IA: motivo"])}` : ""}</div>` : ""}
    </div>` : "";
  const aiSummary = a["IA: resumen"] ? `<div class="section"><h4>Resumen de la IA</h4><div class="ai-box">${esc(a["IA: resumen"])}
      ${a["IA: modelo"] ? `<div class="muted small" style="margin-top:4px">Modelo: ${esc(a["IA: modelo"])}</div>` : ""}</div></div>` : "";
  const reverse = avatar ? REVERSE_SEARCH.map(([name, base]) => link(base + encodeURIComponent(avatar), name)).join("") : "";
  const links = [...(a._links || [])];
  if (ent.type === "url" || ent.type === "account") links.unshift(["Abrir", ent.value]);
  if (a._lat != null && a._lon != null) links.push(["Ver en Google Maps", `https://www.google.com/maps?q=${a._lat},${a._lon}`]);
  const uniqLinks = links.filter((l, i) => safeUrl(l[1]) && links.findIndex((x) => x[1] === l[1]) === i);
  const plainLinks = uniqLinks.filter((l) => !(l[2] || []).length);
  const fillLinks = uniqLinks.filter((l) => (l[2] || []).length);
  const fillBox = fillLinks.length ? `<div class="section"><h4>Consultas con captcha</h4>
      <div class="muted small">Al abrir el sitio se copia el dato: pégalo con Ctrl+V, resuelve el captcha y consulta.</div>
      ${fillLinks.map((l) => `<div class="fill-link">
        <a href="${esc(safeUrl(l[1]))}" target="_blank" rel="noopener noreferrer" data-fillcopy="${esc(l[2][0][1])}">${esc(l[0])}</a>
        <div class="fill-vals">${l[2].map(([k, v]) => `<button class="fill-val" data-copyval="${esc(v)}" title="Copiar">${esc(k)}: <b>${esc(v)}</b></button>`).join("")}</div>
      </div>`).join("")}</div>` : "";

  const conns = [];
  for (const e of S.edges) {
    if (e.src === ent.id && S.entities.has(e.dst)) conns.push(["→", e.label, S.entities.get(e.dst), e]);
    else if (e.dst === ent.id && S.entities.has(e.src)) conns.push(["←", e.label, S.entities.get(e.src), e]);
  }
  const runs = S.runs.filter((r) => r.entity_id === ent.id);
  const latest = new Map(runs.map((r) => [r.module, r]));
  const isFolded = S.layout.collapsed.includes(ent.id);
  const nFound = isFolded ? S.fold.get(ent.id) || 0 : foundBy(ent.id, true).length;
  const myGroup = S.layout.groups.find((g) => g.members?.includes(ent.id));
  const deepMods = Object.values(S.modules).filter((m) => m.deep && m.inputs.includes(ent.type));
  const manual = ent.type === "username" ? manualChecks(ent) : [];
  const nUsers = [...S.entities.values()].filter((e) => e.type === "username").length;
  const deepBox = deepMods.length ? `<div class="section deep-box"><h4>¿No encontraste mucho? Buscar a fondo</h4>
      ${deepMods.map((m) => {
        const r = latest.get(m.name);
        const busy = S.running.has(`${ent.id}|${m.name}`);
        const retry = m.name === "retry_blocked";
        const label = retry && manual.length && !r ? `${m.title} (${manual.length})` : m.title;
        return `<div class="deep-item"><button class="small" data-deep="${esc(m.name)}" ${busy ? "disabled" : ""}>${busy ? "Buscando…" : esc(label)}</button>
          <span class="muted small">${esc(r ? r.message || "" : m.description)}</span>
          ${retry && nUsers > 1 ? `<button class="ghost small" data-deepall="${esc(m.name)}" title="Lo lanza a la vez en cada usuario del caso">En los ${nUsers} usuarios del caso</button>` : ""}</div>`;
      }).join("")}</div>` : "";
  const manualBox = manual.length ? `<div class="section"><details class="dork-group">
      <summary>Revisar a mano (${manual.length})</summary>
      <div class="muted small" style="margin:4px 0">Estos sitios bloquean a los programas, pero no a tu navegador. Ábrelos y marca si el perfil existe.</div>
      <div class="variant-btns"><button class="ghost small" data-mcheck="*" data-exists="0">Descartar toda la lista</button></div>
      ${manual.map(([site, url]) => `<div class="manual-check">${link(url, site)}
        <span class="variant-btns"><button class="ghost small" data-mcheck="${esc(site)}" data-exists="1">Existe</button><button class="ghost small" data-mcheck="${esc(site)}" data-exists="0">No existe</button></span></div>`).join("")}
    </details></div>` : "";
  const fam = ent.type === "username" ? aliasFamilies().find((f) => f.ids.includes(ent.id)) : null;
  const famBox = fam ? `<div class="section"><h4>Familia de alias «${esc(fam.root)}» (${fam.ids.length})</h4>
      <div class="muted small">Parecen el mismo apodo escrito de distintas formas. «Variantes del usuario» prueba las combinaciones que faltan.</div>
      ${fam.ids.filter((id) => id !== ent.id).map((id) => `<div class="conn" data-goto="${esc(id)}"><span class="dot" style="background:${typeInfo("username").color}"></span>${esc(S.entities.get(id).label)}</div>`).join("")}
      <div class="variant-btns"><button class="ghost small" data-act="aliasgroup">Agrupar la familia en una burbuja</button></div></div>` : "";
  const variants = Object.entries(a._variantes || {});
  const variantItem = ([v, hits]) => {
    const inGraph = S.entities.has(`username:${v}`);
    const match = hits.map((h) => h.match).find(Boolean);
    const who = hits.map((h) => h.name).find(Boolean);
    return `<div class="variant">
      <div class="variant-h"><b>${esc(v)}</b>${who ? ` <span class="muted">· ${esc(who)}</span>` : ""}
        ${match ? `<div class="small" style="color:var(--accent)">El nombre coincide con «${esc(match)}», que ya está en el caso</div>` : ""}</div>
      <div class="linklist">${hits.map((h) => link(h.url, (h.match ? "★ " : "") + h.platform + (h.followers != null ? ` (${h.followers} seguidores)` : "") + (h.private ? " · privada" : ""))).join("")}</div>
      <div class="variant-btns">${inGraph ? `<span class="muted small">Ya está en el grafo</span>`
        : `<button class="ghost small" data-varadd="${esc(v)}">Añadir al caso</button><button class="primary small" data-varscan="${esc(v)}">Investigar</button>`}</div>
    </div>`;
  };
  const likelyVars = variants.filter(([, hits]) => hits.some((h) => h.match));
  const otherVars = variants.filter(([, hits]) => !hits.some((h) => h.match));
  const variantBox = a._variantes_probadas ? `<div class="section"><h4>Variantes que existen (${variants.length} de ${esc(a._variantes_probadas)} probadas)</h4>
      ${!variants.length ? `<div class="muted small">Ninguna existe en las redes probadas.</div>`
        : likelyVars.length ? `${likelyVars.map(variantItem).join("")}
          ${otherVars.length ? `<details class="dork-group"><summary>Otras, con nombres que no aparecen en el caso <span class="muted">(${otherVars.length})</span></summary>
            ${otherVars.map(variantItem).join("")}</details>` : ""}`
        : otherVars.map(variantItem).join("")}
      ${(a._variantes_bloqueadas || []).length ? `<div class="muted small">No se pudo comprobar (la red limitó las consultas): ${esc(a._variantes_bloqueadas.join(", "))}. Reintenta más tarde.</div>` : ""}
      <div class="muted small">Una variante puede ser de otra persona: compara el nombre y la foto antes de darla por buena.</div></div>` : "";
  const foldBtn = isFolded
    ? `<button class="small" data-act="fold" title="Vuelve a mostrar lo que salió de este nodo">Desplegar resultados (${nFound})</button>`
    : nFound >= 2 ? `<button class="ghost small" data-act="fold" title="Esconde lo que salió de este nodo y lo deja como un solo nodo marcado con ⊕">Plegar resultados (${nFound})</button>` : "";

  box.innerHTML = `
    <div class="det-head">
      ${avatar ? `<img src="${esc(avatar)}" referrerpolicy="no-referrer" alt="" onerror="this.remove()">` : ""}
      <div style="min-width:0">
        ${badge(ent.type)}
        <div class="det-title">${esc(ent.label)}</div>
        ${ent.label !== ent.value ? `<div class="det-value">${esc(ent.value)}</div>` : ""}
      </div>
    </div>
    <div class="det-actions">
      ${canScan ? `<button class="primary small" data-act="scan">Investigar…</button>` : ""}
      <button class="ghost small" data-act="copy">Copiar</button>
      <button class="ghost small" data-act="focus">Centrar</button>
      <button class="ghost small danger" data-act="delete">Eliminar</button>
      ${conns.some((c) => c[0] === "→") ? `<button class="ghost small" data-act="selfound" title="Selecciona todo lo que salió de este nodo y no está conectado con nada más, para borrarlo de una vez">Seleccionar sus resultados</button>` : ""}
      ${foldBtn}
      ${myGroup ? `<button class="ghost small" data-act="leavegroup">Sacar de «${esc(short(myGroup.name, 24))}»</button>` : ""}
    </div>
    ${ent.root ? "" : verdictBox(a._verdict, ent.type === "account")}
    ${famBox}
    ${variantBox}
    ${deepBox}
    ${manualBox}
    ${aiSummary}
    ${confBox}
    ${rows ? `<div class="section"><h4>Datos</h4><table class="attrs">${rows}</table></div>` : ""}
    ${plainLinks.length ? `<div class="section"><h4>Enlaces</h4><div class="linklist">${plainLinks.map((l) => link(l[1], l[0])).join("")}</div></div>` : ""}
    ${fillBox}
    ${reverse ? `<div class="section"><h4>Buscar esta foto en otros sitios</h4><div class="linklist">${reverse}</div></div>` : ""}
    ${(a._web || []).length ? renderWebHits(a._web, a._web_engine) : ""}
    ${(a._candidatos || []).length ? `<div class="section"><h4>Usuarios probables</h4>${a._candidatos.map((c) =>
      `<div class="cand"><span>${esc(c)}</span><button class="ghost small" data-cand="${esc(c)}">Investigar</button></div>`).join("")}</div>` : ""}
    ${(a._dorks || []).length ? `<div class="section"><h4>Dorks de búsqueda (${a._dorks.length})</h4>${renderDorks(a._dorks)}</div>` : ""}
    ${conns.length ? `<div class="section"><h4>Conexiones (${conns.length})</h4>${conns.slice(0, 150).map(([dir, rel, o, e]) =>
      `<div class="conn" data-goto="${esc(o.id)}">${dir} <span class="dot" style="background:${typeInfo(o.type).color}"></span>${esc(short(o.label, 44))} <span class="rel">${esc(rel)}</span>${e.source === "manual"
        ? `<button class="ghost small unlink" title="Quitar este vínculo" data-unlink="${S.edges.indexOf(e)}">✕</button>` : ""}</div>`).join("")}</div>` : ""}
    ${linkBox(ent)}
    ${latest.size ? `<div class="section"><h4>Fuentes consultadas</h4>${[...latest.values()].map((r) => {
      const [icon, cls] = STATUS[r.status] || ["?", ""];
      return `<div class="src"><span class="${cls}">${icon}</span><span>${esc(S.modules[r.module]?.title || r.module)}</span><span class="msg">${esc(r.message || "")}</span></div>`;
    }).join("")}</div>` : ""}
    ${(a._fuentes || []).length ? `<div class="section muted small">Datos aportados por: ${esc(a._fuentes.join(", "))}</div>` : ""}
  `;
}
const renderDetailsSoon = debounce(renderDetails, 200);

$("#details").addEventListener("change", (ev) => {
  if (ev.target.id !== "linkTarget") return;
  const ent = S.selected && S.entities.get(S.selected);
  if (ent) $("#linkRel").value = defaultRel(ent, S.entities.get(ev.target.value));
});

$("#details").addEventListener("click", async (ev) => {
  if (isGroupId(S.selected)) {
    const goto = ev.target.closest("[data-goto]")?.dataset.goto;
    if (goto) return select(goto, true);
    const gact = ev.target.closest("[data-gact]")?.dataset.gact;
    if (gact) groupAction(S.selected.slice(4), gact);
    return;
  }
  const ent = S.selected && S.entities.get(S.selected);
  if (!ent) return;
  const fillCopy = ev.target.closest("[data-fillcopy]")?.dataset.fillcopy;
  if (fillCopy) {
    return toast(await copyText(fillCopy) ? `Copiado «${fillCopy}»: pégalo en el formulario con Ctrl+V` : "No se pudo copiar");
  }
  const copyVal = ev.target.closest("[data-copyval]")?.dataset.copyval;
  if (copyVal != null) return toast(await copyText(copyVal) ? `Copiado «${copyVal}»` : "No se pudo copiar");
  const act = ev.target.closest("[data-act]")?.dataset.act;
  const goto = ev.target.closest("[data-goto]")?.dataset.goto;
  const cand = ev.target.closest("[data-cand]")?.dataset.cand;
  const unlink = ev.target.closest("[data-unlink]")?.dataset.unlink;
  if (unlink != null) {
    const e = S.edges[+unlink];
    if (!e) return;
    await api(`/api/cases/${S.caseId}/edges/delete`, { method: "POST", body: { src: e.src, dst: e.dst, label: e.label } });
    S.edges.splice(+unlink, 1);
    cy.getElementById(`${e.src}→${e.dst}|${e.label}`).remove();
    renderDetails();
    return toast("Vínculo quitado");
  }
  if (goto) return select(goto, true);
  if (act === "link") {
    const dst = $("#linkTarget").value;
    const label = $("#linkRel").value.trim() || "relacionado con";
    const e = await api(`/api/cases/${S.caseId}/edges`, { method: "POST", body: { src: ent.id, dst, label } });
    addEdge(e);
    scheduleLayout();
    renderDetails();
    return toast(`Vinculado: ${short(ent.label, 30)} ${label} ${short(S.entities.get(dst)?.label || "", 30)}`);
  }
  const verdictBtn = ev.target.closest("[data-verdict]");
  if (verdictBtn) {
    const v = verdictBtn.dataset.verdict || null;
    if ((ent.attrs._verdict || null) === v) return;
    const res = await api(`/api/cases/${S.caseId}/verdict/${encodeURIComponent(ent.id)}`, { method: "PUT", body: { verdict: v } });
    for (const e2 of res.entities) upsertNode(e2);
    renderDetails();
    refreshViewSoon();
    const others = res.entities.filter((e2) => e2.id !== ent.id).length;
    return toast(v ? `Marcada como ${v === "confirmada" ? "suya" : "de otra persona"}` + (others ? ` · ${others} cuentas recalculadas` : "") : "Marca quitada");
  }
  const webadd = ev.target.closest("[data-webadd]")?.dataset.webadd;
  if (webadd != null) {
    const h = (ent.attrs._web || [])[+webadd];
    if (!h) return;
    const exact = h.kind === "exacta";
    const rel = exact ? "posible perfil (nombre completo)" : "posible perfil (nombre parcial)";
    const e2 = await api(`/api/cases/${S.caseId}/entities`, { method: "POST", body: {
      value: h.url, type: "account", parent: ent.id, rel,
      attrs: { Plataforma: h.platform, Usuario: h.user, "Título": h.title, "Descripción": h.snippet || null,
        "Verificación": exact ? "Búsqueda web: perfil con el nombre completo" : `Búsqueda web: coincidencia parcial («${h.variant}»)`,
        _links: [["Abrir perfil", h.url]], _fuentes: ["Añadido a mano desde la búsqueda web"] },
    } });
    upsertNode(e2, ent.id);
    addEdge({ src: ent.id, dst: e2.id, label: rel, source: "manual" });
    renderLegend();
    scheduleLayout();
    renderDetails();
    return toast("Perfil añadido al caso");
  }
  const deep = ev.target.closest("[data-deep]")?.dataset.deep;
  if (deep) {
    try { await startScan(ent.id, [deep], 0); } catch (e) { toast(e.message, true); }
    return renderDetails();
  }
  const deepAll = ev.target.closest("[data-deepall]")?.dataset.deepall;
  if (deepAll) {
    const users = [...S.entities.values()].filter((e) => e.type === "username" && !S.running.has(`${e.id}|${deepAll}`));
    if (!users.length || !confirm(`¿Reintentar lo bloqueado en los ${users.length} usuarios? Puede tardar unos minutos.`)) return;
    for (const u of users) { try { await startScan(u.id, [deepAll], 0); } catch (e) { toast(e.message, true); } }
    toast(`Reintentando en ${users.length} usuarios`);
    return renderDetails();
  }
  const mcheck = ev.target.closest("[data-mcheck]");
  if (mcheck) {
    const exists = mcheck.dataset.exists === "1";
    if (mcheck.dataset.mcheck === "*" && !confirm(`¿Quitar los ${manualChecks(ent).length} sitios de la lista?`)) return;
    const res = await api(`/api/cases/${S.caseId}/manual-check/${encodeURIComponent(ent.id)}`,
      { method: "POST", body: { site: mcheck.dataset.mcheck, exists } });
    for (const e2 of res.entities) upsertNode(e2, ent.id);
    if (res.edge) { addEdge(res.edge); renderLegend(); scheduleLayout(); }
    renderDetails();
    if (mcheck.dataset.mcheck === "*") return toast("Lista vaciada");
    return toast(exists ? `Cuenta de ${mcheck.dataset.mcheck} añadida al caso` : `${mcheck.dataset.mcheck} descartado`);
  }
  const variant = ev.target.closest("[data-varadd], [data-varscan]");
  if (variant) {
    const v = variant.dataset.varadd ?? variant.dataset.varscan;
    const hits = (ent.attrs._variantes || {})[v] || [];
    const rel = "posible variante";
    const e2 = await api(`/api/cases/${S.caseId}/entities`, { method: "POST", body: {
      value: v, type: "username", parent: ent.id, rel,
      attrs: { "Variante de": ent.value, "Existe en": hits.map((h) => h.platform).join(", ") || null,
        _fuentes: ["Variantes del usuario"] },
    } });
    upsertNode(e2, ent.id);
    addEdge({ src: ent.id, dst: e2.id, label: rel, source: "manual" });
    renderLegend();
    scheduleLayout();
    renderDetails();
    if (variant.dataset.varscan == null) return toast(`«${v}» añadido al caso`);
    return startScan(e2.id, null, 0);
  }
  if (cand) {
    const e2 = await api(`/api/cases/${S.caseId}/entities`, { method: "POST", body: { value: cand, type: "username" } });
    upsertNode(e2, ent.id);
    renderLegend();
    scheduleLayout();
    return startScan(e2.id, null, 0);
  }
  if (act === "scan") openPivot(ent.id);
  if (act === "copy") toast(await copyText(ent.value) ? "Copiado" : "No se pudo copiar");
  if (act === "focus") select(ent.id, true);
  if (act === "delete") return deleteMany([ent.id]);
  if (act === "fold") return toggleFold(ent.id);
  if (act === "aliasgroup") {
    const fam = aliasFamilies().find((f) => f.ids.includes(ent.id));
    if (!fam) return;
    const g = aliasGroup(fam);
    return layoutChanged(`Burbuja «${g.name}» creada`);
  }
  if (act === "leavegroup") {
    for (const g of S.layout.groups) if (g.members) g.members = g.members.filter((x) => x !== ent.id);
    return layoutChanged("Sacado de la burbuja");
  }
  if (act === "selfound") {
    const ids = foundBy(ent.id);
    if (!ids.length) return toast("No hay resultados que dependan sólo de este nodo");
    cy.nodes().unselect();
    ids.forEach((id) => cy.getElementById(id).select());
    return toast(`${ids.length} nodos seleccionados: pulsa «Eliminar» en la barra o la tecla Supr`);
  }
});

// ---------------------------------------------------------------- borrado en lote
function degreeMap() {
  const d = {};
  for (const e of S.edges) { d[e.src] = (d[e.src] || 0) + 1; d[e.dst] = (d[e.dst] || 0) + 1; }
  return d;
}

/** Nodos que salieron de este (siguiendo sus flechas) y que no están conectados con nada más del caso. */
function foundBy(startId, includeConfirmed = false) {
  const out = new Map(), nb = new Map();
  for (const e of S.edges) {
    if (!out.has(e.src)) out.set(e.src, []);
    out.get(e.src).push(e.dst);
    for (const [a, b] of [[e.src, e.dst], [e.dst, e.src]]) {
      if (!nb.has(a)) nb.set(a, new Set());
      nb.get(a).add(b);
    }
  }
  const keep = (id) => { const e = S.entities.get(id); return !e || e.root || (!includeConfirmed && e.attrs?._verdict === "confirmada"); };
  const set = new Set();
  const queue = [startId];
  while (queue.length) {
    for (const d of out.get(queue.shift()) || []) {
      if (d === startId || set.has(d) || keep(d)) continue;
      set.add(d);
      queue.push(d);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...set]) {
      if ([...(nb.get(id) || [])].some((o) => o !== startId && !set.has(o))) { set.delete(id); changed = true; }
    }
  }
  return [...set];
}

async function deleteMany(ids) {
  ids = [...new Set(ids)].filter((id) => S.entities.has(id));
  if (!ids.length) return toast("No hay nada que eliminar");
  const ents = ids.map((id) => S.entities.get(id));
  const roots = ents.filter((e) => e.root).length;
  const confirmed = ents.filter((e) => e.attrs?._verdict === "confirmada").length;
  const warn = [roots && `${roots} objetivo(s) que buscaste`, confirmed && `${confirmed} confirmada(s) por ti`].filter(Boolean);
  const msg = ids.length === 1 ? `¿Eliminar «${ents[0].label}» del caso?`
    : `¿Eliminar ${ids.length} nodos del caso?` + (warn.length ? `\n\nIncluye ${warn.join(" y ")}.` : "");
  if (!confirm(msg)) return;
  const { deleted } = await api(`/api/cases/${S.caseId}/entities/delete`, { method: "POST", body: { ids } });
  const gone = new Set(ids);
  cy.batch(() => ids.forEach((id) => cy.getElementById(id).remove()));
  ids.forEach((id) => { S.entities.delete(id); S.listSel.delete(id); });
  S.edges = S.edges.filter((e) => !gone.has(e.src) && !gone.has(e.dst));
  S.runs = S.runs.filter((r) => !gone.has(r.entity_id));
  S.layout.collapsed = S.layout.collapsed.filter((id) => !gone.has(id));
  applyGrouping();
  saveLayout();
  select(null);
  renderAll();
  updateSelBar();
  toast(`${deleted} nodos eliminados`);
}

function updateSelBar() {
  const n = cy ? cy.nodes(":selected").length : 0;
  $("#selBar").classList.toggle("hidden", n < 2);
  $("#selHint").classList.toggle("hidden", n >= 2);
  $("#selCount").textContent = `${n} seleccionados`;
}
let selBarTimer;
function updateSelBarSoon() { clearTimeout(selBarTimer); selBarTimer = setTimeout(updateSelBar, 50); }

$("#selDelete").addEventListener("click", () => deleteMany(cy.nodes(":selected").map((n) => n.id())));
$("#selClear").addEventListener("click", () => { cy.nodes().unselect(); updateSelBar(); });
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Delete" || ev.target.closest("input, textarea, select, dialog") || S.tab !== "graph" || !cy) return;
  const ids = cy.nodes(":selected").map((n) => n.id());
  if (ids.length) deleteMany(ids);
});

// ---------------------------------------------------------------- burbujas y nodos plegados
const GROUP_COLORS = ["#ff9f43", "#4fc3f7", "#b388ff", "#69f0ae", "#ff6e9c", "#ffd54f", "#80cbc4", "#f48fb1"];
const grpNode = (gid) => `grp:${gid}`;
const isGroupId = (id) => typeof id === "string" && id.startsWith("grp:");
const groupById = (gid) => S.layout.groups.find((g) => g.id === gid);
const saveLayout = debounce(() => {
  if (S.caseId) api(`/api/cases/${S.caseId}`, { method: "PATCH", body: { layout: S.layout } }).catch(() => {});
}, 500);

/** Cuentas que salieron sólo de este usuario. */
function accountsOf(uid) {
  const inc = new Map();
  for (const e of S.edges) { if (!inc.has(e.dst)) inc.set(e.dst, new Set()); inc.get(e.dst).add(e.src); }
  return [...new Set(S.edges.filter((e) => e.src === uid && S.entities.get(e.dst)?.type === "account"
    && [...inc.get(e.dst)].every((s) => s === uid)).map((e) => e.dst))];
}

/** Para cada nodo, la búsqueda (raíz) de la que salió; null si salió de varias. */
function treeOwners() {
  const out = new Map();
  for (const e of S.edges) { if (!out.has(e.src)) out.set(e.src, []); out.get(e.src).push(e.dst); }
  const owner = new Map();
  for (const r of [...S.entities.values()].filter((e) => e.root)) {
    const seen = new Set([r.id]);
    const queue = [r.id];
    while (queue.length) {
      for (const d of out.get(queue.shift()) || []) {
        const ent = S.entities.get(d);
        if (seen.has(d) || !ent || ent.root) continue;
        seen.add(d);
        queue.push(d);
        owner.set(d, owner.has(d) && owner.get(d) !== r.id ? null : r.id);
      }
    }
  }
  return owner;
}

/** Miembros de cada burbuja: las hechas a mano mandan sobre las automáticas. */
function groupMembers() {
  const of = new Map();
  const members = new Map(S.layout.groups.map((g) => [g.id, []]));
  const put = (eid, gid) => { if (!of.has(eid) && S.entities.has(eid)) { of.set(eid, gid); members.get(gid).push(eid); } };
  for (const g of S.layout.groups) (g.members || []).forEach((id) => put(id, g.id));
  for (const g of S.layout.groups) if (g.kind === "accounts") accountsOf(g.anchor).forEach((id) => put(id, g.id));
  const trees = S.layout.groups.filter((g) => g.kind === "tree");
  if (trees.length) {
    const owner = treeOwners();
    for (const g of trees) {
      put(g.anchor, g.id);
      for (const [id, r] of owner) if (r === g.anchor) put(id, g.id);
    }
  }
  return { of, members };
}

function centroid(ids) {
  const ps = ids.map((id) => cy.getElementById(id)).filter((n) => n.length).map((n) => n.position());
  if (!ps.length) return { x: 0, y: 0 };
  return { x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length };
}

function applyGrouping() {
  if (!cy) return;
  for (const g of S.layout.groups) if (g.members) g.members = g.members.filter((id) => S.entities.has(id));
  S.layout.groups = S.layout.groups.filter((g) => (g.members ? g.members.length : S.entities.has(g.anchor)));
  const { of, members } = groupMembers();
  const hiddenBy = new Map();
  const rep = (id) => {
    const seen = new Set();
    while (hiddenBy.has(id) && !seen.has(id)) { seen.add(id); id = hiddenBy.get(id); }
    return id;
  };
  S.fold = new Map();
  for (const id of S.layout.collapsed) {
    if (!S.entities.has(id)) continue;
    const ids = foundBy(id, true);
    S.fold.set(id, ids.length);
    for (const d of ids) if (!hiddenBy.has(d) && rep(id) !== d) hiddenBy.set(d, id);
  }
  const live = S.layout.groups.filter((g) => members.get(g.id).length);
  for (const g of live) {
    const gn = grpNode(g.id);
    const mem = members.get(g.id);
    if (mem.every((m) => hiddenBy.has(m))) hiddenBy.set(gn, mem[0]);
    else if (g.collapsed) mem.forEach((m) => { if (!hiddenBy.has(m)) hiddenBy.set(m, gn); });
  }
  S.hiddenBy = hiddenBy;

  cy.batch(() => {
    cy.edges(".meta").remove();
    const wanted = new Set(live.map((g) => grpNode(g.id)));
    cy.nodes("[?isGroup]").forEach((n) => {
      if (wanted.has(n.id())) return;
      n.children().move({ parent: null });
      n.remove();
    });
    for (const g of live) {
      const gn = grpNode(g.id);
      const mem = members.get(g.id);
      const data = { id: gn, isGroup: true, color: g.color, shape: "round-rectangle", size: 64,
        short: g.collapsed ? `${short(I18N.tr(g.name), 30)} · ${mem.length}` : short(I18N.tr(g.name), 40) };
      const n = cy.getElementById(gn);
      if (n.length) n.data(data);
      else cy.add({ group: "nodes", data, position: centroid(mem) });
      cy.getElementById(gn).toggleClass("grp-collapsed", !!g.collapsed);
    }
    cy.nodes().not("[?isGroup]").forEach((n) => {
      const g = groupById(of.get(n.id()));
      const parent = g && !g.collapsed ? grpNode(g.id) : null;
      const cur = n.parent().length ? n.parent().id() : null;
      if (cur !== parent) n.move({ parent });
    });
    cy.nodes().forEach((n) => {
      n.toggleClass("fold-hidden", hiddenBy.has(n.id()));
      if (n.data("isGroup")) return;
      n.toggleClass("folded", (S.fold.get(n.id()) || 0) > 0);
      const ent = S.entities.get(n.id());
      if (ent) n.data("short", nodeData(ent).short);
    });
    const meta = new Map();
    for (const e of S.edges) {
      if (!hiddenBy.has(e.src) && !hiddenBy.has(e.dst)) continue;
      const a = rep(e.src), b = rep(e.dst);
      if (a === b || hiddenBy.has(a) || hiddenBy.has(b) || !cy.getElementById(a).length || !cy.getElementById(b).length) continue;
      const k = `meta:${a}→${b}`;
      meta.set(k, { a, b, n: (meta.get(k)?.n || 0) + 1 });
    }
    for (const [id, m] of meta) {
      cy.add({ group: "edges", classes: "meta", data: { id, source: m.a, target: m.b, label: I18N.tr(m.n > 1 ? `${m.n} vínculos` : "vínculo") } });
    }
  });
  if (isGroupId(S.selected) && !groupById(S.selected.slice(4))) select(null);
}
const applyGroupingSoon = debounce(applyGrouping, 300);

/** Si el nodo está escondido dentro de algo plegado, lo despliega. */
function reveal(id) {
  let changed = false;
  for (let guard = 0; S.hiddenBy.has(id) && guard < 20; guard++) {
    const r = S.hiddenBy.get(id);
    if (isGroupId(r)) { const g = groupById(r.slice(4)); if (g) g.collapsed = false; }
    else S.layout.collapsed = S.layout.collapsed.filter((x) => x !== r);
    changed = true;
    applyGrouping();
  }
  if (changed) { saveLayout(); scheduleLayout(); }
}

function layoutChanged(msg) {
  applyGrouping();
  saveLayout();
  runLayout(false);
  renderDetails();
  if (msg) toast(msg);
}

function toggleFold(id) {
  const i = S.layout.collapsed.indexOf(id);
  if (i >= 0) S.layout.collapsed.splice(i, 1);
  else S.layout.collapsed.push(id);
  layoutChanged(i >= 0 ? "Resultados desplegados" : "Resultados plegados: el nodo queda marcado con ⊕");
}

function toggleGroup(gid) {
  const g = groupById(gid);
  if (!g) return;
  g.collapsed = !g.collapsed;
  layoutChanged(g.collapsed ? `Burbuja «${g.name}» plegada` : `Burbuja «${g.name}» desplegada`);
}

function newGroup(props) {
  const used = new Set(S.layout.groups.map((g) => g.color));
  const color = GROUP_COLORS.find((c) => !used.has(c)) || GROUP_COLORS[S.layout.groups.length % GROUP_COLORS.length];
  const g = { id: Math.random().toString(36).slice(2, 9), color, collapsed: false, ...props };
  S.layout.groups.push(g);
  return g;
}

const GROUP_KIND = {
  tree: "Todo lo que salió de esta búsqueda; se actualiza sola con los nuevos resultados.",
  accounts: "Cuentas encontradas sólo para este usuario; se actualiza sola.",
  alias: "Alias que parecen el mismo apodo escrito de distintas formas, con sus cuentas.",
};

// ---------------------------------------------------------------- familias de alias (misma lógica que app/modules/username.py)
const ALIAS_PRE = ["private", "priv", "official", "oficial", "real", "its", "iam", "the", "soy", "not"];
const ALIAS_SUF = ["private", "priv", "official", "oficial", "real", "backup", "bkp", "alt", "spam", "fake", "xx"];
const ALIAS_LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a", $: "s" };

function aliasStrip(c) {
  const out = [];
  for (const sep of [".", "_", "-", ""]) {
    for (const p of ALIAS_PRE) {
      const rest = c.slice((p + sep).length);
      if (c.startsWith(p + sep) && rest.length >= 3 && (sep || p.length >= 4)) out.push(rest);
    }
    for (const s of ALIAS_SUF) {
      const rest = c.slice(0, c.length - (sep + s).length);
      if (c.endsWith(sep + s) && rest.length >= 3 && (sep || s.length >= 4)) out.push(rest);
    }
  }
  return out.map((x) => x.replace(/^[._-]+|[._-]+$/g, "")).filter((x) => x.length >= 3);
}

function aliasKey(u) {
  let s = u.toLowerCase().trim().replace(/^@/, "");
  for (let k = 0; k < 2; k++) {
    const st = aliasStrip(s);
    if (st.length) s = st.reduce((a, b) => (b.length < a.length ? b : a));
  }
  s = s.replace(/[^a-z0-9@$]/g, "").replace(/\d{2,}$/, "");
  s = [...s].map((c) => ALIAS_LEET[c] || c).join("");
  return s.replace(/(.)\1+/g, "$1").replace(/\d/g, "");
}

function aliasCommon(a, b) {
  let best = "";
  for (let i = 0; i < a.length; i++) {
    for (let j = i + best.length + 1; j <= a.length; j++) {
      if (!b.includes(a.slice(i, j))) break;
      best = a.slice(i, j);
    }
  }
  return best;
}

/** Familias (de 2 o más) entre los usuarios del caso: [{root, ids}]. */
function aliasFamilies() {
  const users = [...S.entities.values()].filter((e) => e.type === "username" && aliasKey(e.value));
  const keys = users.map((e) => aliasKey(e.value));
  const parent = users.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  for (let i = 0; i < users.length; i++) {
    for (let j = i + 1; j < users.length; j++) {
      const n = aliasCommon(keys[i], keys[j]).length;
      if (n >= 4 && n >= 0.6 * Math.min(keys[i].length, keys[j].length)) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  users.forEach((_, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
  return [...groups.values()].filter((g) => g.length >= 2).map((g) => {
    let root = keys[g[0]];
    for (const i of g.slice(1)) root = aliasCommon(root, keys[i]);
    if (root.length < 3) root = g.map((i) => keys[i]).reduce((a, b) => (b.length < a.length ? b : a));
    return { root, ids: g.map((i) => users[i].id) };
  });
}

function aliasGroup(fam) {
  const ids = [...new Set(fam.ids.flatMap((id) => [id, ...accountsOf(id)]))];
  const set = new Set(ids);
  for (const g of S.layout.groups) if (g.members) g.members = g.members.filter((x) => !set.has(x));
  return newGroup({ name: `Alias «${fam.root}»`, kind: "alias", members: ids });
}

const BLOCKED_PROFILE_URLS = { Instagram: "https://www.instagram.com/{}/", TikTok: "https://www.tiktok.com/@{}" };

/** Sitios que no se pudieron comprobar solos: [[sitio, url]]. */
function manualChecks(ent) {
  const a = ent.attrs || {};
  const prof = (a._bloq_perfiles || []).filter((p) => BLOCKED_PROFILE_URLS[p])
    .map((p) => [p, BLOCKED_PROFILE_URLS[p].replace("{}", ent.value)]);
  const rank = (s) => { const i = MANUAL_FIRST.indexOf(s.toLowerCase()); return i < 0 ? 999 : i; };
  return [...prof, ...Object.entries(a._bloq_sitios || {}).sort((x, y) => rank(x[0]) - rank(y[0]) || x[0].localeCompare(y[0]))];
}
/** Redes donde suele estar una persona corriente: van primero en «Revisar a mano». */
const MANUAL_FIRST = ["pinterest", "tumblr", "vsco", "wattpad", "spotify", "soundcloud", "linktree", "deviantart", "letterboxd",
  "archive of our own", "fandom", "9gag", "smule", "mydramalist", "artstation", "behance", "kofi", "redbubble", "xbox gamertag",
  "psnprofiles.com", "fortnitetracker", "osu!", "exophase", "curseforge", "musescore", "discogs", "rate your music", "rumble",
  "academia.edu", "untappd", "codepen", "gamefaqs"];

function renderGroupDetails(box, g) {
  const mem = groupMembers().members.get(g.id) || [];
  const ents = mem.map((id) => S.entities.get(id)).filter(Boolean)
    .sort((a, b) => (b.root - a.root) || a.type.localeCompare(b.type) || a.label.localeCompare(b.label));
  const counts = {};
  ents.forEach((e) => (counts[e.type] = (counts[e.type] || 0) + 1));
  box.innerHTML = `
    <div class="det-head"><div style="min-width:0">
      <span class="badge" style="background:${esc(g.color)}">Burbuja</span>
      <div class="det-title">${esc(g.name)}</div>
      <div class="det-value">${ents.length} nodos${g.collapsed ? " · plegada" : ""}</div></div></div>
    <div class="det-actions">
      <button class="primary small" data-gact="toggle">${g.collapsed ? "Desplegar" : "Plegar"}</button>
      <button class="ghost small" data-gact="rename">Renombrar</button>
      <button class="ghost small" data-gact="select">Seleccionar sus nodos</button>
      <button class="ghost small danger" data-gact="ungroup">Quitar burbuja</button>
    </div>
    <div class="section muted small">${esc(GROUP_KIND[g.kind] || "Creada a mano: añade nodos seleccionándolos y pulsando «Agrupar en burbuja».")}
      Doble clic en la burbuja la pliega o despliega.</div>
    <div class="section"><h4>Contenido</h4><div>${Object.entries(counts).sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${badge(t)} ${n}`).join(" &nbsp;")}</div></div>
    <div class="section"><h4>Nodos (${ents.length})</h4>${ents.slice(0, 200).map((o) =>
      `<div class="conn" data-goto="${esc(o.id)}"><span class="dot" style="background:${typeInfo(o.type).color}"></span>${o.root ? "★ " : ""}${esc(short(o.label, 50))}</div>`).join("")}</div>`;
}

function groupAction(gid, act) {
  const g = groupById(gid);
  if (!g) return;
  if (act === "toggle") return toggleGroup(gid);
  if (act === "rename") {
    const name = prompt("Nombre de la burbuja:", g.name);
    if (!name?.trim()) return;
    g.name = name.trim();
    return layoutChanged();
  }
  if (act === "select") {
    if (g.collapsed) { g.collapsed = false; layoutChanged(); }
    const mem = groupMembers().members.get(gid) || [];
    cy.nodes().unselect();
    mem.forEach((id) => cy.getElementById(id).select());
    return toast(`${mem.length} nodos seleccionados`);
  }
  if (act === "ungroup") {
    S.layout.groups = S.layout.groups.filter((x) => x.id !== gid);
    S.selected = null;
    return layoutChanged(`Burbuja «${g.name}» quitada (los nodos siguen en el caso)`);
  }
}

$("#selGroup").addEventListener("click", () => {
  const ids = cy.nodes(":selected").map((n) => n.id()).filter((id) => S.entities.has(id));
  if (!ids.length) return;
  const ents = ids.map((id) => S.entities.get(id));
  const hint = ents.find((e) => e.root) || ents.find((e) => e.type === "person") || ents.find((e) => e.type === "username");
  const name = prompt(`Nombre de la burbuja (${ids.length} nodos):`, hint ? hint.label : `Grupo ${S.layout.groups.length + 1}`);
  if (!name?.trim()) return;
  const set = new Set(ids);
  for (const g of S.layout.groups) if (g.members) g.members = g.members.filter((x) => !set.has(x));
  const g = newGroup({ name: name.trim(), members: ids });
  cy.nodes().unselect();
  updateSelBar();
  layoutChanged(`Burbuja «${g.name}» creada: doble clic sobre ella para plegarla`);
});

$("#groupSel").addEventListener("change", (ev) => {
  const how = ev.target.value;
  ev.target.value = "";
  if (!how || !S.entities.size) return;
  const ents = [...S.entities.values()];
  let msg = "";
  if (how === "roots") {
    S.layout.groups = S.layout.groups.filter((g) => g.kind !== "tree");
    const owner = treeOwners();
    const roots = ents.filter((e) => e.root && [...owner.values()].includes(e.id));
    roots.forEach((r) => newGroup({ name: short(r.label, 40), kind: "tree", anchor: r.id }));
    const shared = [...owner.values()].filter((v) => v === null).length;
    msg = roots.length ? `${roots.length} burbuja(s), una por búsqueda` + (shared ? ` · ${shared} nodos compartidos quedan fuera, entre ellas` : "")
      : "Aún no hay resultados que agrupar";
  } else if (how === "platform") {
    S.layout.groups = S.layout.groups.filter((g) => g.kind !== "accounts");
    const users = ents.filter((e) => e.type === "username" && accountsOf(e.id).length >= 3);
    users.forEach((u) => newGroup({ name: `Cuentas de ${short(u.label, 30)}`, kind: "accounts", anchor: u.id }));
    msg = users.length ? `${users.length} burbuja(s) de cuentas` : "Ningún usuario tiene 3 o más cuentas propias";
  } else if (how === "alias") {
    S.layout.groups = S.layout.groups.filter((g) => g.kind !== "alias");
    const fams = aliasFamilies();
    fams.forEach(aliasGroup);
    msg = fams.length ? `${fams.length} familia(s) de alias: ${fams.map((f) => `«${f.root}»`).join(", ")}`
      : "No hay alias parecidos entre sí en el caso";
  } else if (how === "collapseBig") {
    const big = (list) => list.filter((e) => !S.layout.collapsed.includes(e.id) && foundBy(e.id, true).length >= 8);
    let pick = big(ents.filter((e) => !e.root));
    if (!pick.length) pick = big(ents.filter((e) => e.root));
    S.layout.collapsed.push(...pick.map((e) => e.id));
    msg = pick.length ? `${pick.length} nodo(s) plegados (marcados con ⊕): selecciónalos y pulsa «Desplegar resultados»`
      : "No hay nodos con 8 o más resultados propios";
  } else if (how === "collapseGroups") {
    S.layout.groups.forEach((g) => (g.collapsed = true));
    msg = S.layout.groups.length ? "Burbujas plegadas" : "No hay burbujas: crea una primero";
  } else if (how === "expand") {
    S.layout.collapsed = [];
    S.layout.groups.forEach((g) => (g.collapsed = false));
    msg = "Todo desplegado";
  } else if (how === "ungroup") {
    S.layout.groups = [];
    msg = "Burbujas quitadas";
  }
  layoutChanged(msg);
});

$("#cleanSel").addEventListener("change", (ev) => {
  const how = ev.target.value;
  ev.target.value = "";
  if (!how) return;
  const deg = degreeMap();
  const all = [...S.entities.values()].filter((e) => !e.root);
  const notConfirmed = (e) => e.attrs?._verdict !== "confirmada";
  const pick = {
    low: (e) => e.attrs?.["Nivel de confianza"] === "Baja" && notConfirmed(e),
    discarded: (e) => e.attrs?._verdict === "descartada",
    orphans: (e) => !deg[e.id] && notConfirmed(e),
    unreviewed: (e) => e.type === "account" && !e.attrs?._verdict,
  }[how];
  deleteMany(all.filter(pick).map((e) => e.id));
});

// ---------------------------------------------------------------- diálogo de pivotado
let pivotTarget = null;
function openPivot(eid) {
  const ent = S.entities.get(eid);
  if (!ent || !typeInfo(ent.type).input) return toast("Este tipo de nodo no se investiga directamente");
  pivotTarget = eid;
  const mods = Object.values(S.modules).filter((m) => m.inputs.includes(ent.type));
  $("#pivotTitle").textContent = `Investigar ${typeInfo(ent.type).label.toLowerCase()}: ${short(ent.label, 50)}`;
  const row = (m) => {
    const missing = m.keys.filter(() => !m.ready);
    return `<label><input type="checkbox" value="${esc(m.name)}" ${!m.ready ? "disabled" : m.deep ? "" : "checked"}>
      <span><b>${esc(m.title)}</b>${missing.length ? ` <span class="st-skipped small">(falta clave en Ajustes)</span>` : ""}</span>
      <small>${esc(m.description)}</small></label>`;
  };
  const deep = mods.filter((m) => m.deep);
  $("#pivotModules").innerHTML = mods.filter((m) => !m.deep).map(row).join("") + (deep.length
    ? `<div class="pivot-deep muted small">A fondo (márcalas sólo si lo normal encontró poco: pueden sumar muchos resultados)</div>${deep.map(row).join("")}` : "");
  $("#pivotDlg").showModal();
}
$("#pivotRunBtn").addEventListener("click", async (ev) => {
  ev.preventDefault();
  const modules = [...$("#pivotModules").querySelectorAll("input:checked")].map((i) => i.value);
  $("#pivotDlg").close();
  if (!modules.length || !pivotTarget) return;
  try { await startScan(pivotTarget, modules, Number($("#pivotDepth").value)); } catch (e) { toast(e.message, true); }
});

// ---------------------------------------------------------------- pestañas, lista y notas
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
  S.tab = b.dataset.tab;
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
  for (const v of ["graph", "list", "map", "timeline", "notes"]) $(`#${v}View`).classList.toggle("hidden", S.tab !== v);
  if (S.tab === "graph") cy.resize();
  refreshView();
}));

// ---------------------------------------------------------------- mapa
let map = null, mapLayer = null, mapFitted = false;
const visibleEnt = (e) => !(S.hideLow && (e.attrs?.["Nivel de confianza"] === "Baja" || e.attrs?._verdict === "descartada"));

function neighbours(id) {
  const out = [];
  for (const e of S.edges) {
    const o = e.src === id ? e.dst : e.dst === id ? e.src : null;
    if (o && S.entities.has(o) && !out.some((x) => x[0].id === o)) out.push([S.entities.get(o), e.label]);
  }
  return out;
}

function renderMap() {
  if (typeof L === "undefined") return;
  if (!map) {
    map = L.map("map", { worldCopyJump: true, zoomControl: true }).setView([20, 0], 2);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, className: "dark-tiles",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    mapLayer = L.featureGroup().addTo(map);
    map.on("popupopen", (e) => e.popup.getElement().addEventListener("click", (ev) => {
      const id = ev.target.closest("[data-goto]")?.dataset.goto;
      if (id) select(id);
    }));
  }
  map.invalidateSize();
  mapLayer.clearLayers();
  let n = 0;
  for (const ent of S.entities.values()) {
    const lat = Number(ent.attrs?._lat), lon = Number(ent.attrs?._lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || ent.attrs._lat == null || !visibleEnt(ent)) continue;
    const near = neighbours(ent.id).filter(([o]) => visibleEnt(o));
    const color = typeInfo(ent.type).color;
    const pop = `<div class="map-pop"><b data-goto="${esc(ent.id)}">${esc(ent.label)}</b>
      <div class="muted small">${esc(typeInfo(ent.type).label)} · ${lat.toFixed(4)}, ${lon.toFixed(4)}</div>
      ${near.length ? `<ul>${near.slice(0, 40).map(([o, rel]) => `<li data-goto="${esc(o.id)}">${esc(short(o.label, 40))} <span class="muted small">${esc(rel)}</span></li>`).join("")}</ul>` : ""}</div>`;
    L.circleMarker([lat, lon], { radius: 7 + Math.min(near.length, 8), color: "#ff7a1a", fillColor: color, fillOpacity: 0.7, weight: 2 })
      .bindPopup(pop).bindTooltip(ent.label).on("click", () => select(ent.id)).addTo(mapLayer);
    n++;
  }
  $("#mapEmpty").classList.toggle("hidden", n > 0);
  if (n && !mapFitted) { map.fitBounds(mapLayer.getBounds().pad(0.3), { maxZoom: 6 }); mapFitted = true; }
}

// ---------------------------------------------------------------- cronología
const DATE_KEY = /^(Creada|Alta|Caduca|Última modificación|Wayback: (primera|última) captura|Servidor creado|Última publicación|Primera actividad|Última actividad.*|Última emisión|Última conexión|Miembro desde|Fecha.*|Primera vez visto|Último push|Primera mención.*|Fecha de nacimiento|Fecha de fallecimiento|Primera foto reciente|Última foto)$/i;

function parseDate(v) {
  if (typeof v === "number") { const d = new Date(v > 1e11 ? v : v * 1000); return { d, txt: d.toISOString().slice(0, 10) }; }
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m;
  if ((m = s.match(/^(\d{4})$/))) return { d: new Date(Date.UTC(+m[1], 0, 1)), txt: m[1] };
  if ((m = s.match(/^(\d{4})[-:](\d{2})(?:[-:](\d{2}))?/))) return { d: new Date(Date.UTC(+m[1], +m[2] - 1, +(m[3] || 1))), txt: m[3] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}` };
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})\d{0,6}$/))) return { d: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])), txt: `${m[1]}-${m[2]}-${m[3]}` };
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) return { d: new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])), txt: `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` };
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return { d, txt: d.toISOString().slice(0, 10) };
}

function timelineEvents() {
  const evs = [];
  const now = Date.now();
  for (const ent of S.entities.values()) {
    if (!visibleEnt(ent)) continue;
    for (const [k, v] of Object.entries(ent.attrs || {})) {
      if (!DATE_KEY.test(k)) continue;
      const p = parseDate(v);
      if (!p || Number.isNaN(p.d.getTime())) continue;
      const y = p.d.getUTCFullYear();
      if (y < 1985 || p.d.getTime() > now + 20 * 365 * 864e5) continue;
      evs.push({ ...p, key: k, ent });
    }
  }
  return evs.sort((a, b) => a.d - b.d);
}

function renderTimeline() {
  const evs = timelineEvents();
  if (!evs.length) {
    $("#timeline").innerHTML = `<div class="muted" style="text-align:center;margin-top:40px">Aún no hay fechas en este caso (creación de cuentas, dominios, filtraciones, actividad…).</div>`;
    return;
  }
  let year = null;
  const now = Date.now();
  $("#timeline").innerHTML = evs.map((e) => {
    const y = e.d.getUTCFullYear();
    const head = y !== year ? `<div class="tl-year">${y}</div>` : "";
    year = y;
    const future = e.d.getTime() > now ? ` <span class="muted">(futuro)</span>` : "";
    return `${head}<div class="tl-item" data-goto="${esc(e.ent.id)}">
      <div class="tl-date">${esc(e.txt)}</div><span class="dot" style="background:${typeInfo(e.ent.type).color}"></span>
      <div class="tl-what">${esc(e.key)}${future}: <b>${esc(e.ent.label)}</b> <span class="muted">${esc(typeInfo(e.ent.type).label)}</span></div></div>`;
  }).join("");
}
$("#timeline").addEventListener("click", (ev) => {
  const id = ev.target.closest("[data-goto]")?.dataset.goto;
  if (id) select(id);
});

function renderList() {
  const q = $("#listFilter").value.trim().toLowerCase();
  const degree = {};
  for (const e of S.edges) { degree[e.src] = (degree[e.src] || 0) + 1; degree[e.dst] = (degree[e.dst] || 0) + 1; }
  const rows = [...S.entities.values()]
    .filter((e) => !q || e.label.toLowerCase().includes(q) || e.value.toLowerCase().includes(q) || typeInfo(e.type).label.toLowerCase().includes(q))
    .sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label));
  S.listRows = rows.map((e) => e.id);
  const allOn = rows.length && rows.every((e) => S.listSel.has(e.id));
  $("#entityTable").innerHTML = `<thead><tr><th><input type="checkbox" data-selall title="Marcar todas las filas visibles"${allOn ? " checked" : ""}></th><th>Tipo</th><th>Entidad</th><th>Conexiones</th><th>Fuentes</th></tr></thead><tbody>` +
    rows.map((e) => `<tr data-id="${esc(e.id)}"${e.attrs._verdict === "descartada" ? ' style="opacity:.45"' : ""}><td><input type="checkbox" data-sel="${esc(e.id)}"${S.listSel.has(e.id) ? " checked" : ""}></td><td>${badge(e.type)}</td><td>${e.attrs._verdict === "confirmada" ? '<span class="conf Alta">✔ Confirmada</span> ' : e.attrs._verdict === "descartada" ? '<span class="conf">Descartada</span> ' : ""}${esc(e.label)}${e.label !== e.value ? `<div class="muted small">${esc(short(e.value, 80))}</div>` : ""}</td>
      <td>${degree[e.id] || 0}</td><td class="muted small">${esc((e.attrs._fuentes || []).join(", "))}</td></tr>`).join("") + "</tbody>";
  updateListDelete();
}
const renderListSoon = debounce(renderList, 300);
$("#listFilter").addEventListener("input", renderListSoon);
function updateListDelete() {
  for (const id of [...S.listSel]) if (!S.entities.has(id)) S.listSel.delete(id);
  const n = S.listSel.size;
  $("#listDelete").disabled = !n;
  $("#listDelete").textContent = n ? `Eliminar marcadas (${n})` : "Eliminar marcadas";
}
$("#listDelete").addEventListener("click", () => deleteMany([...S.listSel]));
$("#entityTable").addEventListener("change", (ev) => {
  if (ev.target.matches("[data-selall]")) {
    for (const id of S.listRows || []) ev.target.checked ? S.listSel.add(id) : S.listSel.delete(id);
    document.querySelectorAll("#entityTable [data-sel]").forEach((c) => { c.checked = ev.target.checked; });
  } else if (ev.target.matches("[data-sel]")) {
    ev.target.checked ? S.listSel.add(ev.target.dataset.sel) : S.listSel.delete(ev.target.dataset.sel);
  }
  updateListDelete();
});
$("#entityTable").addEventListener("click", (ev) => {
  if (ev.target.matches("input[type=checkbox]")) return;
  const tr = ev.target.closest("tr[data-id]");
  if (tr) select(tr.dataset.id);
});

const saveNotes = debounce(() => {
  if (S.caseId) api(`/api/cases/${S.caseId}`, { method: "PATCH", body: { notes: $("#notesArea").value } }).catch(() => {});
}, 600);
$("#notesArea").addEventListener("input", saveNotes);

// ---------------------------------------------------------------- herramientas del grafo
$("#fitBtn").addEventListener("click", () => cy.fit(undefined, 40));
$("#layoutBtn").addEventListener("click", () => runLayout(true, true));
$("#pngBtn").addEventListener("click", () => {
  if (!cy.nodes().length) return;
  const a = document.createElement("a");
  a.href = cy.png({ full: true, scale: 2, bg: "#0a0806" });
  a.download = "osint-grafo.png";
  a.click();
});
$("#exportBtn").addEventListener("click", () => { if (S.caseId) window.location = `/api/cases/${S.caseId}/export`; });
$("#langBtn").textContent = I18N.lang === "en" ? "🌐 Español" : "🌐 English";
$("#langBtn").addEventListener("click", () => I18N.setLang(I18N.lang === "en" ? "es" : "en"));

// ---------------------------------------------------------------- informe
const REPORT_SECTIONS = [
  ["person", "Personas"], ["email", "Emails"], ["phone", "Teléfonos"], ["rut", "RUT"], ["plate", "Patentes"],
  ["username", "Usuarios"], ["organization", "Organizaciones y empresas"], ["location", "Ubicaciones"],
  ["domain", "Dominios"], ["ip", "Direcciones IP"], ["url", "Webs y documentos"], ["crypto", "Criptomonedas"],
  ["hash", "Hashes"], ["breach", "Filtraciones"], ["image", "Imágenes"], ["asn", "Redes (ASN)"],
];

function reportValue(v) {
  if (Array.isArray(v)) return v.map((x) => (Array.isArray(x) ? x.join(" · ") : typeof x === "object" ? JSON.stringify(x) : String(x))).join("; ");
  return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
}

function reportAttrs(ent, max = 12) {
  const rows = Object.entries(ent.attrs || {})
    .filter(([k, v]) => !k.startsWith("_") && !ANALYSIS_KEYS.has(k) && v !== null && v !== "" && !(Array.isArray(v) && !v.length))
    .slice(0, max);
  return rows.length ? `<table class="kv">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(short(reportValue(v), 400))}</td></tr>`).join("")}</table>` : "";
}

function reportOrigin(ent) {
  const e = S.edges.find((x) => x.dst === ent.id && S.entities.has(x.src));
  return e ? `${e.label} ← ${S.entities.get(e.src).label}` : ent.root ? "investigado" : "";
}

function buildReport() {
  const ents = [...S.entities.values()].filter((e) => e.attrs?._verdict !== "descartada" && visibleEnt(e));
  const discarded = [...S.entities.values()].filter((e) => e.attrs?._verdict === "descartada");
  const kase = S.cases.find((c) => c.id === S.caseId);
  const roots = ents.filter((e) => e.root);
  const accounts = ents.filter((e) => e.type === "account")
    .sort((a, b) => (b.attrs?._verdict === "confirmada") - (a.attrs?._verdict === "confirmada") || (b.attrs?.Confianza ?? -1) - (a.attrs?.Confianza ?? -1));
  const confirmed = accounts.filter((a) => a.attrs?._verdict === "confirmada");
  const byType = (t) => ents.filter((e) => e.type === t);
  const counts = REPORT_SECTIONS.map(([t, label]) => [label, byType(t).length]).filter(([, n]) => n);
  const ai = roots.map((r) => r.attrs?.["IA: resumen"]).filter(Boolean);
  const sources = [...new Set(ents.flatMap((e) => e.attrs?._fuentes || []))].sort();
  const notes = $("#notesArea").value.trim();
  const img = cy.nodes().length ? cy.png({ full: true, scale: 1.6, bg: "#0a0806", maxWidth: 2200, maxHeight: 2200 }) : "";
  const now = new Date();

  const highConf = accounts.filter((a) => a.attrs?.["Nivel de confianza"] === "Alta" && a.attrs?._verdict !== "confirmada").length;
  const keyFacts = [
    confirmed.length && `${confirmed.length} cuenta(s) confirmada(s) por el analista`,
    highConf && `${highConf} cuenta(s)${confirmed.length ? " más" : ""} con confianza alta`,
    byType("email").length && `${byType("email").length} email(s)`,
    byType("phone").length && `${byType("phone").length} teléfono(s)`,
    byType("rut").length && `${byType("rut").length} RUT`,
    byType("location").length && `${byType("location").length} ubicación(es)`,
    byType("organization").length && `${byType("organization").length} organización(es) o empresa(s) relacionadas`,
    byType("breach").length && `aparece en ${byType("breach").length} filtración(es) de datos`,
  ].filter(Boolean);

  const accRows = accounts.map((a) => {
    const at = a.attrs || {};
    const verdict = at._verdict === "confirmada" ? `<span class="ok">✔ Confirmada</span>` : at["Nivel de confianza"] ? `${esc(I18N.tr(at["Nivel de confianza"]))} (${esc(at.Confianza ?? "?")})` : "—";
    const url = safeUrl(a.value);
    return `<tr><td>${esc(at.Plataforma || "")}</td><td>${esc(at.Usuario || "")}</td>
      <td>${url ? `<a href="${esc(url)}">${esc(short(url, 60))}</a>` : esc(short(a.label, 60))}</td><td>${verdict}</td>
      <td class="small">${esc((at["Señales"] || []).slice(0, 2).join(" · "))}</td></tr>`;
  }).join("");

  const sections = REPORT_SECTIONS.filter(([t]) => t !== "account").map(([t, label]) => {
    const list = byType(t).filter((e) => !e.root || t === "person");
    if (!list.length) return "";
    return `<section><h2>${esc(label)} <span class="muted">(${list.length})</span></h2>
      ${list.slice(0, 80).map((e) => `<div class="item"><div class="item-h"><b>${esc(e.label)}</b>
        <span class="muted small">${esc(reportOrigin(e))}</span></div>${reportAttrs(e, t === "person" ? 30 : 10)}</div>`).join("")}
      ${list.length > 80 ? `<p class="muted">… y ${list.length - 80} más.</p>` : ""}</section>`;
  }).join("");

  const tl = timelineEvents().filter((e) => e.ent.attrs?._verdict !== "descartada");
  const tlRows = tl.slice(0, 200).map((e) => `<tr><td>${esc(e.txt)}</td><td>${esc(e.key)}</td><td>${esc(e.ent.label)}</td><td class="muted">${esc(typeInfo(e.ent.type).label)}</td></tr>`).join("");

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Informe · ${esc(kase?.name || "Caso")}</title>
<style>
  :root { --acc: #e8650a; }
  * { box-sizing: border-box; }
  body { font: 13px/1.45 "Segoe UI", system-ui, sans-serif; color: #1d1712; margin: 0; background: #fff; }
  .page { max-width: 980px; margin: 0 auto; padding: 32px 40px; }
  header { border-bottom: 3px solid var(--acc); padding-bottom: 12px; margin-bottom: 18px; display: flex; justify-content: space-between; align-items: flex-end; }
  header h1 { margin: 0; font-size: 24px; } header .brand { color: var(--acc); font-weight: 800; letter-spacing: 2px; font-size: 12px; }
  h2 { font-size: 16px; color: var(--acc); border-bottom: 1px solid #eadfd5; padding-bottom: 4px; margin: 26px 0 10px; break-after: avoid; }
  .muted { color: #8a7f75; } .small { font-size: 11px; } .ok { color: #1f9d55; font-weight: 600; }
  .facts { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; padding: 0; list-style: none; }
  .facts li { background: #fff3e8; border: 1px solid #f5cfa9; border-radius: 12px; padding: 3px 10px; }
  table { border-collapse: collapse; width: 100%; } td, th { text-align: left; vertical-align: top; padding: 4px 6px; border-bottom: 1px solid #f0e8e0; }
  th { font-size: 11px; text-transform: uppercase; color: #8a7f75; } a { color: #b44d00; word-break: break-all; }
  table.kv td:first-child { width: 32%; color: #6b6058; } table.kv { margin: 4px 0 0; font-size: 12px; }
  .item { padding: 8px 10px; border: 1px solid #eadfd5; border-radius: 6px; margin-bottom: 8px; break-inside: avoid; }
  .item-h { display: flex; justify-content: space-between; gap: 10px; }
  .graph { width: 100%; border-radius: 6px; margin-top: 6px; }
  .ai { background: #f7f3ef; border-left: 3px solid var(--acc); padding: 8px 12px; white-space: pre-wrap; }
  .notes { white-space: pre-wrap; background: #fafafa; border: 1px solid #eee; padding: 10px; border-radius: 6px; }
  .toolbar { position: sticky; top: 0; background: #1d1712; padding: 8px 40px; display: flex; gap: 8px; justify-content: flex-end; }
  .toolbar button { background: var(--acc); color: #fff; border: 0; padding: 7px 14px; border-radius: 6px; font-weight: 600; cursor: pointer; }
  .toolbar span { color: #c9b8a8; margin-right: auto; align-self: center; font-size: 12px; }
  @media print { .toolbar { display: none; } .page { padding: 0; } h2 { margin-top: 18px; } @page { margin: 16mm; } }
</style></head><body>
<div class="toolbar"><span>Revisa el informe y guárdalo como PDF desde el diálogo de impresión.</span><button onclick="window.print()">Guardar como PDF / Imprimir</button></div>
<div class="page">
<header><div><div class="brand">OSINT HUNTER · INFORME</div><h1>${esc(kase?.name || "Caso")}</h1>
  <div class="muted">Investigado: ${roots.map((r) => `<b>${esc(r.label)}</b> (${esc(I18N.tr(typeInfo(r.type).label))})`).join(", ") || "—"}</div></div>
  <div class="muted small" style="text-align:right">${esc(now.toLocaleDateString(I18N.locale, { dateStyle: "long" }))}<br>${esc(now.toLocaleTimeString(I18N.locale, { timeStyle: "short" }))}<br>${ents.length} entidades</div></header>

<h2>Resumen</h2>
${keyFacts.length ? `<ul class="facts">${keyFacts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : `<p class="muted">Sin hallazgos todavía.</p>`}
<p class="muted small">${counts.map(([l, n]) => `${esc(I18N.tr(l))}: ${n}`).join(" · ")}</p>
${ai.length ? `<h2>Resumen de la IA</h2>${ai.map((x) => `<div class="ai">${esc(x)}</div>`).join("")}` : ""}
${notes ? `<h2>Notas del analista</h2><div class="notes">${esc(notes)}</div>` : ""}

${accounts.length ? `<h2>Cuentas <span class="muted">(${accounts.length})</span></h2>
<table><thead><tr><th>Plataforma</th><th>Usuario</th><th>Enlace</th><th>¿Es la persona?</th><th>Señales</th></tr></thead><tbody>${accRows}</tbody></table>` : ""}

${sections}

${tlRows ? `<h2>Cronología</h2><table><thead><tr><th>Fecha</th><th>Qué</th><th>Entidad</th><th>Tipo</th></tr></thead><tbody>${tlRows}</tbody></table>` : ""}

${img ? `<h2 style="break-before: page">Grafo del caso</h2><img class="graph" src="${img}" alt="Grafo">` : ""}

${discarded.length ? `<h2>Descartadas por el analista <span class="muted">(${discarded.length})</span></h2><p class="small muted">${discarded.map((d) => esc(d.label)).join(" · ")}</p>` : ""}
<h2>Fuentes consultadas</h2><p class="small muted">${sources.map(esc).join(" · ") || "—"}</p>
<p class="small muted">Informe generado con OsintHunter a partir de fuentes abiertas. La confianza de cada cuenta es una estimación automática; las marcadas «Confirmada» fueron verificadas por el analista.</p>
</div></body></html>`;
}

$("#reportBtn").addEventListener("click", () => {
  if (!S.caseId || !S.entities.size) return toast("Primero investiga algo");
  const html = I18N.translateHtml(buildReport());
  const w = window.open("", "_blank");
  if (w) {
    w.document.open();
    w.document.write(html);
    w.document.close();
    return;
  }
  const name = (S.cases.find((c) => c.id === S.caseId)?.name || "caso").replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 40);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  a.download = `informe_${name}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast("Informe descargado: ábrelo y pulsa «Guardar como PDF / Imprimir»");
});
$("#importBtn").addEventListener("click", () => $("#importFile").click());
$("#importFile").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  try {
    const c = await api("/api/import", { method: "POST", body: fd });
    await loadCases(c.id);
    await openCase(c.id);
    toast("Caso importado");
  } catch (e) { toast(e.message, true); }
});

// ---------------------------------------------------------------- ajustes
async function openSettings() {
  const s = await api("/api/settings");
  const f = $("#settingsForm");
  f.default_region.value = s.default_region || "";
  f.username_timeout.value = s.username_timeout;
  f.max_pivot_entities.value = s.max_pivot_entities;
  f.sherlock_db.checked = !!s.sherlock_db;
  f.include_nsfw.checked = !!s.include_nsfw;
  f.ai_base_url.value = s.ai_base_url || "";
  f.ai_model.value = s.ai_model || "";
  syncAiPreset();
  $("#keysList").innerHTML = Object.entries(s.api_keys).map(([k, v]) => `
    <div class="key-row">
      <div class="lbl">${esc(v.label)} <small>${link(v.url, "Conseguir clave")}</small></div>
      <input type="password" data-key="${esc(k)}" placeholder="${v.set ? "Configurada " + esc(v.masked) : "Sin configurar"}" autocomplete="off">
      ${v.set ? `<button type="button" class="ghost small danger" data-clear="${esc(k)}">Borrar</button>` : "<span></span>"}
    </div>`).join("");
  $("#settingsDlg").showModal();
}
$("#settingsBtn").addEventListener("click", openSettings);
function syncAiPreset() {
  const f = $("#settingsForm");
  const cur = `${f.ai_base_url.value.trim()}|${f.ai_model.value.trim()}`;
  $("#aiPreset").value = [...$("#aiPreset").options].some((o) => o.value === cur) ? cur : "";
}
$("#aiPreset").addEventListener("change", (ev) => {
  if (!ev.target.value) return;
  const [base, model] = ev.target.value.split("|");
  const f = $("#settingsForm");
  f.ai_base_url.value = base;
  f.ai_model.value = model;
});
$("#settingsForm").ai_base_url.addEventListener("input", syncAiPreset);
$("#settingsForm").ai_model.addEventListener("input", syncAiPreset);
$("#keysList").addEventListener("click", (ev) => {
  const k = ev.target.closest("[data-clear]")?.dataset.clear;
  if (!k) return;
  const input = $(`#keysList input[data-key="${k}"]`);
  input.dataset.clearIt = "1";
  input.placeholder = "Se borrará al guardar";
  ev.target.remove();
});
$("#saveSettingsBtn").addEventListener("click", async (ev) => {
  ev.preventDefault();
  const f = $("#settingsForm");
  const api_keys = {};
  f.querySelectorAll("input[data-key]").forEach((i) => {
    if (i.value.trim()) api_keys[i.dataset.key] = i.value.trim();
    else if (i.dataset.clearIt) api_keys[i.dataset.key] = "";
  });
  try {
    await api("/api/settings", { method: "PUT", body: {
      default_region: f.default_region.value.trim().toUpperCase(),
      username_timeout: Number(f.username_timeout.value) || 15,
      max_pivot_entities: Number(f.max_pivot_entities.value) || 25,
      sherlock_db: f.sherlock_db.checked,
      include_nsfw: f.include_nsfw.checked,
      ai_base_url: f.ai_base_url.value.trim(),
      ai_model: f.ai_model.value.trim(),
      api_keys,
    } });
    await loadMeta();
    $("#settingsDlg").close();
    toast("Ajustes guardados");
  } catch (e) { toast(e.message, true); }
});

// ---------------------------------------------------------------- arranque
async function loadMeta() {
  S.meta = await api("/api/meta");
  S.types = S.meta.entity_types;
  S.modules = Object.fromEntries(S.meta.modules.map((m) => [m.name, m]));
}

(async function init() {
  initGraph();
  await loadMeta();
  fillTypeSelect(null);
  await loadCases();
  const last = Number(localStorage.getItem("osint-case"));
  const target = S.cases.find((c) => c.id === last) ? last : S.cases[0]?.id;
  await openCase(target ?? null);
  $("#searchInput").focus();
})().catch((e) => toast("No se pudo iniciar: " + e.message, true));
