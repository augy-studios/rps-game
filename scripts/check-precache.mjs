#!/usr/bin/env node
// Fails on a PRECACHE entry in main-site/sw.js with no file on disk, and on
// a module or stylesheet that exists but is not precached, since either one
// is a hole in offline use.
//
// Run: node scripts/check-precache.mjs

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "main-site");
const source = readFileSync(join(ROOT, "sw.js"), "utf8");

const block = source.match(/const PRECACHE\s*=\s*\[([\s\S]*?)\n\];/);
if (!block) {
  console.error("could not find the PRECACHE array in main-site/sw.js");
  process.exit(1);
}

const entries = block[1]
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "")
  .split("\n")
  .map((line) => line.match(/["']([^"']+)["']/)?.[1])
  .filter(Boolean);

// cleanUrls is on, so "/" is index.html on disk.
const onDisk = (route) => (route === "/" ? "index.html" : route.replace(/^\//, ""));

const seen = new Set();
const missing = [];
const duplicates = [];
for (const route of entries) {
  if (seen.has(route)) duplicates.push(route);
  seen.add(route);
  if (!existsSync(join(ROOT, onDisk(route)))) missing.push(route);
}

const unlisted = [];
for (const [dir, ext] of [["js", ".js"], ["css", ".css"]]) {
  const full = join(ROOT, dir);
  if (!existsSync(full)) continue;
  for (const f of readdirSync(full)) {
    if (!f.endsWith(ext) || f.endsWith(".md") || f.endsWith(".txt")) continue;
    const route = `/${dir}/${f}`;
    if (!seen.has(route)) unlisted.push(route);
  }
}

if (duplicates.length) console.error(`duplicate PRECACHE entries:\n  - ${duplicates.join("\n  - ")}`);
if (missing.length) console.error(`PRECACHE entries with no file on disk:\n  - ${missing.join("\n  - ")}`);
if (unlisted.length) console.error(`files the app loads that are not precached:\n  - ${unlisted.join("\n  - ")}`);

if (missing.length || duplicates.length || unlisted.length) process.exit(1);

console.log(`precache ok: ${entries.length} entries, all present, nothing left out.`);
