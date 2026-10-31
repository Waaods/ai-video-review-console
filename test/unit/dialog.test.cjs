"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const dialog = require("../../lib/dialog");

test("buildScript contains the required PowerShell pieces", () => {
  const s = dialog.buildScript({ description: "选择项目文件夹" });
  assert.match(s, /Add-Type -AssemblyName System\.Windows\.Forms/);
  assert.match(s, /FolderBrowserDialog/);
  assert.match(s, /ShowDialog\(\$owner\)/);
  assert.match(s, /TopMost = \$true/);
  assert.match(s, /ShowNewFolderButton = \$false/);
  assert.match(s, /MyComputer/);
  assert.match(s, /\[PATH\]/);
  assert.match(s, /\[CANCEL\]/);
  assert.match(s, /\[ERROR\]/);
  assert.match(s, /try \{[\s\S]*\} catch \{/);
  // -STA is a spawn arg, not part of the script text.
  assert.ok(!s.includes("-STA"));
});

test("buildScript escapes single quotes in description", () => {
  const s = dialog.buildScript({ description: "it's here" });
  assert.ok(s.includes("it''s here"));
  assert.ok(!s.includes("it's here"));
});

test("parseOutput: simple PATH with CRLF", () => {
  assert.deepEqual(dialog.parseOutput("[PATH]C:\\a\\b\r\n", ""), {
    ok: true,
    path: "C:\\a\\b"
  });
});

test("parseOutput: leading log lines then PATH", () => {
  const out = "some log line\r\nanother\r\n[PATH]D:\\videos\\proj\r\n";
  assert.deepEqual(dialog.parseOutput(out, ""), {
    ok: true,
    path: "D:\\videos\\proj"
  });
});

test("parseOutput: quoted path with spaces strips quotes", () => {
  assert.deepEqual(dialog.parseOutput('[PATH]"C:\\x y"\r\n', ""), {
    ok: true,
    path: "C:\\x y"
  });
});

test("parseOutput: uses the LAST [PATH] line", () => {
  const out = "[PATH]C:\\first\r\n[PATH]C:\\second\r\n";
  assert.deepEqual(dialog.parseOutput(out, ""), {
    ok: true,
    path: "C:\\second"
  });
});

test("parseOutput: CANCEL", () => {
  assert.deepEqual(dialog.parseOutput("[CANCEL]\r\n", ""), {
    ok: false,
    reason: "cancel"
  });
});

test("parseOutput: ERROR carries the message", () => {
  const r = dialog.parseOutput("[ERROR]boom\r\n", "");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "error");
  assert.equal(r.error, "boom");
});

test("parseOutput: empty output is an error", () => {
  const r = dialog.parseOutput("", "");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "error");
  assert.equal(r.error, "no output");
});

test("parseOutput: stderr without PATH is an error", () => {
  const r = dialog.parseOutput("", "powershell : something bad");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "error");
  assert.equal(r.error, "powershell : something bad");
});

test("writeScriptFile writes UTF-8 BOM and cleans up", () => {
  const { scriptPath } = dialog.writeScriptFile("# test\r\n");
  try {
    const buf = fs.readFileSync(scriptPath);
    assert.ok(buf.length >= 3, "file should have content");
    assert.equal(buf[0], 0xef, "first byte EF");
    assert.equal(buf[1], 0xbb, "second byte BB");
    assert.equal(buf[2], 0xbf, "third byte BF");
  } finally {
    fs.unlinkSync(scriptPath);
  }
  assert.ok(!fs.existsSync(scriptPath), "temp script removed");
});

test("isAvailable matches platform", () => {
  assert.equal(dialog.isAvailable(), process.platform === "win32");
});
