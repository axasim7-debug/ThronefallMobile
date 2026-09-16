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

// mono-troop strategy for per-troop sanity checks: same build order as
// "atk" (rush barracks), but only ever produces the one troop under test
function monoTroop(troopKey) {
  return Object.assign({}, ALL.atk, { name: `atk(${troopKey})`, pickTroop: () => troopKey });
}

// Caught a real bug during commander development: applying one player's
// full set of same-tick effects before the other's let a same-tick heal
// "catch" damage the opponent just dealt for one side but not its mirror,
// so an identical-strategy-vs-itself match came out asymmetric. Any new
// cross-player effect (a new commander skill, a troop ability that hits
// back, etc.) is a candidate to reintroduce this — this test is the guard.
test("sanity: a mirror matchup (identical strategy vs itself) is symmetric", () => {
  for (const name of Object.keys(ALL)) {
    const { A, B } = run(name, name);
    assert.equal(A.keepDestroyedAtT, B.keepDestroyedAtT,
      `${name} mirror: A died at ${A.keepDestroyedAtT}, B at ${B.keepDestroyedAtT} — should be identical`);
    assert.equal(A.troopsProduced, B.troopsProduced, `${name} mirror: troop counts diverged`);
  }
});

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
          `defense is being bypassed almost immediately, check tower/keep chaining`);
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

// Promoted from `todo` to a real assertion once the fix landed: farms are
// a real attack target (BUILDINGS.farm.disruptionPenalty hits future
// income, not a cash balance, when raided) — see docs/PROGRESS.md for the
// full history of what was tried before this worked. Threshold is 0.7, not
// 0.5: testing showed a purely passive "def" (never attacks until its own
// build order is done) losing comfortably to an active "atk" is expected
// and healthy, not the unanswered-snowball pathology this test exists to
// catch.
// NOTE: since commander passives were added, no matchup ends in an outright
// keep-kill anymore (see docs/PROGRESS.md's open balance question) — so
// this specific check is currently dormant (its precondition never fires).
// Left in place rather than deleted: it reactivates automatically the
// moment any future content change produces a kill again, which is exactly
// when a dominance regression would first show up.
test("balance: no single strategy should dominate every matchup it's in (via keep-kill)", () => {
  const DOMINANCE_KEEP_HP_RATIO = 0.7;
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

// Per-troop smoke test: every troop in the roster, thrown mono-composition
// at "eco" and "def", must not cause an instant (<60s) collapse or a
// mathematically nonsensical result (negative HP, no damage ever dealt by
// a troop that should be capable of dealing some). This is the test to run
// after adding ANY new troop/hero — it isolates that one addition instead
// of only seeing it blended into a mixed army.
test("per-troop sanity: no single troop type causes an instant collapse or a no-op", () => {
  for (const troopKey of Object.keys(content.TROOPS)) {
    const attacker = monoTroop(troopKey);
    for (const defenderName of ["eco", "def"]) {
      const { A, B } = simulate(attacker, ALL[defenderName], content);
      assert.ok(A.troopsProduced > 0, `${troopKey}: attacker never produced a troop`);
      // Caught a real bug this way: a commander passive (shadow's
      // marchTimeMult) could make a troop's arrival tick fractional, which
      // silently never matched the integer tick loop — the troop was
      // "produced" but never actually attacked. A mono-troop attacker
      // fields its own full commander squad (see monoTroop's comment), so
      // this exercises exactly that combination.
      const defenderActivity = B.stats.stoppedAtTower + B.stats.reachedKeep + B.stats.farmsRaided;
      assert.ok(defenderActivity > 0,
        `${troopKey} vs ${defenderName}: attacker produced ${A.troopsProduced} troops but none of them ` +
        `ever resolved an attack (defender combat stats all zero) — troops are vanishing before arrival`);
      if (B.keepDestroyedAtT !== null) {
        assert.ok(B.keepDestroyedAtT >= 60,
          `${troopKey} alone destroyed ${defenderName}'s keep in ${B.keepDestroyedAtT}s — ` +
          `far too fast for a single troop type, check its stats/multipliers`);
      }
      const keepHP = currentHP(B.keep, content.ECONOMY.duration, content);
      assert.ok(keepHP >= 0 && Number.isFinite(keepHP), `${troopKey}: defender keepHP invalid: ${keepHP}`);
    }
  }
});

// Most matches will hit this path, not just in this tool: real players make
// mixed, imperfect decisions, so time-up is a normal outcome, not an edge
// case. Every matchup must resolve to a well-formed result, and a mirror
// matchup (already proven symmetric above) must always draw — if it didn't,
// the tiebreak logic itself would be asymmetric even though the underlying
// match state is identical.
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

test("regression baseline: current adopted numbers (update this snapshot deliberately, not accidentally)", () => {
  const { A, B } = run("def", "def");
  // def vs def is the slowest, most stable matchup — good canary for any
  // accidental change to defense HP, repair cost, or troop numbers.
  assert.equal(A.keepDestroyedAtT, null, "def vs def now ends in death, not mutual survival — did defense/troop numbers change?");
});
