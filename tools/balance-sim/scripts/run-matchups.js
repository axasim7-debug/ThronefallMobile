#!/usr/bin/env node
"use strict";
// Prints every strategy matchup's result to the terminal — the manual
// "eyeball it" companion to `npm test`'s pass/fail assertions. Use this
// while tuning new content interactively; use `npm test` before you commit.
const { simulate, currentHP } = require("../src/engine");
const { ALL } = require("../src/strategies");
const content = require("../src/content");

const MATCHUPS = [
  ["eco", "atk"], ["eco", "def"], ["def", "atk"],
  ["eco", "eco"], ["def", "def"], ["atk", "atk"],
];

function fmt(pl, content) {
  const alive = pl.keepDestroyedAtT === null;
  const keepHP = Math.round(currentHP(pl.keep, content.ECONOMY.duration, content));
  const status = alive ? `survived (keepHP ${keepHP}/${pl.keep.maxHp})` : `DIED at t=${pl.keepDestroyedAtT}s`;
  return `${pl.strategy.padEnd(4)} troops=${String(pl.troopsProduced).padStart(3)} armyValue=${String(pl.armyValue).padStart(5)} barracksT=${String(pl.barracksT ?? "—").padStart(3)} -> ${status}`;
}

console.log(`Round length: ${content.ECONOMY.duration}s | Tower HP: ${content.DEFENSE.tower.hp}x${content.DEFENSE.towerCount} | Keep HP: ${content.DEFENSE.keep.hp} | Reinforce: ${content.DEFENSE.reinforce.startFraction * 100}%->100% over ${content.DEFENSE.reinforce.rampSeconds}s\n`);
for (const [a, b] of MATCHUPS) {
  const { A, B, result } = simulate(ALL[a], ALL[b], content);
  const winnerLabel = result.winner === "draw" ? "DRAW" : `${result.winner === "A" ? a : b} wins`;
  console.log(`${a} vs ${b}  ->  ${winnerLabel}  (${result.tiebreak})`);
  console.log("  A: " + fmt(A, content));
  console.log("  B: " + fmt(B, content));
}
