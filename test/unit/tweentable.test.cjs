"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const tt = require("../../lib/tweentable");

/** 8 tweens: every known lane, one null group, one unknown group, one zero-duration set. */
function laneFixture() {
  return {
    project: "fixture",
    compositions: [
      {
        composition: "index.html",
        tweens: [
          { id: "#fade", target: "#hero", method: "to", group: "visual", start: 0, duration: 1, end: 1, ease: "power1.out" },
          { id: "#grow", target: "#logo", method: "fromTo", group: "scale", start: 1, duration: 2, end: 3, ease: "none" },
          { id: "#slide", target: "#card", method: "to", group: "position", start: 2, duration: 1, end: 3, ease: "none" },
          { id: "#resize", target: "#box", method: "to", group: "size", start: 3, duration: 1, end: 4, ease: "none" },
          { id: "#spin", target: "#ring", method: "to", group: "rotation", start: 4, duration: 1, end: 5, ease: "none" },
          { id: "#glow", target: "#glow", method: "set", group: "other", start: 5, duration: 1, end: 6, ease: "none" },
          { id: "#null-group", target: "#misc1", method: "set", group: null, start: 6, duration: 0, end: 6, ease: "none" },
          { id: "#unknown-group", target: "#misc2", method: "to", group: "banana", start: 7, duration: 1, end: 8, ease: "none" }
        ]
      }
    ]
  };
}

function tweensById(result) {
  const map = {};
  for (const tween of result.tweens) map[tween.id] = tween;
  return map;
}

test("LANES: seven ordered lanes with the documented labels and colors", () => {
  assert.deepEqual(
    tt.LANES.map((lane) => lane.key),
    ["visual", "scale", "position", "size", "rotation", "other", "misc"]
  );
  assert.deepEqual(tt.LANES[0], { key: "visual", label: "视觉", color: "#D9553F" });
  assert.deepEqual(tt.LANES[3], { key: "size", label: "尺寸", color: "#9B6BD6" });
  assert.deepEqual(tt.LANES[5], { key: "other", label: "其他", color: "#8A8F98" });
  assert.deepEqual(tt.LANES[6], { key: "misc", label: "未分类", color: "#2B3A55" });
});

test("build: flattens 8 tweens into lane buckets, keeping zero-duration sets", () => {
  const result = tt.build(laneFixture(), { duration: 20, fps: 30, labels: {} });

  assert.equal(result.ok, true);
  assert.equal(result.composition, "index.html");
  assert.equal(result.tweens.length, 8);

  assert.deepEqual(result.counts, {
    total: 8,
    byLane: { visual: 1, scale: 1, position: 1, rotation: 1, size: 1, other: 1, misc: 2 },
    byMethod: { to: 5, fromTo: 1, set: 2 }
  });

  assert.deepEqual(
    result.lanes.map((lane) => [lane.key, lane.count]),
    [["visual", 1], ["scale", 1], ["position", 1], ["size", 1], ["rotation", 1], ["other", 1], ["misc", 2]]
  );
  assert.equal(result.lanes.length, 7, "all lanes kept, even zero-count ones");

  const byId = tweensById(result);
  assert.equal(byId["#fade"].lane, "visual");
  assert.equal(byId["#grow"].lane, "scale");
  assert.equal(byId["#slide"].lane, "position");
  assert.equal(byId["#resize"].lane, "size");
  assert.equal(byId["#spin"].lane, "rotation");
  assert.equal(byId["#glow"].lane, "other");

  const zero = byId["#null-group"];
  assert.equal(zero.lane, "misc");
  assert.equal(zero.group, null);
  assert.equal(zero.duration, 0);
  assert.equal(zero.start, 6);
  assert.equal(zero.end, 6, "zero-duration set is a point block");
  assert.equal(zero.scene, "ALL");

  const unknown = byId["#unknown-group"];
  assert.equal(unknown.lane, "misc");
  assert.equal(unknown.group, "banana", "original group string is preserved");

  const fade = byId["#fade"];
  assert.equal(fade.file, "index.html");
  assert.equal(fade.ease, "power1.out");
  assert.equal(fade.method, "to");
  assert.equal(fade.target, "#hero");
  assert.deepEqual(Object.keys(fade).sort(), [
    "duration", "ease", "end", "file", "group", "id", "lane", "method", "scene", "start", "target"
  ]);
});

test("build: scene rail from #stageBase/#sN anchors with labels", () => {
  const fixture = {
    compositions: [
      {
        composition: "index.html",
        tweens: [
          { id: "#intro", target: "#hero", method: "to", group: "visual", start: 10, duration: 1, end: 11, ease: "none" },
          { id: "#base", target: "#stageBase", method: "to", group: "visual", start: 16.8, duration: 1, end: 17.8, ease: "none" },
          { id: "#s2", target: "#s2", method: "to", group: "visual", start: 16.8, duration: 1, end: 17.8, ease: "none" },
          { id: "#s3", target: "#s3", method: "to", group: "visual", start: 24, duration: 1, end: 25, ease: "none" }
        ]
      }
    ]
  };

  const result = tt.build(fixture, { duration: 69, fps: 30, labels: { s1: "开场", s2: "第二场" } });

  assert.deepEqual(result.scenes, [
    { id: "s1", label: "开场", from: 0, to: 16.8 },
    { id: "s2", label: "第二场", from: 16.8, to: 24 },
    { id: "s3", label: "s3", from: 24, to: 69 }
  ]);

  const byId = tweensById(result);
  assert.equal(byId["#intro"].scene, "s1");
  // Scene assignment is purely time based: 16.8 is the first instant of s2.
  assert.equal(byId["#base"].scene, "s2");
  assert.equal(byId["#s2"].scene, "s2");
  assert.equal(byId["#s3"].scene, "s3");
});

