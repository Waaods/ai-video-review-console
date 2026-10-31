"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const config = require("./config");

const fsp = fs.promises;

/** How deep `compositions/**` is walked (file depth below `compositions/`). */
const MAX_COMPOSITION_DEPTH = 4;
/** Upper bound on composition HTML files folded into the cache key. */
const MAX_COMPOSITION_FILES = 200;
/** How many trailing stdout characters are handed back on failure. */
const TAIL_CHARS = 2000;

/** In-memory cache keyed by lowercased project root. */
const cache = new Map();

/** Coerce any thrown value to a string. */
function errText(err) {
  if (!err) return "";
  if (typeof err === "string") return err;
  if (typeof err.message === "string") return err.message;
  return String(err);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse a package.json text and return the first `hyperframes@x.y.z` pin
 * found in any script value, or null.
 */
function readPin(pkgJsonText) {
  let pkg;
  try {
    pkg = JSON.parse(String(pkgJsonText));
  } catch {
    return null;
  }
  if (!isPlainObject(pkg)) return null;
  const scripts = pkg.scripts;
  if (!isPlainObject(scripts)) return null;
  const joined = Object.keys(scripts)
    .map((key) => scripts[key])
    .filter((value) => typeof value === "string")
    .join("\n");
  const match = /hyperframes@(\d+\.\d+\.\d+)/.exec(joined);
  return match ? match[1] : null;
}

/**
 * Version precedence: HF_VERSION env var (when non-empty) -> package.json
 * pin -> config.DEFAULT_HF_VERSION.
 */
async function resolveVersion(root) {
  const env = process.env.HF_VERSION;
  if (typeof env === "string" && env.trim() !== "") return env.trim();
  try {
    const text = await fsp.readFile(path.join(String(root), "package.json"), "utf8");
    const pin = readPin(text);
    if (pin) return pin;
  } catch {
    /* missing or unreadable package.json: fall through */
  }
  return config.DEFAULT_HF_VERSION;
}

async function walkCompositions(dir, level, relPrefix, out) {
  if (out.length >= MAX_COMPOSITION_FILES) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (out.length >= MAX_COMPOSITION_FILES) return;
    const abs = path.join(dir, entry.name);
    const rel = `${relPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (level + 1 < MAX_COMPOSITION_DEPTH) {
        await walkCompositions(abs, level + 1, rel, out);
      }
    } else if (entry.isFile() && /\.html$/i.test(entry.name)) {
      try {
        const st = await fsp.stat(abs);
        if (!st.isFile()) continue;
        out.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
}

/**
 * Files that make up the cache key: package.json, index.html and every
 * compositions/**\/*.html (depth <= 4, at most 200 composition files).
 * Missing entries are skipped. `rel` is posix-style.
 */
async function collectSources(root) {
  const rootDir = String(root);
  const out = [];

  const pushRootFile = async (name) => {
    const abs = path.join(rootDir, name);
    try {
      const st = await fsp.stat(abs);
      if (!st.isFile()) return;
      out.push({ rel: name, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* missing */
    }
  };

  await pushRootFile("package.json");
  await pushRootFile("index.html");

  const compFiles = [];
  await walkCompositions(path.join(rootDir, "compositions"), 0, "compositions", compFiles);
  for (const file of compFiles) out.push(file);

  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/**
 * 16-hex sha1 over sorted `rel:size:mtimeMs` lines plus the CLI version.
 */
async function cacheKey(root, version) {
  const sources = await collectSources(root);
  const lines = sources.map((s) => `${s.rel}:${s.size}:${s.mtimeMs}`).sort();
  const payload = `${lines.join("\n")}|v:${String(version)}`;
  return crypto.createHash("sha1").update(payload, "utf8").digest("hex").slice(0, 16);
}

function tryParseObject(text) {
  try {
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Lenient JSON parse: raw JSON, JSON surrounded by CLI log lines, or garbage.
 * Returns a plain object or null.
 */
function parseJsonLoose(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const direct = tryParseObject(trimmed);
  if (direct) return direct;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return tryParseObject(trimmed.slice(start, end + 1));
}

/**
 * Run a command string through cmd.exe (PowerShell blocks npx.ps1).
 * Never rejects. Resolves { ok, stdout, stderr, code, reason? }.
 */
function runCommand(commandString, options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : config.KF_TIMEOUT_MS;
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : config.KF_MAX_BYTES;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", String(commandString)], {
        cwd: opts.cwd,
        windowsHide: true,
        // Verbatim: libuv's CRT-style quote escaping is wrong for cmd.exe and
        // turns `node "C:\a b\x.js"` into a literal-backslash-quoted path.
        windowsVerbatimArguments: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (err) {
      resolve({ ok: false, stdout: "", stderr: errText(err), code: null, reason: "spawn-error" });
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let total = 0;
    let settled = false;
    let timer = null;

    const textOf = (chunks) => Buffer.concat(chunks).toString("utf8");

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(payload);
    };

    const killTree = () => {
      const pid = child && child.pid;
      if (!pid) return;
      try {
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore"
          });
          killer.on("error", () => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* already gone */
            }
          });
          if (typeof killer.unref === "function") killer.unref();
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };

    timer = setTimeout(() => {
      killTree();
      finish({
        ok: false,
        stdout: textOf(outChunks),
        stderr: textOf(errChunks),
        code: null,
        reason: "timeout"
      });
    }, timeoutMs);

    const collect = (chunks) => (buf) => {
      if (settled) return;
      total += buf.length;
      if (total > maxBytes) {
        killTree();
        finish({
          ok: false,
          stdout: textOf(outChunks),
          stderr: textOf(errChunks),
          code: null,
          reason: "max-bytes"
        });
        return;
      }
      chunks.push(buf);
    };

    child.stdout.on("data", collect(outChunks));
    child.stderr.on("data", collect(errChunks));
    child.on("error", (err) => {
      finish({
        ok: false,
        stdout: textOf(outChunks),
        stderr: errText(err),
        code: null,
        reason: "spawn-error"
      });
    });
    child.on("close", (code) => {
      finish({
        ok: code === 0,
        stdout: textOf(outChunks),
        stderr: textOf(errChunks),
        code
      });
    });
  });
}

/** Exact CLI invocation used to dump the keyframes JSON. */
function buildCommand(version) {
  return `npx --yes hyperframes@${version} keyframes --json`;
}

/**
 * Load keyframes JSON for a HyperFrames project.
 * Cached in memory per project root; `force` bypasses the cache.
 */
async function load(root, options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const rootDir = String(root);
  const version = opts.version ? String(opts.version) : await resolveVersion(rootDir);
  const force = Boolean(opts.force);
  const cmd = opts.commandString ? String(opts.commandString) : buildCommand(version);

  const key = await cacheKey(rootDir, version);
  const mapKey = rootDir.toLowerCase();

  const hit = cache.get(mapKey);
  if (hit && hit.cacheKey === key && !force) {
    return {
      ok: true,
      data: hit.data,
      cacheKey: key,
      version: hit.version,
      cmd: hit.cmd,
      cached: true
    };
  }

  const res = await runCommand(cmd, { cwd: rootDir, timeoutMs: opts.timeoutMs });
  const stdoutTail = String(res.stdout || "").slice(-TAIL_CHARS);
  const stderr = String(res.stderr || "");

  if (!res.ok) {
    const reason =
      res.reason || (res.code === null || res.code === undefined ? "spawn-error" : `exit-${res.code}`);
    return { ok: false, cmd, reason, stderr, stdoutTail };
  }

  const data = parseJsonLoose(res.stdout);
  if (!data) {
    return { ok: false, cmd, reason: "bad-json", stderr, stdoutTail };
  }

  cache.set(mapKey, { cacheKey: key, version, data, cmd });
  return { ok: true, data, cacheKey: key, version, cmd, cached: false };
}

/** Drop the cached entry for one project root, or the whole cache. */
function clearCache(root) {
  if (root === undefined || root === null) {
    cache.clear();
    return;
  }
  cache.delete(String(root).toLowerCase());
}

module.exports = {
  readPin,
  resolveVersion,
  collectSources,
  cacheKey,
  parseJsonLoose,
  runCommand,
  buildCommand,
  load,
  clearCache
};
