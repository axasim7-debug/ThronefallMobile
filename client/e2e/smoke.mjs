#!/usr/bin/env node
// End-to-end smoke check: drives the real client, in a real browser, at a real
// phone size, against the real server. Plays a match through to its result and
// fails loudly on any console error.
//
// This is what "tested" means for the client — `npm run build` only proves it
// compiles. It also produces before/after screenshots, which is what makes it
// worth keeping through the art pass.
//
// Requires a running server and dev client:
//   dotnet run --project server/Thronefall.Api    (on :5246)
//   npm --prefix client run dev                   (on :5173)
//
// Usage:
//   node client/e2e/smoke.mjs [--url http://localhost:5173]
//                             [--opponent atk|eco|def] [--speed 20]
//                             [--shots ./shots]
//
// Playwright is a peer requirement, not a client dependency — the game itself
// must not ship a browser driver. A local install is used if present, else a
// global one is resolved explicitly (ESM ignores NODE_PATH, so it has to be
// looked up rather than left to the resolver).

import { mkdir } from "node:fs/promises";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

async function loadChromium() {
  try {
    return (await import("playwright")).chromium;
  } catch {
    let root;
    try {
      root = execSync("npm root -g", { encoding: "utf8" }).trim();
    } catch {
      throw new Error("playwright is not installed — `npm i -D playwright` or install it globally");
    }
    const mod = await import(pathToFileURL(`${root}/playwright/index.js`).href);
    return (mod.default ?? mod).chromium;
  }
}

const chromium = await loadChromium();

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

const base = flag("url", "http://localhost:5173");
const opponent = flag("opponent", "atk");
const speed = flag("speed", "20");
const shotDir = flag("shots", "");

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
};

if (shotDir) await mkdir(shotDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 390, height: 844 }, // iPhone-class portrait
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
});

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const shot = (name) => (shotDir ? page.screenshot({ path: `${shotDir}/${name}.png` }) : Promise.resolve());

await page.goto(`${base}/?opponent=${opponent}&speed=${speed}`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);

// the client ships with no content list — every button here came from the
// server's catalog, so an empty row means the handshake silently failed
const opening = await page.evaluate(() => ({
  builds: document.querySelectorAll(".builds .action").length,
  troops: document.querySelectorAll(".troops .action").length,
  commanders: document.querySelectorAll(".commander").length,
  clock: document.querySelector(".clock")?.textContent ?? "",
}));
console.log("catalog rendered:", JSON.stringify(opening));
if (opening.troops === 0 || opening.commanders === 0) fail("server catalog never rendered");
if (opening.clock === "—:—") fail("no state frame arrived");

// A tampered client: force-enable a control and press it anyway. The server
// must still refuse — the disabled state in the UI is cosmetic, not a gate.
//
// This runs before anything slow (screenshots included): "repair" is only
// guaranteed to be refused while nothing is damaged yet, and once the first
// enemy troops land it becomes a legitimate order. Ordering this late made the
// check fail against a server that was behaving correctly.
const tampered = await page.evaluate(() => {
  const repair = [...document.querySelectorAll(".builds .action")].find(
    (b) => b.querySelector(".action-label")?.textContent === "ترميم",
  );
  if (!repair) return false;
  repair.disabled = false;
  repair.click();
  return true;
});
if (!tampered) fail("repair control not found");

let refused = { shown: false, text: "" };
for (let i = 0; i < 20 && !refused.shown; i++) {
  await page.waitForTimeout(100);
  refused = await page.evaluate(() => {
    const t = document.querySelector(".toast");
    return { shown: t ? !t.hidden : false, text: t?.textContent ?? "" };
  });
}
console.log("tampered command refused:", JSON.stringify(refused));
if (!refused.shown) fail("server accepted a command it should have refused (or the refusal never surfaced)");

await shot("01-start");

// play it out
const press = (row, label) =>
  page.evaluate(
    ({ row, label }) => {
      const b = [...document.querySelectorAll(`${row} .action`)].find(
        (x) => x.querySelector(".action-label")?.textContent === label,
      );
      if (!b || b.disabled) return false;
      b.click();
      return true;
    },
    { row, label },
  );

let trained = 0;
let casts = 0;
let midShot = false;
for (let i = 0; i < 200; i++) {
  if (await page.evaluate(() => document.querySelector(".banner")?.hidden === false)) break;
  await press(".builds", "ثكنة");
  if (await press(".troops", "فرسان")) trained += 1;
  casts += await page.evaluate(() => {
    const ready = [...document.querySelectorAll(".commander.ready")];
    ready.forEach((c) => c.click());
    return ready.length;
  });
  // capture as soon as the base is actually doing something, not at a fixed
  // iteration — a fast match can end before any fixed index is reached
  if (!midShot && trained > 0) {
    midShot = true;
    await shot("02-playing");
  }
  await page.waitForTimeout(250);
}

const final = await page.evaluate(() => ({
  banner: document.querySelector(".banner")?.textContent ?? "",
  bannerShown: document.querySelector(".banner")?.hidden === false,
  you: document.querySelector(".keep-line.you .keep-text")?.textContent ?? "",
  enemy: document.querySelector(".keep-line.enemy .keep-text")?.textContent ?? "",
}));
await shot("03-end");

console.log(`played: cavalry=${trained} rageCasts=${casts}`);
console.log("final:", JSON.stringify(final));
if (!final.bannerShown) fail("match never resolved");
if (trained === 0) fail("no troop was ever trained — the command path is dead");
if (casts === 0) fail("no rage skill ever became castable");
if (errors.length) fail(`console errors: ${JSON.stringify(errors)}`);

await browser.close();
console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE OK");
