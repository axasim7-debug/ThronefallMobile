"use strict";
// Full-match regression suite — same philosophy as
// tools/balance-sim/test/balance.test.js: catch a build-order AI getting
// stuck, a NaN/negative value, an instant collapse, or a broken mirror
// symmetry. This is what proves the continuous combat model still behaves
// sanely once it's economy-paced over a real match duration, not just in an
// isolated skirmish.

const test = require("node:test");
const assert = require("node:assert/strict");
const { simulateMatch, keepDestroyedAtT } = require("../src/match");
const { ALL } = require("../src/match-strategies");
const content = require("../src/match-content");

const MATCHUPS = [
  ["eco", "atk"], ["eco", "def"], ["def", "atk"],
  ["eco", "eco"], ["def", "def"], ["atk", "atk"],
];

function run(a, b) {
  return simulateMatch(ALL[a], ALL[b]);
}

test("sanity: a mirror matchup (identical strategy vs itself) is symmetric", () => {
  for (const name of Object.keys(ALL)) {
    const { battle, A, B } = run(name, name);
    assert.equal(keepDestroyedAtT(battle, A), keepDestroyedAtT(battle, B),
      `${name} mirror: A's keep died at ${keepDestroyedAtT(battle, A)}, B's at ${keepDestroyedAtT(battle, B)} — should be identical`);
    assert.equal(A.troopsProduced, B.troopsProduced, `${name} mirror: troop counts diverged`);
  }
});

test("sanity: every strategy reaches its own barracks and produces troops in a mirror match", () => {
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
    const { battle, A, B } = run(a, b);
    for (const pl of [A, B]) {
      assert.ok(pl.gold >= 0 && Number.isFinite(pl.gold), `${pl.strategy.name} gold invalid: ${pl.gold}`);
      const keep = battle.structures.get(pl.keepId);
      assert.ok(keep.hp >= 0 && Number.isFinite(keep.hp), `${pl.strategy.name} keep HP invalid: ${keep.hp}`);
      for (const id of pl.towerIds) {
        const tower = battle.structures.get(id);
        assert.ok(tower.hp >= 0 && Number.isFinite(tower.hp), `${pl.strategy.name} tower HP invalid: ${tower.hp}`);
      }
    }
  }
});

// Floor revised from the old model's 60s to 90s after discussion with the
// user: the old 120-360s WINDOW was calibrated for staged, instant-per-troop
// resolution and doesn't map onto this model's continuous, geometry-driven
// combat, so the strict upper bound was dropped (reaching time-up with no
// kill is a healthy outcome here too, same as the old model). The lower
// floor is kept and raised slightly, since a genuinely fast collapse is
// still exactly the failure this test exists to catch. See docs/PROGRESS.md.
test("pacing: no matchup ends before 90s (a structural instant-collapse bug)", () => {
  for (const [a, b] of MATCHUPS) {
    const { battle, A, B } = run(a, b);
    for (const pl of [A, B]) {
      const diedAt = keepDestroyedAtT(battle, pl);
      if (diedAt !== null) {
        assert.ok(diedAt >= 90,
          `${pl.strategy.name} keep died at t=${diedAt}s in a ${a} vs ${b} match — defense collapsed almost immediately`);
      }
    }
  }
});

test("time-up: every matchup resolves to a well-formed winner/tiebreak, mirrors always draw", () => {
  const validTiebreaks = new Set([
    "keep-kill", "mutual-destruction-same-tick", "mutual-destruction-timing",
    "towers-destroyed", "own-keep-hp-pct", "true-draw",
  ]);
  for (const [a, b] of MATCHUPS) {
    const { result } = run(a, b);
    assert.ok(["A", "B", "draw"].includes(result.winner), `${a} vs ${b}: invalid winner "${result.winner}"`);
    assert.ok(validTiebreaks.has(result.tiebreak), `${a} vs ${b}: unknown tiebreak "${result.tiebreak}"`);
    if (a === b) assert.equal(result.winner, "draw", `${a} mirror matchup should always draw, got ${result.winner}`);
  }
});

test("balance: no single strategy dominates every matchup it's in (via keep-kill)", () => {
  const DOMINANCE_KEEP_HP_RATIO = 0.7;
  for (const [a, b] of MATCHUPS) {
    if (a === b) continue;
    const { battle, A, B } = run(a, b);
    for (const [winner, loser] of [[A, B], [B, A]]) {
      if (keepDestroyedAtT(battle, loser) === null || keepDestroyedAtT(battle, winner) !== null) continue;
      const ratio = battle.structures.get(winner.keepId).hp / content.DEFENSE.keep.hp;
      assert.ok(ratio <= DOMINANCE_KEEP_HP_RATIO,
        `${winner.strategy.name} beat ${loser.strategy.name} while keeping ${(ratio * 100).toFixed(0)}% ` +
        `of its own keep HP — one-sided result`);
    }
  }
});

// The core hypothesis this whole file exists to check: earlier tests only
// ever proved ONE troop's combat resolves correctly over time. Does the
// continuous model still correctly accumulate damage across MANY separate
// troop arrivals, sustained over a full match, without anything resetting
// or getting lost between arrivals?
test("continuous accumulation: a sustained attacker's troops produce real cumulative damage, not just one hit", () => {
  const { battle, A, B } = run("atk", "atk"); // fast rusher on both sides — reliably produces several troops each
  assert.ok(A.troopsProduced > 3 && B.troopsProduced > 3,
    `expected several troops produced over a full match, got A=${A.troopsProduced} B=${B.troopsProduced}`);

  // with several troops thrown at an unreinforced defense over 360s, SOME
  // structure on each side must show real, non-trivial damage — if this
  // were false, damage from later troops would have to be silently
  // vanishing (overwritten, not summed) rather than accumulating.
  const damagedStructures = (pl) =>
    pl.myStructures().filter((s) => s.destroyed || s.hp < s.maxHp * 0.95);
  assert.ok(damagedStructures(A).length > 0, "A's defense shows no accumulated damage after a sustained assault");
  assert.ok(damagedStructures(B).length > 0, "B's defense shows no accumulated damage after a sustained assault");
});
