/* Quick Claude Answer – Hintergrundskript */
"use strict";

const API_URL = "https://api.anthropic.com/v1/messages";

const DEFAULT_SYSTEM_PROMPT =
  "Du beantwortest Fragen kurz, präzise und korrekt. " +
  "Gib nur die Antwort selbst aus – keine Einleitung, keine Wiederholung der Frage, kein Markdown. " +
  "Bei Multiple-Choice-Fragen nenne die richtige(n) Option(en) mit Buchstabe/Nummer und Wortlaut. " +
  "Bei Rechenaufgaben nenne das Ergebnis und höchstens eine kurze Zeile Rechenweg. " +
  "Bei offenen Fragen antworte in 1–3 Sätzen. " +
  "Antworte in der Sprache der Frage.";

const DEFAULTS = {
  apiKey: "",
  model: "claude-opus-5-5",
  effort: "low",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  showToast: true,
  maxHistory: 200,
};

// Feste Format-Anweisung; wird an den (anpassbaren) System-Prompt angehängt.
const FORMAT_GUIDE = `Antworte im vorgegebenen JSON-Format:
- kind: "matrix", wenn mehrere Aussagen je einer Spalte/Kategorie zugeordnet werden (z. B. zutreffend/nicht zutreffend, richtig/falsch, ja/nein); "choice" bei Single- oder Multiple-Choice; "number" bei Rechenaufgaben; sonst "text".
- items: bei "matrix" ein Eintrag pro Aussage in der Reihenfolge der Seite: label = die Aussage (darf leicht gekürzt sein, muss aber eindeutig erkennbar bleiben), value = die exakte Spalten-/Kategorie-Bezeichnung von der Seite, verdict = "positive" für zutreffend/richtig/ja, "negative" für nicht zutreffend/falsch/nein, sonst "neutral". Bei "choice" ALLE Optionen in Seitenreihenfolge: label = Option inkl. Buchstabe/Nummer, value = "", verdict = "positive" für richtige, "negative" für falsche. Bei "text" und "number" ein leeres Array.
- answer: Text zum direkten Einfügen in ein Formularfeld. Bei "text"/"number" die eigentliche Antwort. Bei "matrix"/"choice" eine kompakte Zusammenfassung (eine Zeile pro Aussage bzw. die richtigen Optionen).
- note: höchstens ein kurzer Satz Begründung bzw. Rechenweg, sonst "".
- confidence: wie sicher du dir bist.`;

const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "items", "answer", "note", "confidence"],
  properties: {
    kind: { type: "string", enum: ["matrix", "choice", "number", "text"] },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "value", "verdict"],
        properties: {
          label: { type: "string" },
          value: { type: "string" },
          verdict: { type: "string", enum: ["positive", "negative", "neutral"] },
        },
      },
    },
    answer: { type: "string" },
    note: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
};

// Modelle, die serverseitige Fallbacks bei Refusals unterstützen (Haiku nicht).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

async function getSettings() {
  const stored = await browser.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

/* ---------------- Verlauf ---------------- */

// Schreibzugriffe serialisieren, damit parallele Anfragen sich nicht überschreiben.
let historyLock = Promise.resolve();
function updateHistory(mutator) {
  const run = historyLock.then(async () => {
    const { history = [] } = await browser.storage.local.get("history");
    const { maxHistory } = await getSettings();
    const next = mutator(history) || history;
    await browser.storage.local.set({ history: next.slice(0, maxHistory) });
  });
  historyLock = run.catch(() => {});
  return run;
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ---------------- Claude API ---------------- */

async function callClaude(settings, content, { structured = false } = {}) {
  const headers = {
    "content-type": "application/json",
    "x-api-key": settings.apiKey,
    "anthropic-version": "2023-06-01",
    // Nötig, weil die Anfrage aus einem Browser-Kontext kommt.
    "anthropic-dangerous-direct-browser-access": "true",
  };
  const body = {
    model: settings.model,
    max_tokens: 4096,
    system: structured ? settings.systemPrompt + "\n\n" + FORMAT_GUIDE : settings.systemPrompt,
    output_config: { effort: settings.effort },
    messages: [{ role: "user", content }],
  };
  if (structured) {
    body.output_config.format = { type: "json_schema", schema: ANSWER_SCHEMA };
  }
  if (FALLBACK_MODELS.has(settings.model)) {
    // Lehnt ein Sicherheitsfilter fälschlich ab, wiederholt die API die Anfrage
    // automatisch auf einem empfohlenen Fallback-Modell.
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    body.fallbacks = "default";
  }

  let res;
  try {
    res = await fetch(API_URL, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error("Netzwerkfehler: " + e.message);
  }
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    if (res.status === 401) throw new Error("Ungültiger API-Key (401).");
    if (res.status === 429) throw new Error("Rate-Limit erreicht (429) – kurz warten.");
    if (res.status === 529 || res.status >= 500) throw new Error(`API überlastet (${res.status}): ${msg}`);
    throw new Error(`API-Fehler ${res.status}: ${msg}`);
  }
  if (data.stop_reason === "refusal") {
    const cat = data.stop_details?.category ? ` (${data.stop_details.category})` : "";
    throw new Error("Claude hat die Anfrage abgelehnt" + cat + ".");
  }
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) {
    throw new Error(
      data.stop_reason === "max_tokens" ? "Antwort abgeschnitten (max_tokens)." : "Leere Antwort erhalten."
    );
  }
  if (!structured) return { text, model: data.model || settings.model, structured: null };

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    // z. B. bei max_tokens abgeschnitten → als Klartext anzeigen
  }
  return {
    text: parsed?.answer?.trim() || text,
    model: data.model || settings.model,
    structured: parsed,
  };
}

