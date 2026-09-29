// Shared helpers for the browser tests (parity.mjs, app-smoke.mjs): a static
// file server rooted at the repo, a promise timeout, and headless system Chrome.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".ttf": "font/ttf", ".css": "text/css", ".mp4": "video/mp4",
};

/** Serve ROOT (a directory serves its index.html) on a free 127.0.0.1 port. Resolves with the http.Server. */
export function serve() {
  const server = createServer(async (req, res) => {
    try {
      const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
      let file = join(ROOT, path);
      if (file !== ROOT && !file.startsWith(ROOT + sep)) throw Object.assign(new Error("outside root"), { code: "ENOENT" });
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
      if (!(await stat(file)).isFile()) throw Object.assign(new Error("not a file"), { code: "ENOENT" });
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r(server)));
}

export function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms); }),
  ]);
}

/**
 * Launch the system Google Chrome (playwright channel "chrome"). Exits the
 * process with a clear message when Chrome is not installed.
 */
export async function launchChrome({ headless = true } = {}) {
  try {
    return await chromium.launch({ channel: "chrome", headless });
  } catch (e) {
    console.error("Could not start Google Chrome. This test drives the system Chrome (playwright channel " +
      "\"chrome\"); install Google Chrome from https://www.google.com/chrome/ and re-run.\n\n" + e.message);
    return null;
  }
}

/** Forward a page's console, errors and crashes to stdout with a time stamp. */
export function forwardConsole(page, stamp) {
  page.on("console", m => console.log(`${stamp()} ${m.type() === "log" ? "" : m.type() + ": "}${m.text()}`));
  page.on("pageerror", e => console.log(`${stamp()} PAGEERROR ${e.message}`));
  page.on("crash", () => console.log(`${stamp()} PAGE CRASHED`));
}
