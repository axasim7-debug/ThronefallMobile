"use strict";
// The current "card" data for the match economy + combat balance simulator.
// Add new heroes/troops/buildings HERE as new entries — never by editing
// engine.js. See ../README.md for the workflow.

const ECONOMY = {
  duration: 360, // seconds per round
  startGold: 100,
  baseIncome: 8, // gold/sec, no buildings
};

const BUILDINGS = {
  // farms are a real attack target (like Clash Royale's Elixir Collector):
  // troops that clear the wall+towers burn the nearest surviving farm
  // before they ever reach the keep. Destroying one does two things, not
  // one: removes its future income (as you'd expect), AND claws back a
  // lump of already-banked gold (goldPenalty — a "sacked treasury").
  // Testing showed future-income-loss alone barely moved outcomes: by the
  // time a farm falls, its owner has already banked most of the benefit,
  // so only a retroactive penalty actually offsets a head start economy
  // race. See docs/PROGRESS.md for the full reasoning.
  farm: { cost: 150, buildTime: 8, incomeBonus: 5, hp: 60, goldPenalty: 150, maxCount: 2, assaultEngageTime: 2 },
  barracks: { cost: 200, buildTime: 12 },
  wall: {
    cost: 80, buildTime: 5, hpPerSegment: 120, maxSegments: 2,
    dps: 25, engageTime: 2, // damage it deals to a passing troop, and for how long
  },
};

// Baseline defense every player starts a match with (not built in-match —
// this is the loadout; meta-progression can raise these later).
//
// REINFORCEMENT: towers/keep do not start at full HP. Their effective HP
// ceiling ramps from `startFraction` of max up to 100% over `rampSeconds`,
// unmanned/unreinforced early on. This is the fix for the "economy-first
// never takes real risk" issue found in tools/balance-sim testing (see
// docs/PROGRESS.md): a fresh, un-reinforced defense is genuinely softer in
// the first ~90s, so an early army has a real window to punish a slow
// start — not just late-game siege power once both sides are maxed out.
const DEFENSE = {
  towerCount: 2,
  tower: { hp: 700, dps: 20, engageTime: 5 },
  // a surviving tower still takes a reduced shot at troops passing through
  // a lane whose own tower has already fallen
  crossFireFactor: 0.45,
  keep: { hp: 1200, dps: 30, engageTime: 1.5 },
  reinforce: { startFraction: 0.35, rampSeconds: 90 },
};

// Repair: rebuilds a damaged wall/tower. cost/time scale with missing HP.
const REPAIR = { costPerMissingHP: 0.6, timePerMissingHP: 0.08 };

// Troop cards. hpFactor/dpsFactor multiply the troop's own gold cost to get
// its combat stats — keeps a troop's "value" legible as a single number
// (its cost) while still giving it real HP/damage for the combat model.
const TROOPS = {
  t1: { name: "T1 — جندي أساسي", cost: 50, buildTime: 3, hpFactor: 2, dpsFactor: 0.6, marchTime: 4 },
};

module.exports = { ECONOMY, BUILDINGS, DEFENSE, REPAIR, TROOPS };