/* ---------------- Kommunikation mit Tabs ---------------- */

async function toast(tabId, payload) {
  if (tabId == null) return;
  const { showToast } = await getSettings();
  if (!showToast && payload.kind !== "error") return;
  try {
    await browser.tabs.sendMessage(tabId, { type: "toast", ...payload }, { frameId: 0 });
  } catch (_) {
    /* z. B. about:-Seiten ohne Content-Script */
  }
}

async function getShortcut(name) {
  const cmds = await browser.commands.getAll();
  return cmds.find((c) => c.name === name)?.shortcut || "";
}

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

const SELECTION_CODE = `(() => {
  let a = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  if (a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT")) {
    try {
      if (a.selectionStart !== a.selectionEnd) return a.value.slice(a.selectionStart, a.selectionEnd);
    } catch (e) {}
  }
  return String(window.getSelection() || "");
})()`;

async function getSelectedText(tabId) {
  try {
    const results = await browser.tabs.executeScript(tabId, { allFrames: true, code: SELECTION_CODE });
    return (results || []).map((s) => (s || "").trim()).find((s) => s.length > 0) || "";
  } catch (_) {
    return "";
  }
}

/* ---------------- Bilder ---------------- */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Screenshot konnte nicht geladen werden."));
    img.src = src;
  });
}

async function cropImage(dataUrl, rect, dpr) {
  const img = await loadImage(dataUrl);
  // captureVisibleTab skaliert in Firefox standardmäßig mit devicePixelRatio (inkl. Zoom).
  const scale = dpr;
  const sx = Math.max(0, Math.round(rect.x * scale));
  const sy = Math.max(0, Math.round(rect.y * scale));
  const sw = Math.min(img.naturalWidth - sx, Math.round(rect.width * scale));
  const sh = Math.min(img.naturalHeight - sy, Math.round(rect.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas;
}

// Für die API: PNG, bei zu großen Bildern JPEG und ggf. verkleinert.
function canvasToApiImage(canvas) {
  const MAX_DIM = 2000;
  let c = canvas;
  const factor = Math.min(1, MAX_DIM / Math.max(canvas.width, canvas.height));
  if (factor < 1) {
    c = document.createElement("canvas");
    c.width = Math.round(canvas.width * factor);
    c.height = Math.round(canvas.height * factor);
    c.getContext("2d").drawImage(canvas, 0, 0, c.width, c.height);
  }
  let url = c.toDataURL("image/png");
  let mediaType = "image/png";
  if (url.length > 3_500_000) {
    url = c.toDataURL("image/jpeg", 0.9);
    mediaType = "image/jpeg";
  }
  return { mediaType, data: url.split(",")[1] };
}

function canvasToThumb(canvas) {
  const MAX_W = 360;
  const f = Math.min(1, MAX_W / canvas.width);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(canvas.width * f));
  c.height = Math.max(1, Math.round(canvas.height * f));
  c.getContext("2d").drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.75);
}

/* ---------------- Hauptablauf ---------------- */

/**
 * @param {object} req
 * @param {"text"|"image"} req.kind
 * @param {string} [req.text]
 * @param {HTMLCanvasElement} [req.canvas]
 * @param {number|null} [req.tabId]
 * @param {string} [req.url]
 */
async function ask(req) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    await toast(req.tabId, { kind: "error", text: "Kein API-Key gesetzt – Einstellungen werden geöffnet." });
    browser.runtime.openOptionsPage();
    return;
  }

  const id = newId();
  let content;
  const entry = {
    id,
    ts: Date.now(),
    kind: req.kind,
    question: req.text || "",
    thumb: null,
    answer: null,
    status: "pending",
    url: req.url || "",
    model: settings.model,
  };

  if (req.kind === "image") {
    const img = canvasToApiImage(req.canvas);
    entry.thumb = canvasToThumb(req.canvas);
    content = [
      { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } },
      {
        type: "text",
        text: req.text || "Beantworte die Frage bzw. löse die Aufgabe auf diesem Screenshot.",
      },
    ];
  } else {
    content = req.text;
  }

  await updateHistory((h) => [entry, ...h]);
  await toast(req.tabId, { kind: "loading", text: "Claude denkt nach …" });

  try {
    const { text, model, structured } = await callClaude(settings, content, { structured: true });
    await updateHistory((h) =>
      h.map((e) => (e.id === id ? { ...e, answer: text, structured, status: "done", model } : e))
    );
    await browser.storage.local.set({ activeAnswer: { id, text } });
    const insertKey = await getShortcut("insert-answer");
    await toast(req.tabId, {
      kind: "answer",
      text,
      structured,
      head: insertKey ? `Antwort · ${insertKey} zum Einfügen` : "Antwort",
    });
  } catch (err) {
    await updateHistory((h) =>
      h.map((e) => (e.id === id ? { ...e, answer: err.message, status: "error" } : e))
    );
    await toast(req.tabId, { kind: "error", text: err.message });
  }
}

