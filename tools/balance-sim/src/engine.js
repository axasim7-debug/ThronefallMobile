"use strict";
// Generic match-economy + combat simulation engine. This file should NOT
// need to change when new troops/heroes/buildings are added — those go in
// content.js, and new build-order archetypes go in strategies.js.

// Reinforcement: a structure's effective HP ceiling ramps from
// startFraction*maxHp up to maxHp over rampSeconds. Structures never start
// fully manned — see content.js DEFENSE.reinforce for the rationale.
function ceiling(maxHp, t, content) {
  const { startFraction, rampSeconds } = content.DEFENSE.reinforce;
  const progress = Math.min(1, t / rampSeconds);
  return maxHp * (startFraction + (1 - startFraction) * progress);
}

function currentHP(structure, t, content) {
  if (structure.destroyed) return 0;
  return Math.max(0, ceiling(structure.maxHp, t, content) - structure.damageTaken);
}

function freshStructure(maxHp) {
  return { maxHp, damageTaken: 0, destroyed: false };
}

function initPlayer(strategy, content) {
  return {
    strategy,
    gold: content.ECONOMY.startGold,
    income: content.ECONOMY.baseIncome,
    farms: [],
    wallHP: 0,
    wallMaxHP: 0,
    hasBarracks: false,
    buildBusy: null,
    buildTimer: 0,
    troopBusy: false,
    troopTimer: 0,
    troopKey: null,
    troopsProduced: 0,
    armyValue: 0,
    towers: Array.from({ length: content.DEFENSE.towerCount }, () => freshStructure(content.DEFENSE.tower.hp)),
    keep: freshStructure(content.DEFENSE.keep.hp),
    keepDestroyedAtT: null,
    _repairTarget: null,
    stats: { diedAtWall: 0, stoppedAtTower: 0, reachedKeep: 0, towersLost: 0, repairsDone: 0 },
    barracksT: null,
    firstTroopT: null,
  };
}

function damagedStructure(pl, t, content) {
  if (pl.wallMaxHP > 0 && pl.wallHP < pl.wallMaxHP) return "wall";
  const t1 = pl.towers.find((s) => currentHP(s, t, content) < ceiling(s.maxHp, t, content));
  if (t1) return t1;
  return null;
}

function startRepair(pl, content, t) {
  const need = damagedStructure(pl, t, content);
  if (!need) return false;
  const { costPerMissingHP, timePerMissingHP } = content.REPAIR;
  if (need === "wall") {
    const missing = pl.wallMaxHP - pl.wallHP;
    const cost = Math.ceil(missing * costPerMissingHP);
    if (pl.gold < cost) return false;
    pl.gold -= cost; pl.buildBusy = "repairWall"; pl.buildTimer = Math.ceil(missing * timePerMissingHP);
    return true;
  }
  const missing = ceiling(need.maxHp, t, content) - currentHP(need, t, content);
  const cost = Math.ceil(missing * costPerMissingHP);
  if (pl.gold < cost) return false;
  pl.gold -= cost; pl.buildBusy = "repairTower"; pl.buildTimer = Math.ceil(missing * timePerMissingHP);
  pl._repairTarget = need;
  return true;
}

function startTroop(pl, content, troopKey) {
  if (pl.troopBusy || !pl.hasBarracks) return false;
  const troop = content.TROOPS[troopKey];
  if (pl.gold < troop.cost) return false;
  pl.gold -= troop.cost; pl.troopBusy = true; pl.troopTimer = troop.buildTime; pl.troopKey = troopKey;
  return true;
}

function damageStructure(structure, dmg, t, content) {
  structure.damageTaken += dmg;
  if (!structure.destroyed && currentHP(structure, t, content) <= 0) structure.destroyed = true;
}

