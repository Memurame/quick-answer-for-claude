"use strict";

const listEl = document.getElementById("list");
const tpl = document.getElementById("item-tpl");
const activeEl = document.getElementById("active-text");
const filterEl = document.getElementById("filter");
const askForm = document.getElementById("ask-form");
const askInput = document.getElementById("ask-input");

document.head.appendChild(
  Object.assign(document.createElement("style"), { textContent: CQARender.CSS })
);

let history = [];
let activeAnswer = null;
let keys = {};

async function loadShortcuts() {
  const cmds = await browser.commands.getAll();
  keys = Object.fromEntries(cmds.map((c) => [c.name, c.shortcut || ""]));
  document.getElementById("insert-kbd").textContent = keys["insert-answer"] || "";
}

const timeFmt = new Intl.DateTimeFormat("de-CH", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function shortModel(m) {
  return (m || "").replace(/^claude-/, "");
}

function render() {
  activeEl.textContent = activeAnswer?.text || "–";
  activeEl.classList.toggle("muted", !activeAnswer?.text);

  const q = filterEl.value.trim().toLowerCase();
  const items = q
    ? history.filter((e) => (e.question + " " + (e.answer || "")).toLowerCase().includes(q))
    : history;

  listEl.replaceChildren();
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = history.length
      ? "Keine Treffer."
      : `Noch keine Fragen. Text markieren und ${keys["ask-selection"] || "das Kürzel"} drücken ` +
        `oder mit ${keys["capture-region"] || "dem Screenshot-Kürzel"} einen Bereich wählen.`;
    listEl.appendChild(p);
    return;
  }

  for (const e of items) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = e.id;
    node.classList.add(e.status);
    if (activeAnswer?.id === e.id) node.classList.add("is-active");

    node.querySelector(".kind").textContent = e.kind === "image" ? "📷 Screenshot" : "📝 Text";
    node.querySelector(".time").textContent = timeFmt.format(new Date(e.ts));
    node.querySelector(".model").textContent = shortModel(e.model);

    const thumb = node.querySelector(".thumb");
    if (e.thumb) thumb.src = e.thumb;
    else thumb.remove();

    const qEl = node.querySelector(".question");
    if (e.question) qEl.textContent = e.question;
    else qEl.remove();

    const ansEl = node.querySelector(".answer");
    if (e.status === "done" && e.structured) {
      ansEl.classList.add("rich");
      ansEl.replaceChildren(CQARender.render(e.structured, e.answer));
    } else {
      ansEl.textContent = e.status === "pending" ? "Claude denkt nach …" : e.answer || "";
    }

    const acts = node.querySelector(".actions");
    if (e.status !== "done") {
      acts.querySelector('[data-act="use"]').remove();
      acts.querySelector('[data-act="copy"]').remove();
    }
    if (e.kind !== "text" || e.status === "pending") {
      acts.querySelector('[data-act="retry"]').remove();
    }
    listEl.appendChild(node);
  }
}

async function load() {
  const data = await browser.storage.local.get(["history", "activeAnswer"]);
  history = data.history || [];
  activeAnswer = data.activeAnswer || null;
  render();
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.history) history = changes.history.newValue || [];
  if (changes.activeAnswer) activeAnswer = changes.activeAnswer.newValue || null;
  if (changes.history || changes.activeAnswer) render();
});

listEl.addEventListener("click", async (ev) => {
  const item = ev.target.closest(".item");
  if (!item) return;
  const entry = history.find((e) => e.id === item.dataset.id);
  if (!entry) return;

  if (ev.target.classList.contains("question")) {
    ev.target.classList.toggle("open");
    return;
  }
  if (ev.target.classList.contains("thumb")) {
    ev.target.classList.toggle("big");
    return;
  }
  const act = ev.target.dataset.act;
  if (act === "use") {
    await browser.storage.local.set({ activeAnswer: { id: entry.id, text: entry.answer } });
  } else if (act === "copy") {
    await navigator.clipboard.writeText(entry.answer);
    ev.target.textContent = "Kopiert ✓";
    setTimeout(() => (ev.target.textContent = "Kopieren"), 1200);
  } else if (act === "retry") {
    browser.runtime.sendMessage({ type: "askManual", text: entry.question });
  } else if (act === "delete") {
    await browser.runtime.sendMessage({ type: "deleteEntry", id: entry.id });
  }
});

/* Bild aus der Zwischenablage (Strg+V) an die eigene Frage anhängen */
const askImageBox = document.getElementById("ask-image");
const askImageEl = askImageBox.querySelector("img");
let askImage = null; // Data-URL des eingefügten Bildes

function setAskImage(dataUrl) {
  askImage = dataUrl;
  askImageEl.src = dataUrl || "";
  askImageBox.hidden = !dataUrl;
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

askInput.addEventListener("paste", async (ev) => {
  const item = [...(ev.clipboardData?.items || [])].find(
    (i) => i.kind === "file" && i.type.startsWith("image/")
  );
  if (!item) return; // normaler Text-Paste
  ev.preventDefault();
  const file = item.getAsFile();
  if (file) setAskImage(await readAsDataUrl(file));
});
document.getElementById("ask-image-remove").addEventListener("click", () => setAskImage(null));

askForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = askInput.value.trim();
  if (!text && !askImage) return;
  browser.runtime.sendMessage({ type: "askManual", text, image: askImage });
  askInput.value = "";
  setAskImage(null);
});
askInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) askForm.requestSubmit();
});

filterEl.addEventListener("input", render);

document.getElementById("clear").addEventListener("click", async () => {
  if (!confirm("Gesamten Verlauf löschen?")) return;
  await browser.runtime.sendMessage({ type: "clearHistory" });
});
document.getElementById("settings").addEventListener("click", () => browser.runtime.openOptionsPage());

loadShortcuts().then(load);
// Kürzel können in den Einstellungen geändert werden → beim Fokussieren neu einlesen.
window.addEventListener("focus", () => loadShortcuts().then(render));
