"use strict";
// Build-order archetypes used to stress-test the economy/combat numbers.
// Each exposes `decide(player, content)`, called whenever the player's
// single build slot is free, and may start at most one action.
const { startRepair } = require("./engine");

const ECO = {
  name: "eco",
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
  decide(pl, content) {
    const { wall, barracks } = content.BUILDINGS;
    // repairs only compete for the idle build slot once the initial
    // wall -> barracks order is done, so they never preempt reaching barracks
    if (pl.hasBarracks && startRepair(pl, content)) return;
    if (pl.wallMaxHP < wall.maxSegments * wall.hpPerSegment && pl.gold >= wall.cost) {
      pl.wallMaxHP += wall.hpPerSegment;
      pl.gold -= wall.cost; pl.buildBusy = "wall"; pl.buildTimer = wall.buildTime; return;
    }
    if (pl.wallMaxHP >= wall.maxSegments * wall.hpPerSegment && !pl.hasBarracks && pl.gold >= barracks.cost) {
      pl.gold -= barracks.cost; pl.buildBusy = "barracks"; pl.buildTimer = barracks.buildTime;
    }
  },
};

const ATK = {
  name: "atk",
  decide(pl, content) {
    const { barracks } = content.BUILDINGS;
    if (!pl.hasBarracks && pl.gold >= barracks.cost) {
      pl.gold -= barracks.cost; pl.buildBusy = "barracks"; pl.buildTimer = barracks.buildTime;
    }
  },
};

const ALL = { eco: ECO, def: DEF, atk: ATK };

module.exports = { ECO, DEF, ATK, ALL };
