#!/usr/bin/env node
// End-to-end smoke check: drives the real client, in a real browser, at a real
// phone size, against the real server. Plays a match through to its result,
// performs a REAL drag gesture to walk the king onto the barracks plot (the
// king walk-and-build mechanic — Build is refused until it does) and a
// second one to move a trained unit, and fails loudly on any console error.
// Backed by Thronefall.PositionalEngine — see docs/PROGRESS.md for the pivot
// from the old staged-combat engine and for the king mechanic itself.
//
// The tamper probe sends a raw WebSocket frame with a nonsense troop key
// rather than clicking a disabled UI button. That was tried first and was
// genuinely flaky against the "atk" opponent: "repair" is only illegal while
// nothing of yours is damaged, and atk's first troop can land as early as
// tick ~34 — a slow evaluate() or console.log in the probe was sometimes
// enough real time, at high --speed, to land after that. A nonsense key is
// illegal for the entire match regardless of opponent or timing, which is
// what the probe is actually supposed to prove: the server, not any client
// state, decides.
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
//                             [--opponent eco|def|atk] [--speed 6]
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
// "eco" (slow to field an army) and a modest --speed by default: the drag
// check needs a real WALL-CLOCK window for its async multi-step Playwright
// gesture (several evaluate()/mouse round-trips) to land before anything it
// touches dies or the match itself ends — at speed=15+, a full match can
// conclude for real in under 10 seconds, leaving no margin. An opponent
// killing a fresh unit or reaching your keep in that window is a correct
// server verdict, not a bug, but it makes the CHECK flaky. Override with
// --opponent/--speed for a specific matchup.
const opponent = flag("opponent", "eco");
const speed = flag("speed", "6");
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

await page.addInitScript(() => {
  const Native = window.WebSocket;
  window.WebSocket = function (...args) {
    const socket = new Native(...args);
    window.__thronefallSocket = socket;
    // captured purely for the test harness to read real server state (unit
    // positions) without duplicating any client logic — the app itself never
    // reads this
    window.__thronefallAcks = [];
    socket.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "state") window.__thronefallLatestState = msg;
        if (msg.type === "ack") window.__thronefallAcks.push(msg);
        if (msg.type === "matchStarted") window.__thronefallCatalog = msg.catalog;
      } catch { /* not JSON we care about */ }
    });
    return socket;
  };
  window.WebSocket.prototype = Native.prototype;
  for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) window.WebSocket[key] = Native[key];
});
await page.goto(`${base}/?opponent=${opponent}&speed=${speed}`, { waitUntil: "networkidle" });

// The app now opens on a splash -> lobby screen (docs/UI_UX_IDENTITY.md §10)
// instead of connecting immediately — walk through it like a real player:
// wait for the splash's fixed beat, press Battle, then the fixed
// "searching for opponent" beat before the match actually connects.
await page.waitForTimeout(1500);
await page.click(".cta-battle");
await page.waitForTimeout(1100);

// the client ships with no content list — every button here came from the
// server's catalog, so an empty row means the handshake silently failed
const opening = await page.evaluate(() => ({
  builds: document.querySelectorAll(".builds .action").length,
  troops: document.querySelectorAll(".troops .action").length,
  clock: document.querySelector(".clock")?.textContent ?? "",
}));
console.log("catalog rendered:", JSON.stringify(opening));
if (opening.troops === 0 || opening.builds === 0) fail("server catalog never rendered");
if (opening.clock === "—:—") fail("no state frame arrived");

// A tampered client: send a command no legitimate button could ever produce.
// The server must still refuse it on its own authority — nothing here reads
// or depends on match state, so there is no race with the opponent to avoid.
const tampered = await page.evaluate(() => {
  if (!window.__thronefallSocket) return false;
  window.__thronefallSocket.send(JSON.stringify({ type: "command", kind: "train", arg: "ghost-knight", seq: 999 }));
  return true;
});
if (!tampered) fail("no socket handle to tamper with (did the capture hook not fire?)");

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
if (!refused.text.toLowerCase().includes("unknown")) fail(`unexpected refusal reason: ${refused.text}`);

await shot("01-start");

