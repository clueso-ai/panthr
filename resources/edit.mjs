// The Studio editor's hands on a project (studio/editor.py installs and runs
// this on the project's machine, where the files are).
//
//   node edit.mjs <request.json>   ->   one JSON object on stdout
//
// A composition file is an HTML page with one GSAP timeline script. Its
// LAYERS are the root composition's direct children that have an id: the
// things that sit on top of each other and that the timeline can move.
//
//   inspect   every composition file's layers: timing window, the tweens
//             that animate each (from the HyperFrames GSAP parser), stacking,
//             and the texts and media inside it that have ids
//   move      shift a layer in time (every tween on it or inside it)
//   resize    stretch a layer's window (tweens scale with it)
//   tween     change one tween: start, duration, ease, end values
//   zorder    restack a file's layers (z-index, front to back)
//   text      replace the text of a leaf element with an id
//   src       point an image or video with an id at another file
//   restore   put a file back as it was (undo), unless it changed since
//   controls  the current value of each control the agent made
//             (studio/controls.py): does its target exist, what it holds now
//   set       write one control's value into its target
//
// Timing, two ways. A composition whose root says data-editable-timing places
// each layer's tweens relative to that layer's data-start (the Studio prompt
// asks for this), so moving a layer is changing data-start and stretching it
// is changing data-duration: an attribute splice, whatever the code looks
// like. Otherwise a layer moves by rewriting its tweens with the HyperFrames
// GSAP writer, which needs literal tweens (ones built in helper functions or
// loops, or with computed selectors, are read-only). Layering,
// text and media are spliced into the element's own tag, so nothing else in
// the file is re-serialized: the agent's code stays byte for byte as written.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseHTML } from "linkedom";
import { parseGsapScriptAcorn } from "@hyperframes/parsers/gsap-parser-acorn";
import {
  scalePositionsInScript,
  shiftPositionsInScript,
  updateAnimationInScript,
} from "@hyperframes/parsers/gsap-writer-acorn";

const PROJECT = path.resolve(process.env.CLUESO_PROJECT || "/home/user/project");
const NOT_LAYERS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "LINK", "META", "NOSCRIPT", "AUDIO"]);
const DEFAULT_TWEEN_S = 0.5;

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
const r3 = (x) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);

function abs(file) {
  const p = path.resolve(PROJECT, file);
  if (p !== PROJECT && !p.startsWith(PROJECT + path.sep)) throw new Error(`${file} is outside the project`);
  return p;
}
const read = (file) => fs.readFileSync(abs(file), "utf8");
function write(file, text) {
  const p = abs(file);
  const tmp = `${p}.edit-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
}

// ── The file's GSAP script ────────────────────────────────────────────

const SCRIPT_RE = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;

function scriptRanges(html) {
  const out = [];
  for (const m of html.matchAll(SCRIPT_RE)) {
    const start = m.index + m[0].indexOf(">") + 1;
    out.push({ start, end: start + m[1].length, text: m[1] });
  }
  return out;
}

/** The inline script that drives the timeline, as [start, end) in the file. */
function gsapScript(html) {
  return scriptRanges(html).find((s) => /gsap\.timeline\s*\(|\.(to|from|fromTo|set)\s*\(/.test(s.text)) || null;
}

function parse(html) {
  const sc = gsapScript(html);
  if (!sc) return { sc: null, anims: [], timelines: 0, error: null };
  const timelines = (sc.text.match(/gsap\.timeline\s*\(/g) || []).length;
  try {
    return { sc, anims: parseGsapScriptAcorn(sc.text).animations || [], timelines, error: null };
  } catch (e) {
    return { sc, anims: [], timelines, error: String(e?.message || e) };
  }
}

// ── Tags, spliced in place ────────────────────────────────────────────

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const escText = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The opening tag of the element with this id: outside scripts, and only one. */
function openTag(html, id) {
  const scripts = scriptRanges(html);
  const re = new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*?\\sid\\s*=\\s*(["'])${escRe(id)}\\2[^>]*>`, "g");
  const hits = [...html.matchAll(re)].filter((m) => !scripts.some((s) => m.index >= s.start && m.index < s.end));
  if (!hits.length) throw new Error(`#${id} is not in the file`);
  if (hits.length > 1) throw new Error(`#${id} appears more than once`);
  const m = hits[0];
  return { start: m.index, end: m.index + m[0].length, tag: m[1].toLowerCase(), text: m[0] };
}

