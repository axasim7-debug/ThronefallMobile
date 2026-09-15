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
  farm: { cost: 150, buildTime: 8, incomeBonus: 5, hp: 150, maxCount: 2 },
  barracks: { cost: 200, buildTime: 12 },
  wall: {
    cost: 80, buildTime: 5, hpPerSegment: 120, maxSegments: 2,
    dps: 25, engageTime: 2, // damage it deals to a passing troop, and for how long
  },
};

// Baseline defense every player starts a match with (not built in-match —
// this is the loadout; meta-progression can raise these later).
const DEFENSE = {
  towerCount: 2,
  tower: { hp: 700, dps: 20, engageTime: 5 },
  // a surviving tower still takes a reduced shot at troops passing through
  // a lane whose own tower has already fallen
  crossFireFactor: 0.45,
  keep: { hp: 1200, dps: 30, engageTime: 1.5 },
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
