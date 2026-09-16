"use strict";
// Build-order archetypes used to stress-test the economy/combat numbers.
// Each exposes `decide(player, content)`, called whenever the player's
// single build slot is free, and may start at most one action.
const { startRepair } = require("./engine");

// launch roster fields all 3 commanders (there's no "pick 1 of 3" — squads
// of 3-4 are the point; see docs/GAME_DESIGN.md §3.3)
const FULL_SQUAD = ["warlord", "guardian", "shadow"];

const ECO = {
  name: "eco",
  squad: FULL_SQUAD,
  decide(pl, content) {
    const { farm, barracks } = content.BUILDINGS;
    if (pl.farms.length < farm.maxCount && pl.gold >= farm.cost) {
      pl.gold -= farm.cost; pl.buildBusy = "farm"; pl.buildTimer = farm.buildTime; return;
    }
    if (pl.farms.length >= farm.maxCount && !pl.hasBarracks && pl.gold >= barracks.cost) {
      pl.gold -= barracks.cost; pl.buildBusy = "barracks"; pl.buildTimer = barracks.buildTime;
    }
  },
};

const DEF = {
  name: "def",
  squad: FULL_SQUAD,
  // With no wall to build (removed — see docs/PROGRESS.md), "defensive"
  // no longer means "invest in an extra structure before barracks": the
  // only buildable structures are farm/barracks, both of which "eco" and
  // "atk" already stress-test at their own extremes. This archetype's
  // distinguishing trait now is upkeep discipline instead — one farm for a
  // small cushion, then barracks, then a repair ALWAYS takes the idle build
  // slot over spending on anything else once a tower is damaged.
  decide(pl, content, t) {
    const { farm, barracks } = content.BUILDINGS;
    if (startRepair(pl, content, t)) return;
    if (pl.farms.length < 1 && pl.gold >= farm.cost) {
      pl.gold -= farm.cost; pl.buildBusy = "farm"; pl.buildTimer = farm.buildTime; return;
    }
    if (!pl.hasBarracks && pl.gold >= barracks.cost) {
      pl.gold -= barracks.cost; pl.buildBusy = "barracks"; pl.buildTimer = barracks.buildTime;
    }
  },
};

const ATK = {
  name: "atk",
  squad: FULL_SQUAD,
  decide(pl, content) {
    const { barracks } = content.BUILDINGS;
    if (!pl.hasBarracks && pl.gold >= barracks.cost) {
      pl.gold -= barracks.cost; pl.buildBusy = "barracks"; pl.buildTimer = barracks.buildTime;
    }
  },
};

const ALL = { eco: ECO, def: DEF, atk: ATK };

module.exports = { ECO, DEF, ATK, ALL };
