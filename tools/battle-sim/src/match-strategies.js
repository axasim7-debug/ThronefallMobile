"use strict";
// Build-order archetypes for the full-match scenario — same shape and same
// intent as tools/balance-sim/src/strategies.js's eco/def/atk (and mirrors
// the post-wall-removal "def" redesign there: repair-first discipline
// instead of investing in a wall that no longer exists — see
// docs/PROGRESS.md). Kept as its own file rather than reusing balance-sim's
// directly because these call match.js's startBuild/startRepair, not
// balance-sim's engine.

const { startBuild, startRepair } = require("./match");
const content = require("./match-content");

const ECO = {
  name: "eco",
  decide(pl, t) {
    const { farm, barracks } = content.BUILDINGS;
    if (pl.farms < farm.maxCount && pl.gold >= farm.cost) { startBuild(pl, "farm"); return; }
    if (pl.farms >= farm.maxCount && !pl.hasBarracks && pl.gold >= barracks.cost) startBuild(pl, "barracks");
  },
};

const DEF = {
  name: "def",
  decide(pl, t) {
    const { barracks } = content.BUILDINGS;
    if (startRepair(pl, t)) return;
    if (pl.farms < 1 && startBuild(pl, "farm")) return;
    if (!pl.hasBarracks && pl.gold >= barracks.cost) startBuild(pl, "barracks");
  },
};

const ATK = {
  name: "atk",
  decide(pl, t) {
    const { barracks } = content.BUILDINGS;
    if (!pl.hasBarracks && pl.gold >= barracks.cost) startBuild(pl, "barracks");
  },
};

const ALL = { eco: ECO, def: DEF, atk: ATK };

module.exports = { ECO, DEF, ATK, ALL };