function resolveAttack(defender, troop, content, t) {
  if (defender.keepDestroyedAtT !== null) return;
  let hp = troop.hp;
  const { wall } = content.BUILDINGS;
  const { tower, crossFireFactor, keep } = content.DEFENSE;

  if (defender.wallHP > 0) {
    const dmgToTroop = wall.dps * wall.engageTime;
    const dmgToWall = troop.dps * wall.engageTime;
    defender.wallHP = Math.max(0, defender.wallHP - dmgToWall);
    hp -= dmgToTroop;
    if (hp <= 0) { defender.stats.diedAtWall++; return; }
  }

  const alive = defender.towers.filter((s) => !s.destroyed);
  if (alive.length > 0) {
    const primary = alive.reduce((a, b) => (currentHP(a, t, content) <= currentHP(b, t, content) ? a : b));
    const dmgToTroop = tower.dps * tower.engageTime;
    const dmgToTower = troop.dps * tower.engageTime;
    damageStructure(primary, dmgToTower, t, content);
    if (primary.destroyed) defender.stats.towersLost++;
    hp -= dmgToTroop;
    if (hp <= 0 || !primary.destroyed) { defender.stats.stoppedAtTower++; return; }
  }

  const survivors = defender.towers.filter((s) => !s.destroyed);
  if (survivors.length > 0) {
    hp -= tower.dps * crossFireFactor * tower.engageTime;
    if (hp <= 0) { defender.stats.stoppedAtTower++; return; }
  }

  if (hp > 0) {
    defender.stats.reachedKeep++;
    const dmgToKeep = troop.dps * keep.engageTime;
    damageStructure(defender.keep, dmgToKeep, t, content);
    if (defender.keep.destroyed && defender.keepDestroyedAtT === null) defender.keepDestroyedAtT = t;
  }
}

function advanceBuild(pl, content, t) {
  if (!pl.buildBusy) return;
  pl.buildTimer--;
  if (pl.buildTimer > 0) return;
  switch (pl.buildBusy) {
    case "farm": {
      pl.farms.push({ hp: content.BUILDINGS.farm.hp });
      pl.income += content.BUILDINGS.farm.incomeBonus;
      break;
    }
    case "wall":
      pl.wallHP += content.BUILDINGS.wall.hpPerSegment;
      break;
    case "barracks":
      pl.hasBarracks = true;
      pl.barracksT = t;
      break;
    case "repairWall":
      pl.wallHP = pl.wallMaxHP;
      pl.stats.repairsDone++;
      break;
    case "repairTower":
      pl._repairTarget.damageTaken = 0;
      pl._repairTarget.destroyed = false;
      pl._repairTarget = null;
      pl.stats.repairsDone++;
      break;
  }
  pl.buildBusy = null;
}

function advanceTroop(pl, content, t, onSpawn) {
  if (!pl.troopBusy) return;
  pl.troopTimer--;
  if (pl.troopTimer > 0) return;
  const troopDef = content.TROOPS[pl.troopKey];
  pl.troopsProduced++;
  pl.armyValue += troopDef.cost;
  pl.troopBusy = false;
  if (pl.firstTroopT === null) pl.firstTroopT = t;
  onSpawn({
    arriveAt: t + troopDef.marchTime,
    hp: troopDef.hpFactor * troopDef.cost,
    dps: troopDef.dpsFactor * troopDef.cost,
  });
}

/**
 * Simulate one 1v1 match. stratA/stratB are strategy modules (see
 * strategies.js) exposing a `decide(player, content)` that may start a build
 * action, and optionally `pickTroop(player, content)` (defaults to "t1").
 */
function simulate(stratA, stratB, content) {
  const A = initPlayer(stratA.name, content);
  const B = initPlayer(stratB.name, content);
  const arrivalsToA = new Map();
  const arrivalsToB = new Map();
  const duration = content.ECONOMY.duration;

  const queue = (map, arrival) => {
    if (!map.has(arrival.arriveAt)) map.set(arrival.arriveAt, []);
    map.get(arrival.arriveAt).push(arrival);
  };

  for (let t = 0; t <= duration; t++) {
    if (arrivalsToA.has(t)) for (const tr of arrivalsToA.get(t)) resolveAttack(A, tr, content, t);
    if (arrivalsToB.has(t)) for (const tr of arrivalsToB.get(t)) resolveAttack(B, tr, content, t);

    if (t > 0) {
      if (A.keepDestroyedAtT === null) A.gold += A.income;
      if (B.keepDestroyedAtT === null) B.gold += B.income;
      for (const [pl, arrivals] of [[A, arrivalsToB], [B, arrivalsToA]]) {
        if (pl.keepDestroyedAtT !== null) continue;
        advanceBuild(pl, content, t);
        advanceTroop(pl, content, t, (arrival) => queue(arrivals, arrival));
      }
    }

    if (A.keepDestroyedAtT === null) {
      if (!A.buildBusy) stratA.decide(A, content, t);
      if (!A.troopBusy) startTroop(A, content, (stratA.pickTroop && stratA.pickTroop(A, content)) || "t1");
    }
    if (B.keepDestroyedAtT === null) {
      if (!B.buildBusy) stratB.decide(B, content, t);
      if (!B.troopBusy) startTroop(B, content, (stratB.pickTroop && stratB.pickTroop(B, content)) || "t1");
    }
  }

  return { A, B };
}

module.exports = { simulate, initPlayer, startRepair, damagedStructure, currentHP, ceiling };
