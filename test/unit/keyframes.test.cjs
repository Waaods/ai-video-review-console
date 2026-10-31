"use strict";

const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const config = require("../../lib/config");
const kf = require("../../lib/keyframes");

const tmpDirs = [];

function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writeFixture(dir, name, source) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, source, "utf8");
  return file;
}

function readCounter(file) {
  try {
    return Number(fs.readFileSync(file, "utf8")) || 0;
  } catch {
    return 0;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tasklistHas(pid) {
  try {
    const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
      encoding: "utf8",
      windowsHide: true
    });
    return out.includes(`"${pid}"`);
  } catch {
    return null; // tasklist unavailable: cannot judge
  }
}

beforeEach(() => {
  kf.clearCache();
});

after(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

test("readPin: extracts the pinned hyperframes version from any script", () => {
  const text = JSON.stringify({
    name: "demo",
    scripts: {
      dev: "npx --yes hyperframes@0.8.168 preview",
      render: "npx --yes hyperframes@0.8.168 render"
    }
  });
  assert.equal(kf.readPin(text), "0.8.168");
});

test("readPin: null when missing, unparsable, or unpinned", () => {
  assert.equal(kf.readPin(JSON.stringify({ scripts: { build: "node build.js" } })), null);
  assert.equal(kf.readPin(JSON.stringify({ name: "no-scripts" })), null);
  assert.equal(kf.readPin("not json at all"), null);
  assert.equal(kf.readPin("null"), null);
  assert.equal(kf.readPin(""), null);
});

test("buildCommand: exact npx invocation", () => {
  assert.equal(kf.buildCommand("0.8.168"), "npx --yes hyperframes@0.8.168 keyframes --json");
});

test("resolveVersion: package.json pin, then env override, then default", async () => {
  const dir = makeTmpDir("hf-kf-version-");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ scripts: { render: "npx --yes hyperframes@1.2.3 render" } }),
    "utf8"
  );

  const saved = process.env.HF_VERSION;
  delete process.env.HF_VERSION;
  try {
    assert.equal(await kf.resolveVersion(dir), "1.2.3", "package.json pin");

    process.env.HF_VERSION = "9.9.9";
    assert.equal(await kf.resolveVersion(dir), "9.9.9", "env override wins");

    process.env.HF_VERSION = "   ";
    assert.equal(await kf.resolveVersion(dir), "1.2.3", "blank env is ignored");
  } finally {
    if (saved === undefined) delete process.env.HF_VERSION;
    else process.env.HF_VERSION = saved;
  }

  const emptyDir = makeTmpDir("hf-kf-default-");
  delete process.env.HF_VERSION;
  try {
    assert.equal(await kf.resolveVersion(emptyDir), config.DEFAULT_HF_VERSION);
  } finally {
    if (saved === undefined) delete process.env.HF_VERSION;
    else process.env.HF_VERSION = saved;
  }
});

test("collectSources: root files plus compositions/**/*.html, posix rel, missing skipped", async () => {
  const dir = makeTmpDir("hf-kf-sources-");
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>", "utf8");
  fs.mkdirSync(path.join(dir, "compositions", "nested"), { recursive: true });
  fs.writeFileSync(path.join(dir, "compositions", "a.html"), "<html>a</html>", "utf8");
  fs.writeFileSync(path.join(dir, "compositions", "nested", "b.html"), "<html>b</html>", "utf8");
  fs.writeFileSync(path.join(dir, "compositions", "notes.txt"), "ignored", "utf8");

  const sources = await kf.collectSources(dir);
  const rels = sources.map((s) => s.rel);
  assert.deepEqual(rels, [
    "compositions/a.html",
    "compositions/nested/b.html",
    "index.html",
    "package.json"
  ]);
  for (const source of sources) {
    assert.ok(!source.rel.includes("\\"), "posix separators only");
    assert.equal(typeof source.size, "number");
    assert.ok(source.mtimeMs > 0);
  }

  const missingDir = makeTmpDir("hf-kf-empty-");
  assert.deepEqual(await kf.collectSources(missingDir), []);
});

test("cacheKey: stable when nothing changes, changes on composition mtime and version", async () => {
  const dir = makeTmpDir("hf-kf-cache-");
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>", "utf8");
  fs.mkdirSync(path.join(dir, "compositions"), { recursive: true });
  const composition = path.join(dir, "compositions", "scene.html");
  fs.writeFileSync(composition, "<html>scene</html>", "utf8");

  const first = await kf.cacheKey(dir, "0.8.168");
  const second = await kf.cacheKey(dir, "0.8.168");
  assert.equal(first, second, "stable across calls");
  assert.match(first, /^[0-9a-f]{16}$/);

  assert.notEqual(await kf.cacheKey(dir, "0.8.169"), first, "version participates in the key");

  const future = new Date(Date.now() + 5000);
  fs.utimesSync(composition, future, future);
  const touched = await kf.cacheKey(dir, "0.8.168");
  assert.notEqual(touched, first, "mtime change invalidates the key");
});

test("parseJsonLoose: raw JSON, log-prefixed JSON, trailing newline, garbage", () => {
  const payload = { project: "demo", compositions: [] };
  const raw = JSON.stringify(payload);

  assert.deepEqual(kf.parseJsonLoose(raw), payload);
  assert.deepEqual(kf.parseJsonLoose(`${raw}\n`), payload);
  assert.deepEqual(kf.parseJsonLoose(`npm warn exec something\n${raw}\nDone in 1.2s`), payload);
  assert.deepEqual(kf.parseJsonLoose(`  \n${raw}\r\n`), payload);

  assert.equal(kf.parseJsonLoose("no json here"), null);
  assert.equal(kf.parseJsonLoose("{ broken"), null);
  assert.equal(kf.parseJsonLoose(""), null);
  assert.equal(kf.parseJsonLoose(null), null);
  assert.equal(kf.parseJsonLoose("[1,2,3]"), null);
});

