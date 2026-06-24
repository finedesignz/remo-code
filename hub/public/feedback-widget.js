/*
 * Remo Code — embeddable end-user feedback widget (Option A).
 *
 * Framework-agnostic, dependency-light vanilla JS. Drop one <script> tag into
 * any app; it renders a floating "Report a problem" button that opens a small
 * form (description + optional screenshot) and POSTs to the app's feedback
 * endpoint. Auto-captures recent window.onerror / console.error output.
 *
 * Fail-open: every failure is swallowed — the widget NEVER throws into or
 * breaks the host app.
 *
 * Embed:
 *   <script
 *     src="https://app.remo-code.com/feedback-widget.js"
 *     data-feedback-token="fb_XXXXXXXX"
 *     data-endpoint="https://app.remo-code.com"   <!-- optional; defaults to script origin -->
 *   ></script>
 *
 * Screenshots: if html2canvas is already present on the page (window.html2canvas)
 * the widget offers a one-click "Capture screenshot" button; otherwise it falls
 * back to a file picker so the user can attach an image manually.
 */
(function () {
  'use strict';
  try {
    var script = document.currentScript;
    if (!script) return;
    var TOKEN = script.getAttribute('data-feedback-token');
    if (!TOKEN) { console.warn('[feedback-widget] missing data-feedback-token'); return; }
    var ORIGIN = script.getAttribute('data-endpoint') ||
      (function () { try { return new URL(script.src).origin; } catch (e) { return ''; } })();
    var URL_ = ORIGIN.replace(/\/$/, '') + '/api/feedback/' + encodeURIComponent(TOKEN);
    var MAX_IMG_BYTES = 10 * 1024 * 1024;

    // ── Capture recent errors (bounded ring buffer) ──────────────────────────
    var errLog = [];
    function pushErr(s) { try { errLog.push(s); if (errLog.length > 50) errLog.shift(); } catch (e) {} }
    window.addEventListener('error', function (e) {
      pushErr('[onerror] ' + (e && e.message ? e.message : String(e)) +
        (e && e.filename ? ' @ ' + e.filename + ':' + (e.lineno || '') : ''));
    });
    window.addEventListener('unhandledrejection', function (e) {
      pushErr('[unhandledrejection] ' + (e && e.reason ? (e.reason.message || String(e.reason)) : 'unknown'));
    });
    try {
      var origErr = console.error;
      console.error = function () {
        try { pushErr('[console.error] ' + Array.prototype.map.call(arguments, String).join(' ')); } catch (e) {}
        return origErr.apply(console, arguments);
      };
    } catch (e) {}

    // ── Minimal styles (scoped via unique ids/classes) ───────────────────────
    var css =
      '#rmf-btn{position:fixed;bottom:20px;right:20px;z-index:2147483000;background:#2563eb;color:#fff;' +
      'border:none;border-radius:9999px;padding:10px 16px;font:600 14px system-ui,sans-serif;cursor:pointer;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.25)}' +
      '#rmf-modal{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.45);display:none;' +
      'align-items:center;justify-content:center}' +
      '#rmf-card{background:#fff;color:#111;width:min(420px,92vw);border-radius:12px;padding:18px;' +
      'font:14px system-ui,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.35)}' +
      '#rmf-card h3{margin:0 0 10px;font-size:16px}' +
      '#rmf-card textarea{width:100%;min-height:90px;box-sizing:border-box;border:1px solid #ccc;border-radius:8px;' +
      'padding:8px;font:inherit;resize:vertical}' +
      '#rmf-row{display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap}' +
      '.rmf-sec{background:#f3f4f6;border:none;border-radius:8px;padding:8px 12px;cursor:pointer;font:inherit}' +
      '#rmf-send{background:#2563eb;color:#fff;border:none;border-radius:8px;padding:9px 16px;cursor:pointer;font:600 14px system-ui}' +
      '#rmf-send:disabled{opacity:.5;cursor:default}' +
      '#rmf-thumb{max-width:100%;max-height:120px;border-radius:8px;margin-top:8px;display:none}' +
      '#rmf-status{margin-top:8px;font-size:13px;color:#555}';
    var style = document.createElement('style'); style.textContent = css;

    var shot = null; // { media_type, dataUri }

    function el(tag, attrs, txt) {
      var n = document.createElement(tag);
      if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
      if (txt != null) n.textContent = txt;
      return n;
    }

    function build() {
      var btn = el('button', { id: 'rmf-btn' }, 'Report a problem');
      var modal = el('div', { id: 'rmf-modal' });
      var card = el('div', { id: 'rmf-card' });
      card.appendChild(el('h3', null, 'Report a problem'));
      var ta = el('textarea', { id: 'rmf-desc', placeholder: 'Describe what went wrong…' });
      card.appendChild(ta);
      var thumb = el('img', { id: 'rmf-thumb', alt: 'screenshot' });
      card.appendChild(thumb);
      var row = el('div', { id: 'rmf-row' });
      var fileInput = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
      var capBtn = el('button', { class: 'rmf-sec', type: 'button' },
        window.html2canvas ? 'Capture screenshot' : 'Attach screenshot');
      var cancelBtn = el('button', { class: 'rmf-sec', type: 'button' }, 'Cancel');
      var sendBtn = el('button', { id: 'rmf-send', type: 'button' }, 'Send');
      row.appendChild(capBtn); row.appendChild(cancelBtn); row.appendChild(sendBtn);
      card.appendChild(row);
      var status = el('div', { id: 'rmf-status' });
      card.appendChild(status); card.appendChild(fileInput);
      modal.appendChild(card);

      function setShot(dataUri) {
        if (!dataUri) { shot = null; thumb.style.display = 'none'; return; }
        if (dataUri.length > Math.ceil(MAX_IMG_BYTES * 4 / 3) + 64) {
          status.textContent = 'Screenshot too large (max 10MB).'; return;
        }
        var m = /^data:([^;]+);base64,/.exec(dataUri);
        shot = { media_type: m ? m[1] : 'image/png', dataUri: dataUri };
        thumb.src = dataUri; thumb.style.display = 'block';
      }

      capBtn.addEventListener('click', function () {
        if (window.html2canvas) {
          status.textContent = 'Capturing…';
          window.html2canvas(document.body).then(function (canvas) {
            try { setShot(canvas.toDataURL('image/png')); status.textContent = ''; }
            catch (e) { status.textContent = 'Capture failed; attach manually.'; fileInput.click(); }
          }).catch(function () { status.textContent = ''; fileInput.click(); });
        } else { fileInput.click(); }
      });
      fileInput.addEventListener('change', function () {
        var f = fileInput.files && fileInput.files[0]; if (!f) return;
        if (f.size > MAX_IMG_BYTES) { status.textContent = 'Image too large (max 10MB).'; return; }
        var r = new FileReader();
        r.onload = function () { setShot(String(r.result)); };
        r.readAsDataURL(f);
      });

      function close() { modal.style.display = 'none'; }
      function open() { ta.value = ''; setShot(null); status.textContent = ''; modal.style.display = 'flex'; }
      btn.addEventListener('click', open);
      cancelBtn.addEventListener('click', close);
      modal.addEventListener('click', function (e) { if (e.target === modal) close(); });

      sendBtn.addEventListener('click', function () {
        var comment = (ta.value || '').trim();
        if (!comment) { status.textContent = 'Please add a description.'; return; }
        sendBtn.disabled = true; status.textContent = 'Sending…';
        var payload = {
          comment: comment.slice(0, 5000),
          page_url: location.href,
          console_errors: errLog.slice(-50).join('\n').slice(0, 20000) || undefined,
        };
        if (shot && shot.dataUri) payload.screenshot = shot.dataUri;
        fetch(URL_, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(function (res) {
          if (res.status === 202) { status.textContent = 'Thanks — your report was sent.'; setTimeout(close, 1200); }
          else if (res.status === 429) { status.textContent = 'Too many reports — please try again later.'; }
          else { status.textContent = 'Could not send (error ' + res.status + ').'; }
        }).catch(function () {
          status.textContent = 'Could not send — check your connection.';
        }).then(function () { sendBtn.disabled = false; });
      });

      document.body.appendChild(style);
      document.body.appendChild(btn);
      document.body.appendChild(modal);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { try { build(); } catch (e) {} });
    } else { build(); }
  } catch (e) { /* fail-open: never break the host app */ }
})();
