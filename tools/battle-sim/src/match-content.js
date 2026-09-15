"use strict";
// Real launch-roster numbers for the full-match scenario (economy + the
// continuous positional combat model together) — NOT a new balance pass.
// cost/hpFactor/dpsFactor/marchTime here are the numbers already adopted in
// tools/balance-sim/src/content.js; this file only translates them into
// what the positional model needs (hp/dps/range/speed instead of
// hpFactor/dpsFactor/marchTime). See docs/PROGRESS.md for why this
// full-match pass exists: tools/battle-sim so far only validated isolated
// skirmishes, never economy-paced production sustained over a real match
// duration.

const ECONOMY = { durationSeconds: 360, startGold: 100, baseIncome: 8 };

const BUILDINGS = {
  farm: { cost: 150, buildTime: 8, incomeBonus: 5, maxCount: 2 },
  barracks: { cost: 200, buildTime: 12 },
};

// Real client layout (client/src/scene.ts): PLOT_DEPTH=7.5, LAYOUT fractions
// (wall removed — see docs/PROGRESS.md). Reused verbatim, not re-guessed.
const PLOT_DEPTH = 7.5;
const LAYOUT = { tower: 0.36, econ: 0.58, keep: 0.86 };

// Total straight-line distance a troop actually has to cover in the
// positional model: from its own side's barracks to the enemy's keep,
// unobstructed. This is ONLY a unit-conversion anchor — it turns the old
// model's marchTime (a number that meant "when combat resolves", with no
// real distance behind it) into a speed stat the positional model needs.
// It is not a new balance number.
const MARCH_DISTANCE = LAYOUT.econ * PLOT_DEPTH + LAYOUT.keep * PLOT_DEPTH; // 4.35 + 6.45 = 10.8

// NOTE: engine.js's positional combat only knows hp/dps/range/speed right
// now — it never implemented the old engine's per-troop bypasses/
// damageProfile/defenseResistFactor mechanics (ninja slipping past towers,
// engineer's siege bonus, archer's return-fire resistance, fire's arson
// bonus). Giving those their positional-combat equivalent is a real design
// question (what does "bypass a tower" even mean when a tower's range is
// what actually engages a unit, not a staged order?) — deliberately left
// for its own pass rather than guessed here. All six troops below differ
// ONLY by hp/dps/range/speed for this validation.
function troop(cost, buildTime, marchTime, hpFactor, dpsFactor, range = 1.2) {
  return {
    cost,
    buildTime,
    hp: hpFactor * cost,
    dps: dpsFactor * cost,
    speed: MARCH_DISTANCE / marchTime,
    range,
  };
}

const TROOPS = {
  infantry: troop(60, 3, 6, 3.5, 0.4),
  archer: troop(70, 4, 4, 1.3, 0.6, 4.5),
  cavalry: troop(90, 4, 2, 0.8, 0.75),
  ninja: troop(130, 6, 4, 0.8, 0.5),
  fire: troop(55, 2, 4, 0.5, 0.4),
  engineer: troop(90, 6, 7, 1.8, 0.5),
};

// Fixed baseline defense, same numbers as the shipped engine
// (server/Thronefall.Engine/Content.cs's DefenseConfig).
const DEFENSE = {
  towerCount: 2,
  tower: { hp: 700, dps: 20, range: 6.0 },
  keep: { hp: 1200, dps: 30, range: 3.5 },
};

// Same numbers as the shipped engine's ReinforceConfig: defenses start at
// startFraction of max effective HP and harden to 100% over rampSeconds.
// This was invented specifically to give early aggression a real window
// against an unreinforced defense (see docs/PROGRESS.md) — it turned out to
// be load-bearing here too: the continuous model's real exposure-time
// damage makes full-strength towers from tick 0 nearly unbeatable for a
// lone early unit (see the "def crushes atk" finding this file's test
// suite caught).
const REINFORCE = { startFraction: 0.35, rampSeconds: 90 };

// Same numbers as the shipped engine's RepairConfig — repair cost/time scale
// with missing HP.
const REPAIR = { costPerMissingHp: 0.6, timePerMissingHp: 0.08 };

module.exports = { ECONOMY, BUILDINGS, TROOPS, DEFENSE, REPAIR, REINFORCE, PLOT_DEPTH, LAYOUT, MARCH_DISTANCE };
