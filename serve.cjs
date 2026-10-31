"use strict";

/**
 * Standalone local review tool HTTP server.
 *
 * Node built-ins only. One closure-held `state` per server instance, so
 * multiple servers (tests) never share project state.
 */

const fs = require("fs");
const http = require("http");
const path = require("path");
const { exec } = require("child_process");

const config = require("./lib/config");
const paths = require("./lib/paths");
const scan = require("./lib/scan");
const keyframes = require("./lib/keyframes");
const tweentable = require("./lib/tweentable");
const store = require("./lib/store");
const media = require("./lib/media");
const dialog = require("./lib/dialog");

const MAX_BODY_BYTES = 40 * 1024 * 1024;
const PUBLIC_DIR = path.join(__dirname, "public");
const START_NOTICE = "请选择一个项目文件夹";
const ERR_STDERR_CHARS = 4000;
const SHOT_PREFIX = "data:image/png;base64,";

/** Chinese message for an unusable /api/project/set path. */
function badFolderError() {
  const err = new Error("文件夹不存在");
  err.code = 400;
  return err;
}

function errorText(err) {
  if (!err) return "internal error";
  if (typeof err.message === "string" && err.message) return err.message;
  return String(err);
}

function emptyLanes() {
  return tweentable.LANES.map((lane) => ({
    key: lane.key,
    label: lane.label,
    color: lane.color,
    count: 0
  }));
}

/** Table shape used when there are no animation nodes (plain/empty project). */
function emptyTable() {
  return {
    ok: false,
    tweens: [],
    scenes: [],
    lanes: emptyLanes(),
    counts: { total: 0, byLane: {}, byMethod: {} }
  };
}

function sameVideo(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.rel === b.rel && Number(a.mtime) === Number(b.mtime);
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

/**
 * Read a POST body as a JSON object.
 * Resolves { ok:true, value } or { ok:false, status, error }.
 * Never rejects.
 */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let received = 0;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on("data", (chunk) => {
      if (settled) return;
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        finish({ ok: false, status: 413, error: "body too large" });
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") {
        finish({ ok: true, value: {} });
        return;
      }
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        finish({ ok: false, status: 400, error: "bad json" });
        return;
      }
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        finish({ ok: false, status: 400, error: "bad json" });
        return;
      }
      finish({ ok: true, value });
    });

    req.on("error", () => finish({ ok: false, status: 400, error: "bad json" }));
    req.on("aborted", () => finish({ ok: false, status: 400, error: "bad json" }));
  });
}

/**
 * Build one server plus its private state.
 * @param {{dataRoot?:string, keyframesCommand?:string|null, pick?:Function|null}} [options]
 */