function setAttr(tag, name, value) {
  const re = new RegExp(`(\\s${escRe(name)}\\s*=\\s*)("[^"]*"|'[^']*')`, "i");
  const q = `"${escAttr(value)}"`;
  if (re.test(tag)) return tag.replace(re, `$1${q}`);
  return tag.replace(/\s*(\/?)>$/, ` ${name}=${q}$1>`);
}

function getAttr(tag, name) {
  const m = tag.match(new RegExp(`\\s${escRe(name)}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return m ? (m[2] ?? m[3]) : null;
}

function setStyleProp(tag, prop, value) {
  let style = getAttr(tag, "style") || "";
  const re = new RegExp(`(^|;)\\s*${escRe(prop)}\\s*:[^;]*`, "i");
  if (re.test(style)) style = style.replace(re, `$1${prop}: ${value}`);
  else style = `${style.trim().replace(/;?\s*$/, style.trim() ? "; " : "")}${prop}: ${value}`;
  return setAttr(tag, "style", style);
}

function splice(html, at, text) {
  return html.slice(0, at.start) + text + html.slice(at.end);
}

// ── Inspect ───────────────────────────────────────────────────────────

function compositionFiles() {
  const idx = read("index.html");
  const subs = [...idx.matchAll(/data-composition-src\s*=\s*["']([^"']+)["']/g)]
    .map((m) => m[1])
    .filter((s) => !/^(https?:)?\/\//.test(s));
  return ["index.html", ...new Set(subs)].filter((f) => fs.existsSync(abs(f)));
}

function rootOf(document) {
  const roots = [...document.querySelectorAll("[data-composition-id]")];
  return roots.find((r) => !r.parentElement?.closest("[data-composition-id]")) || roots[0] || null;
}

function matches(document, selector) {
  if (!selector || selector.startsWith("__")) return null;
  try {
    return [...document.querySelectorAll(selector)];
  } catch {
    return null;
  }
}

function tweenInfo(a) {
  const start = typeof a.resolvedStart === "number" ? a.resolvedStart : typeof a.position === "number" ? a.position : null;
  const duration = a.method === "set" ? 0 : typeof a.duration === "number" ? a.duration : a.durationUnresolved ? null : DEFAULT_TWEEN_S;
  let why = null;
  if (a.provenance) why = "built in a loop or helper";
  else if (a.hasUnresolvedSelector) why = "its target is computed";
  else if (a.durationUnresolved) why = "its duration is computed";
  else if (start == null) why = "its start is computed";
  else if (a.hasUnresolvedKeyframes) why = "its keyframes are computed";
  return {
    id: a.id,
    selector: a.targetSelector,
    method: a.method,
    start: r3(start),
    duration: r3(duration),
    ease: a.ease || null,
    to: a.properties || {},
    from: a.fromProperties || null,
    group: a.propertyGroup || null,
    keyframes: a.keyframes ? true : false,
    editable: !why,
    why,
  };
}

/** The file as a DOM to inspect. A sub-composition keeps its markup in a
 * <template>, whose content querySelectorAll does not reach, so the template
 * tags are dropped from this read-only copy (edits splice the file itself). */
function domOf(html) {
  return parseHTML(html.replace(/<\/?template\b[^>]*>/gi, "")).document;
}

function inspectFile(file) {
  const html = read(file);
  const document = domOf(html);
  const root = rootOf(document);
  const { anims, timelines, error } = parse(html);
  const rootDuration = root ? Number(root.getAttribute("data-duration")) || null : null;
  const attrTiming = !!root && root.hasAttribute("data-editable-timing");
  const out = { file, sha: sha(html), duration: rootDuration, timelines, parse_error: error, attribute_timing: attrTiming, layers: [] };
  if (!root) return out;

  // Which elements each tween's selector reaches (null: can't tell).
  const reach = anims.map((a) => ({ a, els: matches(document, a.targetSelector) }));
  const kids = [...root.children].filter((el) => el.id && !NOT_LAYERS.has(el.tagName));

  kids.forEach((el, domIndex) => {
    const mine = reach.filter((r) => r.els && r.els.some((n) => n === el || el.contains(n)));
    const tweens = mine.map((r) => tweenInfo(r.a));
    // A selector that also reaches elements outside this layer moves them too.
    const shared = mine.filter((r) => r.els.some((n) => n !== el && !el.contains(n))).map((r) => r.a.targetSelector);

    let start = null;
    let end = null;
    const ds = el.getAttribute("data-start");
    if (ds != null && ds !== "") {
      start = Number(ds);
      const dd = Number(el.getAttribute("data-duration"));
      end = Number.isFinite(dd) ? start + dd : rootDuration;
    } else if (tweens.length) {
      for (const t of tweens) {
        if (t.start == null) continue;
        start = start == null ? t.start : Math.min(start, t.start);
        const e = t.start + (t.duration || 0);
        end = end == null ? e : Math.max(end, e);
      }
    }

    let movable = true;
    let why = null;
    let timing = "tweens";
    if (attrTiming && ds != null && ds !== "") timing = "attributes";
    else if (error) [movable, why] = [false, "the timeline script could not be read"];
    else if (timelines > 1) [movable, why] = [false, "the file has more than one timeline"];
    else if (tweens.some((t) => !t.editable)) [movable, why] = [false, `a tween on it is ${tweens.find((t) => !t.editable).why}`];
    else if (shared.length) [movable, why] = [false, `${shared[0]} also animates elements outside it`];
    else if (!tweens.length && ds == null) [movable, why] = [false, "nothing animates it"];

    const style = el.getAttribute("style") || "";
    const z = style.match(/z-index\s*:\s*(-?\d+)/i);

    // Texts and media inside the layer that can be addressed (they have ids).
    const texts = [];
    const media = [];
    for (const n of [el, ...el.querySelectorAll("[id]")]) {
      if (!n.id) continue;
      const tag = n.tagName;
      if (tag === "IMG" || tag === "VIDEO") media.push({ id: n.id, kind: tag.toLowerCase(), src: n.getAttribute("src") });
      else if (!n.children.length && n.textContent.trim() && n.textContent.length <= 400 && !NOT_LAYERS.has(tag))
        texts.push({ id: n.id, tag: tag.toLowerCase(), text: n.textContent.trim() });
      if (texts.length >= 80 && media.length >= 40) break;
    }

    out.layers.push({
      id: el.id,
      tag: el.tagName.toLowerCase(),
      label: el.getAttribute("data-label") || el.getAttribute("data-timeline-label") || el.id,
      dom_index: domIndex,
      z_index: z ? Number(z[1]) : null,
      start: r3(start),
      end: r3(end),
      movable,
      why,
      timing: movable ? timing : null,
      composition_src: el.getAttribute("data-composition-src"),
      tweens,
      texts: texts.slice(0, 80),
      media: media.slice(0, 40),
    });
  });
  // Front to back: explicit z-index first, then later in the document.
  out.layers.sort((a, b) => (b.z_index ?? 0) - (a.z_index ?? 0) || b.dom_index - a.dom_index);
  return out;
}

function inspect() {
  return { files: compositionFiles().map(inspectFile) };
}

// ── Edits ─────────────────────────────────────────────────────────────

function layerOf(file, id) {
  const info = inspectFile(file);
  const layer = info.layers.find((l) => l.id === id);
  if (!layer) throw new Error(`#${id} is not a layer of ${file}`);
  return { info, layer };
}

/** Every selector that animates the layer (all must stay inside it). */
function selectorsOf(layer) {
  return [...new Set(layer.tweens.map((t) => t.selector))];
}

function rewriteScript(html, fn) {
  const sc = gsapScript(html);
  if (!sc) throw new Error("the file has no timeline script");
  const next = fn(sc.text);
  if (next === sc.text) return html;
  parseGsapScriptAcorn(next); // must still read back
  return html.slice(0, sc.start) + next + html.slice(sc.end);
}

/** Grow the root composition's data-duration to fit, never shrink it. */
function fitRoot(html, file) {
  const info = (() => {
    const document = domOf(html);
    const root = rootOf(document);
    return root ? { id: root.id, duration: Number(root.getAttribute("data-duration")) || 0 } : null;
  })();
  if (!info || !info.id) return html;
  const { anims } = parse(html);
  let end = 0;
  for (const a of anims) {
    const t = tweenInfo(a);
    if (t.editable && t.start != null) end = Math.max(end, t.start + (t.duration || 0));
  }
  for (const m of html.matchAll(/\sdata-start\s*=\s*["']([\d.]+)["'][^>]*?\sdata-duration\s*=\s*["']([\d.]+)["']/g))
    end = Math.max(end, Number(m[1]) + Number(m[2]));
  if (end <= info.duration + 1e-6) return html;
  const tag = openTag(html, info.id);
  return splice(html, tag, setAttr(tag.text, "data-duration", String(r3(end))));
}

function setLayerTiming(html, layer, start, end) {
  if (layer.start == null) return html;
  const tag = openTag(html, layer.id);
  if (getAttr(tag.text, "data-start") == null) return html;
  let t = setAttr(tag.text, "data-start", String(r3(start)));
  if (getAttr(tag.text, "data-duration") != null) t = setAttr(t, "data-duration", String(r3(end - start)));
  return splice(html, tag, t);
}

const ops = {
  inspect: () => inspect(),

  move({ file, layer: id, delta }) {
    const { layer } = layerOf(file, id);
    if (!layer.movable) throw new Error(`#${id} can't be moved: ${layer.why}`);
    const d = Number(delta);
    if (!Number.isFinite(d) || d === 0) throw new Error("delta must be a non-zero number");
    if (layer.start != null && layer.start + d < 0) throw new Error("that would move it before the start");
    let html = read(file);
    const before = html;
    if (layer.timing === "tweens")
      html = rewriteScript(html, (s) => selectorsOf(layer).reduce((acc, sel) => shiftPositionsInScript(acc, sel, d), s));
    html = setLayerTiming(html, layer, layer.start + d, layer.end + d);
    html = fitRoot(html, file);
    return commit(file, before, html);
  },

  resize({ file, layer: id, start, end }) {
    const { layer } = layerOf(file, id);
    if (!layer.movable) throw new Error(`#${id} can't be stretched: ${layer.why}`);
    const ns = Number(start);
    const ne = Number(end);
    if (!(ns >= 0 && ne > ns + 0.05)) throw new Error("the new window must start at 0 or later and last over 0.05 s");
    const os = layer.start;
    const od = layer.end - layer.start;
    let html = read(file);
    const before = html;
    // Attribute timing: the layer holds for longer or shorter; its own
    // animation keeps its pace. Tween timing: its tweens stretch with it.
    if (layer.timing === "tweens")
      html = rewriteScript(html, (s) => selectorsOf(layer).reduce((acc, sel) => scalePositionsInScript(acc, sel, os, od, ns, ne - ns), s));
    html = setLayerTiming(html, layer, ns, ne);
    html = fitRoot(html, file);
    return commit(file, before, html);
  },

  tween({ file, animation, updates }) {
    const html0 = read(file);
    const { anims } = parse(html0);
    const a = anims.find((x) => x.id === animation);
    if (!a) throw new Error("that tween is no longer in the file");
    const info = tweenInfo(a);
    if (!info.editable) throw new Error(`that tween can't be edited: ${info.why}`);
    const u = {};
    if (updates.position != null) u.position = r3(Math.max(0, Number(updates.position)));
    if (updates.duration != null) u.duration = r3(Math.max(0, Number(updates.duration)));
    if (updates.ease != null) u.ease = String(updates.ease);
    if (updates.properties) u.properties = { ...a.properties, ...updates.properties };
    for (const [k, v] of Object.entries(u)) if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`${k} must be a number`);
    let html = rewriteScript(html0, (s) => updateAnimationInScript(s, animation, u));
    html = fitRoot(html, file);
    return commit(file, html0, html);
  },

  zorder({ file, order }) {
    const info = inspectFile(file);
    const ids = info.layers.map((l) => l.id);
    if (!Array.isArray(order) || order.length !== ids.length || !order.every((id) => ids.includes(id)))
      throw new Error("order must list every layer of the file, front to back");
    let html = read(file);
    const before = html;
    order.forEach((id, i) => {
      const tag = openTag(html, id);
      html = splice(html, tag, setStyleProp(tag.text, "z-index", String(order.length - i)));
    });
    return commit(file, before, html);
  },

  text({ file, id, text }) {
    let html = read(file);
    const before = html;
    const tag = openTag(html, id);
    const close = html.indexOf(`</${tag.tag}`, tag.end);
    if (close < 0) throw new Error(`#${id} has no closing tag`);
    if (/<[a-zA-Z]/.test(html.slice(tag.end, close))) throw new Error(`#${id} holds other elements, not just text`);
    html = html.slice(0, tag.end) + escText(text) + html.slice(close);
    return commit(file, before, html);
  },

  src({ file, id, src }) {
    let html = read(file);
    const before = html;
    const tag = openTag(html, id);
    if (!["img", "video", "source"].includes(tag.tag)) throw new Error(`#${id} is not an image or video`);
    const clean = String(src);
    if (/^\s*javascript:/i.test(clean)) throw new Error("not a file");
    html = splice(html, tag, setAttr(tag.text, "src", clean));
    return commit(file, before, html);
  },

  controls({ file, controls }) {
    const html = read(file);
    return {
      ok: true,
      file,
      sha: sha(html),
      values: (controls || []).map((c) => {
        try {
          return { value: readTarget(html, c.target, c.write) };
        } catch (e) {
          return { error: String(e?.message || e) };
        }
      }),
    };
  },

  // One value into one element or several (a control for a whole set, such
  // as every row of a table), in one write.
  set({ file, target, targets, write: how, value }) {
    const html = read(file);
    const ids = Array.isArray(targets) && targets.length ? targets : [target];
    return commit(file, html, ids.reduce((acc, id) => writeTarget(acc, id, how, value), html));
  },

  restore({ file, content, expect }) {
    const now = read(file);
    if (expect && sha(now) !== expect) throw new Error("the file changed since that edit; not undone");
    write(file, content);
    return { ok: true, file, sha: sha(content), inspect: inspectFile(file) };
  },
};

// ── Controls ──────────────────────────────────────────────────────────
//
// A control writes one thing on one element with an id:
//   style:<property>   an inline style property, or a CSS variable (--x)
//   attr:<name>        an attribute (a data-* the page's script reads, say)
//   text               the text of a leaf element
//   src                an image's or video's file
//   class:<name>       a class, on or off

function parseWrite(how) {
  const m = /^(style|attr|class):(.+)$/.exec(String(how || ""));
  if (m) {
    const [, kind, name] = m;
    if (kind === "style" && !/^(--[\w-]+|[a-z][a-z-]*)$/i.test(name)) throw new Error(`bad style property ${name}`);
    if (kind === "attr" && (!/^[a-z_][\w.:-]*$/i.test(name) || /^(on|id$|style$)/i.test(name))) throw new Error(`can't write the ${name} attribute`);
    if (kind === "class" && !/^[\w-]+$/.test(name)) throw new Error(`bad class ${name}`);
    return { kind, name };
  }
  if (how === "text" || how === "src") return { kind: how, name: null };
  throw new Error(`a control writes style:<property>, attr:<name>, text, src or class:<name>, not ${how}`);
}

function leafText(html, tag, id) {
  const close = html.indexOf(`</${tag.tag}`, tag.end);
  if (close < 0) throw new Error(`#${id} has no closing tag`);
  const inner = html.slice(tag.end, close);
  if (/<[a-zA-Z]/.test(inner)) throw new Error(`#${id} holds other elements, not just text`);
  return inner;
}

function readTarget(html, id, how) {
  const w = parseWrite(how);
  const tag = openTag(html, id);
  if (w.kind === "style") {
    const style = getAttr(tag.text, "style") || "";
    const m = new RegExp(`(?:^|;)\\s*${escRe(w.name)}\\s*:([^;]*)`, "i").exec(style);
    return m ? m[1].trim() : null;
  }
  if (w.kind === "attr") return getAttr(tag.text, w.name);
  if (w.kind === "src") return getAttr(tag.text, "src");
  if (w.kind === "class") return (getAttr(tag.text, "class") || "").split(/\s+/).includes(w.name);
  return leafText(html, tag, id)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .trim();
}

function writeTarget(html, id, how, value) {
  const w = parseWrite(how);
  const tag = openTag(html, id);
  if (w.kind === "text") {
    leafText(html, tag, id);
    const close = html.indexOf(`</${tag.tag}`, tag.end);
    return html.slice(0, tag.end) + escText(String(value)) + html.slice(close);
  }
  if (w.kind === "class") {
    const on = value === true || value === "true" || value === 1;
    const cls = (getAttr(tag.text, "class") || "").split(/\s+/).filter((c) => c && c !== w.name);
    if (on) cls.push(w.name);
    return splice(html, tag, setAttr(tag.text, "class", cls.join(" ")));
  }
  const v = String(value ?? "");
  if (w.kind === "src") {
    if (!["img", "video", "source"].includes(tag.tag)) throw new Error(`#${id} is not an image or video`);
    if (/^\s*javascript:/i.test(v)) throw new Error("not a file");
    return splice(html, tag, setAttr(tag.text, "src", v));
  }
  if (w.kind === "style") {
    if (/[;{}<>]|expression\s*\(|javascript:/i.test(v)) throw new Error("that is not a single CSS value");
    return splice(html, tag, setStyleProp(tag.text, w.name, v));
  }
  return splice(html, tag, setAttr(tag.text, w.name, v));
}

function commit(file, before, after) {
  if (after === before) return { ok: true, file, changed: false, sha: sha(before), inspect: inspectFile(file) };
  write(file, after);
  return { ok: true, file, changed: true, before, before_sha: sha(before), sha: sha(after), inspect: inspectFile(file) };
}

// ── Main ──────────────────────────────────────────────────────────────

try {
  const req = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const fn = ops[req.op];
  if (!fn) throw new Error(`unknown op ${req.op}`);
  process.stdout.write(JSON.stringify(fn(req)));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  process.exitCode = 0;
}
