"use strict";

const path = require("path");
const crypto = require("crypto");
const config = require("./config");

/**
 * Readable ASCII folder slug derived from the path's basename.
 * Lowercase; runs of chars outside [a-z0-9._-] become "-"; collapses
 * repeated "-"; trims leading/trailing "-_."; empty/"." -> "project";
 * capped at 40 chars.
 */
function slugify(absPath) {
  const base = path.basename(String(absPath));
  let slug = base.toLowerCase();
  slug = slug.replace(/[^a-z0-9._-]+/g, "-");
  slug = slug.replace(/-+/g, "-");
  slug = slug.replace(/^[-_.]+|[-_.]+$/g, "");
  if (!slug || slug === ".") slug = "project";
  if (slug.length > 40) slug = slug.slice(0, 40);
  return slug;
}

/**
 * 10-char lowercase hex sha1 of the normalized, lowercased absolute path.
 * Backslashes are converted to forward slashes so "C:\a\b" and "C:/a/b"
 * hash identically. Lowercased for Windows case-insensitive filesystems.
 */
function stableHash(absPath) {
  const normalized = path
    .resolve(String(absPath))
    .replace(/\\/g, "/")
    .toLowerCase();
  return crypto.createHash("sha1").update(normalized, "utf8").digest("hex").slice(0, 10);
}

/** `${slugify(absPath)}-${stableHash(absPath)}` */
function projectDirName(absPath) {
  return `${slugify(absPath)}-${stableHash(absPath)}`;
}

/**
 * Compute data locations for a project. Pure — creates nothing on disk.
 * Returns { dir, markers, shots }.
 */
function dataDirs(dataRoot, absProjectPath) {
  const dir = path.join(dataRoot, "projects", projectDirName(absProjectPath));
  return {
    dir,
    markers: path.join(dir, "markers.json"),
    shots: path.join(dir, "shots")
  };
}

/**
 * True when target equals root or lies strictly inside root.
 * Resolves both paths; case-insensitive on win32. Rejects ".." escapes
 * and sibling-prefix tricks (e.g. root "C:\proj" vs target "C:\proj2").
 */
function isContained(root, target) {
  const r = path.resolve(String(root));
  const t = path.resolve(String(target));
  if (r === t) return true;
  const ci = process.platform === "win32";
  const rl = ci ? r.toLowerCase() : r;
  const tl = ci ? t.toLowerCase() : t;
  const sep = path.sep;
  return tl.startsWith(rl + sep);
}

/** True when name has a video extension known to config.VIDEO_EXT. */
function assertVideoExt(name) {
  if (typeof name !== "string") return false;
  return config.VIDEO_EXT.has(path.extname(name).toLowerCase());
}

/**
 * Path of abs relative to root with forward slashes, or null when abs
 * is not contained in root (root itself yields "").
 */
function toPosixRel(root, abs) {
  if (!isContained(root, abs)) return null;
  const r = path.resolve(String(root));
  const a = path.resolve(String(abs));
  if (r === a) return "";
  return path.relative(r, a).replace(/\\/g, "/");
}

module.exports = {
  slugify,
  stableHash,
  projectDirName,
  dataDirs,
  isContained,
  assertVideoExt,
  toPosixRel
};
