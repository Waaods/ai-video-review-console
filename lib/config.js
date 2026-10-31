"use strict";

const path = require("path");

module.exports = {
  PORT: Number(process.env.PORT || 8903),
  HOST: "127.0.0.1",
  DEFAULT_HF_VERSION: "0.8.168",
  VIDEO_EXT: new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv", ".avi"]),
  VIDEO_MIME: {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo"
  },
  SKIP_DIRS: new Set([
    "node_modules",
    ".git",
    ".hyperframes",
    "cache",
    "$RECYCLE.BIN",
    "System Volume Information"
  ]),
  MAX_SCAN_DEPTH: 8,
  MAX_SCAN_ENTRIES: 50000,
  MAX_VIDEOS: 50,
  KF_TIMEOUT_MS: 180000,
  KF_MAX_BYTES: 32 * 1024 * 1024,
  DIALOG_TIMEOUT_MS: 300000,
  DATA_ROOT: path.join(__dirname, "..", "data")
};
