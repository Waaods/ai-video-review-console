"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_CATS = [
  { id: "c-point", name: "卡点", color: "#F2D14E" },
  { id: "c-text", name: "文案", color: "#5B7DB1" },
  { id: "c-vis", name: "画面", color: "#D9553F" },
  { id: "c-sfx", name: "音效", color: "#3FAE6A" },
  { id: "c-rhythm", name: "节奏", color: "#9B6BD6" }
];

function freshDB() {
  return { categories: DEFAULT_CATS.slice(), markers: [] };
}

/** Frame-rounded clamp to [0, duration]; non-finite -> 0. */
function clampT(t, duration, fps) {
  t = Number(t);
  if (!isFinite(t)) t = 0;
  return Math.max(0, Math.min(duration, Math.round(t * fps) / fps));
}

/** Read db file; missing/corrupt -> fresh defaults. Guarantees categories + markers arrays. */
function read(dbFile) {
  try {
    const d = JSON.parse(fs.readFileSync(dbFile, "utf8"));
    if (!Array.isArray(d.categories) || !d.categories.length) d.categories = DEFAULT_CATS.slice();
    if (!Array.isArray(d.markers)) d.markers = [];
    return d;
  } catch (e) {
    return freshDB();
  }
}

/** Write db as 2-space JSON UTF-8, creating the parent directory. */
function write(dbFile, db) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2), "utf8");
}

/** Create the default db file when missing. */
function ensure(dbFile) {
  if (!fs.existsSync(dbFile)) write(dbFile, freshDB());
}

function newMarkerId() {
  return "m" + Date.now().toString(36) + Math.floor(Math.random() * 1e3).toString(36);
}

/** Add a marker from input; clamps times, resolves cat, pushes into db.markers. */
function addMarker(db, input, ctx) {
  const cat = db.categories.find(c => c.id === input.cat) || db.categories[0];
  const a = clampT(input.from != null ? input.from : input.t, ctx.duration, ctx.fps);
  const b = clampT(input.to != null ? input.to : a, ctx.duration, ctx.fps);
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  const rec = {
    id: newMarkerId(),
    from,
    to,
    cat: cat.id,
    text: String(input.text || "").slice(0, 600),
    scene: ctx.sceneOf(from),
    at: new Date().toISOString()
  };
  db.markers.push(rec);
  return rec;
}

/** Update a marker by id; null when absent. */
function updateMarker(db, input, ctx) {
  const m = db.markers.find(x => x.id === input.id);
  if (!m) return null;
  if (typeof input.text === "string") m.text = input.text.slice(0, 600);
  if (typeof input.cat === "string" && db.categories.some(c => c.id === input.cat)) m.cat = input.cat;
  if (input.from != null) m.from = clampT(input.from, ctx.duration, ctx.fps);
  if (input.to != null) m.to = clampT(input.to, ctx.duration, ctx.fps);
  if (m.to < m.from) { const t = m.from; m.from = m.to; m.to = t; }
  m.scene = ctx.sceneOf(m.from);
  return m;
}

/** Remove marker by id; returns removed count (0 or 1). */
function deleteMarker(db, id) {
  const before = db.markers.length;
  db.markers = db.markers.filter(x => x.id !== id);
  return before - db.markers.length;
}

/** Merge up to 8 markers into one span. */
function mergeMarkers(db, ids, ctx) {
  const wanted = Array.isArray(ids) ? ids.filter(x => typeof x === "string").slice(0, 8) : [];
  const picked = db.markers.filter(m => wanted.indexOf(m.id) >= 0);
  if (picked.length < 2) return { ok: false, error: "need two markers" };
  picked.sort((a, b) => a.from - b.from);
  const from = Math.min.apply(null, picked.map(m => m.from));
  const to = Math.max.apply(null, picked.map(m => m.to));
  if (to - from < 1 / ctx.fps) return { ok: false, error: "same frame" };
  const rec = {
    id: newMarkerId(),
    from,
    to,
    cat: picked[0].cat,
    text: picked.map(m => (m.text || "").trim()).filter(Boolean).join(" / ").slice(0, 600),
    scene: ctx.sceneOf(from),
    at: new Date().toISOString(),
    mergedFrom: picked.map(m => m.id)
  };
  db.markers = db.markers.filter(m => wanted.indexOf(m.id) < 0);
  db.markers.push(rec);
  return { ok: true, marker: rec, markers: db.markers };
}

/** Clear all markers. */
function clearMarkers(db) {
  db.markers = [];
}

/** Add a category; validates name/color. */
function addCategory(db, input) {
  const name = String(input.name || "").trim().slice(0, 12);
  if (!name) return { ok: false, error: "name required" };
  const cat = {
    id: "c" + Date.now().toString(36),
    name,
    color: /^#[0-9a-f]{6}$/i.test(input.color || "") ? input.color : "#F2D14E"
  };
  db.categories.push(cat);
  return { ok: true, category: cat };
}

/** Delete a category; repoints its markers to the first remaining category. */
function deleteCategory(db, id) {
  if (db.categories.length <= 1) return { ok: false, error: "keep at least one" };
  db.categories = db.categories.filter(c => c.id !== id);
  const fb = db.categories[0].id;
  db.markers.forEach(m => { if (m.cat === id) m.cat = fb; });
  return { ok: true };
}

/** Markers with scene recomputed; originals untouched. */
function withScene(db, sceneOf) {
  return db.markers.map(m => Object.assign({}, m, { scene: sceneOf(m.from) }));
}

module.exports = {
  DEFAULT_CATS,
  clampT,
  read,
  write,
  ensure,
  addMarker,
  updateMarker,
  deleteMarker,
  mergeMarkers,
  clearMarkers,
  addCategory,
  deleteCategory,
  withScene
};
