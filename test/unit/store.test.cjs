"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const store = require("../../lib/store");

let tmp;

test.before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "store-test-"));
});

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function dbFile(name) {
  return path.join(tmp, name, "markers.json");
}

const CTX = { duration: 10, fps: 25, sceneOf: t => (t < 5 ? "s1" : "s2") };

test("read missing file returns defaults with 5 categories", () => {
  const db = store.read(dbFile("missing"));
  assert.equal(db.categories.length, 5);
  assert.deepEqual(db.markers, []);
  assert.equal(db.categories[0].name, "卡点");
  assert.equal(db.categories[0].color, "#F2D14E");
});

test("write/read round-trip", () => {
  const f = dbFile("roundtrip");
  const db = { categories: store.DEFAULT_CATS.slice(), markers: [{ id: "m1", from: 1, to: 2, cat: "c-point", text: "hi", scene: "s1", at: "x" }] };
  store.write(f, db);
  const back = store.read(f);
  assert.deepEqual(back, db);
});

test("read corrupt file returns fresh defaults", () => {
  const f = dbFile("corrupt");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "{not json", "utf8");
  const db = store.read(f);
  assert.equal(db.categories.length, 5);
  assert.deepEqual(db.markers, []);
});

test("ensure creates default file", () => {
  const f = dbFile("ensured");
  store.ensure(f);
  assert.ok(fs.existsSync(f));
  const db = store.read(f);
  assert.equal(db.categories.length, 5);
});

test("addMarker clamps beyond duration and snaps to frame grid", () => {
  const db = store.read(dbFile("clamp"));
  const rec = store.addMarker(db, { t: 9.999, text: "x" }, CTX);
  assert.equal(rec.from, 10);
  const rec2 = store.addMarker(db, { t: 1.234 }, CTX);
  assert.equal(rec2.from, Math.round(1.234 * 25) / 25);
  assert.equal(rec2.cat, "c-point");
});

test("addMarker slices text to 600 chars", () => {
  const db = store.read(dbFile("textslice"));
  const rec = store.addMarker(db, { t: 1, text: "a".repeat(700) }, CTX);
  assert.equal(rec.text.length, 600);
});

test("addMarker with unknown cat falls back to first", () => {
  const db = store.read(dbFile("unknowncat"));
  const rec = store.addMarker(db, { t: 1, cat: "nope" }, CTX);
  assert.equal(rec.cat, "c-point");
});

test("addMarker orders from/to", () => {
  const db = store.read(dbFile("order"));
  const rec = store.addMarker(db, { from: 4, to: 2 }, CTX);
  assert.equal(rec.from, 2);
  assert.equal(rec.to, 4);
});

test("updateMarker swaps inverted range and moves scene", () => {
  const db = store.read(dbFile("update"));
  const rec = store.addMarker(db, { from: 1, to: 2 }, CTX);
  assert.equal(rec.scene, "s1");
  const out = store.updateMarker(db, { id: rec.id, from: 8, to: 6 }, CTX);
  assert.equal(out.from, 6);
  assert.equal(out.to, 8);
  assert.equal(out.scene, "s2");
});

test("updateMarker returns null for unknown id", () => {
  const db = store.read(dbFile("update-null"));
  assert.equal(store.updateMarker(db, { id: "zzz" }, CTX), null);
});

test("updateMarker ignores unknown cat", () => {
  const db = store.read(dbFile("update-cat"));
  const rec = store.addMarker(db, { t: 1 }, CTX);
  const out = store.updateMarker(db, { id: rec.id, cat: "nope" }, CTX);
  assert.equal(out.cat, "c-point");
});

test("deleteMarker returns 1 then 0", () => {
  const db = store.read(dbFile("delete"));
  const rec = store.addMarker(db, { t: 1 }, CTX);
  assert.equal(store.deleteMarker(db, rec.id), 1);
  assert.equal(store.deleteMarker(db, rec.id), 0);
});

