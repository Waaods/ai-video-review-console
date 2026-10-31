"use strict";

/** Ordered timeline lanes. `misc` collects null/unknown groups. */
const LANES = [
  { key: "visual", label: "视觉", color: "#D9553F" },
  { key: "scale", label: "缩放", color: "#3FAE6A" },
  { key: "position", label: "位移", color: "#5B7DB1" },
  { key: "size", label: "尺寸", color: "#9B6BD6" },
  { key: "rotation", label: "旋转", color: "#F2A03D" },
  { key: "other", label: "其他", color: "#8A8F98" },
  { key: "misc", label: "未分类", color: "#2B3A55" }
];

const KNOWN_LANES = new Set(["visual", "scale", "position", "rotation", "size", "other"]);
const MISC_LANE = "misc";

function asString(value) {
  return value === null || value === undefined ? "" : String(value);
}

/** JS numeric coercion: null -> 0, while undefined/NaN/Infinity are invalid. */
function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `#stageBase` and `#s12` are scene anchor targets; everything else is null. */
function sceneIdForTarget(target) {
  if (target === "#stageBase") return "s1";
  if (typeof target !== "string") return null;
  const match = /^#s(\d+)$/.exec(target);
  if (!match) return null;
  return `s${Number(match[1])}`;
}

function sceneNumber(id) {
  const match = /^s(\d+)$/.exec(id);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function emptyResult() {
  return {
    ok: false,
    tweens: [],
    scenes: [],
    lanes: LANES,
    counts: { total: 0, byLane: {}, byMethod: {} }
  };
}

/**
 * Flatten keyframes CLI output into a flat, sorted tween table with a scene
 * rail. `fps` does not affect clamping: `end` is clamped to `duration` exactly.
 */
function build(kfJson, options = {}) {
  const opts = options !== null && typeof options === "object" ? options : {};
  const labels = opts.labels !== null && typeof opts.labels === "object" ? opts.labels : {};
  const rawDuration = Number(opts.duration);
  const duration = Number.isFinite(rawDuration) ? Math.max(0, rawDuration) : 0;

  if (kfJson === null || typeof kfJson !== "object" || Array.isArray(kfJson)) {
    return emptyResult();
  }
  if (!Array.isArray(kfJson.compositions)) return emptyResult();

  const firstComposition = kfJson.compositions.find(
    (comp) => comp !== null && typeof comp === "object" && !Array.isArray(comp)
  );
  const composition =
    firstComposition && typeof firstComposition.composition === "string" && firstComposition.composition
      ? firstComposition.composition
      : "index.html";

  const tweens = [];

  for (const comp of kfJson.compositions) {
    if (comp === null || typeof comp !== "object" || !Array.isArray(comp.tweens)) continue;
    const file =
      typeof comp.composition === "string" && comp.composition ? comp.composition : "index.html";

    for (const raw of comp.tweens) {
      if (raw === null || typeof raw !== "object") continue;

      const startNumber = finiteNumber(raw.start);
      const durationNumber = finiteNumber(raw.duration);
      const endNumber = finiteNumber(raw.end);
      if (startNumber === null || durationNumber === null || endNumber === null) continue;

      const start = Math.max(0, startNumber);
      let end = endNumber;
      if (duration > 0 && end > duration) end = duration;
      if (end < start) end = start;

      const group = typeof raw.group === "string" ? raw.group : null;
      const lane = group !== null && KNOWN_LANES.has(group) ? group : MISC_LANE;

      tweens.push({
        id: asString(raw.id),
        target: asString(raw.target),
        method: asString(raw.method),
        group,
        lane,
        start,
        duration: durationNumber,
        end,
        ease: asString(raw.ease),
        file,
        scene: null
      });
    }
  }

  tweens.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.target !== b.target) return a.target < b.target ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  });

  // Scene rail: first in-time of every scene anchor target.
  const inTime = new Map();
  for (const tween of tweens) {
    const sceneId = sceneIdForTarget(tween.target);
    if (sceneId === null) continue;
    const previous = inTime.get(sceneId);
    if (previous === undefined || tween.start < previous) inTime.set(sceneId, tween.start);
  }

  const scenes = [];
  if (inTime.size === 0) {
    scenes.push({ id: "ALL", label: "全片", from: 0, to: duration });
  } else {
    const ids = Array.from(inTime.keys()).sort((a, b) => sceneNumber(a) - sceneNumber(b));
    // The rail always opens with s1, even when only later scenes are anchored.
    if (ids[0] !== "s1") ids.unshift("s1");

    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      const from = i === 0 ? 0 : inTime.get(id);
      const nextId = ids[i + 1];
      const nextStart = nextId === undefined ? undefined : inTime.get(nextId);
      const to = nextStart || duration;
      const label = id === "s1" ? labels.s1 || "S1" : labels[id] || id;
      scenes.push({ id, label, from, to });
    }
  }

  const sceneAt = (time) => {
    for (const scene of scenes) {
      if (time >= scene.from && time < scene.to) return scene.id;
    }
    return scenes.length > 0 ? scenes[scenes.length - 1].id : null;
  };

  const byLane = {};
  for (const lane of LANES) byLane[lane.key] = 0;
  const byMethod = {};

  for (const tween of tweens) {
    tween.scene = sceneAt(tween.start);
    byLane[tween.lane] = (byLane[tween.lane] || 0) + 1;
    byMethod[tween.method] = (byMethod[tween.method] || 0) + 1;
  }

  return {
    ok: true,
    composition,
    tweens,
    scenes,
    lanes: LANES.map((lane) => ({
      key: lane.key,
      label: lane.label,
      color: lane.color,
      count: byLane[lane.key] || 0
    })),
    counts: { total: tweens.length, byLane, byMethod }
  };
}

module.exports = { LANES, build };
