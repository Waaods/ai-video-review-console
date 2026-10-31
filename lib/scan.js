"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");
const paths = require("./paths");

/**
 * Breadth-first recursive walk from root, collecting video files.
 * Skips SKIP_DIRS (case-insensitive) and dot-directories (root itself
 * is always scanned). Stops at MAX_SCAN_DEPTH / MAX_SCAN_ENTRIES.
 * Per-entry errors are ignored. Returns newest-first by mtime.
 */
async function findVideos(root) {
  const out = [];
  const rootStat = await statSafe(root);
  if (!rootStat || !rootStat.isDirectory()) return out;

  const skipLower = new Set();
  for (const name of config.SKIP_DIRS) skipLower.add(String(name).toLowerCase());

  let entries = 0;
  const queue = [{ dir: path.resolve(root), depth: 0 }];

  while (queue.length > 0 && entries < config.MAX_SCAN_ENTRIES) {
    const { dir, depth } = queue.shift();
    let dirents;
    try {
      dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // EACCES / EPERM / ENOENT / not a dir — skip silently
    }
    for (const ent of dirents) {
      if (entries >= config.MAX_SCAN_ENTRIES) break;
      entries += 1;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        const base = ent.name;
        if (base.startsWith(".")) continue;
        if (skipLower.has(base.toLowerCase())) continue;
        if (depth + 1 > config.MAX_SCAN_DEPTH) continue;
        queue.push({ dir: abs, depth: depth + 1 });
      } else if (ent.isFile()) {
        if (!paths.assertVideoExt(ent.name)) continue;
        const st = await statSafe(abs);
        if (!st || !st.isFile()) continue;
        const rel = paths.toPosixRel(root, abs);
        if (rel === null || rel === "") continue;
        out.push({ rel, abs, size: st.size, mtime: st.mtimeMs });
      }
    }
  }

  out.sort((a, b) => (b.mtime - a.mtime) || a.rel.localeCompare(b.rel));
  if (out.length > config.MAX_VIDEOS) out.length = config.MAX_VIDEOS;
  return out;
}

async function statSafe(p) {
  try {
    return await fs.promises.stat(p);
  } catch {
    return null;
  }
}

/** Newest video under root, or null. */
async function findNewestVideo(root) {
  const vids = await findVideos(root);
  return vids.length > 0 ? vids[0] : null;
}

/** Read index.html under root as UTF-8, or null when missing/unreadable. */
async function readIndexHtml(root) {
  const file = path.join(path.resolve(root), "index.html");
  let st;
  try {
    st = await fs.promises.stat(file);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  let src;
  try {
    src = await fs.promises.readFile(file, "utf8");
  } catch {
    return null;
  }
  return { src, path: file, mtimeMs: st.mtimeMs };
}

/**
 * HyperFrames project detection: hyperframes.json present, or index.html
 * containing data-composition-id.
 */
async function isHyperframesProject(dir) {
  const hf = path.join(path.resolve(dir), "hyperframes.json");
  try {
    const st = await fs.promises.stat(hf);
    if (st.isFile()) return { ok: true, basis: "hyperframes.json" };
  } catch {
    // fall through to index.html check
  }
  const idx = await readIndexHtml(dir);
  if (idx && idx.src.includes("data-composition-id")) {
    return { ok: true, basis: "index.html" };
  }
  return { ok: false, basis: null };
}

/**
 * Walk upward from startDir (max 8 levels) looking for a HyperFrames
 * project root. Returns { root, kind, basis }.
 */
async function inferProjectRoot(startDir) {
  let cur = path.resolve(String(startDir));
  for (let i = 0; i < 8; i += 1) {
    const det = await isHyperframesProject(cur);
    if (det.ok) {
      return { root: cur, kind: "hyperframes", basis: det.basis };
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { root: null, kind: "plain", basis: null };
}

/**
 * Decide which project root governs the session.
 * Priority: chosenPath is itself an HF project > newest video's dir
 * infers an HF root > plain chosenPath.
 */
async function detectProject(chosenPath, newestVideo) {
  const chosen = path.resolve(String(chosenPath));
  const self = await isHyperframesProject(chosen);
  if (self.ok) {
    return { root: chosen, kind: "hyperframes", basis: self.basis, chosenPath: chosen };
  }
  if (newestVideo && newestVideo.abs) {
    const inferred = await inferProjectRoot(path.dirname(newestVideo.abs));
    if (inferred.root) {
      return {
        root: inferred.root,
        kind: inferred.kind,
        basis: inferred.basis,
        chosenPath: chosen
      };
    }
  }
  return { root: chosen, kind: "plain", basis: null, chosenPath: chosen };
}

/** Decode the basic HTML entities we care about in labels. */
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Extract attr="value" pairs from a tag's inner text. Attribute-order safe. */
function extractAttrs(tagInner) {
  const attrs = {};
  const re = /([a-zA-Z_:@][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tagInner)) !== null) {
    attrs[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[4];
  }
  return attrs;
}

/**
 * Parse composition metadata from root/index.html:
 * duration, fps (first data-duration / data-fps), and scene labels
 * (id="sN" or data-scene="sN" with data-label).
 */
async function parseComposition(root) {
  const idx = await readIndexHtml(root);
  const source = path.join(path.resolve(root), "index.html");
  if (!idx) {
    return { duration: null, fps: null, labels: {}, source, mtimeMs: null };
  }

  let duration = null;
  let fps = null;
  const labels = {};

  const tagRe = /<[a-zA-Z][^>]*>/g;
  let m;
  while ((m = tagRe.exec(idx.src)) !== null) {
    const tag = m[0];
    const attrs = extractAttrs(tag.slice(1, -1));

    if (duration === null && attrs["data-duration"] !== undefined) {
      const n = Number(attrs["data-duration"]);
      if (Number.isFinite(n)) duration = n;
    }
    if (fps === null && attrs["data-fps"] !== undefined) {
      const n = Number(attrs["data-fps"]);
      if (Number.isFinite(n)) fps = n;
    }

    const sceneId = attrs.id && /^s\d{1,2}$/.test(attrs.id)
      ? attrs.id
      : (attrs["data-scene"] && /^s\d{1,2}$/.test(attrs["data-scene"])
        ? attrs["data-scene"]
        : null);
    if (sceneId && attrs["data-label"] !== undefined && !(sceneId in labels)) {
      labels[sceneId] = decodeEntities(attrs["data-label"]);
    }
  }

  return { duration, fps, labels, source, mtimeMs: idx.mtimeMs };
}

module.exports = {
  findVideos,
  findNewestVideo,
  readIndexHtml,
  isHyperframesProject,
  inferProjectRoot,
  detectProject,
  parseComposition
};