async function askSelection(tab, preselected) {
  const text = (preselected || (await getSelectedText(tab.id)) || "").trim();
  if (!text) {
    await toast(tab.id, { kind: "error", text: "Kein Text markiert." });
    return;
  }
  await ask({ kind: "text", text, tabId: tab.id, url: tab.url });
}

async function captureRegion(tab) {
  let sel;
  try {
    sel = await browser.tabs.sendMessage(tab.id, { type: "selectRegion" }, { frameId: 0 });
  } catch (_) {
    // Seite ohne Content-Script (z. B. about:, addons.mozilla.org) → ganzer Bereich
    sel = { full: true };
  }
  if (!sel || sel.cancelled) return;
  await captureAndAsk(tab, sel.full ? null : sel);
}

async function captureAndAsk(tab, rect) {
  let dataUrl;
  try {
    dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (e) {
    await toast(tab.id, { kind: "error", text: "Screenshot fehlgeschlagen: " + e.message });
    return;
  }
  let canvas;
  if (rect) {
    canvas = await cropImage(dataUrl, rect, rect.dpr || 1);
  } else {
    const img = await loadImage(dataUrl);
    canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
  }
  await ask({ kind: "image", canvas, tabId: tab.id, url: tab.url });
}

async function insertAnswer(tab) {
  const { activeAnswer } = await browser.storage.local.get("activeAnswer");
  if (!activeAnswer?.text) {
    await toast(tab.id, { kind: "error", text: "Noch keine Antwort vorhanden." });
    return;
  }
  let inserted = false;
  try {
    inserted = await browser.tabs.sendMessage(tab.id, { type: "insert", text: activeAnswer.text });
  } catch (_) {}
  if (!inserted) {
    try {
      await navigator.clipboard.writeText(activeAnswer.text);
      await toast(tab.id, { kind: "info", text: "Kein Eingabefeld fokussiert – Antwort in Zwischenablage kopiert." });
    } catch (_) {
      await toast(tab.id, { kind: "error", text: "Kein Eingabefeld fokussiert." });
    }
  }
}

/* ---------------- Tastenkürzel ---------------- */

browser.commands.onCommand.addListener(async (command) => {
  const tab = await getActiveTab();
  if (!tab) return;
  if (command === "ask-selection") return askSelection(tab);
  if (command === "capture-region") return captureRegion(tab);
  if (command === "insert-answer") return insertAnswer(tab);
});

/* ---------------- Kontextmenü ---------------- */

browser.menus.removeAll().then(() => {
  browser.menus.create({ id: "ask-text", title: "Claude fragen: „%s“", contexts: ["selection"] });
  browser.menus.create({
    id: "ask-region",
    title: "Screenshot-Bereich an Claude",
    contexts: ["page", "selection", "image", "link", "editable", "frame"],
  });
  browser.menus.create({
    id: "ask-visible",
    title: "Ganzen sichtbaren Bereich an Claude",
    contexts: ["page", "selection", "image", "link", "editable", "frame"],
  });
  browser.menus.create({ id: "insert", title: "Aktuelle Antwort einfügen", contexts: ["editable"] });
});

browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "ask-text") return askSelection(tab, info.selectionText);
  if (info.menuItemId === "ask-region") return captureRegion(tab);
  if (info.menuItemId === "ask-visible") return captureAndAsk(tab, null);
  if (info.menuItemId === "insert") return insertAnswer(tab);
});

/* ---------------- Nachrichten von Sidebar / Options ---------------- */

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === "askManual") {
    return getActiveTab().then((tab) =>
      ask({ kind: "text", text: msg.text, tabId: null, url: tab?.url || "" })
    );
  }
  if (msg.type === "testKey") {
    return getSettings().then(async (s) => {
      try {
        const r = await callClaude({ ...s, ...msg.overrides }, "Antworte nur mit: OK");
        return { ok: true, text: r.text, model: r.model };
      } catch (e) {
        return { ok: false, text: e.message };
      }
    });
  }
  if (msg.type === "deleteEntry") {
    return updateHistory((h) => h.filter((e) => e.id !== msg.id));
  }
  if (msg.type === "clearHistory") {
    return updateHistory(() => []);
  }
  if (msg.type === "getDefaults") {
    return Promise.resolve(DEFAULTS);
  }
});
