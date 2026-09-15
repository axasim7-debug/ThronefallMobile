"use strict";
// Full-match scenario: economy (gold, build orders, troop training) driving
// the continuous positional combat model in engine.js, sustained over a
// realistic match duration — not just an isolated skirmish. This is the
// validation tools/battle-sim's own header comment said was still missing
// before the new combat model could be considered ready to port. See
// docs/PROGRESS.md.
//
// Known deliberate simplifications for this first pass (not oversights —
// see docs/PROGRESS.md for the reasoning):
//   - farms are pure economy (income) — not physical Battle structures a
//     troop can path into or attack. The positional engine's targeting is
//     purely nearest-in-range, not a staged wall/tower/farm/keep order, so
//     "farm raiding" needs its own deliberate design pass, not a guess.
//   - bots never retreat or reposition once a troop is sent — same baseline
//     aggression the OLD model's eco/def/atk archetypes always had; this
//     pass is about economy/combat PACING, not tactical play.
//
// Reinforcement (defenses start at REINFORCE.startFraction of max effective
// HP and harden to 100% over REINFORCE.rampSeconds) WAS initially left out
// as "just" a simplification, but a first test run proved it load-bearing:
// full-strength towers from tick 0, combined with the new model's real
// exposure-time damage (a slow unit sits in a tower's 6.0 range far longer
// than the old model's flat 5s engageTime ever assumed), made ANY early
// solo attack unwinnable — exactly the pathology reinforcement was already
// invented to solve once before (see docs/PROGRESS.md). It's ported here
// faithfully, not re-tuned: same startFraction/rampSeconds the shipped
// engine uses.

const { Battle, DEFAULT_DT } = require("./engine");
const content = require("./match-content");

function buildDefense(battle, side, direction) {
  const towerZ = direction * content.LAYOUT.tower * content.PLOT_DEPTH;
  const keepZ = direction * content.LAYOUT.keep * content.PLOT_DEPTH;
  const towerIds = [-3, 3].map((x) =>
    battle.addStructure({ side, x, z: towerZ, ...content.DEFENSE.tower, key: "tower" }),
  );
  const keepId = battle.addStructure({ side, x: 0, z: keepZ, ...content.DEFENSE.keep, key: "keep" });
  return { towerIds, keepId };
}

function barracksAnchor(direction) {
  return { x: 0, z: direction * content.LAYOUT.econ * content.PLOT_DEPTH };
}
function keepAnchor(direction) {
  return { x: 0, z: direction * content.LAYOUT.keep * content.PLOT_DEPTH };
}

function reinforcementCeiling(maxHp, t) {
  const progress = Math.min(1, t / content.REINFORCE.rampSeconds);
  return maxHp * (content.REINFORCE.startFraction + (1 - content.REINFORCE.startFraction) * progress);
}

class MatchPlayer {
  constructor(side, direction, strategy, battle, defense) {
    this.side = side;
    this.direction = direction;
    this.strategy = strategy;
    this.battle = battle;
    this.towerIds = defense.towerIds;
    this.keepId = defense.keepId;

    this.gold = content.ECONOMY.startGold;
    this.income = content.ECONOMY.baseIncome;
    this.farms = 0;
    this.hasBarracks = false;
    this.buildBusy = null; // "farm" | "barracks" | "repair"
    this.buildTimer = 0;
    this.repairTargetId = null;
    this.troopBusy = false;
    this.troopTimer = 0;
    this.troopKey = null;
    this.troopsProduced = 0;
    this.barracksT = null;

    // reinforcement bookkeeping: cumulative REAL combat damage taken, kept
    // separate from the structure's own (ceiling-suppressed) raw hp — see
    // the header comment on reinforcement.
    this.damageTaken = new Map();
    for (const s of this.myStructures()) {
      this.damageTaken.set(s.id, 0);
      s.hp = reinforcementCeiling(s.maxHp, 0); // soften starting HP immediately
    }
  }

