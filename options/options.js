"use strict";

const FIELDS = ["apiKey", "model", "effort", "systemPrompt", "maxHistory", "showToast"];
const $ = (id) => document.getElementById(id);
const statusEl = $("status");
let DEFAULTS = {};

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || "";
}

function readForm() {
  return {
    apiKey: $("apiKey").value.trim(),
    model: $("model").value,
    effort: $("effort").value,
    systemPrompt: $("systemPrompt").value.trim() || DEFAULTS.systemPrompt,
    maxHistory: Math.max(10, parseInt($("maxHistory").value, 10) || DEFAULTS.maxHistory),
    showToast: $("showToast").checked,
  };
}

async function load() {
  DEFAULTS = await browser.runtime.sendMessage({ type: "getDefaults" });
  const s = { ...DEFAULTS, ...(await browser.storage.local.get(FIELDS)) };
  $("apiKey").value = s.apiKey;
  $("model").value = s.model;
  $("effort").value = s.effort;
  $("systemPrompt").value = s.systemPrompt;
  $("maxHistory").value = s.maxHistory;
  $("showToast").checked = s.showToast;
}

$("save").addEventListener("click", async () => {
  await browser.storage.local.set(readForm());
  setStatus("Gespeichert ✓", "ok");
});

$("test").addEventListener("click", async () => {
  setStatus("Teste …");
  const res = await browser.runtime.sendMessage({ type: "testKey", overrides: readForm() });
  setStatus(res.ok ? `OK – ${res.model} antwortet: „${res.text}“` : res.text, res.ok ? "ok" : "err");
});

$("resetPrompt").addEventListener("click", () => {
  $("systemPrompt").value = DEFAULTS.systemPrompt;
});

load();

/* ---------------- Tastenkürzel ---------------- */

const COMMAND_LABELS = {
  "ask-selection": "Markierten Text an Claude schicken",
  "capture-region": "Screenshot-Bereich (Enter = ganzer sichtbarer Bereich)",
  "insert-answer": "Aktuelle Antwort ins fokussierte Feld einfügen",
  "fill-forms": "Formular (Microsoft Forms) ausfüllen lassen",
  _execute_sidebar_action: "Verlauf-Sidebar ein-/ausblenden",
};

// Bekannte Firefox-/Linux-Belegungen, vor denen gewarnt wird.
const KNOWN_CONFLICTS = {
  "Ctrl+Alt+R": "Firefox-Lesemodus (Linux)",
  "Ctrl+Alt+Delete": "System",
  "Ctrl+Shift+S": "Firefox-Bildschirmfoto",
  "Ctrl+Shift+Y": "Firefox-Downloads",
  "Ctrl+Shift+A": "Firefox-Add-ons-Verwaltung",
  "Ctrl+Shift+B": "Firefox-Lesezeichen-Symbolleiste",
  "Ctrl+Shift+H": "Firefox-Chronik",
  "Ctrl+Shift+O": "Firefox-Lesezeichen",
  "Ctrl+Shift+P": "Firefox privates Fenster",
  "Ctrl+Shift+N": "Firefox Fenster wiederherstellen",
  "Ctrl+Shift+T": "Firefox Tab wiederherstellen",
  "Ctrl+Shift+W": "Firefox Fenster schliessen",
  "Ctrl+Shift+Q": "Firefox beenden",
  "Ctrl+Shift+I": "Firefox Entwicklerwerkzeuge",
  "Ctrl+Shift+K": "Firefox Web-Konsole",
  "Ctrl+Shift+C": "Firefox Inspektor",
  "Ctrl+Shift+E": "Firefox Netzwerkanalyse",
  "Ctrl+Shift+M": "Firefox Bildschirmgrössen-Test",
  "Ctrl+Shift+V": "Als reinen Text einfügen",
  "Alt+D": "Firefox Adressleiste",
  "Alt+F": "Firefox Menü „Datei“",
  "Alt+E": "Firefox Menü „Bearbeiten“",
  "Alt+A": "Firefox Menü „Ansicht“",
  "Alt+C": "Firefox Menü „Chronik“",
  "Alt+L": "Firefox Menü „Lesezeichen“",
  "Alt+X": "Firefox Menü „Extras“",
  "Alt+H": "Firefox Menü „Hilfe“",
};

