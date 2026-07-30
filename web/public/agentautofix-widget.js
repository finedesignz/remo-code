/* AgentAutofix click-to-comment widget.
   Contract: agentautofix/docs/widget-contract.md. Ctrl/Cmd+click an element to file a comment.
   Config comes from `window.__AGENTAUTOFIX_CONFIG__` (set by the React app right before this
   script loads) instead of being hardcoded — remo-code provisions AgentAutofix per environment,
   not per build. */
(function () {
  var cfg = window.__AGENTAUTOFIX_CONFIG__;
  if (!cfg || !cfg.host || !cfg.publicKey) return;

  var HOST = cfg.host;
  var SITE_KEY = cfg.publicKey;
  var TOKEN_URL = cfg.tokenUrl || '/api/agentautofix/token';
  var NS = 'agentautofix';

  var caps = null;
  var booting = null;

  /* ---- structural secret-exclusion (learned from the mcp-factory pilot QC:
     `value=`, `data-*`, `title`, `aria-label`, and inline `on*` handlers are
     where live tokens/passwords land as ordinary DOM). Any element (or an
     ancestor OR descendant) opting out via [data-autofix-exclude] is never
     reported, and password inputs are never reported regardless. */
  function isExcluded(el) {
    if (!el || typeof el.closest !== 'function') return false;
    if (el.closest('[data-autofix-exclude]')) return true;
    if (el.matches && el.matches('input[type="password"]')) return true;
    if (el.querySelector && el.querySelector('input[type="password"], [data-autofix-exclude]')) return true;
    return false;
  }

  /* ---- boot: fetch the caps the server actually enforces ---------------- */
  function boot() {
    if (caps) return Promise.resolve(caps);
    if (booting) return booting;
    booting = fetch(HOST + '/api/plugin/v1/config', {
      headers: { 'x-agentautofix-key': SITE_KEY },
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (c) { caps = c; return c; })
      .catch(function () { return null; });
    return booting;
  }

  function identity() {
    return fetch(TOKEN_URL, { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { return d ? d.token : null; })
      .catch(function () { return null; });
  }

  /* ---- a stable-ish selector for the clicked element -------------------- */
  function selectorFor(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      var part = node.tagName.toLowerCase();
      if (node.classList.length) {
        part += '.' + [].slice.call(node.classList, 0, 3).map(function (c) { return CSS.escape(c); }).join('.');
      }
      var parent = node.parentElement;
      if (parent) {
        var sibs = [].slice.call(parent.children).filter(function (c) { return c.tagName === node.tagName; });
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      if (node.id) break;
      node = parent;
    }
    return parts.join(' > ').slice(0, 1000);
  }

  /* NEVER ships `value`, `data-*`, `title`, `aria-*`, or `on*` attributes —
     those are exactly where secrets, tokens, and PII render as ordinary DOM
     in this app's own Settings/Connect modals (API keys, webhook URLs).
     Structural allowlist, not a denylist: only a small set of layout/
     identification attributes ever leaves the browser. */
  var ATTR_ALLOWLIST = ['id', 'class', 'type', 'name', 'role', 'href', 'disabled', 'required', 'placeholder'];

  function metaFor(el) {
    var attrs = {};
    for (var i = 0; i < el.attributes.length && i < 20; i++) {
      var a = el.attributes[i];
      if (ATTR_ALLOWLIST.indexOf(a.name) === -1) continue;
      attrs[a.name] = String(a.value).slice(0, 200);
    }
    var rect = el.getBoundingClientRect();
    return {
      kind: 'element_comment',
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || '').trim().slice(0, 500),
      attrs: attrs,
      rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      user_agent: navigator.userAgent,
    };
  }

  /* ---- CONTRACT: x and y are PERCENTAGES, never pixels ------------------ */
  function coords(e) {
    return {
      x: Math.min(100, Math.max(0, (e.clientX / innerWidth) * 100)),
      y: Math.max(0, (e.pageY / innerHeight) * 100),
    };
  }

  function submit(el, e, text) {
    return boot().then(function (cfgResp) {
      var limit = (cfgResp && cfgResp.caps && cfgResp.caps.comment_chars) || 4000;
      if (!text || text.length > limit) return { ok: false, error: 'comment too long or empty' };

      return identity().then(function (token) {
        if (!token && cfgResp && cfgResp.require_identity) {
          return { ok: false, error: 'not signed in' };
        }

        var c = coords(e);
        return fetch(HOST + '/api/plugin/v1/comments', {
          method: 'POST',
          headers: Object.assign(
            { 'content-type': 'application/json', 'x-agentautofix-key': SITE_KEY },
            token ? { authorization: 'Bearer ' + token } : {},
          ),
          body: JSON.stringify({
            comment: text,
            x: c.x,
            y: c.y,
            page_url: location.href.slice(0, (cfgResp && cfgResp.caps && cfgResp.caps.page_url_chars) || 2000),
            element_selector: selectorFor(el),
            element_meta: metaFor(el),
          }),
        }).then(function (res) {
          if (res.ok) return res.json().then(function (body) { return Object.assign({ ok: true }, body); });
          return res.json().catch(function () { return {}; }).then(function (body) {
            if (res.status === 429) {
              return { ok: false, error: 'rate limited, retry in ' + (res.headers.get('retry-after') || 60) + 's' };
            }
            return { ok: false, error: body.error || ('http_' + res.status), field: body.field };
          });
        });
      });
    });
  }

  /* ---- composer UI ------------------------------------------------------ */
  function openComposer(el, e) {
    var existing = document.getElementById(NS + '-composer');
    if (existing) existing.remove();
    var box = document.createElement('div');
    box.id = NS + '-composer';
    box.style.cssText = 'position:fixed;z-index:2147483647;left:' + Math.min(e.clientX, innerWidth - 340) +
      'px;top:' + Math.min(e.clientY, innerHeight - 200) +
      'px;width:320px;padding:12px;border-radius:10px;background:#111;color:#eee;' +
      'font:13px/1.45 system-ui,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.45)';
    box.innerHTML =
      '<div style="font-weight:600;margin-bottom:8px">AgentAutofix</div>' +
      '<textarea id="' + NS + '-text" rows="4" placeholder="What is wrong with this element?" ' +
      'style="width:100%;box-sizing:border-box;background:#1c1c1c;color:#eee;border:1px solid #333;' +
      'border-radius:6px;padding:8px;font:inherit;resize:vertical"></textarea>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">' +
      '<button id="' + NS + '-cancel" style="background:none;border:0;color:#999;cursor:pointer">Cancel</button>' +
      '<button id="' + NS + '-send" style="background:#4f7cff;border:0;color:#fff;border-radius:6px;' +
      'padding:6px 12px;cursor:pointer">Send</button></div>' +
      '<div id="' + NS + '-status" style="margin-top:6px;color:#999;min-height:16px"></div>';
    document.body.appendChild(box);
    var text = box.querySelector('#' + NS + '-text');
    var status = box.querySelector('#' + NS + '-status');
    text.focus();

    box.querySelector('#' + NS + '-cancel').onclick = function () { box.remove(); };
    box.querySelector('#' + NS + '-send').onclick = function () {
      status.textContent = 'Sending...';
      submit(el, e, text.value.trim()).then(function (r) {
        if (r.ok) {
          status.textContent = 'Queued. A pull request is on its way.';
          setTimeout(function () { box.remove(); }, 1800);
        } else {
          status.textContent = r.error + (r.field ? ' (' + r.field + ')' : '');
        }
      });
    };
  }

  addEventListener(
    'click',
    function (e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      var composer = document.getElementById(NS + '-composer');
      if (composer && composer.contains(e.target)) return;
      var targetEl = e.target;
      if (isExcluded(targetEl)) return;
      e.preventDefault();
      e.stopPropagation();
      openComposer(targetEl, e);
    },
    true,
  );

  boot();
})();
