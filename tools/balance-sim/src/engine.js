"use strict";
// Generic match-economy + combat simulation engine.
//
// A troop's combat behavior is data-driven via three optional fields on its
// content.js entry — most new troops (even unusual ones) should only need
// these, not a change to this file:
//   - bypasses: string[]   stages this troop skips entirely, e.g. ["wall",
//                          "tower"] for a wall-climbing infiltrator
//   - damageProfile: {}    per-target-type damage multiplier, e.g.
//                          { wall: 2, tower: 2 } for a siege specialist, or
//                          { farm: 3, keep: 3 } for an arsonist
//   - defenseResistFactor  multiplier on the return damage structures deal
//                          to this troop (e.g. 0.7 for a ranged attacker)
// A genuinely new mechanic (troop-vs-troop combat, DOT, an ability that
// triggers on other troops) is the signal this file needs to change — that
// should be a deliberate decision, not an accident. See ../README.md.

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
    disruptions: [], // temporary income penalties from raided farms: {amount, until}
    towers: Array.from({ length: content.DEFENSE.towerCount }, () => freshStructure(content.DEFENSE.tower.hp)),
    keep: freshStructure(content.DEFENSE.keep.hp),
    keepDestroyedAtT: null,
    _repairTarget: null,
    stats: { diedAtWall: 0, stoppedAtTower: 0, reachedKeep: 0, towersLost: 0, repairsDone: 0, farmsRaided: 0 },
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

// dmg multiplier this troop deals to a given target type ("wall"/"tower"/
// "farm"/"keep"); defaults to 1 for anything not in the troop's profile
function dmgMult(troop, targetType) {
  return (troop.damageProfile && troop.damageProfile[targetType]) ?? 1;
}

// multiplier applied to damage a defensive structure deals BACK to this
// troop (e.g. an archer's defenseResistFactor < 1 — takes less return fire)
function resistMult(troop) {
  return troop.defenseResistFactor ?? 1;
}

function resolveAttack(defender, troop, content, t) {
  if (defender.keepDestroyedAtT !== null) return;
  let hp = troop.hp;
  const { wall } = content.BUILDINGS;
  const { tower, crossFireFactor, keep } = content.DEFENSE;
  const bypasses = troop.bypasses || [];

  if (!bypasses.includes("wall") && defender.wallHP > 0) {
    const dmgToTroop = wall.dps * resistMult(troop) * wall.engageTime;
    const dmgToWall = troop.dps * dmgMult(troop, "wall") * wall.engageTime;
    defender.wallHP = Math.max(0, defender.wallHP - dmgToWall);
    hp -= dmgToTroop;
    if (hp <= 0) { defender.stats.diedAtWall++; return; }
  }

  if (!bypasses.includes("tower")) {
    const alive = defender.towers.filter((s) => !s.destroyed);
    if (alive.length > 0) {
      const primary = alive.reduce((a, b) => (currentHP(a, t, content) <= currentHP(b, t, content) ? a : b));
      const dmgToTroop = tower.dps * resistMult(troop) * tower.engageTime;
      const dmgToTower = troop.dps * dmgMult(troop, "tower") * tower.engageTime;
      damageStructure(primary, dmgToTower, t, content);
      if (primary.destroyed) defender.stats.towersLost++;
      hp -= dmgToTroop;
      if (hp <= 0 || !primary.destroyed) { defender.stats.stoppedAtTower++; return; }
    }

    const survivors = defender.towers.filter((s) => !s.destroyed);
    if (survivors.length > 0) {
      hp -= tower.dps * resistMult(troop) * crossFireFactor * tower.engageTime;
      if (hp <= 0) { defender.stats.stoppedAtTower++; return; }
    }
  }

  if (hp <= 0) return;

  // troops that broke through go after the economy first — an unwalled
  // farm is a real, undefended target, same as Clash Royale's collector
  const farm = content.BUILDINGS.farm;
  const targetFarm = defender.farms.find((f) => f.hp > 0);
  if (targetFarm) {
    defender.stats.farmsRaided++;
    targetFarm.hp = Math.max(0, targetFarm.hp - troop.dps * dmgMult(troop, "farm") * farm.assaultEngageTime);
    if (targetFarm.hp === 0 && !targetFarm.incomeRemoved) {
      defender.income -= farm.incomeBonus;
      // a flat gold grab gets clamped to ~0 by any strategy that spends as
      // fast as it earns (every archetype here does) — it can't claw back
      // gold already converted into troops. A temporary production penalty
      // can't be dodged that way: it hits future income, not a cash balance.
      if (farm.disruptionPenalty && farm.disruptionSeconds) {
        defender.disruptions.push({ amount: farm.disruptionPenalty, until: t + farm.disruptionSeconds });
      }
      targetFarm.incomeRemoved = true;
    }
    return;
  }

  defender.stats.reachedKeep++;
  const dmgToKeep = troop.dps * dmgMult(troop, "keep") * keep.engageTime;
  damageStructure(defender.keep, dmgToKeep, t, content);
  if (defender.keep.destroyed && defender.keepDestroyedAtT === null) defender.keepDestroyedAtT = t;
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
    bypasses: troopDef.bypasses,
    damageProfile: troopDef.damageProfile,
    defenseResistFactor: troopDef.defenseResistFactor,
  });
}

/**
 * Simulate one 1v1 match. stratA/stratB are strategy modules (see
 * strategies.js) exposing a `decide(player, content)` that may start a build
 * action, and optionally `pickTroop(player, content)` (defaults to "infantry").
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
      for (const pl of [A, B]) {
        if (pl.keepDestroyedAtT !== null) continue;
        pl.disruptions = pl.disruptions.filter((d) => d.until > t);
        const penalty = pl.disruptions.reduce((sum, d) => sum + d.amount, 0);
        pl.gold += Math.max(1, pl.income - penalty); // production never fully stalls
      }
      for (const [pl, arrivals] of [[A, arrivalsToB], [B, arrivalsToA]]) {
        if (pl.keepDestroyedAtT !== null) continue;
        advanceBuild(pl, content, t);
        advanceTroop(pl, content, t, (arrival) => queue(arrivals, arrival));
      }
    }

    if (A.keepDestroyedAtT === null) {
      if (!A.buildBusy) stratA.decide(A, content, t);
      if (!A.troopBusy) startTroop(A, content, (stratA.pickTroop && stratA.pickTroop(A, content)) || "infantry");
    }
    if (B.keepDestroyedAtT === null) {
      if (!B.buildBusy) stratB.decide(B, content, t);
      if (!B.troopBusy) startTroop(B, content, (stratB.pickTroop && stratB.pickTroop(B, content)) || "infantry");
    }
  }

  return { A, B };
}

module.exports = { simulate, initPlayer, startRepair, damagedStructure, currentHP, ceiling };
