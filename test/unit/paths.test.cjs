"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const config = require("../../lib/config");
const {
  slugify,
  stableHash,
  projectDirName,
  dataDirs,
  isContained,
  assertVideoExt,
  toPosixRel
} = require("../../lib/paths");

const HEX10 = /^[0-9a-f]{10}$/;

test("slugify: unicode Chinese path yields non-empty ASCII slug, deterministic", () => {
  const p = "C:\\004Data\\赚米找副业\\ai视频\\我的项目";
  const a = slugify(p);
  const b = slugify(p);
  assert.equal(a, b, "deterministic");
  assert.ok(a.length > 0, "never empty");
  assert.match(a, /^[a-z0-9._-]+$/, "ASCII-safe charset only");
  assert.ok(!/[^\x00-\x7F]/.test(a), "no unicode chars");
});

test("slugify: empty-ish basenames fall back to 'project'", () => {
  assert.equal(slugify("C:\\."), "project");
  assert.equal(slugify("C:\\"), "project");
});

test("slugify: caps at 40 chars", () => {
  const long = "C:\\" + "a".repeat(80);
  assert.ok(slugify(long).length <= 40);
});

test("stableHash: deterministic, 10-char lowercase hex", () => {
  const h1 = stableHash("C:\\proj\\demo");
  const h2 = stableHash("C:\\proj\\demo");
  assert.equal(h1, h2);
  assert.match(h1, HEX10);
});

test("stableHash: differs for different paths", () => {
  assert.notEqual(stableHash("C:\\proj\\a"), stableHash("C:\\proj\\b"));
});

test("stableHash: same for backslash vs forward-slash forms", () => {
  assert.equal(stableHash("C:\\proj\\demo"), stableHash("C:/proj/demo"));
});

test("projectDirName: shape <slug>-<10 hex>", () => {
  const name = projectDirName("C:\\004Data\\赚米找副业\\ai视频\\改片台");
  const m = /^(.+)-([0-9a-f]{10})$/.exec(name);
  assert.ok(m, `shape mismatch: ${name}`);
  assert.ok(m[1].length > 0);
  assert.match(name, /^[a-z0-9._-]+-[0-9a-f]{10}$/);
});

test("dataDirs: no filesystem side effects, paths under dataRoot", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-data-"));
  try {
    const proj = "C:\\some\\where\\项目A";
    const before = fs.readdirSync(tmpRoot).sort();
    const res = dataDirs(tmpRoot, proj);
    const after = fs.readdirSync(tmpRoot).sort();
    assert.deepEqual(after, before, "dataDirs must not create anything");
    assert.equal(fs.existsSync(res.dir), false, "dir must not exist before use");
    assert.equal(fs.existsSync(res.markers), false);
    assert.equal(fs.existsSync(res.shots), false);
    // all under dataRoot
    assert.ok(isContained(tmpRoot, res.dir));
    assert.ok(isContained(tmpRoot, res.markers));
    assert.ok(isContained(tmpRoot, res.shots));
    assert.equal(path.basename(res.markers), "markers.json");
    assert.equal(path.basename(res.shots), "shots");
    assert.equal(path.basename(path.dirname(res.markers)), path.basename(res.dir));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("dataDirs: deterministic for same inputs", () => {
  const a = dataDirs("C:\\data", "C:\\proj\\x");
  const b = dataDirs("C:\\data", "C:\\proj\\x");
  assert.deepEqual(a, b);
});

test("isContained: accepts root itself and direct child", () => {
  assert.equal(isContained("C:\\proj", "C:\\proj"), true);
  assert.equal(isContained("C:\\proj", "C:\\proj\\sub\\a.mp4"), true);
});

test("isContained: rejects parent escape via ..", () => {
  assert.equal(isContained("C:\\proj", "C:\\proj\\..\\..\\evil"), false);
});

test("isContained: rejects sibling-prefix trick C:\\proj2", () => {
  assert.equal(isContained("C:\\proj", "C:\\proj2"), false);
  assert.equal(isContained("C:\\proj", "C:\\proj2\\file.mp4"), false);
});

test("isContained: case-insensitive on win32", () => {
  if (process.platform !== "win32") return; // windows-specific rule
  assert.equal(isContained("C:\\proj", "C:\\PROJ\\x"), true);
  assert.equal(isContained("C:\\PROJ", "c:\\proj\\x"), true);
});

test("assertVideoExt: video extensions true, others false", () => {
  assert.equal(assertVideoExt("clip.MP4"), true);
  assert.equal(assertVideoExt("clip.mp4"), true);
  assert.equal(assertVideoExt("clip.webm"), true);
  assert.equal(assertVideoExt("clip.mov"), true);
  assert.equal(assertVideoExt("notes.txt"), false);
  assert.equal(assertVideoExt("noext"), false);
  assert.equal(assertVideoExt(""), false);
  assert.equal(assertVideoExt(null), false);
});

test("toPosixRel: forward-slash relative path inside root", () => {
  assert.equal(toPosixRel("C:\\proj", "C:\\proj\\renders\\a.mp4"), "renders/a.mp4");
});

test("toPosixRel: null for outside root", () => {
  assert.equal(toPosixRel("C:\\proj", "C:\\other\\a.mp4"), null);
  assert.equal(toPosixRel("C:\\proj", "C:\\proj2\\a.mp4"), null);
});

test("config sanity: DATA_ROOT points at 改片台/data", () => {
  assert.equal(config.DATA_ROOT, path.join(__dirname, "..", "..", "data"));
  assert.equal(config.HOST, "127.0.0.1");
  assert.ok(config.VIDEO_EXT.has(".mp4"));
});