  myStructures() {
    return [...this.towerIds.map((id) => this.battle.structures.get(id)), this.battle.structures.get(this.keepId)];
  }

  /** Recompute each of this side's structures' effective HP against the
   * rising reinforcement ceiling, after combat for tick `t` has resolved.
   * Skips anything already destroyed — reinforcement never revives a
   * structure the engine already declared dead, same as the old engine. */
  applyReinforcement(t) {
    for (const s of this.myStructures()) {
      if (s.destroyed) continue;
      const prevCeiling = reinforcementCeiling(s.maxHp, t - 1);
      const dealtThisTick = Math.max(0, prevCeiling - s.hp);
      const dt = this.damageTaken.get(s.id) + dealtThisTick;
      this.damageTaken.set(s.id, dt);
      s.hp = Math.max(0, reinforcementCeiling(s.maxHp, t) - dt);
    }
  }
}

function startRepair(pl, t) {
  if (pl.buildBusy) return false;
  const target = pl.myStructures().find((s) => !s.destroyed && s.hp < reinforcementCeiling(s.maxHp, t));
  if (!target) return false;
  const missing = reinforcementCeiling(target.maxHp, t) - target.hp;
  const cost = Math.ceil(missing * content.REPAIR.costPerMissingHp);
  if (pl.gold < cost) return false;
  pl.gold -= cost;
  pl.buildBusy = "repair";
  pl.buildTimer = Math.ceil(missing * content.REPAIR.timePerMissingHp);
  pl.repairTargetId = target.id;
  return true;
}

function startBuild(pl, building) {
  if (pl.buildBusy) return false;
  if (building === "farm") {
    const farm = content.BUILDINGS.farm;
    if (pl.farms >= farm.maxCount || pl.gold < farm.cost) return false;
    pl.gold -= farm.cost;
    pl.buildBusy = "farm";
    pl.buildTimer = farm.buildTime;
    return true;
  }
  if (building === "barracks") {
    const barracks = content.BUILDINGS.barracks;
    if (pl.hasBarracks || pl.gold < barracks.cost) return false;
    pl.gold -= barracks.cost;
    pl.buildBusy = "barracks";
    pl.buildTimer = barracks.buildTime;
    return true;
  }
  return false;
}

function startTroop(pl, troopKey) {
  if (pl.troopBusy || !pl.hasBarracks) return false;
  const troop = content.TROOPS[troopKey];
  if (pl.gold < troop.cost) return false;
  pl.gold -= troop.cost;
  pl.troopBusy = true;
  pl.troopTimer = troop.buildTime;
  pl.troopKey = troopKey;
  return true;
}

function advanceBuild(pl, t) {
  if (!pl.buildBusy) return;
  pl.buildTimer--;
  if (pl.buildTimer > 0) return;
  if (pl.buildBusy === "farm") {
    pl.farms++;
    pl.income += content.BUILDINGS.farm.incomeBonus;
  } else if (pl.buildBusy === "barracks") {
    pl.hasBarracks = true;
    pl.barracksT = t;
  } else if (pl.buildBusy === "repair") {
    const target = pl.battle.structures.get(pl.repairTargetId);
    // restore to the CURRENT reinforcement ceiling, not raw maxHp — a
    // repaired tower shouldn't leapfrog the ramp everyone else is still
    // subject to (same as the old engine: repair zeroes DamageTaken, not
    // MaxHp itself).
    pl.damageTaken.set(target.id, 0);
    target.hp = reinforcementCeiling(target.maxHp, t);
    target.destroyed = false;
    pl.repairTargetId = null;
  }
  pl.buildBusy = null;
}

function advanceTroop(pl, enemy, t) {
  if (!pl.troopBusy) return;
  pl.troopTimer--;
  if (pl.troopTimer > 0) return;
  const troopDef = content.TROOPS[pl.troopKey];
  pl.troopsProduced++;
  pl.troopBusy = false;

  const spawn = barracksAnchor(pl.direction);
  const target = keepAnchor(enemy.direction);
  const id = pl.battle.addUnit({
    side: pl.side,
    x: spawn.x,
    z: spawn.z,
    hp: troopDef.hp,
    dps: troopDef.dps,
    range: troopDef.range,
    speed: troopDef.speed,
    key: pl.troopKey,
  });
  pl.battle.moveUnit(id, target.x, target.z); // bots commit — no retreat, see header comment
}

