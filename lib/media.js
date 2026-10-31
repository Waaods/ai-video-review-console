"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");
const paths = require("./paths");

/**
 * Error carrying an HTTP status code in `.code` (number >= 400).
 */
function httpError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Resolve a URL path segment (may be percent-encoded) to a video file
 * inside `root`. Returns { abs, mime, size }.
 *
 * Throws:
 *   .code = 400 — empty/NUL name, malformed percent-encoding, non-video ext
 *   .code = 403 — resolved path escapes root
 *   .code = 404 — missing file / not a regular file
 */
function resolveMedia(root, rel) {
  if (typeof rel !== "string" || rel === "") {
    throw httpError(400, "missing media path");
  }
  if (rel.includes("\0")) {
    throw httpError(400, "NUL byte in media path");
  }
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch (e) {
    throw httpError(400, "malformed percent-encoding in media path");
  }
  if (decoded.includes("\0")) {
    throw httpError(400, "NUL byte in media path");
  }
  if (path.isAbsolute(decoded)) {
    throw httpError(400, "absolute media path not allowed");
  }
  const abs = path.resolve(root, decoded);
  if (!paths.isContained(root, abs)) {
    throw httpError(403, "media path escapes root");
  }
  if (!paths.assertVideoExt(abs)) {
    throw httpError(400, "not a video file extension");
  }
  let st;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    throw httpError(404, "media file not found");
  }
  if (!st.isFile()) {
    throw httpError(404, "media path is not a regular file");
  }
  const ext = path.extname(abs).toLowerCase();
  const mime = config.VIDEO_MIME[ext] || "application/octet-stream";
  return { abs, mime, size: st.size };
}

/**
 * Parse a Range header against a resource of `size` bytes.
 * Returns { start, end } (inclusive) or null when the header is absent,
 * malformed, or unsatisfiable (caller should respond 416).
 *
 * Only the first range of a comma-separated list is honored.
 * `bytes=-N` is a suffix request for the last N bytes.
 * end is clamped to size-1; start is clamped to 0.
 */
function parseRange(header, size) {
  if (typeof header !== "string") return null;
  const m = /^bytes=(\d*)-(\d*)(?:\s*,.*)?$/.exec(header.trim());
  if (!m) return null;
  if (m[1] === "" && m[2] === "") return null;

  let start;
  let end;
  if (m[1] === "") {
    // suffix form: bytes=-N → last N bytes
    const n = parseInt(m[2], 10);
    if (n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (start < 0) start = 0;
  if (start > end || start >= size) return null;
  return { start, end };
}

/**
 * Build the streaming headers for `size` bytes given a raw Range header
 * (or null/undefined for a full response). Content-Type is added by serve().
 */
function rangeHeaders(size, range) {
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store"
  };
  const parsed = range == null ? null : parseRange(range, size);
  if (range != null && !parsed) {
    headers["Content-Range"] = `bytes */${size}`;
    return headers;
  }
  if (parsed) {
    headers["Content-Range"] = `bytes ${parsed.start}-${parsed.end}/${size}`;
    headers["Content-Length"] = parsed.end - parsed.start + 1;
  } else {
    headers["Content-Length"] = size;
  }
  return headers;
}

/**
 * Stream `abs` to `res`, honoring Range requests. Never buffers the whole
 * file. Returns the read stream (or null for the 416 path).
 */
function serve(req, res, abs, mime, size) {
  const rangeHeader = (req && req.headers && req.headers.range) || null;
  const parsed = rangeHeader == null ? null : parseRange(rangeHeader, size);
  const headers = Object.assign(rangeHeaders(size, rangeHeader), {
    "Content-Type": mime
  });

  if (rangeHeader != null && !parsed) {
    res.writeHead(416, headers);
    res.end();
    return null;
  }

  if (parsed) {
    res.writeHead(206, headers);
    const stream = fs.createReadStream(abs, { start: parsed.start, end: parsed.end });
    stream.pipe(res);
    return stream;
  }

  res.writeHead(200, headers);
  const stream = fs.createReadStream(abs);
  stream.pipe(res);
  return stream;
}

/**
 * Send a JSON error body using err.code when it is a valid HTTP status,
 * otherwise 500.
 */
function sendError(res, err) {
  const code =
    err && Number.isInteger(err.code) && err.code >= 400 && err.code < 600
      ? err.code
      : 500;
  const message = err && err.message ? err.message : "internal error";
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify({ error: message }));
}

module.exports = {
  resolveMedia,
  parseRange,
  rangeHeaders,
  serve,
  sendError
};
