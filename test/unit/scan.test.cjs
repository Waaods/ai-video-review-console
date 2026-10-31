"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const config = require("../../lib/config");
const scan = require("../../lib/scan");

let tmpRoot;

function mk(rel) {
  const abs = path.join(tmpRoot, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return abs;
}

function write(rel, content, mtimeMs) {
  const abs = mk(rel);
  fs.writeFileSync(abs, content, "utf8");
  if (mtimeMs !== undefined) {
    const d = new Date(mtimeMs);
    fs.utimesSync(abs, d, d);
  }
  return abs;
}

test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hfs-scan-"));
});

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("findVideos: newest first, forward-slash rel, correct fields", async () => {
  const root = mk("newest");
  write("newest/a.mp4", "a", 1000);
  write("newest/b.mp4", "b", 3000);
  write("newest/c.mp4", "c", 2000);
  const vids = await scan.findVideos(root);
  assert.equal(vids.length, 3);
  assert.equal(vids[0].rel, "b.mp4");
  assert.equal(vids[1].rel, "c.mp4");
  assert.equal(vids[2].rel, "a.mp4");
  assert.ok(vids[0].abs.startsWith(root));
  assert.ok(vids[0].rel.indexOf("\\") === -1);
  assert.equal(vids[0].size, 1);
  assert.equal(typeof vids[0].mtime, "number");
  assert.ok(vids[0].mtime > vids[2].mtime);
});

test("findVideos: extension filter (.MP4 in, .txt/.info.json out)", async () => {
  const root = mk("ext");
  write("ext/upper.MP4", "x", 5000);
  write("ext/notes.txt", "x", 6000);
  write("ext/meta.info.json", "x", 7000);
  const vids = await scan.findVideos(root);
  assert.equal(vids.length, 1);
  assert.equal(vids[0].rel, "upper.MP4");
});

test("findVideos: depth 2 found; node_modules and dot-dir skipped", async () => {
  const root = mk("depth");
  write("depth/l1/l2/deep.mp4", "x", 100);
  write("depth/node_modules/fresh.mp4", "x", 999999);
  write("depth/.hidden/secret.mp4", "x", 999998);
  const vids = await scan.findVideos(root);
  assert.equal(vids.length, 1);
  assert.equal(vids[0].rel, "l1/l2/deep.mp4");
});

test("findVideos: length <= MAX_VIDEOS and sorted newest-first", async () => {
  const root = mk("cap");
  for (let i = 0; i < 3; i += 1) {
    write(`cap/v${i}.mp4`, "x", 100 + i);
  }
  const vids = await scan.findVideos(root);
  assert.ok(vids.length <= config.MAX_VIDEOS);
  for (let i = 1; i < vids.length; i += 1) {
    assert.ok(vids[i - 1].mtime >= vids[i].mtime);
  }
});

test("findVideos: missing root returns []", async () => {
  const vids = await scan.findVideos(path.join(tmpRoot, "does-not-exist"));
  assert.deepEqual(vids, []);
});

test("findNewestVideo: first item or null", async () => {
  const root = mk("newest2");
  write("newest2/x.mp4", "x", 42);
  const newest = await scan.findNewestVideo(root);
  assert.equal(newest.rel, "x.mp4");
  const none = await scan.findNewestVideo(path.join(tmpRoot, "nope"));
  assert.equal(none, null);
});

test("isHyperframesProject: hyperframes.json basis", async () => {
  const root = mk("hf1");
  write("hf1/hyperframes.json", "{}");
  const det = await scan.isHyperframesProject(root);
  assert.deepEqual(det, { ok: true, basis: "hyperframes.json" });
});

test("isHyperframesProject: index.html with data-composition-id basis", async () => {
  const root = mk("hf2");
  write("hf2/index.html", '<div data-composition-id="demo"></div>');
  const det = await scan.isHyperframesProject(root);
  assert.deepEqual(det, { ok: true, basis: "index.html" });
});

test("isHyperframesProject: plain dir -> ok false", async () => {
  const root = mk("plain1");
  write("plain1/index.html", "<div>no marker here</div>");
  const det = await scan.isHyperframesProject(root);
  assert.deepEqual(det, { ok: false, basis: null });
});