const CODE_KEYS = {
  Comma: "Comma", Period: "Period", Space: "Space", Home: "Home", End: "End",
  PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert", Delete: "Delete",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
};

function keyFromEvent(e) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(e.code))) return m[1];
  if ((m = /^Digit(\d)$/.exec(e.code))) return m[1];
  if ((m = /^Numpad(\d)$/.exec(e.code))) return m[1];
  if (/^F([1-9]|1[0-2])$/.test(e.code)) return e.code;
  return CODE_KEYS[e.code] || null;
}

function comboFromEvent(e) {
  const key = keyFromEvent(e);
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return [...mods, key].join("+");
}

const scTable = $("shortcuts");
const scStatus = $("sc-status");

function setScStatus(text, cls) {
  scStatus.textContent = text;
  scStatus.className = "hint " + (cls || "");
}

async function renderShortcuts() {
  const cmds = await browser.commands.getAll();
  scTable.replaceChildren();
  for (const cmd of cmds) {
    const row = $("sc-row").content.firstElementChild.cloneNode(true);
    row.querySelector(".desc").textContent = COMMAND_LABELS[cmd.name] || cmd.description || cmd.name;
    const input = row.querySelector(".sc-input");
    input.value = cmd.shortcut || "— keins —";
    input.dataset.name = cmd.name;
    row.querySelector(".sc-reset").addEventListener("click", async () => {
      await browser.commands.reset(cmd.name);
      setScStatus("Auf Standard zurückgesetzt.", "ok");
      renderShortcuts();
    });
    scTable.appendChild(row);
  }
}

scTable.addEventListener("focusin", (e) => {
  if (!e.target.classList.contains("sc-input")) return;
  e.target.dataset.old = e.target.value;
  e.target.value = "Taste drücken …";
});
scTable.addEventListener("focusout", (e) => {
  if (!e.target.classList.contains("sc-input")) return;
  if (e.target.value === "Taste drücken …") e.target.value = e.target.dataset.old;
});

scTable.addEventListener("keydown", async (e) => {
  const input = e.target;
  if (!input.classList.contains("sc-input")) return;
  e.preventDefault();
  e.stopPropagation();
  if (["Control", "Alt", "Shift", "Meta", "AltGraph"].includes(e.key)) return;

  if (e.key === "Escape") return input.blur();
  if (e.key === "Backspace" && !e.ctrlKey && !e.altKey) {
    await browser.commands.update({ name: input.dataset.name, shortcut: "" });
    setScStatus("Kürzel entfernt.", "ok");
    input.dataset.old = "— keins —";
    input.blur();
    return renderShortcuts();
  }

  const combo = comboFromEvent(e);
  if (!combo) return setScStatus("Diese Taste wird nicht unterstützt.", "err");
  if (!e.ctrlKey && !e.altKey && !/^F\d+$/.test(combo)) {
    return setScStatus("Bitte Ctrl und/oder Alt mitdrücken.", "err");
  }

  const cmds = await browser.commands.getAll();
  const dup = cmds.find((c) => c.shortcut === combo && c.name !== input.dataset.name);
  if (dup) {
    return setScStatus(`${combo} ist schon für „${COMMAND_LABELS[dup.name] || dup.name}“ vergeben.`, "err");
  }

  try {
    await browser.commands.update({ name: input.dataset.name, shortcut: combo });
  } catch (err) {
    return setScStatus(`${combo} ist nicht erlaubt: ${err.message}`, "err");
  }
  const warn = KNOWN_CONFLICTS[combo];
  setScStatus(
    warn ? `${combo} gespeichert – Achtung, überschreibt evtl.: ${warn}.` : `${combo} gespeichert ✓`,
    warn ? "err" : "ok"
  );
  input.dataset.old = combo;
  input.blur();
  renderShortcuts();
});

renderShortcuts();
