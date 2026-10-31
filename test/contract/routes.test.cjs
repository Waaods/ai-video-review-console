"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createServer } = require("../../serve.cjs");

const EMIT_SRC = [
  '"use strict";',
  'const fs = require("fs");',
  'const path = require("path");',
  'const counterFile = path.join(__dirname, "emit-count.txt");',
  "let count = 0;",
  "try {",
  '  count = parseInt(fs.readFileSync(counterFile, "utf8"), 10) || 0;',
  "} catch (e) {",
  "  count = 0;",
  "}",
  'fs.writeFileSync(counterFile, String(count + 1), "utf8");',
  "const payload = {",
  "  compositions: [",
  "    {",
  '      composition: "index.html",',
  "      tweens: [",
  '        { id: "#a", target: "#stageBase", method: "to", group: "visual", start: 0, duration: 1, end: 1, ease: "none" },',
  '        { id: "#b", target: "#s2", method: "fromTo", group: "scale", start: 2, duration: 1, end: 3, ease: "none" }',
  "      ]",
  "    }",
  "  ]",
  "};",
  "process.stdout.write(JSON.stringify(payload));",
  ""
].join("\n");

const INDEX_HTML =
  '<div data-composition-id="x" data-duration="10" data-fps="30">' +
  '<div id="stageBase" data-scene="s1" data-label="开场">' +
  '<section id="s2" data-label="第二场"></section>' +
  "</div>";

let tmp;
let tmpData;
let hfproj;
let plainDir;
let emptyDir;
let emitPath;
let counterFile;
let server;
let base;

let markerId = null;

function writeFile(abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function counterText() {
  try {
    return fs.readFileSync(counterFile, "utf8");
  } catch {
    return "";
  }
}

function findFileNamed(dir, name) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory() && findFileNamed(abs, name)) return true;
    if (ent.isFile() && ent.name === name) return true;
  }
  return false;
}

async function api(method, urlPath, body) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + urlPath, init);
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, json };
}

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hf-contract-"));
  tmpData = path.join(tmp, "data");

  // HyperFrames fixture project.
  hfproj = path.join(tmp, "hfproj");
  writeFile(path.join(hfproj, "hyperframes.json"), "{}");
  writeFile(
    path.join(hfproj, "package.json"),
    JSON.stringify({ scripts: { render: "npx --yes hyperframes@0.8.168 render" } }, null, 2)
  );
  writeFile(path.join(hfproj, "index.html"), INDEX_HTML);
  writeFile(path.join(hfproj, "renders", "a.mp4"), Buffer.alloc(1000, 1));

  // Plain folder: one video, no composition.
  plainDir = path.join(tmp, "plain");
  writeFile(path.join(plainDir, "renders", "b.mp4"), Buffer.alloc(100, 2));

  // Empty folder: no videos at all.
  emptyDir = path.join(tmp, "empty");
  fs.mkdirSync(emptyDir, { recursive: true });

  // Fake keyframes CLI: bumps a counter next to itself, prints fixed JSON.
  emitPath = path.join(tmp, "emit.cjs");
  fs.writeFileSync(emitPath, EMIT_SRC, "utf8");
  counterFile = path.join(tmp, "emit-count.txt");

  server = createServer({
    dataRoot: tmpData,
    keyframesCommand: 'node "' + emitPath + '"'
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  assert.equal(server.address().address, "127.0.0.1");
  base = "http://127.0.0.1:" + server.address().port;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    });
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test("01 POST /api/project/set loads a HyperFrames project", async () => {
  const { res, json } = await api("POST", "/api/project/set", { path: hfproj });
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);

  const state = json.state;
  assert.equal(state.kind, "hyperframes");
  assert.equal(state.video.rel, "renders/a.mp4");
  assert.equal(state.duration, 10);
  assert.equal(state.fps, 30);
  assert.equal(state.tweens.length, 2);
  assert.equal(state.scenes[0].label, "开场");
  assert.ok(state.dataDir.startsWith(tmpData));

  // The fake emitter ran exactly once during the load.
  assert.ok(fs.existsSync(counterFile));
  assert.equal(counterText().trim(), "1");
});

test("02 GET /api/meta is stat-only, fast, and does not run the CLI", async () => {
  const before = counterText();
  const t0 = process.hrtime.bigint();
  const { res, json } = await api("GET", "/api/meta");
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.kfStale, false);
  assert.equal(typeof json.version, "string");
  assert.ok(json.version.length > 0);
  assert.ok(elapsedMs < 200, "meta took " + elapsedMs.toFixed(1) + "ms");

  assert.equal(counterText(), before, "emitter must not run on /api/meta");
});

