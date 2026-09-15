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
  // before they ever reach the keep. Destroying one does two things:
  // removes its future income permanently, AND applies a temporary extra
  // production penalty (disruptionPenalty, for disruptionSeconds) on top.
  // Tried a flat "claw back banked gold" penalty first — it barely moved
  // outcomes, because every strategy here spends close to as fast as it
  // earns, so there's rarely much cash sitting around to grab. A temporary
  // income penalty can't be dodged that way: it hits future production
  // directly. See docs/PROGRESS.md for the full history.
  farm: {
    cost: 150, buildTime: 8, incomeBonus: 5, hp: 60, maxCount: 2, assaultEngageTime: 2,
    disruptionPenalty: 6, disruptionSeconds: 40,
  },
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
// See engine.js's header comment for what bypasses/damageProfile/
// defenseResistFactor do. These are the launch roster (6 troops) — first
// pass, expect numbers to move once matchup-tested against each other.
const TROOPS = {
  infantry: {
    name: "مشاة — درع ثقيل", cost: 60, buildTime: 3, marchTime: 6,
    hpFactor: 3.5, dpsFactor: 0.4, // tanky, slow, hits soft — the default "soak" unit
  },
  archer: {
    name: "رماة — مدى بعيد", cost: 70, buildTime: 4, marchTime: 4,
    hpFactor: 1.3, dpsFactor: 0.6, defenseResistFactor: 0.7, // shoots from range: takes less return fire
  },
  cavalry: {
    // v1 (cost80/dps1.1/hp0.9) won solo mono-troop runs by a huge margin
    // (149-169s vs 218-267s for everything else) — tested and retuned.
    name: "فرسان — صدمة سريعة", cost: 90, buildTime: 4, marchTime: 2,
    hpFactor: 0.8, dpsFactor: 0.75, // still the fastest, no longer the strongest outright
  },
  ninja: {
    name: "نينجا — يتسلق الأسوار", cost: 130, buildTime: 6, marchTime: 4,
    hpFactor: 0.8, dpsFactor: 0.5,
    bypasses: ["wall", "tower"], // climbs straight past both — a costly precision infiltrator, not a brawler
  },
  fire: {
    name: "حارق — يشعل ما يصل إليه", cost: 55, buildTime: 2, marchTime: 4,
    hpFactor: 0.5, dpsFactor: 0.4, // dies almost instantly to any real defense
    damageProfile: { farm: 3, keep: 2.5 }, // catastrophic if it ever gets inside unanswered
  },
  engineer: {
    name: "مهندس حصار — يهدم الدفاع", cost: 90, buildTime: 6, marchTime: 7,
    hpFactor: 1.8, dpsFactor: 0.5,
    damageProfile: { wall: 2.5, tower: 2 }, // built to punish a wall/tower-heavy defense specifically
  },
};

// Commander rage economy: a 10-point bar per commander, filling at ONE
// fixed rate — same for every commander, every player, F2P included. This
// can NEVER be sped up by a purchase or an upgrade; that would translate
// payment directly into "more skill casts," breaking the same match-time
// fairness rule the whole economy design rests on (docs/GAME_DESIGN.md §4).
// A commander fires its rage skill as soon as it can afford the cost
// (AI policy for this test pass — a real player could hold for a bigger
// window instead); cost is *subtracted*, not reset to 0, so the bar keeps
// building from the remainder.
const RAGE = { max: 10, fillRatePerSec: 10 / 90 }; // full bar from empty in 90s

// Commander cards. Each has exactly ONE manually-triggered ability (the
// rage skill — the only skill players actively manage) plus 3 passives,
// always-on stat buffs from the same combat axis as the rage skill. A
// launch squad fields all 3 commanders.
//
// Numbers here are a single representative tier (~mid skill-level), NOT
// yet the full 1-5 upgrade curve + mastery bonus from docs/GAME_DESIGN.md
// §3.3 — deliberately deferred until this base shape is proven not to
// break balance (same "prove the mechanism before the granular curve"
// order used for the rage economy itself).
//
// HARD RULE: no passive may touch RAGE.fillRatePerSec or a rageCost. That
// would let card-leveling speed (which payment CAN accelerate, same as
// any other card) indirectly buy more skill casts — exactly the loophole
// the fixed-rate rule exists to close. Passives may only affect combat
// stats (troop dps/hp/marchTime, structure damage taken) or a rage
// skill's EFFECT MAGNITUDE once cast, never how often it can be cast.
const COMMANDERS = {
  warlord: {
    name: "القائد المدمّر — الهجمة الكاسحة",
    rageCost: 6, rageEffect: { kind: "damageStructure", target: "enemyTower", amount: 320 },
    passives: {
      troopDpsBonus: { troop: "cavalry", mult: 1.15 }, // +15% cavalry damage
      troopDpsBonus2: { troop: "engineer", mult: 1.15 }, // +15% engineer damage
      rageEffectBonus: 1.2, // +20% to the rage skill's own damage
    },
  },
  guardian: {
    name: "الحارسة — الدرع الحصين",
    rageCost: 6, rageEffect: { kind: "repairStructure", target: "ownDamaged", amount: 260 },
    passives: {
      troopHpBonus: { troop: "infantry", mult: 1.2 }, // +20% infantry HP
      structureDamageTakenMult: 0.9, // own structures take 10% less damage
      rageEffectBonus: 1.2, // +20% to the rage skill's own heal
    },
  },
  shadow: {
    name: "الظل — الغارة الخاطفة",
    rageCost: 6, rageEffect: { kind: "damageStructure", target: "enemyFarm", amount: 200 },
    passives: {
      marchTimeMult: { troops: ["ninja", "fire"], mult: 0.85 }, // -15% march time
      infiltratorResistMult: { troops: ["ninja", "fire"], mult: 0.85 }, // -15% return damage taken
      rageEffectBonus: 1.2, // +20% to the rage skill's own damage
    },
  },
};

module.exports = { ECONOMY, BUILDINGS, DEFENSE, REPAIR, TROOPS, RAGE, COMMANDERS };