/**
 * Simulate one full 1v1 match. stratA/stratB expose `decide(player, t)`
 * (may call startBuild/startRepair once) and optionally `pickTroop(player)`
 * (defaults to "infantry"), same shape as tools/balance-sim/src/strategies.js
 * on purpose — these are the same archetypes, ported.
 */
function simulateMatch(stratA, stratB) {
  const battle = new Battle();
  const defA = buildDefense(battle, "A", -1);
  const defB = buildDefense(battle, "B", 1);
  const A = new MatchPlayer("A", -1, stratA, battle, defA);
  const B = new MatchPlayer("B", 1, stratB, battle, defB);

  const duration = content.ECONOMY.durationSeconds;
  const subStepsPerSecond = Math.round(1 / DEFAULT_DT);

  for (let t = 0; t <= duration; t++) {
    if (t > 0) {
      for (let i = 0; i < subStepsPerSecond; i++) battle.step();

      A.applyReinforcement(t);
      B.applyReinforcement(t);

      for (const [pl, enemy] of [[A, B], [B, A]]) {
        if (isKeepDestroyed(battle, pl)) continue;
        pl.gold += pl.income;
        advanceBuild(pl, t);
        advanceTroop(pl, enemy, t);
      }
    }

    for (const [pl, enemy] of [[A, B], [B, A]]) {
      if (isKeepDestroyed(battle, pl)) continue;
      if (!pl.buildBusy) pl.strategy.decide(pl, t);
      if (!pl.troopBusy) startTroop(pl, (pl.strategy.pickTroop && pl.strategy.pickTroop(pl)) || "infantry");
    }
  }

  return { battle, A, B, result: determineWinner(battle, A, B) };
}

function isKeepDestroyed(battle, pl) {
  return battle.structures.get(pl.keepId).destroyed;
}

function keepDestroyedAtT(battle, pl) {
  const event = battle.log.find((e) => e.event === "structureDestroyed" && e.side === pl.side && e.key === "keep");
  return event ? event.t : null;
}

function towersLost(battle, pl) {
  return pl.towerIds.filter((id) => battle.structures.get(id).destroyed).length;
}

function determineWinner(battle, A, B) {
  const aDied = keepDestroyedAtT(battle, A);
  const bDied = keepDestroyedAtT(battle, B);
  const duration = content.ECONOMY.durationSeconds;

  if (aDied !== null && bDied === null) return { winner: "B", tiebreak: "keep-kill" };
  if (bDied !== null && aDied === null) return { winner: "A", tiebreak: "keep-kill" };
  if (aDied !== null && bDied !== null) {
    if (aDied === bDied) return { winner: "draw", tiebreak: "mutual-destruction-same-tick" };
    return { winner: aDied > bDied ? "A" : "B", tiebreak: "mutual-destruction-timing" };
  }
  const aTowersLostCount = towersLost(battle, A);
  const bTowersLostCount = towersLost(battle, B);
  if (aTowersLostCount !== bTowersLostCount) {
    return { winner: bTowersLostCount > aTowersLostCount ? "A" : "B", tiebreak: "towers-destroyed" };
  }
  const aKeepFraction = battle.structures.get(A.keepId).hp / content.DEFENSE.keep.hp;
  const bKeepFraction = battle.structures.get(B.keepId).hp / content.DEFENSE.keep.hp;
  if (aKeepFraction !== bKeepFraction) {
    return { winner: aKeepFraction > bKeepFraction ? "A" : "B", tiebreak: "own-keep-hp-pct" };
  }
  return { winner: "draw", tiebreak: "true-draw" };
}

module.exports = { simulateMatch, startBuild, startRepair, keepDestroyedAtT, towersLost };