test("03 GET /api/keyframes serves the cached table", async () => {
  const { res, json } = await api("GET", "/api/keyframes");
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.tweens.length, 2);
  assert.equal(json.cached, true);
});

test("04 GET /media serves a Range request with 206", async () => {
  const res = await fetch(base + "/media/renders/a.mp4", {
    headers: { Range: "bytes=0-9" }
  });
  assert.equal(res.status, 206);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, 10);
  assert.ok((res.headers.get("content-range") || "").startsWith("bytes 0-9/1000"));
});

test("05 GET /media rejects path traversal", async () => {
  const res = await fetch(base + "/media/..%5C..%5Csecret.mp4");
  assert.notEqual(res.status, 200);
  assert.ok(res.status === 400 || res.status === 403, "status=" + res.status);
});

test("06 POST /api/mark persists and exposes the scene", async () => {
  const added = await api("POST", "/api/mark", {
    from: 1,
    to: 2,
    cat: "c-point",
    text: "x"
  });
  assert.equal(added.res.status, 200);
  assert.equal(added.json.ok, true);
  markerId = added.json.marker.id;
  assert.ok(markerId);

  const state = await api("GET", "/api/state");
  assert.equal(state.json.markers.length, 1);
  assert.equal(state.json.markers[0].scene, "s1");

  assert.ok(findFileNamed(tmpData, "markers.json"), "markers.json under tmpData");
});

test("07 POST /api/mark/update edits text", async () => {
  const updated = await api("POST", "/api/mark/update", {
    id: markerId,
    text: "edited"
  });
  assert.equal(updated.res.status, 200);
  assert.equal(updated.json.ok, true);
  assert.equal(updated.json.marker.text, "edited");

  const state = await api("GET", "/api/state");
  assert.equal(state.json.markers[0].text, "edited");
});

test("08 POST /api/mark/merge folds two markers into one", async () => {
  const added = await api("POST", "/api/mark", {
    from: 3,
    to: 4,
    cat: "c-point",
    text: "y"
  });
  assert.equal(added.json.ok, true);
  const secondId = added.json.marker.id;

  const merged = await api("POST", "/api/mark/merge", {
    ids: [markerId, secondId]
  });
  assert.equal(merged.res.status, 200);
  assert.equal(merged.json.ok, true);
  assert.equal(merged.json.markers.length, 1);
  assert.equal(merged.json.count, 1);
});

test("09 POST /api/cat adds then POST /api/cat/delete removes", async () => {
  const added = await api("POST", "/api/cat", { name: "新分类", color: "#123456" });
  assert.equal(added.res.status, 200);
  assert.equal(added.json.ok, true);
  const catId = added.json.category.id;

  const deleted = await api("POST", "/api/cat/delete", { id: catId });
  assert.equal(deleted.res.status, 200);
  assert.equal(deleted.json.ok, true);
  assert.ok(Array.isArray(deleted.json.categories));
  assert.ok(Array.isArray(deleted.json.markers));
});

test("10 plain folder loads without animation nodes", async () => {
  const { res, json } = await api("POST", "/api/project/set", { path: plainDir });
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.state.kind, "plain");
  assert.equal(json.state.tweens.length, 0);
  assert.ok(json.state.notice.includes("非 HyperFrames"));
});

test("11 empty folder reports missing video and still serves /api/meta", async () => {
  const { res, json } = await api("POST", "/api/project/set", { path: emptyDir });
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.ok(json.state.notice.includes("未找到视频文件"));

  const meta = await api("GET", "/api/meta");
  assert.equal(meta.res.status, 200);
  assert.equal(meta.json.ok, true);
});

test("12 a failed project switch keeps the previous project usable", async () => {
  const bad = await api("POST", "/api/project/set", { path: "Z:\\nope\\nope" });
  assert.equal(bad.res.status, 400);
  assert.equal(bad.json.ok, false);

  const state = await api("GET", "/api/state");
  assert.equal(state.res.status, 200);
  assert.equal(state.json.ok, true);
  assert.equal(state.json.chosenPath, emptyDir);
  assert.ok(state.json.notice.includes("未找到视频文件"));
});

test("13 /api/state exposes 5 categories and 7 lanes", async () => {
  const state = await api("GET", "/api/state");
  assert.equal(state.res.status, 200);
  assert.equal(state.json.categories.length, 5);
  assert.equal(state.json.lanes.length, 7);
});