test("mergeMarkers merges two overlapping points into one span", () => {
  const db = store.read(dbFile("merge"));
  const a = store.addMarker(db, { t: 2, text: " alpha " }, CTX);
  const b = store.addMarker(db, { t: 3, text: "beta" }, CTX);
  const res = store.mergeMarkers(db, [a.id, b.id], CTX);
  assert.equal(res.ok, true);
  assert.equal(res.marker.from, 2);
  assert.equal(res.marker.to, 3);
  assert.equal(res.marker.text, "alpha / beta");
  assert.deepEqual(res.marker.mergedFrom, [a.id, b.id]);
  assert.equal(res.marker.cat, a.cat);
  assert.equal(db.markers.length, 1);
  assert.equal(res.markers.length, 1);
});

test("mergeMarkers with one marker errors", () => {
  const db = store.read(dbFile("merge1"));
  const a = store.addMarker(db, { t: 2 }, CTX);
  const res = store.mergeMarkers(db, [a.id], CTX);
  assert.deepEqual(res, { ok: false, error: "need two markers" });
});

test("mergeMarkers same frame errors", () => {
  const db = store.read(dbFile("merge-same"));
  const a = store.addMarker(db, { t: 2 }, CTX);
  const b = store.addMarker(db, { t: 2.01 }, CTX);
  const res = store.mergeMarkers(db, [a.id, b.id], CTX);
  assert.deepEqual(res, { ok: false, error: "same frame" });
});

test("clearMarkers empties list", () => {
  const db = store.read(dbFile("clear"));
  store.addMarker(db, { t: 1 }, CTX);
  store.clearMarkers(db);
  assert.deepEqual(db.markers, []);
});

test("addCategory rejects blank name", () => {
  const db = store.read(dbFile("cat-blank"));
  const res = store.addCategory(db, { name: "   ", color: "#123456" });
  assert.deepEqual(res, { ok: false, error: "name required" });
});

test("addCategory truncates name to 12 chars", () => {
  const db = store.read(dbFile("cat-long"));
  const res = store.addCategory(db, { name: "一二三四五六七八九十十一十二十三" });
  assert.equal(res.ok, true);
  assert.equal(res.category.name.length, 12);
  assert.equal(res.category.color, "#F2D14E");
});

test("addCategory rejects bad color", () => {
  const db = store.read(dbFile("cat-color"));
  const res = store.addCategory(db, { name: "ok", color: "red" });
  assert.equal(res.category.color, "#F2D14E");
  const res2 = store.addCategory(db, { name: "ok2", color: "#ABCDEF" });
  assert.equal(res2.category.color, "#ABCDEF");
});

test("deleteCategory repoints markers; refuses when one left", () => {
  const db = store.read(dbFile("cat-delete"));
  const rec = store.addMarker(db, { t: 1, cat: "c-text" }, CTX);
  const res = store.deleteCategory(db, "c-text");
  assert.deepEqual(res, { ok: true });
  assert.equal(db.categories.length, 4);
  assert.equal(rec.cat, "c-point");
  const res2 = store.deleteCategory(db, "c-vis");
  assert.deepEqual(res2, { ok: true });
  const res3 = store.deleteCategory(db, "c-sfx");
  assert.deepEqual(res3, { ok: true });
  const res4 = store.deleteCategory(db, "c-rhythm");
  assert.deepEqual(res4, { ok: true });
  assert.equal(db.categories.length, 1);
  const res5 = store.deleteCategory(db, "c-point");
  assert.deepEqual(res5, { ok: false, error: "keep at least one" });
});

test("withScene maps without mutating originals", () => {
  const db = store.read(dbFile("withscene"));
  const rec = store.addMarker(db, { t: 1 }, CTX);
  const mapped = store.withScene(db, t => (t < 2 ? "A" : "B"));
  assert.equal(mapped[0].scene, "A");
  assert.equal(rec.scene, "s1");
  assert.notEqual(mapped[0], rec);
});
