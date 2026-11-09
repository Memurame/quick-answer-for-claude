/* Quick Answer for Claude – Content-Script */
"use strict";

(() => {
  if (window.__quickAnswerForClaude) return;
  window.__quickAnswerForClaude = true;

  const isTop = window === window.top;

  /* ---------------- Einfügen ---------------- */

  function deepActiveElement() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  const TEXT_INPUT_TYPES = /^(text|search|url|tel|email|number|password|)$/i;

  function insertText(text) {
    const el = deepActiveElement();
    if (!el) return false;
    const isInput =
      el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && TEXT_INPUT_TYPES.test(el.type || ""));
    const isEditable = el.isContentEditable;
    if (!isInput && !isEditable) return false;
    if (el.disabled || el.readOnly) return false;

    el.focus();
    // execCommand erhält Undo-Verlauf und löst die Events aus, auf die Frameworks (React, Vue …) hören.
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, text);
    } catch (_) {}
    if (ok) return true;

    if (isInput) {
      try {
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        el.setRangeText(text, start, end, "end");
      } catch (_) {
        el.value = text; // z. B. type=number unterstützt keine Selection
      }
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      return true;
    }
    return false;
  }

  /* ---------------- Toast (nur Top-Frame) ---------------- */

  let toastHost = null;
  let toastTimer = null;

  function ensureToast() {
    if (toastHost && toastHost.isConnected) return toastHost;
    toastHost = document.createElement("div");
    toastHost.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;";
    const root = toastHost.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        .t { font: 13px/1.4 system-ui, sans-serif; width: max-content; max-width: min(440px, calc(100vw - 32px));
             padding: 10px 12px; border-radius: 10px; background: #1f1e1c; color: #f5f4ef;
             box-shadow: 0 6px 24px rgba(0,0,0,.35); word-break: break-word; opacity: .97; }
        .t.error { background: #8a1c1c; }
        .t.info { background: #2c4a6b; }
        .top { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
        .h { font-size: 11px; opacity: .7; flex: 1; }
        .x { all: unset; cursor: pointer; opacity: .6; font-size: 14px; padding: 0 2px; }
        .x:hover { opacity: 1; }
        .b { max-height: min(60vh, 520px); overflow: auto; white-space: pre-wrap; }
        .b.rich { white-space: normal; }
      </style>
      <div class="t"><div class="top"><div class="h"></div><button class="x" title="Schliessen">✕</button></div><div class="b"></div></div>`;
    toastHost._box = root.querySelector(".t");
    toastHost._head = root.querySelector(".h");
    toastHost._body = root.querySelector(".b");
    if (window.CQARender) {
      const style = document.createElement("style");
      style.textContent = window.CQARender.CSS;
      root.appendChild(style);
    }
    root.querySelector(".x").addEventListener("click", hideToast);
    // Beim Lesen nicht automatisch ausblenden.
    toastHost._box.addEventListener("mouseenter", () => clearTimeout(toastTimer));
    toastHost._box.addEventListener("mouseleave", () => {
      if (toastHost?._kind && toastHost._kind !== "loading") toastTimer = setTimeout(hideToast, 4000);
    });
    (document.body || document.documentElement).appendChild(toastHost);
    return toastHost;
  }

  function hideToast() {
    clearTimeout(toastTimer);
    if (toastHost) toastHost.remove();
    toastHost = null;
  }

  function showToast({ kind, text, head, structured }) {
    const host = ensureToast();
    host._kind = kind;
    host._box.className = "t " + (kind === "error" ? "error" : kind === "info" ? "info" : "");
    const heads = {
      loading: "Claude",
      answer: "Antwort",
      error: "Fehler",
      info: "Hinweis",
    };
    host._head.textContent = head || heads[kind] || "Claude";
    const rich = kind === "answer" && structured && window.CQARender;
    host._body.classList.toggle("rich", !!rich);
    if (rich) host._body.replaceChildren(window.CQARender.render(structured, text));
    else host._body.textContent = text;
    clearTimeout(toastTimer);
    if (kind !== "loading") {
      // Längere Antworten länger stehen lassen.
      const ms = kind === "answer" ? (structured?.items?.length ? 25000 : 15000) : 5000;
      toastTimer = setTimeout(hideToast, ms);
    }
  }

  /* ---------------- Bereichsauswahl ---------------- */

  function selectRegion() {
    hideToast();
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText =
        "all:initial;position:fixed;inset:0;z-index:2147483647;cursor:crosshair;" +
        "background:rgba(0,0,0,.25);user-select:none;";
      const box = document.createElement("div");
      box.style.cssText =
        "all:initial;position:fixed;border:2px solid #d97757;background:rgba(255,255,255,.08);" +
        "box-shadow:0 0 0 99999px rgba(0,0,0,.25);display:none;pointer-events:none;";
      const hint = document.createElement("div");
      hint.textContent = "Bereich aufziehen · Esc = abbrechen · Enter = ganzer sichtbarer Bereich";
      hint.style.pointerEvents = "none";
      hint.style.cssText =
        "all:initial;position:fixed;top:12px;left:50%;transform:translateX(-50%);" +
        "font:13px system-ui,sans-serif;color:#fff;background:#1f1e1c;padding:6px 10px;border-radius:6px;";
      overlay.append(box, hint);
      document.documentElement.appendChild(overlay);

      let start = null;
      let rect = null;

      const finish = (result) => {
        overlay.remove();
        window.removeEventListener("keydown", onKey, true);
        // Zwei Frames warten, damit das Overlay garantiert nicht im Screenshot landet.
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(result)));
      };

      const onKey = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish({ cancelled: true });
        } else if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          finish({ full: true });
        }
      };
      window.addEventListener("keydown", onKey, true);

      overlay.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return finish({ cancelled: true });
        e.preventDefault();
        start = { x: e.clientX, y: e.clientY };
        hint.style.display = "none";
      });
      overlay.addEventListener("mousemove", (e) => {
        if (!start) return;
        const x = Math.min(start.x, e.clientX);
        const y = Math.min(start.y, e.clientY);
        const w = Math.abs(e.clientX - start.x);
        const h = Math.abs(e.clientY - start.y);
        rect = { x, y, width: w, height: h };
        overlay.style.background = "transparent";
        Object.assign(box.style, {
          display: "block",
          left: x + "px",
          top: y + "px",
          width: w + "px",
          height: h + "px",
        });
      });
      overlay.addEventListener("mouseup", () => {
        if (!rect || rect.width < 8 || rect.height < 8) return finish({ cancelled: true });
        finish({
          ...rect,
          dpr: window.devicePixelRatio || 1,
        });
      });
    });
  }

  /* ---------------- Nachrichten ---------------- */

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "insert") {
      // Nur der Frame mit Fokus antwortet; andere Frames bleiben stumm.
      if (!document.hasFocus()) return;
      const ok = insertText(msg.text);
      return ok ? Promise.resolve(true) : undefined;
    }
    if (!isTop) return;
    if (msg.type === "toast") {
      showToast(msg);
      return;
    }
    if (msg.type === "selectRegion") {
      return selectRegion();
    }
  });
})();
