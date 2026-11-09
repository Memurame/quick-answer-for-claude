/* Quick Answer for Claude – Microsoft-Forms-Modus (Content-Script)
 *
 * Liest die Fragen der aktuell sichtbaren Formularseite aus („formsScan“) und
 * füllt die Antworten von Claude ein („formsFill“). Auf „Weiter“ bzw. „Absenden“
 * klickt die Erweiterung nie selbst – das macht der Benutzer.
 */
"use strict";

(() => {
  if (window.__quickAnswerForClaudeForms) return;
  window.__quickAnswerForClaudeForms = true;

  const QUESTION_SELECTOR = [
    '[data-automation-id="questionItem"]',
    ".office-form-question", // ältere Forms-Oberfläche
  ].join(",");
  const TITLE_SELECTOR = [
    '[data-automation-id="questionTitle"]',
    ".office-form-question-title",
  ].join(",");
  const TEXT_INPUT_SELECTOR =
    'textarea, input:not([type]), input[type="text"], input[type="number"], input[type="date"], ' +
    'input[type="email"], input[type="tel"], input[type="url"], input[type="time"]';

  /** Letzter Scan: { scanId, questions: [{ id, item, kind, ... }] } */
  let lastScan = null;

  /* ---------------- Hilfsfunktionen ---------------- */

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest("[hidden], [aria-hidden='true']")) return false;
    return el.getClientRects().length > 0;
  }

  // Eingaben sind in Forms oft visuell versteckt – dann zählt die Sichtbarkeit des Containers.
  function isUsable(el, item) {
    if (el.disabled) return false;
    const box = el.closest("label, [role='radio'], [role='checkbox'], [data-automation-id='choiceItem']") || el;
    return isVisible(box) || (isVisible(item) && el.getClientRects().length > 0);
  }

  function textOfIds(ids) {
    return clean(
      (ids || "")
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ")
    );
  }

  function labelOf(el) {
    return (
      clean(el.getAttribute("aria-label")) ||
      textOfIds(el.getAttribute("aria-labelledby")) ||
      clean(el.labels?.[0]?.textContent) ||
      clean(el.closest('[data-automation-id="choiceItem"]')?.textContent) ||
      clean(el.closest("label")?.textContent) ||
      (el.getAttribute("role") ? clean(el.textContent) : "") ||
      clean(el.value) ||
      clean(el.title)
    );
  }

  function titleOf(item) {
    const t = item.querySelector(TITLE_SELECTOR);
    let s = clean(t ? t.innerText || t.textContent : "");
    if (!s) s = clean((item.innerText || "").split("\n").find((l) => l.trim()));
    // Pflichtfeld-Sternchen am Ende entfernen
    return s.replace(/\s*\*\s*$/, "");
  }

  function isChecked(el) {
    if (el.tagName === "INPUT") return el.checked;
    return el.getAttribute("aria-checked") === "true";
  }

  async function waitFor(fn, timeout = 1500) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const r = fn();
      if (r) return r;
      await sleep(50);
    }
    return null;
  }

  /* ---------------- Fragen erkennen ---------------- */

  function findItems() {
    return [...document.querySelectorAll(QUESTION_SELECTOR)]
      // verschachtelte Treffer (alte + neue Klasse am selben Baum) nur einmal
      .filter((el, _, all) => !all.some((o) => o !== el && o.contains(el)))
      .filter(isVisible);
  }

  function radioGroupKey(el, item) {
    if (el.tagName === "INPUT" && el.name) return "name:" + el.name;
    const g = el.closest("[role='radiogroup']");
    return g && item.contains(g) ? g : item;
  }

  function rowLabel(groupEls, item, index) {
    const first = groupEls[0];
    const g = first.closest("[role='radiogroup']");
    if (g && item.contains(g)) {
      const l = clean(g.getAttribute("aria-label")) || textOfIds(g.getAttribute("aria-labelledby"));
      if (l) return l;
    }
    const row = first.closest("tr, [role='row']");
    if (row) {
      const head = [...row.querySelectorAll("th, td, [role='rowheader'], [role='cell']")].find(
        (c) => !c.querySelector("input, [role='radio']") && clean(c.textContent)
      );
      if (head) return clean(head.textContent);
    }
    return "Zeile " + (index + 1);
  }

  function columnHeaders(item) {
    return [...item.querySelectorAll("[role='columnheader'], thead th")]
      .map((c) => clean(c.textContent))
      .filter(Boolean);
  }

  function findDropdownTrigger(item) {
    return [...item.querySelectorAll("[aria-haspopup='listbox'], [role='combobox']")].find((el) =>
      isVisible(el)
    );
  }

  function visibleOptions() {
    return [...document.querySelectorAll("[role='listbox'] [role='option'], [role='option']")]
      .filter(isVisible)
      .filter((el, _, all) => !all.some((o) => o !== el && o.contains(el)));
  }

  async function closeDropdown(trigger) {
    const esc = { key: "Escape", code: "Escape", keyCode: 27, bubbles: true };
    (document.activeElement || trigger).dispatchEvent(new KeyboardEvent("keydown", esc));
    await waitFor(() => visibleOptions().length === 0, 500);
    if (visibleOptions().length) trigger.click();
  }

  async function readDropdownOptions(trigger) {
    trigger.click();
    const opts = await waitFor(() => {
      const o = visibleOptions();
      return o.length ? o : null;
    });
    const labels = (opts || []).map(labelOf);
    await closeDropdown(trigger);
    return labels;
  }

  /** Analysiert einen Fragecontainer. Gibt null zurück, wenn nichts ausfüllbar ist. */
  async function analyze(item, id) {
    const base = { id, item, title: titleOf(item), images: [] };
    base.images = [...item.querySelectorAll("img")]
      .filter((img) => isVisible(img) && img.naturalWidth >= 40 && img.naturalHeight >= 40)
      .map((img) => img.currentSrc || img.src)
      .filter((src) => /^(https?:|data:image\/)/.test(src))
      .slice(0, 4);

    // Eingaben innerhalb einer Option (z. B. „Andere: ____“) zählen nicht als Textfrage.
    // Wrapper mit role=radio/checkbox, die selbst ein echtes <input> enthalten, nicht doppelt zählen.
    const pick = (sel, inputSel) =>
      [...item.querySelectorAll(sel)].filter(
        (el) => isUsable(el, item) && !(el.tagName !== "INPUT" && el.querySelector(inputSel))
      );
    const radios = pick("input[type='radio'], [role='radio']", "input[type='radio']");
    const checks = pick("input[type='checkbox'], [role='checkbox']", "input[type='checkbox']");

    if (radios.length) {
      const groups = new Map();
      for (const r of radios) {
        const k = radioGroupKey(r, item);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }
      const list = [...groups.values()];
      if (list.length === 1) {
        return { ...base, kind: "single", optionEls: list[0], options: list[0].map(labelOf) };
      }
      const headers = columnHeaders(item);
      const n = list[0].length;
      const columns = headers.length >= n ? headers.slice(-n) : list[0].map(labelOf);
      return {
        ...base,
        kind: "matrix",
        groups: list,
        rows: list.map((g, i) => rowLabel(g, item, i)),
        columns,
      };
    }

    if (checks.length) {
      return { ...base, kind: "multi", optionEls: checks, options: checks.map(labelOf) };
    }

    const select = [...item.querySelectorAll("select")].find((s) => isVisible(s) && !s.disabled);
    if (select) {
      const opts = [...select.options].filter((o) => !o.disabled && clean(o.textContent));
      return { ...base, kind: "dropdown", selectEl: select, selectOpts: opts, options: opts.map((o) => clean(o.textContent)) };
    }

    const trigger = findDropdownTrigger(item);
    if (trigger) {
      const options = await readDropdownOptions(trigger);
      if (options.length) return { ...base, kind: "dropdown", trigger, options };
    }

    const texts = [...item.querySelectorAll(TEXT_INPUT_SELECTOR)].filter(
      (el) => isVisible(el) && !el.disabled && !el.readOnly
    );
    if (texts.length) {
      const t = texts[0];
      return {
        ...base,
        kind: "text",
        textEl: t,
        multiline: t.tagName === "TEXTAREA",
        placeholder: clean(t.getAttribute("placeholder")),
        inputType: t.tagName === "INPUT" ? t.type : "",
      };
    }
    return null;
  }

  function formTitle() {
    const t =
      document.querySelector('[data-automation-id="formTitle"]') ||
      document.querySelector(".office-form-title");
    return clean(t?.textContent) || document.title;
  }

  function formDescription() {
    const d =
      document.querySelector('[data-automation-id="formDescription"]') ||
      document.querySelector(".office-form-description");
    return clean(d?.innerText || d?.textContent).slice(0, 2000);
  }

  async function scan(scanId) {
    clearMarks();
    const items = findItems();
    const questions = [];
    const unsupported = [];
    for (const item of items) {
      const q = await analyze(item, questions.length + unsupported.length + 1);
      if (q) questions.push(q);
      else unsupported.push({ id: questions.length + unsupported.length + 1, title: titleOf(item) });
    }
    lastScan = { scanId, questions };

    // Nur serialisierbare Daten an das Hintergrundskript
    return {
      formTitle: formTitle(),
      formDescription: formDescription(),
      unsupported,
      questions: questions.map((q) => {
        const out = { id: q.id, type: q.kind, question: q.title };
        const full = clean(q.item.innerText || q.item.textContent);
        if (full && full !== q.title) out.context = full.slice(0, 2000);
        if (q.options) out.options = q.options;
        if (q.kind === "matrix") {
          out.rows = q.rows;
          out.columns = q.columns;
        }
        if (q.kind === "text") {
          out.multiline = q.multiline;
          if (q.placeholder) out.placeholder = q.placeholder;
          if (q.inputType && q.inputType !== "text") out.inputType = q.inputType;
        }
        if (q.images.length) out.images = q.images;
        return out;
      }),
    };
  }

  /* ---------------- Ausfüllen ---------------- */

  function setChecked(el, want) {
    if (isChecked(el) === want) return;
    el.click();
    // Manche Komponenten reagieren nur auf den Klick aufs Label
    if (isChecked(el) !== want) el.closest("label")?.click();
  }

  function setText(el, text) {
    el.focus();
    try {
      el.select();
    } catch (_) {}
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, text);
    } catch (_) {}
    if (!ok || el.value !== text) {
      el.value = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
  }

  async function pickDropdown(q, index) {
    if (q.selectEl) {
      const opt = q.selectOpts[index];
      if (!opt) return false;
      q.selectEl.value = opt.value;
      q.selectEl.dispatchEvent(new Event("input", { bubbles: true }));
      q.selectEl.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    q.trigger.click();
    const opts = await waitFor(() => {
      const o = visibleOptions();
      return o.length ? o : null;
    });
    if (!opts) return false;
    // Über den Text zuordnen, Index nur als Rückfall
    const wanted = q.options[index];
    const target = opts.find((o) => labelOf(o) === wanted) || opts[index];
    if (!target) {
      await closeDropdown(q.trigger);
      return false;
    }
    target.click();
    return true;
  }

  const MARK_ATTR = "data-cqa-mark";
  function mark(item, confidence) {
    if (confidence === "high") return;
    item.setAttribute(MARK_ATTR, "");
    item.style.outline = confidence === "low" ? "2px dashed #d64545" : "2px dashed #d6a028";
    item.style.outlineOffset = "4px";
  }
  function clearMarks() {
    for (const el of document.querySelectorAll(`[${MARK_ATTR}]`)) {
      el.style.outline = "";
      el.style.outlineOffset = "";
      el.removeAttribute(MARK_ATTR);
    }
  }

  async function fill(answers) {
    const byId = new Map(answers.map((a) => [a.id, a]));
    const result = { filled: [], failed: [] };
    for (const q of lastScan.questions) {
      const a = byId.get(q.id);
      if (!a) {
        result.failed.push(q.id);
        continue;
      }
      try {
        let ok = false;
        if (q.kind === "single") {
          const el = q.optionEls[a.choices?.[0]];
          if (el) {
            setChecked(el, true);
            ok = true;
          }
        } else if (q.kind === "multi") {
          const want = new Set(a.choices || []);
          q.optionEls.forEach((el, i) => setChecked(el, want.has(i)));
          ok = want.size > 0;
        } else if (q.kind === "matrix") {
          (a.rows || []).forEach((col, r) => {
            const el = q.groups[r]?.[col];
            if (el) {
              setChecked(el, true);
              ok = true;
            }
          });
        } else if (q.kind === "dropdown") {
          ok = a.choices?.length ? await pickDropdown(q, a.choices[0]) : false;
        } else if (q.kind === "text") {
          if (a.text) {
            setText(q.textEl, a.text);
            ok = true;
          }
        }
        // Forms rendert nach Änderungen neu – kurz Luft lassen
        await sleep(40);
        if (ok) {
          result.filled.push(q.id);
          mark(q.item, a.confidence);
        } else result.failed.push(q.id);
      } catch (_) {
        result.failed.push(q.id);
      }
    }
    return result;
  }

  /* ---------------- Nachrichten ---------------- */

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "formsScan") {
      // Frames ohne Fragen bleiben stumm, damit der Frame mit dem Formular antwortet.
      if (!findItems().length) return;
      return scan(msg.scanId);
    }
    if (msg.type === "formsFill") {
      if (!lastScan || lastScan.scanId !== msg.scanId) return;
      return fill(msg.answers || []);
    }
  });
})();
