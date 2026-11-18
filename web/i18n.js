"use strict";

// Traducción de la interfaz. El código y los módulos escriben en español; en inglés se traduce lo que se muestra
// (texto del DOM, atributos, diálogos, etiquetas del grafo e informe) con el diccionario de i18n-en.js.
const I18N = (() => {
  const lang = localStorage.getItem("osint-lang") === "en" ? "en" : "es";
  const locale = lang === "en" ? "en-US" : "es-CL";
  const exact = new Map(), keys = new Map(), patterns = [];
  const missing = new Set();
  const SPANISH = /[áéíóúñ¿¡]|\b(de|del|los|las|una|con|sin|para|que|por|sus|nodos?|cuentas?|buscar|investigar|caso)\b/i;
  const SKIP = "textarea, input, script, style, code, [data-notr], .det-title, .det-value, .leaflet-attribution-flag";

  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function compile(es, en) {
    const parts = es.split("{}");
    const re = new RegExp("^" + parts.map(escRe).join("(.+?)") + "$", "s");
    patterns.push({ re, en, lit: parts.reduce((n, p) => n + p.length, 0) });
  }
  function load(dict) {
    for (const [es, en] of Object.entries(dict.text || {})) (es.includes("{}") ? compile(es, en) : exact.set(es, en));
    for (const [es, en] of Object.entries(dict.keys || {})) keys.set(es, en);
    patterns.sort((a, b) => b.lit - a.lit);
  }

  function lookup(s) {
    if (exact.has(s)) return exact.get(s);
    const low = s.charAt(0).toUpperCase() + s.slice(1);
    if (low !== s && exact.has(low)) { const t = exact.get(low); return t.charAt(0).toLowerCase() + t.slice(1); }
    if (keys.has(s)) return keys.get(s);
    return null;
  }

  function fill(p, m, depth) {
    let i = 1, partial = false;
    const out = p.en.replace(/\{\}/g, () => {
      const v = m[i++] ?? "";
      const t = v.trim() && trCore(v.trim(), depth + 1);
      if (t == null && SPANISH.test(v)) partial = true;
      return t ?? v;
    });
    // un conector suelto («{} y {}») sólo se traduce si no deja trozos en español, que serían datos del usuario
    return partial && p.lit <= 4 ? null : out;
  }

  function trCore(s, depth = 0) {
    const hit = lookup(s);
    if (hit != null) return hit;
    if (/\s{2,}|\n/.test(s) && depth === 0) {
      const flat = trCore(s.replace(/\s+/g, " "), 1);
      if (flat != null) return flat;
    }
    if (s.length > 1 && s.endsWith(":")) {
      const t = trCore(s.slice(0, -1), depth + 1);
      if (t != null) return t + ":";
    }
    for (const p of patterns) {
      const m = s.match(p.re);
      const out = m && fill(p, m, depth);
      if (out != null) return out;
    }
    if (depth < 3) {
      for (const sep of [" · ", "\n", "; ", ", "]) {
        if (!s.includes(sep)) continue;
        const segs = s.split(sep);
        const out = segs.map((x) => (x.trim() ? trCore(x.trim(), depth + 1) ?? x : x));
        if (!out.some((x, i) => x !== segs[i])) continue;
        // en listas con comas sólo vale si no queda nada en español (evita traducir frases a medias)
        if (sep === ", " && out.some((x, i) => x === segs[i] && SPANISH.test(x))) continue;
        return out.join(sep);
      }
    }
    return null;
  }

  /** Traduce un texto completo; conserva los espacios de los extremos. */
  function tr(text) {
    if (lang === "es" || text == null) return text;
    const s = String(text);
    const core = s.trim();
    if (!core || !/[A-Za-zÁ-ú]/.test(core)) return s;
    const out = trCore(core);
    if (out == null) {
      if (SPANISH.test(core) && core.length < 400) missing.add(core);
      return s;
    }
    return s.replace(core, out);
  }

  /** Nombres de campos (la columna izquierda de las tablas de datos). */
  function trKey(text) {
    if (lang === "es") return text;
    const core = String(text).trim();
    return keys.has(core) ? keys.get(core) : tr(text);
  }

  const isKeyCell = (el) => el && el.tagName === "TD" && !el.previousElementSibling && el.closest("table.attrs, table.kv");

  function translateNode(node) {
    if (node.nodeType === 3) {
      const parent = node.parentElement;
      if (!parent || parent.closest(SKIP)) return;
      const t = isKeyCell(parent) ? trKey(node.nodeValue) : tr(node.nodeValue);
      if (t !== node.nodeValue) node.nodeValue = t;
      return;
    }
    if (node.nodeType !== 1 || node.closest("[data-notr]")) return;
    for (const a of ["title", "placeholder", "aria-label"]) {
      const v = node.getAttribute(a);
      if (v) { const t = tr(v); if (t !== v) node.setAttribute(a, t); }
    }
    if (node.matches(SKIP)) return;
    for (const c of node.childNodes) translateNode(c);
  }

  function translateTree(root) {
    if (lang === "es" || !root) return;
    translateNode(root);
  }

  function start() {
    if (lang === "es") return;
    document.documentElement.lang = "en";
    document.title = tr(document.title);
    translateTree(document.body);
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "childList") m.addedNodes.forEach(translateNode);
        else if (m.type === "characterData") translateNode(m.target);
        else if (m.type === "attributes") {
          const v = m.target.getAttribute(m.attributeName);
          if (v && !m.target.closest("[data-notr]")) { const t = tr(v); if (t !== v) m.target.setAttribute(m.attributeName, t); }
        }
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ["title", "placeholder", "aria-label"] });
    const multi = (m) => String(m ?? "").split("\n").map((l) => tr(l)).join("\n");
    const p = window.prompt.bind(window), c = window.confirm.bind(window), a = window.alert.bind(window);
    window.prompt = (m, d) => p(multi(m), d);
    window.confirm = (m) => c(multi(m));
    window.alert = (m) => a(multi(m));
  }

  /** Traduce un documento HTML completo (el informe). */
  function translateHtml(html) {
    if (lang === "es") return html;
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.documentElement.lang = "en";
    doc.title = tr(doc.title);
    translateTree(doc.body);
    return "<!doctype html>" + doc.documentElement.outerHTML;
  }

  async function setLang(l) {
    localStorage.setItem("osint-lang", l);
    try {
      const token = document.querySelector('meta[name="osint-token"]')?.content || "";
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(token ? { "X-Osint-Token": token } : {}) },
        body: JSON.stringify({ lang: l }),
      });
    } catch { /* el idioma de la IA se sincroniza la próxima vez */ }
    location.reload();
  }

  return { lang, locale, load, tr, trKey, translateTree, translateHtml, start, setLang, missing };
})();
