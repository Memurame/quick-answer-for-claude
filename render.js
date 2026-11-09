/* Quick Claude Answer – gemeinsame Darstellung strukturierter Antworten
 * Wird vom Content-Script (Popup im Shadow DOM) und von der Sidebar genutzt.
 * Baut ausschliesslich DOM-Knoten mit textContent – kein innerHTML für Modell-Text.
 */
"use strict";

(function () {
  if (window.CQARender) return;

  const VERDICT = {
    positive: { icon: "✓", cls: "pos" },
    negative: { icon: "✗", cls: "neg" },
    neutral: { icon: "•", cls: "neu" },
  };
  const KIND_LABEL = {
    matrix: "Zuordnung",
    choice: "Auswahl",
    number: "Rechnung",
    text: "Antwort",
  };
  const CONF_LABEL = { high: "sicher", medium: "eher sicher", low: "unsicher" };

  const CSS = `
    .cqa { display: grid; gap: 8px; }
    .cqa-head { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 11px; }
    .cqa-badge { padding: 1px 7px; border-radius: 999px; background: rgba(127,127,127,.18); }
    .cqa-conf-high { background: rgba(46,158,91,.22); }
    .cqa-conf-medium { background: rgba(214,160,40,.25); }
    .cqa-conf-low { background: rgba(214,69,69,.25); }
    .cqa-main { font-size: 1.25em; font-weight: 700; white-space: pre-wrap; word-break: break-word; }
    .cqa-rows { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
    .cqa-row { display: grid; grid-template-columns: 22px 1fr; gap: 2px 6px; align-items: start;
               padding: 5px 6px; border-radius: 6px; border-left: 3px solid transparent;
               background: rgba(127,127,127,.08); }
    .cqa-row.pos { border-left-color: #2e9e5b; background: rgba(46,158,91,.12); }
    .cqa-row.neg { border-left-color: #d64545; background: rgba(214,69,69,.10); }
    .cqa-row.neu { border-left-color: #8a8a8a; }
    .cqa-ico { grid-row: span 2; width: 20px; height: 20px; border-radius: 50%; display: grid;
               place-items: center; font-weight: 700; font-size: 12px; color: #fff; background: #8a8a8a; }
    .pos .cqa-ico { background: #2e9e5b; }
    .neg .cqa-ico { background: #d64545; }
    .cqa-label { word-break: break-word; }
    .cqa-val { justify-self: start; font-size: 11px; font-weight: 700; padding: 1px 7px; border-radius: 4px;
               background: rgba(127,127,127,.2); }
    .pos .cqa-val { background: #2e9e5b; color: #fff; }
    .neg .cqa-val { background: #d64545; color: #fff; }
    .cqa-choice .cqa-row.neg { opacity: .55; }
    .cqa-choice .cqa-row.pos .cqa-label { font-weight: 700; }
    .cqa-note { font-size: .92em; opacity: .8; white-space: pre-wrap; word-break: break-word; }
    .cqa-plain { white-space: pre-wrap; word-break: break-word; font-weight: 600; }
  `;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /**
   * @param {object|null} s  strukturierte Antwort (Schema siehe background.js) oder null
   * @param {string} fallbackText  Klartext, falls keine Struktur vorhanden
   * @returns {HTMLElement}
   */
  function render(s, fallbackText) {
    if (!s || typeof s !== "object") return el("div", "cqa-plain", fallbackText || "");

    const root = el("div", "cqa cqa-" + (s.kind || "text"));

    const head = el("div", "cqa-head");
    head.append(el("span", "cqa-badge", KIND_LABEL[s.kind] || "Antwort"));
    if (s.confidence) {
      head.append(el("span", "cqa-badge cqa-conf-" + s.confidence, CONF_LABEL[s.confidence] || s.confidence));
    }
    root.append(head);

    const items = Array.isArray(s.items) ? s.items : [];
    if (items.length && (s.kind === "matrix" || s.kind === "choice")) {
      const list = el("ol", "cqa-rows");
      items.forEach((it, i) => {
        const v = VERDICT[it.verdict] || VERDICT.neutral;
        const row = el("li", "cqa-row " + v.cls);
        row.append(el("span", "cqa-ico", v.icon));
        const prefix = s.kind === "matrix" ? `${i + 1}. ` : "";
        row.append(el("span", "cqa-label", prefix + (it.label || "")));
        if (it.value) row.append(el("span", "cqa-val", it.value));
        list.append(row);
      });
      root.append(list);
    } else {
      root.append(el("div", "cqa-main", s.answer || fallbackText || ""));
    }

    if (s.note) root.append(el("div", "cqa-note", "💡 " + s.note));
    return root;
  }

  window.CQARender = { render, CSS };
})();