function createApp(options) {
  const opts = options !== null && typeof options === "object" ? options : {};
  const dataRoot =
    typeof opts.dataRoot === "string" && opts.dataRoot ? opts.dataRoot : config.DATA_ROOT;
  const keyframesCommand =
    typeof opts.keyframesCommand === "string" && opts.keyframesCommand
      ? opts.keyframesCommand
      : null;
  const pickImpl = typeof opts.pick === "function" ? opts.pick : dialog.pickFolder;

  let state = null;
  let pickInFlight = false;

  function loadOptions() {
    return keyframesCommand ? { commandString: keyframesCommand } : {};
  }

  function sceneOf(t) {
    if (!state || !Array.isArray(state.scenes) || state.scenes.length === 0) return "?";
    for (const scene of state.scenes) {
      if (t >= scene.from && t < scene.to) return scene.id;
    }
    return state.scenes[state.scenes.length - 1].id;
  }

  function makeCtx() {
    return {
      duration: state && state.duration > 0 ? state.duration : 86400,
      fps: (state && state.fps) || 30,
      sceneOf
    };
  }

  function versionOf(st) {
    if (st.kfKey) return st.kfKey;
    return st.plainVersion || null;
  }

  function publicState() {
    if (!state) {
      return {
        ok: false,
        error: START_NOTICE,
        projectPath: null,
        chosenPath: null,
        kind: null,
        basis: null,
        notice: START_NOTICE,
        video: null,
        videos: [],
        duration: 0,
        fps: 30,
        scenes: [],
        tweens: [],
        lanes: emptyLanes(),
        counts: null,
        categories: [],
        markers: [],
        dataDir: null,
        hf: null,
        kfError: null,
        version: null
      };
    }
    return {
      ok: true,
      projectPath: state.projectRoot,
      chosenPath: state.chosenPath,
      kind: state.kind,
      basis: state.basis,
      notice: state.notice,
      video: state.video,
      videos: state.videos.slice(0, 50),
      duration: state.duration,
      fps: state.fps,
      scenes: state.scenes || [],
      tweens: state.tweens || [],
      lanes: state.lanes || [],
      counts: state.counts,
      categories: state.db.categories,
      markers: store.withScene(state.db, sceneOf),
      dataDir: state.dirs.dir,
      hf:
        state.kind === "hyperframes"
          ? {
              ok: !state.kfError,
              version: state.kfVersion,
              cmd: state.kfCmd,
              cached: state.kfCached
            }
          : null,
      kfError: state.kfError,
      version: versionOf(state)
    };
  }

  async function writeSettings(chosenPath) {
    const dir = dataRoot;
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, "settings.json");
    await fs.promises.writeFile(
      file,
      JSON.stringify({ lastPath: chosenPath }, null, 2),
      "utf8"
    );
  }

  /**
   * Fully load a project into a NEW state object. The closure state is only
   * swapped once every step has succeeded, so a failed switch keeps the
   * previously loaded project usable.
   */
  async function loadProject(absPath) {
    const chosenPath = path.resolve(String(absPath));

    let st;
    try {
      st = await fs.promises.stat(chosenPath);
    } catch {
      throw badFolderError();
    }
    if (!st.isDirectory()) throw badFolderError();

    const videos = await scan.findVideos(chosenPath);
    const video = videos.length > 0 ? videos[0] : null;

    const proj = await scan.detectProject(chosenPath, video);
    const comp = await scan.parseComposition(proj.root);

    const duration =
      Number.isFinite(comp.duration) && comp.duration > 0 ? comp.duration : 0;
    const fps = Number.isFinite(comp.fps) && comp.fps > 0 ? comp.fps : 30;
    const plainVersion = "plain:" + (comp.mtimeMs == null ? 0 : comp.mtimeMs);

    let table = emptyTable();
    let kfVersion = null;
    let kfCmd = null;
    let kfCached = null;
    let kfKey = null;
    let kfError = null;

    if (proj.kind === "hyperframes") {
      let kf;
      try {
        kf = await keyframes.load(proj.root, loadOptions());
      } catch (err) {
        kf = {
          ok: false,
          cmd: "(keyframes load threw)",
          reason: errorText(err),
          stderr: "",
          stdoutTail: ""
        };
      }

      kfCmd = kf.cmd || null;

      if (kf.ok) {
        table = tweentable.build(kf.data, {
          duration,
          fps,
          labels: comp.labels
        });
        kfVersion = kf.version;
        kfCached = Boolean(kf.cached);
        kfKey = kf.cacheKey;
      } else {
        kfError = {
          cmd: kf.cmd || "",
          reason: kf.reason || "error",
          stderr: String(kf.stderr || "").slice(0, ERR_STDERR_CHARS),
          stdoutTail: String(kf.stdoutTail || "")
        };
        console.log("[kf] keyframes failed: " + kfError.reason);
      }
    }

    const dirs = paths.dataDirs(dataRoot, proj.root);
    store.ensure(dirs.markers);
    const db = store.read(dirs.markers);

    let notice = "";
    if (!video) {
      notice = "未找到视频文件（只看到时间轴，没有画面）";
    } else if (proj.kind !== "hyperframes") {
      notice = "非 HyperFrames 项目：只播放视频，没有动画节点";
    } else if (kfError) {
      notice = "动画节点读取失败：" + kfError.reason + "（命令：" + kfError.cmd + "）";
    }

    const next = {
      chosenPath,
      projectRoot: proj.root,
      kind: proj.kind,
      basis: proj.basis,
      notice,
      videos,
      video,
      duration,
      fps,
      labels: comp.labels || {},
      scenes: table.scenes || [],
      tweens: table.tweens || [],
      lanes: table.lanes || emptyLanes(),
      counts: table.counts || { total: 0, byLane: {}, byMethod: {} },
      kfVersion,
      kfCmd,
      kfCached,
      kfKey,
      kfError,
      plainVersion,
      dirs,
      db
    };

    // Atomic swap: everything above succeeded.
    state = next;

    try {
      await writeSettings(chosenPath);
    } catch (err) {
      console.log("[state] settings write failed: " + errorText(err));
    }

    console.log(
      "[project] loaded kind=" +
        next.kind +
        " tweens=" +
        next.tweens.length +
        " videos=" +
        next.videos.length
    );

    return next;
  }

  async function meta() {
    if (!state) return { ok: false, error: START_NOTICE };

    let version;
    if (state.kind === "hyperframes") {
      version = await keyframes.cacheKey(state.projectRoot, state.kfVersion);
    } else {
      const comp = await scan.parseComposition(state.projectRoot);
      version = "plain:" + (comp.mtimeMs == null ? 0 : comp.mtimeMs);
    }

    // Cheap stat walk; never runs the CLI and never writes markers.
    const fresh = await scan.findVideos(state.chosenPath);
    const currentNewest = fresh.length > 0 ? fresh[0] : null;

    return {
      ok: true,
      version,
      kfStale: version !== state.kfKey,
      video: currentNewest || state.video,
      videoStale: !sameVideo(currentNewest, state.video),
      duration: state.duration,
      fps: state.fps,
      kind: state.kind,
      notice: state.notice
    };
  }

  async function keyframesRoute(force) {
    if (!state) return { ok: false, error: START_NOTICE };
    if (state.kind !== "hyperframes") {
      return { ok: false, error: "非 HyperFrames 项目" };
    }

    const current = await keyframes.cacheKey(state.projectRoot, state.kfVersion);
    if (!force && current === state.kfKey) {
      return {
        ok: true,
        tweens: state.tweens,
        scenes: state.scenes,
        lanes: state.lanes,
        counts: state.counts,
        version: state.kfKey,
        cached: true
      };
    }

    const kf = await keyframes.load(
      state.projectRoot,
      Object.assign(loadOptions(), { force: true })
    );

    if (!kf.ok) {
      state.kfCmd = kf.cmd || state.kfCmd;
      state.kfError = {
        cmd: kf.cmd || "",
        reason: kf.reason || "error",
        stderr: String(kf.stderr || "").slice(0, ERR_STDERR_CHARS),
        stdoutTail: String(kf.stdoutTail || "")
      };
      console.log("[kf] reload failed: " + state.kfError.reason);
      return {
        ok: false,
        cmd: kf.cmd,
        reason: kf.reason,
        stderr: state.kfError.stderr,
        stdoutTail: state.kfError.stdoutTail
      };
    }

    const table = tweentable.build(kf.data, {
      duration: state.duration,
      fps: state.fps,
      labels: state.labels
    });

    state.tweens = table.tweens;
    state.scenes = table.scenes;
    state.lanes = table.lanes;
    state.counts = table.counts;
    state.kfKey = kf.cacheKey;
    state.kfVersion = kf.version;
    state.kfCmd = kf.cmd || null;
    state.kfCached = Boolean(kf.cached);
    state.kfError = null;
    console.log("[kf] reloaded tweens=" + state.tweens.length);

    return {
      ok: true,
      tweens: state.tweens,
      scenes: state.scenes,
      lanes: state.lanes,
      counts: state.counts,
      version: state.kfKey,
      cached: Boolean(kf.cached)
    };
  }

  async function pickProject(res) {
    if (pickInFlight) {
      sendJson(res, 429, { ok: false, error: "选择窗口已经打开了" });
      return;
    }

    pickInFlight = true;
    try {
      let r;
      try {
        r = await pickImpl({ description: "选择 HyperFrames 项目文件夹" });
      } catch (err) {
        sendJson(res, 200, { ok: false, reason: "error", error: errorText(err) });
        return;
      }

      if (!r || !r.ok) {
        if (r && r.reason === "cancel") {
          sendJson(res, 200, { ok: false, reason: "cancel" });
          return;
        }
        sendJson(res, 200, {
          ok: false,
          reason: (r && r.reason) || "error",
          error: (r && r.error) || "选择失败"
        });
        return;
      }

      try {
        await loadProject(r.path);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: errorText(err) });
        return;
      }

      sendJson(res, 200, { ok: true, path: r.path, state: publicState() });
    } finally {
      pickInFlight = false;
    }
  }

  async function serveEditor(res) {
    let html;
    try {
      html = await fs.promises.readFile(path.join(PUBLIC_DIR, "editor.html"));
    } catch {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": html.length,
      "Cache-Control": "no-store"
    });
    res.end(html);
  }

  function serveMedia(req, res, rel) {
    if (!state) {
      sendJson(res, 400, { ok: false, error: START_NOTICE });
      return;
    }
    let found;
    try {
      found = media.resolveMedia(state.chosenPath, rel);
    } catch (err) {
      media.sendError(res, err);
      return;
    }
    media.serve(req, res, found.abs, found.mime, found.size);
  }

  async function handle(req, res) {
    const rawUrl = typeof req.url === "string" && req.url ? req.url : "/";
    const qIndex = rawUrl.indexOf("?");
    const rawPath = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);

    let pathname;
    try {
      pathname = decodeURIComponent(rawPath);
    } catch {
      pathname = rawPath; // malformed %-encoding must not crash
    }

    const method = String(req.method || "GET").toUpperCase();

    if (method === "GET") {
      if (pathname === "/" || pathname === "/index.html") {
        await serveEditor(res);
        return;
      }

      // Media keeps the RAW (still percent-encoded) relative path so that
      // lib/media.js is the single decoder and containment gate.
      if (rawPath.startsWith("/media/")) {
        serveMedia(req, res, rawPath.slice("/media/".length));
        return;
      }

      if (pathname === "/api/state") {
        sendJson(res, 200, publicState());
        return;
      }

      if (pathname === "/api/meta") {
        sendJson(res, 200, await meta());
        return;
      }

      if (pathname === "/api/keyframes") {
        const force = /[?&]force=1(?:&|$)/.test(rawUrl);
        sendJson(res, 200, await keyframesRoute(force));
        return;
      }

      if (pathname === "/api/videos") {
        sendJson(res, 200, { ok: true, videos: state ? state.videos : [] });
        return;
      }
    }

    if (method === "POST") {
      if (pathname === "/api/project/pick") {
        await pickProject(res);
        return;
      }

      const body = await readBody(req);
      if (!body.ok) {
        sendJson(res, body.status, { ok: false, error: body.error });
        return;
      }
      const input = body.value;

      if (pathname === "/api/project/set") {
        if (typeof input.path !== "string" || input.path.trim() === "") {
          sendJson(res, 400, { ok: false, error: "path required" });
          return;
        }
        try {
          await loadProject(input.path);
        } catch (err) {
          sendJson(res, 400, { ok: false, error: errorText(err) });
          return;
        }
        sendJson(res, 200, { ok: true, state: publicState() });
        return;
      }

      if (pathname === "/api/reload") {
        if (!state) {
          sendJson(res, 400, { ok: false, error: START_NOTICE });
          return;
        }
        try {
          await loadProject(state.chosenPath);
        } catch (err) {
          sendJson(res, 400, { ok: false, error: errorText(err) });
          return;
        }
        sendJson(res, 200, { ok: true, state: publicState() });
        return;
      }

      if (pathname === "/api/shot") {
        await handleShot(res, input);
        return;
      }

      if (pathname.startsWith("/api/mark") || pathname === "/api/cat" || pathname === "/api/cat/delete") {
        await handleMarkerRoutes(res, pathname, input);
        return;
      }
    }

    sendJson(res, 404, { error: "not found" });
  }

  async function handleShot(res, input) {
    if (!state) {
      sendJson(res, 400, { ok: false, error: START_NOTICE });
      return;
    }
    const dataUrl = input.dataUrl;
    if (typeof dataUrl !== "string" || !dataUrl.startsWith(SHOT_PREFIX)) {
      sendJson(res, 400, { ok: false, error: "empty image" });
      return;
    }
    const buf = Buffer.from(dataUrl.slice(SHOT_PREFIX.length), "base64");
    if (buf.length === 0) {
      sendJson(res, 400, { ok: false, error: "empty image" });
      return;
    }

    const stamp = String(input.t == null ? 0 : input.t)
      .replace(/[^0-9A-Za-z._-]+/g, "_")
      .slice(0, 32) || "0";
    const abs = path.join(state.dirs.shots, "shot-" + stamp + "-" + Date.now() + ".png");
    try {
      await fs.promises.mkdir(state.dirs.shots, { recursive: true });
      await fs.promises.writeFile(abs, buf);
    } catch (err) {
      const wrapped = new Error("截图保存失败：" + errorText(err));
      wrapped.code = 500;
      throw wrapped;
    }
    sendJson(res, 200, { ok: true, path: abs });
  }

  async function handleMarkerRoutes(res, pathname, input) {
    if (!state) {
      sendJson(res, 400, { ok: false, error: START_NOTICE });
      return;
    }

    if (pathname === "/api/mark") {
      const rec = store.addMarker(state.db, input, makeCtx());
      store.write(state.dirs.markers, state.db);
      sendJson(res, 200, {
        ok: true,
        marker: Object.assign({}, rec, { scene: sceneOf(rec.from) }),
        count: state.db.markers.length
      });
      return;
    }

    if (pathname === "/api/mark/update") {
      const rec = store.updateMarker(state.db, input, makeCtx());
      if (!rec) {
        sendJson(res, 404, { ok: false, error: "no marker" });
        return;
      }
      store.write(state.dirs.markers, state.db);
      sendJson(res, 200, {
        ok: true,
        marker: Object.assign({}, rec, { scene: sceneOf(rec.from) }),
        count: state.db.markers.length
      });
      return;
    }

    if (pathname === "/api/mark/delete") {
      const removed = store.deleteMarker(state.db, input.id);
      store.write(state.dirs.markers, state.db);
      sendJson(res, 200, { ok: true, removed, count: state.db.markers.length });
      return;
    }

    if (pathname === "/api/mark/merge") {
      const merged = store.mergeMarkers(state.db, input.ids, makeCtx());
      if (!merged.ok) {
        sendJson(res, 400, { ok: false, error: merged.error });
        return;
      }
      store.write(state.dirs.markers, state.db);
      sendJson(res, 200, {
        ok: true,
        marker: Object.assign({}, merged.marker, { scene: sceneOf(merged.marker.from) }),
        markers: store.withScene(state.db, sceneOf),
        count: state.db.markers.length
      });
      return;
    }

    if (pathname === "/api/mark/clear") {
      store.clearMarkers(state.db);
      store.write(state.dirs.markers, state.db);
      sendJson(res, 200, { ok: true, count: 0 });
      return;
    }

    if (pathname === "/api/cat") {
      const added = store.addCategory(state.db, input);
      if (!added.ok) {
        sendJson(res, 400, { ok: false, error: added.error });
        return;
      }
      store.write(state.dirs.markers, state.db);
      sendJson(res, 200, {
        ok: true,
        category: added.category,
        categories: state.db.categories
      });
      return;
    }

    if (pathname === "/api/cat/delete") {
      const deleted = store.deleteCategory(state.db, input.id);
      if (!deleted.ok) {
        sendJson(res, 400, { ok: false, error: deleted.error });
        return;
      }
      store.write(state.dirs.markers, state.db);
      sendJson(res, 200, {
        ok: true,
        categories: state.db.categories,
        markers: store.withScene(state.db, sceneOf)
      });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) {
        media.sendError(res, err);
        return;
      }
      try {
        res.end();
      } catch {
        /* response already gone */
      }
    });
  });

  return { server, loadProject, getState: () => state, dataRoot };
}