// King walk-and-build (docs/PROGRESS.md): Build now requires the king to be
// physically standing on the plot first, so before the play loop even
// starts building a barracks, drag the king there — a real gesture, exactly
// like the unit drag below, computing the barracks plot's world position
// from the same catalog constants the client itself uses (protocol.ts's
// Catalog.layout), not a hardcoded guess.
const catalog = await page.evaluate(() => window.__thronefallCatalog ?? null);
if (!catalog) fail("no matchStarted catalog was ever captured");
else {
  const before = await page.evaluate(() => {
    const you = window.__thronefallLatestState?.you;
    const keep = you?.structures?.find((s) => s.key === "keep");
    return you && keep ? { kingX: you.kingX, kingZ: you.kingZ, keepZ: keep.z } : null;
  });
  if (!before) fail("no king/keep state to compute the barracks plot from");
  else {
    const sign = before.keepZ < 0 ? -1 : 1;
    const barracksPlot = { x: 0, z: sign * catalog.layout.econ * catalog.layout.plotDepth };
    const from = await page.evaluate((k) => window.__thronefallProject(k.kingX, k.kingZ), before);
    const to = await page.evaluate((p) => window.__thronefallProject(p.x, p.z), barracksPlot);

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();

    let arrived = false;
    for (let i = 0; i < 100 && !arrived; i++) {
      await page.waitForTimeout(100);
      arrived = await page.evaluate((p) => {
        const you = window.__thronefallLatestState?.you;
        if (!you) return false;
        return Math.hypot(you.kingX - p.x, you.kingZ - p.z) < 1.6; // server's buildRadius is 1.5
      }, barracksPlot);
    }
    console.log("king dragged to barracks plot, arrived:", arrived);
    if (!arrived) fail("king never arrived at the barracks plot after a real drag gesture");
  }
}
await shot("01b-king-at-plot");

// play it out: build a barracks, train troops, and — the new part — once a
// unit exists, actually DRAG it on the canvas (a real pointer gesture, not a
// button click) and confirm the server accepts the resulting moveUnit.
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
let dragged = false;
let dragAccepted = false;
let dragAttempts = 0;
let midShot = false;
for (let i = 0; i < 400; i++) {
  if (await page.evaluate(() => document.querySelector(".banner")?.hidden === false)) break;
  await press(".builds", "Barracks");
  if (await press(".troops", "Cavalry")) trained += 1;

  // Retries with whatever unit currently exists: at high --speed, a freshly
  // trained unit can die in combat before an async multi-step Playwright
  // drag round-trips, which is a real (and correct) "unit-already-dead"
  // rejection, not a bug in the drag itself — so retry with a fresh unit
  // rather than fight the timing.
  if (!dragAccepted && dragAttempts < 10) {
    const unit = await page.evaluate(() => window.__thronefallLatestState?.you?.units?.[0] ?? null);
    if (unit) {
      dragged = true;
      dragAttempts += 1;
      const from = await page.evaluate((u) => window.__thronefallProject(u.x, u.z), unit);
      const enemyKeep = await page.evaluate(
        () => window.__thronefallLatestState.enemy.structures.find((s) => s.key === "keep"),
      );
      const to = await page.evaluate((k) => window.__thronefallProject(k.x, k.z), enemyKeep);

      const acksBefore = await page.evaluate(() => window.__thronefallAcks.length);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await page.mouse.up();

      // look for the moveUnit ack itself — checking the unit's waypoint
      // afterward is a race: a fast unit can already have arrived (waypoint
      // cleared back to null on arrival) before the next poll runs
      let moveAck = null;
      for (let j = 0; j < 15 && !moveAck; j++) {
        await page.waitForTimeout(100);
        moveAck = await page.evaluate(
          (from) => window.__thronefallAcks.slice(from).find((a) => a.kind === "moveUnit") ?? null,
          acksBefore,
        );
      }
      console.log(`drag attempt ${dragAttempts} from/to:`, JSON.stringify(from), JSON.stringify(to), "moveAck:", JSON.stringify(moveAck));
      if (moveAck?.accepted === true) dragAccepted = true;
      else if (moveAck && moveAck.reason !== "unit-already-dead") fail(`moveUnit refused for an unexpected reason: ${JSON.stringify(moveAck)}`);
      // a null ack (no response yet) usually means the match ended mid-flight
      // — not a protocol problem, just nothing left to retry against
    }
  }

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

console.log(`played: cavalry=${trained} dragged=${dragged} dragAccepted=${dragAccepted}`);
console.log("final:", JSON.stringify(final));
if (!final.bannerShown) fail("match never resolved");
if (trained === 0) fail("no troop was ever trained — the command path is dead");
if (!dragged) fail("never got the chance to drag a unit — none appeared on the battlefield");
if (!dragAccepted) fail("dragging a unit never resulted in the server reporting it as moving (waypoint set)");
if (errors.length) fail(`console errors: ${JSON.stringify(errors)}`);

await browser.close();
console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE OK");
