#!/usr/bin/env node
"use strict";
// Prints every strategy matchup's result to the terminal — the manual
// "eyeball it" companion to `npm test`'s pass/fail assertions. Use this
// while tuning new content interactively; use `npm test` before you commit.
const { simulate } = require("../src/engine");
const { ALL } = require("../src/strategies");
const content = require("../src/content");

const MATCHUPS = [
  ["eco", "atk"], ["eco", "def"], ["def", "atk"],
  ["eco", "eco"], ["def", "def"], ["atk", "atk"],
];

function fmt(pl, maxKeep) {
  const alive = pl.keepDestroyedAtT === null;
  const status = alive ? `survived (keepHP ${pl.keepHP}/${maxKeep})` : `DIED at t=${pl.keepDestroyedAtT}s`;
  return `${pl.strategy.padEnd(4)} troops=${String(pl.troopsProduced).padStart(3)} armyValue=${String(pl.armyValue).padStart(5)} barracksT=${String(pl.barracksT ?? "—").padStart(3)} -> ${status}`;
}

console.log(`Round length: ${content.ECONOMY.duration}s | Tower HP: ${content.DEFENSE.tower.hp}x${content.DEFENSE.towerCount} | Keep HP: ${content.DEFENSE.keep.hp}\n`);
for (const [a, b] of MATCHUPS) {
  const { A, B } = simulate(ALL[a], ALL[b], content);
  console.log(`${a} vs ${b}`);
  console.log("  A: " + fmt(A, content.DEFENSE.keep.hp));
  console.log("  B: " + fmt(B, content.DEFENSE.keep.hp));
}
