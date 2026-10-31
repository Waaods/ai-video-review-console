"use strict";

/**
 * Native Windows folder picker without npm dependencies.
 *
 * Strategy: write a small PowerShell 5.1 script to a temp file, spawn
 * `powershell.exe -STA` to show a FolderBrowserDialog, and parse its stdout
 * for a `[PATH]...` / `[CANCEL]` / `[ERROR]...` marker line.
 *
 * The script is written as UTF-8 WITH BOM so Windows PowerShell 5.1 (which
 * assumes ANSI without a BOM) decodes Chinese description text correctly.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const config = require("./config");

const STDOUT_CAP = 1024 * 1024; // 1 MB cap on collected output
const STDERR_CAP = 1024 * 1024;

/**
 * Build the PowerShell 5.1 picker script.
 * @param {{ description?: string }} opts
 * @returns {string} the script text
 */
function buildScript({ description } = {}) {
  // PowerShell single-quote escaping: double every single quote.
  const desc = String(description || "")
    .replace(/'/g, "''")
    .replace(/[\r\n]+/g, " ");
  return [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "  Add-Type -AssemblyName System.Windows.Forms",
    "  $owner = New-Object System.Windows.Forms.Form",
    "  $owner.TopMost = $true",
    "  $owner.ShowInTaskbar = $false",
    "  $owner.WindowState = 'Minimized'",
    "  $owner.Opacity = 0",
    "  $owner.StartPosition = 'CenterScreen'",
    "  $owner.Show()",
    "  $owner.Activate()",
    "  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog",
    "  $dlg.Description = '" + desc + "'",
    "  $dlg.ShowNewFolderButton = $false",
    "  $dlg.RootFolder = [System.Environment+SpecialFolder]::MyComputer",
    "  $r = $dlg.ShowDialog($owner)",
    "  if ($r -eq [System.Windows.Forms.DialogResult]::OK) {",
    "    [Console]::Out.WriteLine('[PATH]' + $dlg.SelectedPath)",
    "  } else {",
    "    [Console]::Out.WriteLine('[CANCEL]')",
    "  }",
    "  $owner.Close()",
    "} catch {",
    "  [Console]::Out.WriteLine('[ERROR]' + $_.Exception.Message)",
    "  exit 1",
    "}",
    ""
  ].join("\r\n");
}

/**
 * Parse picker stdout/stderr into a result object.
 * @param {string} stdout
 * @param {string} stderr
 * @returns {{ok:true, path:string} | {ok:false, reason:"cancel"|"error", error?:string}}
 */
function parseOutput(stdout, stderr) {
  const out = String(stdout || "");
  const err = String(stderr || "").trim();

  const lines = out.split(/\r?\n/);
  // Find the LAST line starting with [PATH].
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (/^\s*\[PATH\]/.test(line)) {
      let p = line.slice(line.indexOf("[PATH]") + 6).trim();
      // Strip surrounding quotes (PowerShell may quote paths with spaces).
      if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
        p = p.slice(1, -1);
      }
      if (p) return { ok: true, path: p };
    }
  }

  if (/^\s*\[CANCEL\]\s*$/m.test(out)) {
    return { ok: false, reason: "cancel" };
  }

  const errMatch = out.match(/^\s*\[ERROR\](.*)$/m);
  if (errMatch) {
    return { ok: false, reason: "error", error: errMatch[1].trim() || "unknown error" };
  }

  if (err) {
    return { ok: false, reason: "error", error: err };
  }

  if (out.trim() === "") {
    return { ok: false, reason: "error", error: "no output" };
  }

  return { ok: false, reason: "error", error: "unrecognized output" };
}

/**
 * Write the script to a temp file as UTF-8 WITH BOM.
 * @param {string} script
 * @returns {{ scriptPath: string }} path of the written file
 */
function writeScriptFile(script) {
  const rand = Math.random().toString(36).slice(2, 10);
  const scriptPath = path.join(os.tmpdir(), `hfpicker-${process.pid}-${rand}.ps1`);
  fs.writeFileSync(scriptPath, "\uFEFF" + script, "utf8");
  return { scriptPath };
}

/**
 * Open the native folder picker. Never rejects.
 * @param {{ timeoutMs?: number, description?: string }} opts
 * @returns {Promise<{ok:true, path:string} | {ok:false, reason:"cancel"|"error"|"timeout", error?:string}>}
 */
function pickFolder({ timeoutMs = config.DIALOG_TIMEOUT_MS, description } = {}) {
  return new Promise((resolve) => {
    const script = buildScript({ description });
    let scriptPath;
    try {
      scriptPath = writeScriptFile(script).scriptPath;
    } catch (err) {
      resolve({ ok: false, reason: "error", error: "failed to write script: " + err.message });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let child = null;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { fs.unlinkSync(scriptPath); } catch (_) { /* best effort */ }
      resolve(result);
    };

    try {
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
      );
    } catch (err) {
      finish({ ok: false, reason: "error", error: "spawn failed: " + err.message });
      return;
    }

    child.stdout.on("data", (d) => {
      if (stdout.length < STDOUT_CAP) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < STDERR_CAP) stderr += d.toString("utf8");
    });

    timer = setTimeout(() => {
      if (settled) return;
      // Kill the whole tree so the STA host and dialog die with it.
      if (child.pid) {
        if (process.platform === "win32") {
          try {
            spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
          } catch (_) { /* best effort */ }
        } else {
          try { child.kill("SIGKILL"); } catch (_) { /* best effort */ }
        }
      }
      finish({ ok: false, reason: "timeout" });
    }, Math.max(1, Number(timeoutMs) || config.DIALOG_TIMEOUT_MS));

    child.on("error", (err) => {
      finish({ ok: false, reason: "error", error: err.message });
    });

    child.on("close", (code) => {
      if (settled) return;
      const result = parseOutput(stdout, stderr);
      if (result.ok) {
        finish(result);
        return;
      }
      // Non-zero exit without a marker line: surface the exit code.
      if (code !== 0 && result.reason === "error" && !result.error) {
        result.error = "powershell exited with code " + code;
      }
      finish(result);
    });
  });
}

/**
 * Best-effort availability check: the picker only works on Windows where
 * `powershell.exe` (Windows PowerShell 5.1) exists. On win32 we assume it is
 * present (it ships with every supported Windows); on other platforms the
 * FolderBrowserDialog approach does not apply. Callers should treat a
 * pickFolder error as the authoritative signal.
 * @returns {boolean}
 */
function isAvailable() {
  return process.platform === "win32";
}

module.exports = {
  buildScript,
  parseOutput,
  writeScriptFile,
  pickFolder,
  isAvailable
};
