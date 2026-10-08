// Panthr's bridge in the preview page: reports time, scenes, layers and
// size to the app (the parent window), fits the composition to the view,
// takes playback and pen commands, and describes a layer chosen on the
// timeline. Injected into every project page with the runtime and picker.
(function(){
  if (window.__studioBridge) return; window.__studioBridge = 1;
  const send = (m) => { try { parent.postMessage({ __panthr: m }, '*'); } catch (e) {} };
  const OUT = { ready:1, picked:1, layers:1, survey:1, 'script-error':1, label:1, path:1 };
  window.addEventListener('error', (e) => { if (e.message) send({ kind: 'error', message: e.message }); });
  let last = -1, lastPlaying = null, lastSent = 0, lastScan = -1e9, scenesKey = '', layersKey = '', resumed = false;
  // The timeline's layers: every element a GSAP tween moves, and every timed
  // element (data-start), each with when it moves. Like HyperFrames Studio's
  // tracks, read from the page as it runs.
  // An element's reference, written as the picker writes it: its id, else
  // a path from the nearest id (or its composition) down.
  function refOf(el) {
    if (el.id) return el.id;
    const parts = []; let e = el;
    while (e && e.parentElement && !(e.id && !e.hasAttribute('data-composition-id'))) {
      const p = e.parentElement; let n = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === e.tagName) n++;
      parts.unshift(e.tagName.toLowerCase() + ':nth-of-type(' + n + ')');
      if (p.hasAttribute('data-composition-id')) { parts.unshift("[data-composition-id='" + p.getAttribute('data-composition-id') + "']"); e = null; break; }
      e = p;
    }
    if (e && e.id) parts.unshift('#' + e.id);
    return parts.join(' > ');
  }
  // A layer chosen on the timeline, described as a click on it would be.
  function describe(ref, layer) {
    let el = document.getElementById(ref);
    if (!el) { try { el = document.querySelector(ref); } catch (e) {} }
    if (!el) return;
    const r = el.closest('[data-composition-id]') || document.querySelector('[data-composition-id]');
    const rb = r ? r.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth };
    const W = (r && +r.getAttribute('data-width')) || rb.width, k = W / (rb.width || 1), b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    let tx = false;
    for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && n.nodeValue.trim()) tx = true;
    const m = /matrix\(([^)]+)\)/.exec(cs.transform || '');
    let rot = 0;
    if (m) { const v = m[1].split(',').map(parseFloat); rot = Math.round(Math.atan2(v[1], v[0]) * 180 / Math.PI); }
    const path = []; for (let e = el.parentElement; e && e !== document.body && path.length < 12; e = e.parentElement) if (e.id) path.push(e.id);
    const src = el.closest('[data-composition-src]');
    send({ kind: 'editor', data: { type: 'picked', id: ref, hasId: !!el.id, layer: layer || null, fromLayer: true,
      file: src ? src.getAttribute('data-composition-src') : 'index.html',
      rect: { x: b.left / innerWidth, y: b.top / innerHeight, w: b.width / innerWidth, h: b.height / innerHeight },
      box: { x: Math.round((b.left - rb.left) * k), y: Math.round((b.top - rb.top) * k), w: Math.round(b.width * k), h: Math.round(b.height * k) },
      style: { font: (cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim(), size: Math.round(parseFloat(cs.fontSize) || 0), weight: cs.fontWeight, color: cs.color, opacity: parseFloat(cs.opacity), align: cs.textAlign, rotate: rot, text: tx },
      inside: [...el.querySelectorAll('[id]')].slice(0, 300).map((q) => q.id),
      tag: el.tagName.toLowerCase(), text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80), path } });
  }
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d && d.source === 'clueso-editor' && d.type === 'describe') describe(d.ref, d.layer);
  });
  function layers() {
    const rows = new Map();
    const root = document.querySelector('[data-composition-id]');
    const kindOf = (el) => {
      if (!(el instanceof Element)) return 'motion';
      const tag = el.tagName.toLowerCase();
      if (tag === 'img' || tag === 'video' || tag === 'picture') return 'media';
      if (tag === 'audio') return 'audio';
      if (tag === 'canvas' || tag === 'svg' || el.querySelector('canvas,svg')) return 'shape';
      if (el.hasAttribute('data-composition-id')) return 'scene';
      if (!el.children.length && el.textContent.trim()) return 'text';
      return el.children.length ? 'group' : 'shape';
    };
    const nameOf = (t) => {
      if (t instanceof Element) {
        const named = t.getAttribute('data-label') || t.getAttribute('data-timeline-label') || (t.dataset && t.dataset.layer);
        if (named) return named;
        const txt = !t.children.length ? t.textContent.trim().replace(/\s+/g, ' ') : '';
        return txt ? (txt.length > 40 ? txt.slice(0, 39) + '\u2026' : txt) : (t.id || t.getAttribute('data-composition-id') || t.className || t.tagName.toLowerCase());
      }
      for (const k of Object.keys(window)) { try { if (window[k] === t) return k; } catch (e) {} }
      return 'Animation';
    };
    // A script's state object (a 3D scene's) names its element: __layer.
    const own = (t) => (t && !(t instanceof Element) && t.__layer && document.getElementById(t.__layer)) || t;
    const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : null; };
    const row = (t) => {
      let r = rows.get(t);
      if (!r) {
        const el = t instanceof Element ? t : null;
        r = { id: (el && el.id) || '', sel: el ? refOf(el) : '', label: nameOf(t), kind: kindOf(t), spans: [] };
        rows.set(t, r);
      }
      return r;
    };
    const add = (t, a, b) => {
      t = own(t);
      if (!(b > a)) return;
      if (t === root) return;
      const r = row(t);
      r.spans.push([Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000]);
    };
    const walk = (tl, off, depth) => {
      if (!tl || !tl.getChildren || depth > 6) return;
      for (const c of tl.getChildren(false, true, true)) {
        const at = off + c.startTime();
        if (c.getChildren) walk(c, at, depth + 1);
        else for (const t of (c.targets ? c.targets() : [])) add(t, at, at + c.totalDuration());
      }
    };
    for (const tl of Object.values(window.__timelines || {})) walk(tl, 0, 0);
    // Timed clips. The runtime stamps the whole video's timing on plain
    // elements too; a span that is just "all of it" says nothing, so only
    // real clips (a track, or the clip class) or partial spans count.
    const total = window.__player && window.__player.getDuration ? window.__player.getDuration() : 0;
    document.querySelectorAll('[data-start]').forEach((el) => {
      if (el === root) return;
      const a = parseFloat(el.getAttribute('data-start')) || 0;
      const d = parseFloat(el.getAttribute('data-duration')) || 0;
      const clip = el.hasAttribute('data-track-index') || el.classList.contains('clip');
      const whole = a <= 0.001 && total > 0 && Math.abs(a + d - total) < 0.01;
      if (d > 0 && (clip || !whole)) add(el, a, a + d);
    });
    const out = [...rows.values()].filter((r) => r.spans.length);
    out.forEach((r) => r.spans.sort((x, y) => x[0] - y[0]));
    out.sort((x, y) => x.spans[0][0] - y.spans[0][0]);
    return out.slice(0, 40);
  }
  function tick(now) {
    const p = window.__player;
    if (p && window.__playerReady) {
      if (!resumed) {
        // After a reload, back to where it was (location hash t=..&p=1).
        resumed = true;
        const h = new URLSearchParams(location.hash.slice(1));
        const t0 = parseFloat(h.get('t') || '0');
        if (t0 > 0) p.seek(t0);
        if (h.get('p') === '1') p.play(); else p.pause();
      }
      const t = p.getTime(), playing = !!p.isPlaying();
      if ((now - lastSent > 66 && Math.abs(t - last) > 0.01) || playing !== lastPlaying) {
        last = t; lastPlaying = playing; lastSent = now;
        send({ kind: 'time', t, playing, d: p.getDuration() });
      }
      // Scenes rarely change: look once a second, not every frame.
      if (now - lastScan > 1000) {
        lastScan = now;
        const sc = [...document.querySelectorAll('[data-composition-id]')]
          .filter(el => el.parentElement && el.parentElement.closest('[data-composition-id]'))
          .map(el => ({ id: el.getAttribute('data-composition-id') || el.id || 'scene',
                        start: parseFloat(el.getAttribute('data-start') || '0') || 0,
                        duration: parseFloat(el.getAttribute('data-duration') || '0') || 0 }))
          .filter(s => s.duration > 0);
        const key = JSON.stringify(sc);
        if (key !== scenesKey) { scenesKey = key; send({ kind: 'scenes', scenes: sc }); }
        try {
          const ly = layers(), lk = JSON.stringify(ly);
          if (lk !== layersKey) { layersKey = lk; send({ kind: 'layers', layers: ly }); }
        } catch (e) {}
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  // Fit the composition into the view, letterboxed, whatever its size.
  function fit() {
    const r = document.querySelector('[data-composition-id]');
    if (!r || !document.body) return;
    const W = +r.getAttribute('data-width') || 1920, H = +r.getAttribute('data-height') || 1080;
    if (fit.sent !== W + 'x' + H) { fit.sent = W + 'x' + H; send({ kind: 'size', w: W, h: H }); }
    const s = Math.min(innerWidth / W, innerHeight / H);
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.style.background = '#000';
    const b = document.body.style;
    b.margin = '0'; b.width = W + 'px'; b.height = H + 'px'; b.overflow = 'hidden';
    b.transformOrigin = '0 0';
    b.transform = `translate(${(innerWidth - W * s) / 2}px, ${(innerHeight - H * s) / 2}px) scale(${s})`;
  }
  addEventListener('resize', fit);
  document.addEventListener('DOMContentLoaded', fit);
  addEventListener('load', fit);
})();
(function(){
  const PEN_ON = function(){ (function(){
  if (window.__pen) return;
  const r = document.querySelector('[data-composition-id]');
  if (!r) return;
  const W = +r.getAttribute('data-width') || 1920, H = +r.getAttribute('data-height') || 1080;
  const c = document.createElement('canvas');
  c.id = '__studio_pen';
  Object.assign(c.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', zIndex: 2147483647, cursor: 'crosshair', touchAction: 'none' });
  document.documentElement.appendChild(c);
  const ctx = c.getContext('2d');
  const strokes = []; let cur = null;
  const size = () => { c.width = innerWidth * devicePixelRatio; c.height = innerHeight * devicePixelRatio; draw(); };
  const toComp = (e) => { const b = r.getBoundingClientRect(); return [ (e.clientX - b.left) / b.width * W, (e.clientY - b.top) / b.height * H ]; };
  const toView = (p) => { const b = r.getBoundingClientRect(); return [ (b.left + p[0] / W * b.width) * devicePixelRatio, (b.top + p[1] / H * b.height) * devicePixelRatio ]; };
  function draw() {
    ctx.clearRect(0, 0, c.width, c.height);
    const b = r.getBoundingClientRect();
    ctx.lineWidth = Math.max(3, 8 * b.width / W) * devicePixelRatio; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = '#ff4f9a'; ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 6 * devicePixelRatio;
    for (const s of strokes.concat(cur ? [cur] : [])) {
      ctx.beginPath(); s.forEach((p, i) => { const v = toView(p); i ? ctx.lineTo(v[0], v[1]) : ctx.moveTo(v[0], v[1]); }); ctx.stroke();
    }
  }
  const send = () => { try { parent.postMessage({ __panthr: { kind: 'pen', strokes } }, '*'); } catch (e) {} };
  c.addEventListener('pointerdown', (e) => { c.setPointerCapture(e.pointerId); cur = [toComp(e)]; draw(); });
  c.addEventListener('pointermove', (e) => { if (cur) { cur.push(toComp(e)); draw(); } });
  c.addEventListener('pointerup', () => { if (cur && cur.length > 1) strokes.push(cur); cur = null; draw(); send(); });
  addEventListener('resize', size);
  window.__pen = { clear() { strokes.length = 0; draw(); send(); }, undo() { strokes.pop(); draw(); send(); } };
  size();
})(); };
  const PEN_OFF = function(){ (function(){ const c = document.getElementById('__studio_pen'); if (c) c.remove(); window.__pen = null; })(); };
  // Commands from the app.
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.source !== 'panthr') return;
    const p = window.__player;
    switch (d.op) {
      case 'play': if (p) p.play(); break;
      case 'pause': if (p) p.pause(); break;
      case 'seek': if (p) p.seek(+d.t || 0); break;
      case 'pen': if (d.on) PEN_ON(); else PEN_OFF(); break;
      case 'pen-clear': if (window.__pen) window.__pen.clear(); break;
      case 'pen-undo': if (window.__pen) window.__pen.undo(); break;
    }
  });
})();
