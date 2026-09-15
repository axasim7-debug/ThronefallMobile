"use strict";
// Balance regression suite. Run with: npm test (or `node --test`).
//
// These tests exist to catch the two kinds of mistakes that happen when
// content changes (new troop, new hero, new building, or just a retuned
// number): (1) an actual bug in build/combat logic — a strategy getting
// stuck, a structure never taking damage, math that silently breaks; and
// (2) a balance regression — a round that ends absurdly fast/slow, or one
// archetype crushing the others. See ../README.md before adding content.

const test = require("node:test");
const assert = require("node:assert/strict");
const { simulate, currentHP } = require("../src/engine");
const { ALL } = require("../src/strategies");
const content = require("../src/content");

const MATCHUPS = [
  ["eco", "atk"], ["eco", "def"], ["def", "atk"],
  ["eco", "eco"], ["def", "def"], ["atk", "atk"],
];

function run(a, b) {
  return simulate(ALL[a], ALL[b], content);
}

test("sanity: every strategy reaches its own barracks in a mirror match", () => {
  for (const name of Object.keys(ALL)) {
    const { A, B } = run(name, name);
    assert.notEqual(A.barracksT, null, `${name} (A) never built a barracks — build-order AI is stuck`);
    assert.notEqual(B.barracksT, null, `${name} (B) never built a barracks — build-order AI is stuck`);
    assert.ok(A.troopsProduced > 0, `${name} (A) never produced a troop`);
    assert.ok(B.troopsProduced > 0, `${name} (B) never produced a troop`);
  }
});

test("sanity: no negative gold / HP, no NaN, across all matchups", () => {
  for (const [a, b] of MATCHUPS) {
    const { A, B } = run(a, b);
    for (const pl of [A, B]) {
      assert.ok(pl.gold >= 0 && Number.isFinite(pl.gold), `${pl.strategy} gold invalid: ${pl.gold}`);
      const keepHP = currentHP(pl.keep, content.ECONOMY.duration, content);
      assert.ok(keepHP >= 0 && Number.isFinite(keepHP), `${pl.strategy} keepHP invalid: ${keepHP}`);
      for (const s of pl.towers) assert.ok(currentHP(s, content.ECONOMY.duration, content) >= 0, `${pl.strategy} tower HP went negative`);
    }
  }
});

test("pacing: no matchup ends before 60s (a structural instant-collapse bug)", () => {
  for (const [a, b] of MATCHUPS) {
    const { A, B } = run(a, b);
    for (const pl of [A, B]) {
      if (pl.keepDestroyedAtT !== null) {
        assert.ok(pl.keepDestroyedAtT >= 60,
          `${pl.strategy} keep died at t=${pl.keepDestroyedAtT}s in a ${a} vs ${b} match — ` +
          `defense is being bypassed almost immediately, check wall/tower/keep chaining`);
      }
    }
  }
});

test("pacing: mirror matchups (fair fights) land inside the 120-360s target window", () => {
  for (const name of Object.keys(ALL)) {
    const { A, B } = run(name, name);
    for (const pl of [A, B]) {
      if (pl.keepDestroyedAtT === null) continue; // survived the round — fine
      assert.ok(
        pl.keepDestroyedAtT >= 120 && pl.keepDestroyedAtT <= 360,
        `${name} mirror match ended at t=${pl.keepDestroyedAtT}s, outside the intended ` +
        `120-360s round-length window — see docs/GAME_DESIGN.md §"وتيرة الجولة"`,
      );
    }
  }
});

// --- known open issue, tracked not hidden ---------------------------------
// "eco" currently wins every asymmetric matchup with a large margin (see
// docs/PROGRESS.md, "قضية اقتصاد أولاً المهيمنة"). Diminishing/capped farm
// returns were tried and did NOT fix it — root cause is that baseline
// defense (fixed from t=0, same for every strategy) is strong enough that
// an early rush can never meaningfully punish a slow start. This is a
// `todo` test, not a passing one: it documents the target we have not hit
// yet. Once a fix (e.g. defense that starts weaker and reinforces over
// time) is implemented and tested, promote this to a real assertion.
test("balance: no single strategy should dominate every matchup it's in", { todo: "open issue — see docs/PROGRESS.md" }, () => {
  const DOMINANCE_KEEP_HP_RATIO = 0.5; // winner should not keep >50% HP while fully destroying the loser
  for (const [a, b] of MATCHUPS) {
    if (a === b) continue;
    const { A, B } = run(a, b);
    for (const [winner, loser] of [[A, B], [B, A]]) {
      if (loser.keepDestroyedAtT === null || winner.keepDestroyedAtT !== null) continue;
      const ratio = currentHP(winner.keep, content.ECONOMY.duration, content) / content.DEFENSE.keep.hp;
      assert.ok(ratio <= DOMINANCE_KEEP_HP_RATIO,
        `${winner.strategy} beat ${loser.strategy} while keeping ${(ratio * 100).toFixed(0)}% ` +
        `of its own keep HP — one-sided result`);
    }
  }
});

test("regression baseline: current adopted numbers (update this snapshot deliberately, not accidentally)", () => {
  const { A, B } = run("def", "def");
  // def vs def is the slowest, most stable matchup — good canary for any
  // accidental change to defense HP, repair cost, or wall numbers.
  assert.ok(A.keepDestroyedAtT >= 300, "def vs def got faster — did defense/repair numbers change?");
});