test("load: runs once, parses the JSON, then serves the in-memory cache", async () => {
  const dir = makeTmpDir("hf-kf-load-");
  const emit = writeFixture(
    dir,
    "emit.cjs",
    `"use strict";
const fs = require("fs");
const path = require("path");
const counter = path.join(__dirname, "counter.txt");
let n = 0;
try { n = parseInt(fs.readFileSync(counter, "utf8"), 10) || 0; } catch (e) {}
fs.writeFileSync(counter, String(n + 1));
console.log(JSON.stringify({
  project: "fixture",
  compositions: [{
    composition: "index.html",
    tweens: [{ id: "#fade", target: "#hero", method: "to", group: "visual",
               start: 0.15, duration: 0.3, end: 0.45, ease: "power1.out" }]
  }]
}));
`
  );

  const commandString = `node "${emit}"`;
  const first = await kf.load(dir, { version: "0.8.168", commandString });

  assert.equal(first.ok, true, `expected ok, got ${JSON.stringify(first)}`);
  assert.equal(first.cached, false);
  assert.equal(first.version, "0.8.168");
  assert.equal(first.cmd, commandString);
  assert.match(first.cacheKey, /^[0-9a-f]{16}$/);
  assert.equal(first.data.compositions[0].tweens.length, 1);
  assert.equal(readCounter(path.join(dir, "counter.txt")), 1);

  const second = await kf.load(dir, { version: "0.8.168", commandString });
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
  assert.deepEqual(second.data, first.data);
  assert.equal(readCounter(path.join(dir, "counter.txt")), 1, "cached call must not spawn");
});

test("load: force bypasses the cache and re-runs the command", async () => {
  const dir = makeTmpDir("hf-kf-force-");
  const emit = writeFixture(
    dir,
    "emit.cjs",
    `"use strict";
const fs = require("fs");
const path = require("path");
const counter = path.join(__dirname, "counter.txt");
let n = 0;
try { n = parseInt(fs.readFileSync(counter, "utf8"), 10) || 0; } catch (e) {}
fs.writeFileSync(counter, String(n + 1));
console.log("{}");
`
  );

  const commandString = `node "${emit}"`;
  const first = await kf.load(dir, { version: "0.8.168", commandString });
  assert.equal(first.ok, true);
  assert.equal(readCounter(path.join(dir, "counter.txt")), 1);

  const forced = await kf.load(dir, { version: "0.8.168", commandString, force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.cached, false);
  assert.equal(readCounter(path.join(dir, "counter.txt")), 2, "force must spawn again");
});

test("load: timeout kills the tree and resolves fast", async () => {
  const dir = makeTmpDir("hf-kf-timeout-");
  const hang = writeFixture(
    dir,
    "hang.cjs",
    `"use strict";
const fs = require("fs");
const path = require("path");
fs.writeFileSync(path.join(__dirname, "pid.txt"), String(process.pid));
setTimeout(function () {}, 60000);
`
  );

  const commandString = `node "${hang}"`;
  const started = Date.now();
  const result = await kf.load(dir, { version: "0.8.168", commandString, timeoutMs: 300 });
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
  assert.equal(result.cmd, commandString);
  assert.equal(typeof result.stdoutTail, "string");
  assert.ok(elapsed < 3000, `resolved in ${elapsed}ms (must be < 3000ms)`);

  const pidText = fs.readFileSync(path.join(dir, "pid.txt"), "utf8").trim();
  const pid = Number(pidText);
  assert.ok(Number.isInteger(pid) && pid > 0, "fixture wrote its pid");

  let alive = tasklistHas(pid);
  for (let i = 0; i < 20 && alive === true; i += 1) {
    await delay(100);
    alive = tasklistHas(pid);
  }
  assert.equal(alive, false, `pid ${pid} should be gone after the timeout kill`);
});

test("load: exit-0 garbage is reported as bad-json", async () => {
  const dir = makeTmpDir("hf-kf-badjson-");
  const bad = writeFixture(dir, "bad.cjs", `process.stdout.write("this is not json at all");\n`);
  const commandString = `node "${bad}"`;

  const result = await kf.load(dir, { version: "0.8.168", commandString });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "bad-json");
  assert.equal(result.cmd, commandString);
  assert.match(result.stdoutTail, /not json/);
});

test("load: non-zero exit does not populate the cache", async () => {
  const dir = makeTmpDir("hf-kf-exit-");
  const fail = writeFixture(
    dir,
    "fail.cjs",
    `"use strict";
const fs = require("fs");
const path = require("path");
const counter = path.join(__dirname, "counter.txt");
let n = 0;
try { n = parseInt(fs.readFileSync(counter, "utf8"), 10) || 0; } catch (e) {}
fs.writeFileSync(counter, String(n + 1));
process.stderr.write("boom\\n");
process.exit(3);
`
  );

  const commandString = `node "${fail}"`;
  const first = await kf.load(dir, { version: "0.8.168", commandString });
  assert.equal(first.ok, false);
  assert.equal(first.reason, "exit-3");
  assert.match(first.stderr, /boom/);

  const second = await kf.load(dir, { version: "0.8.168", commandString });
  assert.equal(second.ok, false);
  assert.equal(readCounter(path.join(dir, "counter.txt")), 2, "failures are never cached");
});