test("inferProjectRoot: finds root from nested compositions/x", async () => {
  const root = mk("proj");
  write("proj/hyperframes.json", "{}");
  const nested = mk("proj/compositions/x");
  const inf = await scan.inferProjectRoot(nested);
  assert.equal(inf.root, root);
  assert.equal(inf.kind, "hyperframes");
  assert.equal(inf.basis, "hyperframes.json");
});

test("inferProjectRoot: plain -> null root", async () => {
  const nested = mk("noproj/a/b");
  const inf = await scan.inferProjectRoot(nested);
  assert.deepEqual(inf, { root: null, kind: "plain", basis: null });
});

test("detectProject: chosen HF project wins over newest video elsewhere", async () => {
  const chosen = mk("chosen-proj");
  write("chosen-proj/hyperframes.json", "{}");
  const other = mk("other-proj");
  write("other-proj/index.html", '<div data-composition-id="o"></div>');
  write("other-proj/out/v.mp4", "x", 999);
  const newest = await scan.findNewestVideo(mk("other-proj"));
  const det = await scan.detectProject(chosen, newest);
  assert.equal(det.root, chosen);
  assert.equal(det.kind, "hyperframes");
  assert.equal(det.basis, "hyperframes.json");
  assert.equal(det.chosenPath, chosen);
});

test("detectProject: plain chosen + video inside HF project infers HF root", async () => {
  const hf = mk("hf-proj");
  write("hf-proj/index.html", '<div data-composition-id="c"></div>');
  write("hf-proj/out/render/v.mp4", "x", 777);
  const plain = mk("plain-chosen");
  const newest = await scan.findNewestVideo(hf);
  const det = await scan.detectProject(plain, newest);
  assert.equal(det.root, hf);
  assert.equal(det.kind, "hyperframes");
  assert.equal(det.basis, "index.html");
  assert.equal(det.chosenPath, plain);
});

test("detectProject: no HF anywhere -> plain chosenPath", async () => {
  const plain = mk("solo");
  write("solo/v.mp4", "x", 5);
  const newest = await scan.findNewestVideo(plain);
  const det = await scan.detectProject(plain, newest);
  assert.deepEqual(det, { root: plain, kind: "plain", basis: null, chosenPath: plain });
});

test("parseComposition: duration/fps and decoded labels", async () => {
  const root = mk("comp");
  write(
    "comp/index.html",
    '<div id="root" data-duration="69" data-fps="30">' +
      '<div id="stageBase" data-scene="s1" data-label="开场 &amp; 标题"></div>' +
      '<section id="s2" data-label="手机也能看同一个会话"></section>' +
      "</div>"
  );
  const comp = await scan.parseComposition(root);
  assert.equal(comp.duration, 69);
  assert.equal(comp.fps, 30);
  assert.equal(comp.labels.s1, "开场 & 标题");
  assert.equal(comp.labels.s2, "手机也能看同一个会话");
  assert.equal(comp.source, path.join(root, "index.html"));
  assert.equal(typeof comp.mtimeMs, "number");
});

test("parseComposition: attribute order independence (data-label before id)", async () => {
  const root = mk("comp2");
  write(
    "comp2/index.html",
    '<div data-label="倒序标签" data-scene="s3"></div>' +
      '<span data-label="引号 &quot;q&quot;" id="s4"></span>'
  );
  const comp = await scan.parseComposition(root);
  assert.equal(comp.labels.s3, "倒序标签");
  assert.equal(comp.labels.s4, '引号 "q"');
});

test("parseComposition: missing index.html -> nulls", async () => {
  const root = mk("empty-comp");
  const comp = await scan.parseComposition(root);
  assert.deepEqual(comp, {
    duration: null,
    fps: null,
    labels: {},
    source: path.join(root, "index.html"),
    mtimeMs: null
  });
});

test("parseComposition: non-finite duration ignored", async () => {
  const root = mk("comp3");
  write("comp3/index.html", '<div data-duration="abc" data-fps="Infinity"></div>');
  const comp = await scan.parseComposition(root);
  assert.equal(comp.duration, null);
  assert.equal(comp.fps, null);
});