test("build: no scene anchors yields a single ALL scene", () => {
  const result = tt.build(laneFixture(), { duration: 20, fps: 30 });

  assert.deepEqual(result.scenes, [{ id: "ALL", label: "全片", from: 0, to: 20 }]);
  for (const tween of result.tweens) assert.equal(tween.scene, "ALL");
});

test("build: clamps start/end to the timeline duration", () => {
  const fixture = {
    compositions: [
      {
        composition: "index.html",
        tweens: [
          { id: "#tail", target: "#a", method: "to", group: "visual", start: 68, duration: 5, end: 75, ease: "none" },
          { id: "#late", target: "#b", method: "to", group: "visual", start: 70, duration: 5, end: 75, ease: "none" },
          { id: "#negative", target: "#c", method: "to", group: "visual", start: -3, duration: 1, end: -2, ease: "none" }
        ]
      }
    ]
  };

  const result = tt.build(fixture, { duration: 69, fps: 30, labels: {} });
  const byId = tweensById(result);

  assert.equal(result.tweens.length, 3);

  assert.equal(byId["#tail"].start, 68);
  assert.equal(byId["#tail"].end, 69, "end clamped to duration");
  assert.equal(byId["#tail"].duration, 5, "raw tween duration is preserved");

  // Only `end` is clamped; `start` has no upper bound in the contract, so the
  // tween survives and collapses onto its start on the last scene.
  assert.equal(byId["#late"].start, 70);
  assert.equal(byId["#late"].end, 70, "clamped end below start collapses to start");
  assert.equal(byId["#late"].scene, "ALL", "past the end -> last scene");

  assert.equal(byId["#negative"].start, 0, "start clamped to zero");
  assert.equal(byId["#negative"].end, 0, "end below start collapses to start");
});

test("build: tweens with non-numeric timing are skipped", () => {
  const fixture = {
    compositions: [
      {
        composition: "index.html",
        tweens: [
          { id: "#ok", target: "#ok", method: "to", group: "visual", start: 0, duration: 1, end: 1 },
          { id: "#nan-start", target: "#x", method: "to", group: "visual", start: "abc", duration: 1, end: 1 },
          { id: "#missing-duration", target: "#x", method: "to", group: "visual", start: 2, end: 3 },
          { id: "#infinite", target: "#x", method: "to", group: "visual", start: 0, duration: Infinity, end: 1 },
          { id: "#missing-start", target: "#x", method: "to", group: "visual", duration: 1, end: 1 }
        ]
      }
    ]
  };

  const result = tt.build(fixture, { duration: 10 });
  assert.equal(result.tweens.length, 1);
  assert.equal(result.tweens[0].id, "#ok");
  assert.equal(result.counts.total, 1);
});

test("build: null start/end from unresolved CLI tweens coerce to 0 and stay visible", () => {
  const fixture = {
    compositions: [
      {
        composition: "index.html",
        tweens: [
          {
            id: "__unresolved__-fromTo-__raw:t",
            target: "__unresolved__",
            method: "fromTo",
            start: null,
            duration: 0.28,
            end: null,
            totalDuration: 0.28,
            position: "__raw:t"
          }
        ]
      }
    ]
  };

  const result = tt.build(fixture, { duration: 69, fps: 30 });
  assert.equal(result.tweens.length, 1);

  const tween = result.tweens[0];
  assert.equal(tween.start, 0);
  assert.equal(tween.end, 0);
  assert.equal(tween.duration, 0.28);
  assert.equal(tween.lane, "misc");
  assert.equal(tween.group, null);
});

test("build: sorts by start, then target, then id", () => {
  const fixture = {
    compositions: [
      {
        composition: "index.html",
        tweens: [
          { id: "#c", target: "#b", method: "to", group: "visual", start: 5, duration: 1, end: 6 },
          { id: "#b", target: "#b", method: "to", group: "visual", start: 1, duration: 1, end: 2 },
          { id: "#z", target: "#a", method: "to", group: "visual", start: 1, duration: 1, end: 2 },
          { id: "#a", target: "#a", method: "to", group: "visual", start: 1, duration: 1, end: 2 }
        ]
      }
    ]
  };

  const result = tt.build(fixture, { duration: 10 });
  assert.deepEqual(result.tweens.map((tween) => tween.id), ["#a", "#z", "#b", "#c"]);
});

test("build: missing or invalid input returns the empty contract", () => {
  const invalid = [null, undefined, 42, "nope", {}, { compositions: "nope" }];
  for (const value of invalid) {
    const result = tt.build(value, { duration: 10 });
    assert.equal(result.ok, false);
    assert.deepEqual(result.tweens, []);
    assert.deepEqual(result.scenes, []);
    assert.deepEqual(result.lanes, tt.LANES);
    assert.deepEqual(result.counts, { total: 0, byLane: {}, byMethod: {} });
  }

  const empty = tt.build({ compositions: [] }, { duration: 10 });
  assert.equal(empty.ok, true);
  assert.equal(empty.tweens.length, 0);
  assert.deepEqual(empty.scenes, [{ id: "ALL", label: "全片", from: 0, to: 10 }]);
  assert.equal(empty.lanes.length, 7);
  assert.equal(empty.counts.total, 0);
});