/**
 * Create an unbound http.Server with isolated state.
 * Never opens a browser and never reads settings.
 */
function createServer(options) {
  return createApp(options).server;
}

async function boot(app) {
  const file = path.join(app.dataRoot, "settings.json");
  let parsed;
  try {
    parsed = JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch {
    return; // no settings dir/file, or invalid JSON
  }
  if (!parsed || typeof parsed.lastPath !== "string" || parsed.lastPath === "") return;
  try {
    await app.loadProject(parsed.lastPath);
  } catch (err) {
    console.log("[project] boot load skipped: " + errorText(err));
  }
}

function openBrowser(url) {
  try {
    exec('start "" "' + url + '"', () => {
      /* the browser opener is best effort */
    });
  } catch {
    /* ignore */
  }
}

/**
 * Boot the standalone tool: load last project, bind 127.0.0.1, print info,
 * optionally open the browser on win32.
 */
async function start() {
  const app = createApp();
  const server = app.server;
  const port = config.PORT;
  const url = "http://127.0.0.1:" + port + "/";

  // Bind before loading keyframes: a second instance must report EADDRINUSE
  // immediately instead of running the project's CLI first.
  await new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };

    server.on("error", (err) => {
      if (err && err.code === "EADDRINUSE") {
        console.log("[boot] 改片台已在运行: " + url);
        setTimeout(() => process.exit(0), 1500);
        return; // keep the process alive for the 1.5s grace window
      }
      console.log("[boot] listen failed: " + errorText(err));
      process.exitCode = 1;
      finish();
    });

    server.listen(port, config.HOST, async () => {
      try {
        await boot(app);
      } catch (err) {
        console.log("[boot] settings load failed: " + errorText(err));
      }
      const st = app.getState();
      console.log("改片台: " + url);
      console.log("[project] " + (st ? st.projectRoot : "(none)"));
      console.log("[video] " + (st && st.video ? st.video.rel : "(none)"));
      console.log("[kf] nodes=" + (st ? st.tweens.length : 0));
      if (process.platform === "win32" && !process.env.NO_OPEN) openBrowser(url);
      finish();
    });
  });

  return server;
}

if (require.main === module) {
  start().catch((err) => {
    console.log("[boot] failed: " + errorText(err));
    process.exitCode = 1;
  });
}

module.exports = { createServer, start };
