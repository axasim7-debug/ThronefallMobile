"use strict";

// Generic stat profiles for testing the combat MATH only — these are not
// meant to become permanent troop types. Per the actual design decision:
// every real card will carry its own bespoke stats and abilities, and there
// is no rock-paper-scissors type system in the engine. "Tank"/"skirmisher"/
// "ranged" here are just readable labels for a few different stat shapes,
// picked to stress different parts of the model (melee brawling, focus
// fire, kiting) — nothing about the engine knows or cares what a unit is
// called.

const UNIT_PROFILES = {
  tank: { hp: 300, dps: 15, range: 1.2, speed: 2.0 },
  skirmisher: { hp: 80, dps: 25, range: 1.2, speed: 4.0 },
  ranged: { hp: 60, dps: 20, range: 5.0, speed: 2.2 },
};

const STRUCTURE_PROFILES = {
  tower: { hp: 700, dps: 20, range: 6.0 },
  keep: { hp: 1200, dps: 30, range: 3.5 },
  // negligible counter-damage on purpose — used to isolate pure DPS-stacking
  // math in tests without an attacker's own death confounding the measurement
  dummy: { hp: 300, dps: 0, range: 0 },
};

module.exports = { UNIT_PROFILES, STRUCTURE_PROFILES };
