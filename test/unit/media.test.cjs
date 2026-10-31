"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { Writable } = require("node:stream");

const media = require("../../lib/media");

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "media-test-"));
  fs.writeFileSync(path.join(root, "a.mp4"), Buffer.alloc(1000));
  fs.writeFileSync(path.join(root, "a.txt"), Buffer.alloc(10));
  fs.mkdirSync(path.join(root, "dir.mp4"));
  return root;
}

function expectHttpError(fn, code) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, "expected a throw");
  assert.equal(err.code, code);
  return err;
}

class FakeRes extends Writable {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = null;
    this.chunks = [];
  }
  writeHead(code, headers) {
    this.statusCode = code;
    this.headers = headers;
  }
  _write(chunk, enc, cb) {
    this.chunks.push(chunk);
    cb();
  }
  body() {
    return Buffer.concat(this.chunks);
  }
}

test("resolveMedia: resolves a.mp4 with correct mime and size", () => {
  const root = makeTempRoot();
  try {
    const r = media.resolveMedia(root, "a.mp4");
    assert.equal(r.mime, "video/mp4");
    assert.equal(r.size, 1000);
    assert.equal(path.resolve(r.abs), path.resolve(root, "a.mp4"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveMedia: percent-encoded name decodes", () => {
  const root = makeTempRoot();
  try {
    const r = media.resolveMedia(root, "%61.mp4");
    assert.equal(r.mime, "video/mp4");
    assert.equal(r.size, 1000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveMedia: encoded traversal escapes root → 4xx, never outside", () => {
  const root = makeTempRoot();
  try {
    const outside = path.resolve(root, "..", "secret.mp4");
    fs.writeFileSync(outside, Buffer.alloc(5));
    let err = null;
    try {
      media.resolveMedia(root, "..%5C..%5Csecret.mp4");
    } catch (e) {
      err = e;
    }
    assert.ok(err, "expected a throw");
    assert.ok(err.code >= 400 && err.code < 500, `4xx expected, got ${err.code}`);
    assert.ok(!("abs" in err), "no abs leaked on error");
    const decoded = decodeURIComponent("..%5C..%5Csecret.mp4");
    const resolved = path.resolve(root, decoded);
    assert.ok(
      !resolved.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep),
      "resolution must land outside root"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveMedia: /etc/passwd → 400", () => {
  const root = makeTempRoot();
  try {
    expectHttpError(() => media.resolveMedia(root, "/etc/passwd"), 400);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveMedia: a.txt → 400 even though it exists", () => {
  const root = makeTempRoot();
  try {
    expectHttpError(() => media.resolveMedia(root, "a.txt"), 400);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveMedia: missing b.mp4 → 404", () => {
  const root = makeTempRoot();
  try {
    expectHttpError(() => media.resolveMedia(root, "b.mp4"), 404);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveMedia: directory named dir.mp4 → 404 (not a regular file)", () => {
  const root = makeTempRoot();
  try {
    expectHttpError(() => media.resolveMedia(root, "dir.mp4"), 404);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveMedia: empty rel → 400; NUL → 400; malformed encoding → 400", () => {
  const root = makeTempRoot();
  try {
    expectHttpError(() => media.resolveMedia(root, ""), 400);
    expectHttpError(() => media.resolveMedia(root, "a\0.mp4"), 400);
    expectHttpError(() => media.resolveMedia(root, "%ZZ.mp4"), 400);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("parseRange: documented cases", () => {
  assert.deepEqual(media.parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(media.parseRange("bytes=500-", 1000), { start: 500, end: 999 });
  assert.deepEqual(media.parseRange("bytes=-500", 1000), { start: 500, end: 999 });
  assert.deepEqual(media.parseRange("bytes=0-9999999", 1000), { start: 0, end: 999 });
  assert.equal(media.parseRange("bytes=2000-", 1000), null);
  assert.deepEqual(media.parseRange("bytes=0-99,200-299", 1000), { start: 0, end: 99 });
  assert.equal(media.parseRange("nonsense", 1000), null);
});

test("parseRange: edge cases", () => {
  assert.equal(media.parseRange(null, 1000), null);
  assert.equal(media.parseRange("bytes=-0", 1000), null);
  assert.deepEqual(media.parseRange("bytes=0-0", 1000), { start: 0, end: 0 });
  assert.deepEqual(media.parseRange("bytes=999-", 1000), { start: 999, end: 999 });
  assert.equal(media.parseRange("bytes=1000-", 1000), null);
  assert.equal(media.parseRange("bytes=5-2", 1000), null);
});

test("rangeHeaders: full response", () => {
  const h = media.rangeHeaders(1000, null);
  assert.equal(h["Content-Length"], 1000);
  assert.equal(h["Accept-Ranges"], "bytes");
  assert.equal(h["Cache-Control"], "no-store");
  assert.equal(h["Content-Range"], undefined);
});

test("rangeHeaders: valid range", () => {
  const h = media.rangeHeaders(1000, "bytes=0-99");
  assert.equal(h["Content-Range"], "bytes 0-99/1000");
  assert.equal(h["Content-Length"], 100);
});

test("rangeHeaders: unsatisfiable range", () => {
  const h = media.rangeHeaders(1000, "bytes=2000-");
  assert.equal(h["Content-Range"], "bytes */1000");
  assert.equal(h["Content-Length"], undefined);
});

test("serve: 200 full body, headers, returns stream", async () => {
  const root = makeTempRoot();
  try {
    const { abs, mime, size } = media.resolveMedia(root, "a.mp4");
    const res = new FakeRes();
    const stream = media.serve({ headers: {} }, res, abs, mime, size);
    assert.ok(stream, "serve returns the stream");
    await new Promise(resolve => res.on("finish", resolve));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["Content-Length"], 1000);
    assert.equal(res.headers["Content-Type"], "video/mp4");
    assert.equal(res.headers["Accept-Ranges"], "bytes");
    assert.equal(res.headers["Cache-Control"], "no-store");
    assert.equal(res.body().length, 1000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("serve: 206 partial body of correct length", async () => {
  const root = makeTempRoot();
  try {
    const { abs, mime, size } = media.resolveMedia(root, "a.mp4");
    const res = new FakeRes();
    const stream = media.serve({ headers: { range: "bytes=100-199" } }, res, abs, mime, size);
    assert.ok(stream);
    await new Promise(resolve => res.on("finish", resolve));
    assert.equal(res.statusCode, 206);
    assert.equal(res.headers["Content-Range"], "bytes 100-199/1000");
    assert.equal(res.headers["Content-Length"], 100);
    assert.equal(res.body().length, 100);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("serve: 416 on unsatisfiable range, empty body", async () => {
  const root = makeTempRoot();
  try {
    const { abs, mime, size } = media.resolveMedia(root, "a.mp4");
    const res = new FakeRes();
    const stream = media.serve({ headers: { range: "bytes=2000-" } }, res, abs, mime, size);
    assert.equal(stream, null);
    await new Promise(resolve => res.on("close", resolve));
    assert.equal(res.statusCode, 416);
    assert.equal(res.headers["Content-Range"], "bytes */1000");
    assert.equal(res.body().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sendError: uses err.code, JSON body", () => {
  const calls = [];
  const res = {
    writeHead(code, headers) {
      calls.push({ code, headers });
    },
    end(body) {
      calls.push({ body });
    }
  };
  const err = new Error("nope");
  err.code = 403;
  media.sendError(res, err);
  assert.equal(calls[0].code, 403);
  assert.equal(calls[0].headers["Content-Type"], "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(calls[1].body), { error: "nope" });
});

test("sendError: non-HTTP code falls back to 500", () => {
  const calls = [];
  const res = {
    writeHead(code) {
      calls.push(code);
    },
    end() {}
  };
  const err = new Error("boom");
  err.code = "ENOENT";
  media.sendError(res, err);
  assert.equal(calls[0], 500);
  media.sendError(res, null);
  assert.equal(calls[1], 500);
});
