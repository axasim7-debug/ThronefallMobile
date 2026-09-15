"use strict";

// Prints the actual numbers behind each test scenario — passing assertions
// alone don't prove the model FEELS right, only that it's internally
// consistent. This is the "look at it from another angle" pass.

const { Battle, distance } = require("../src/engine");
const { UNIT_PROFILES, STRUCTURE_PROFILES } = require("../src/content");

function timeToKill(attackerCount) {
  const b = new Battle();
  const targetId = b.addStructure({ side: "B", x: 0, z: 0, ...STRUCTURE_PROFILES.dummy });
  for (let i = 0; i < attackerCount; i++) {
    b.addUnit({ side: "A", x: 0.3 * i, z: 1.0, ...UNIT_PROFILES.skirmisher });
  }
  let ticks = 0;
  while (!b.structures.get(targetId).destroyed && ticks < 2000) { b.step(); ticks++; }
  return { time: b.time, timedOut: ticks >= 2000 };
}

console.log("--- focus fire (dummy target, negligible counter-damage) ---");
console.log(`dummy hp=${STRUCTURE_PROFILES.dummy.hp}, skirmisher dps=${UNIT_PROFILES.skirmisher.dps}`);
const r1 = timeToKill(1), r3 = timeToKill(3);
console.log(`1 attacker:  ${r1.time.toFixed(2)}s${r1.timedOut ? " (TIMED OUT — bogus)" : ""}  (naive expectation: ${(STRUCTURE_PROFILES.dummy.hp / UNIT_PROFILES.skirmisher.dps).toFixed(2)}s)`);
console.log(`3 attackers: ${r3.time.toFixed(2)}s${r3.timedOut ? " (TIMED OUT — bogus)" : ""}  (naive expectation: ${(STRUCTURE_PROFILES.dummy.hp / (3 * UNIT_PROFILES.skirmisher.dps)).toFixed(2)}s)`);

console.log("\n--- real finding: lone skirmisher vs tank (NOT a dummy) ---");
{
  const b = new Battle();
  const skirmisher = b.addUnit({ side: "A", x: 0, z: 1.0, ...UNIT_PROFILES.skirmisher });
  const tank = b.addUnit({ side: "B", x: 0, z: 0, ...UNIT_PROFILES.tank });
  let ticks = 0;
  while (b.units.get(skirmisher).alive && b.units.get(tank).alive && ticks < 2000) { b.step(); ticks++; }
  const s = b.units.get(skirmisher), t = b.units.get(tank);
  console.log(`skirmisher(hp=${UNIT_PROFILES.skirmisher.hp},dps=${UNIT_PROFILES.skirmisher.dps}) vs tank(hp=${UNIT_PROFILES.tank.hp},dps=${UNIT_PROFILES.tank.dps})`);
  console.log(`  ended at t=${b.time.toFixed(2)}s — skirmisher alive=${s.alive}, tank alive=${t.alive} hp=${t.hp.toFixed(1)}/${UNIT_PROFILES.tank.hp}`);
  console.log(`  the tank wins solo: its counter-fire kills the skirmisher (${(UNIT_PROFILES.skirmisher.hp/UNIT_PROFILES.tank.dps).toFixed(2)}s) before the skirmisher's own clock (${(UNIT_PROFILES.tank.hp/UNIT_PROFILES.skirmisher.dps).toFixed(2)}s) finishes`);
}

console.log("\n--- mirror symmetry with UNEQUAL stats (both sides must still see fair, non-buggy resolution) ---");
{
  const b = new Battle();
  const a = b.addUnit({ side: "A", x: 0, z: 0, ...UNIT_PROFILES.skirmisher });
  const e = b.addUnit({ side: "B", x: 1.0, z: 0, ...UNIT_PROFILES.ranged });
  let ticks = 0;
  while (b.units.get(a).alive && b.units.get(e).alive && ticks < 2000) { b.step(); ticks++; }
  const ua = b.units.get(a), ue = b.units.get(e);
  console.log(`skirmisher(hp=${UNIT_PROFILES.skirmisher.hp},dps=${UNIT_PROFILES.skirmisher.dps}) vs ranged(hp=${UNIT_PROFILES.ranged.hp},dps=${UNIT_PROFILES.ranged.dps}), both melee-range apart`);
  console.log(`  ended at t=${b.time.toFixed(2)}s — A alive=${ua.alive} hp=${ua.hp.toFixed(1)}, B alive=${ue.alive} hp=${ue.hp.toFixed(1)}`);
  // sanity: skirmisher's higher dps should let it win despite similar-ish hp
}

console.log("\n--- retreat: HP trace ---");
{
  const b = new Battle();
  const ranged = b.addUnit({ side: "A", x: 0, z: 0, ...UNIT_PROFILES.ranged });
  b.addUnit({ side: "B", x: 1.0, z: 0, ...UNIT_PROFILES.tank });
  const trace = [];
  for (let i = 0; i < 4; i++) { b.step(); trace.push(b.units.get(ranged).hp.toFixed(1)); }
  console.log(`HP after 4 engaged ticks: ${trace.join(" -> ")} (started at ${UNIT_PROFILES.ranged.hp})`);
  b.moveUnit(ranged, -20, 0);
  const traceOut = [];
  for (let i = 0; i < 10; i++) { b.step(); traceOut.push(b.units.get(ranged).hp.toFixed(1)); }
  console.log(`HP during retreat (10 ticks): ${traceOut.join(" -> ")}`);
}

console.log("\n--- structure combat: full HP trace, attacker vs tower ---");
{
  const b = new Battle();
  const attacker = b.addUnit({ side: "A", x: -10, z: 0, ...UNIT_PROFILES.tank });
  const tower = b.addStructure({ side: "B", x: 0, z: 0, ...STRUCTURE_PROFILES.tower });
  b.moveUnit(attacker, 0, 0);
  let ticks = 0;
  let engagedTicks = 0;
  while (b.units.get(attacker).alive && !b.structures.get(tower).destroyed && ticks < 4000) {
    b.step(); ticks++;
    if (b.units.get(attacker).targetId || b.structures.get(tower).targetId) engagedTicks++;
  }
  const att = b.units.get(attacker), tw = b.structures.get(tower);
  console.log(`tank(hp=${UNIT_PROFILES.tank.hp},dps=${UNIT_PROFILES.tank.dps}) vs tower(hp=${STRUCTURE_PROFILES.tower.hp},dps=${STRUCTURE_PROFILES.tower.dps},range=${STRUCTURE_PROFILES.tower.range})`);
  console.log(`  ended at t=${b.time.toFixed(2)}s over ${ticks} ticks (${engagedTicks} actually engaged)`);
  console.log(`  attacker: alive=${att.alive} hp=${att.hp.toFixed(1)}   tower: destroyed=${tw.destroyed} hp=${tw.hp.toFixed(1)}`);
  console.log(`  NOTE: tower range (6.0) >> tank range (1.2) — tower should land free hits before the tank ever reaches it`);
}

console.log("\n--- kiting: full trace ---");
{
  const kite = new Battle();
  const ranged = kite.addUnit({ side: "A", x: 0, z: 0, ...UNIT_PROFILES.ranged });
  const tank = kite.addUnit({ side: "B", x: 4.5, z: 0, ...UNIT_PROFILES.tank });
  let kiteTicks = 0;
  let closestApproach = Infinity;
  while (kite.units.get(ranged).alive && kite.units.get(tank).alive && kiteTicks < 4000) {
    const r = kite.units.get(ranged), t = kite.units.get(tank);
    const d = distance(r, t);
    closestApproach = Math.min(closestApproach, d);
    kite.moveUnit(tank, r.x, r.z);
    if (d < UNIT_PROFILES.tank.range + 0.6) {
      const dx = r.x - t.x, dz = r.z - t.z;
      const len = Math.hypot(dx, dz) || 1;
      kite.moveUnit(ranged, r.x + (dx / len) * 5, r.z + (dz / len) * 5);
    } else {
      r.waypoint = null;
    }
    kite.step();
    kiteTicks++;
  }
  const r = kite.units.get(ranged), t = kite.units.get(tank);
  console.log(`ended at t=${kite.time.toFixed(2)}s over ${kiteTicks} ticks`);
  console.log(`  ranged: alive=${r.alive} hp=${r.hp.toFixed(1)}/${UNIT_PROFILES.ranged.hp}   tank: alive=${t.alive} hp=${t.hp.toFixed(1)}/${UNIT_PROFILES.tank.hp}`);
  console.log(`  closest the tank ever got: ${closestApproach.toFixed(2)} (its melee range is ${UNIT_PROFILES.tank.range})`);
}

console.log("\n--- wall blocking: position trace ---");
{
  const b = new Battle();
  const wall = b.addStructure({
    side: "B", x: 0, z: 0, hp: 200, dps: 5, range: 1.0, key: "wall",
    blockRect: { minX: -3, maxX: 3, minZ: -0.5, maxZ: 0.5 },
  });
  const attacker = b.addUnit({ side: "A", x: 0, z: -10, ...UNIT_PROFILES.tank });
  b.moveUnit(attacker, 0, 5);
  const trace = [];
  for (let i = 0; i < 60 && !b.structures.get(wall).destroyed; i++) {
    b.step();
    if (i % 5 === 0) trace.push(`t=${b.time.toFixed(1)} z=${b.units.get(attacker).z.toFixed(2)} wallHp=${b.structures.get(wall).hp.toFixed(0)}`);
  }
  console.log(trace.join("\n"));
  console.log(`final: wall destroyed=${b.structures.get(wall).destroyed}, attacker z=${b.units.get(attacker).z.toFixed(2)} (approached from z=-10, wall face at z=0)`);
}

console.log("\n--- resume-after-wall-falls: position trace ---");
{
  const b = new Battle();
  const wall = b.addStructure({
    side: "B", x: 0, z: 0, hp: 40, dps: 0, range: 1.0, key: "wall",
    blockRect: { minX: -3, maxX: 3, minZ: -0.5, maxZ: 0.5 },
  });
  const attacker = b.addUnit({ side: "A", x: 0, z: -10, ...UNIT_PROFILES.tank });
  b.moveUnit(attacker, 0, 5);
  let fellAt = null;
  for (let i = 0; i < 100; i++) {
    b.step();
    if (fellAt === null && b.structures.get(wall).destroyed) fellAt = { t: b.time, z: b.units.get(attacker).z };
  }
  console.log(`wall fell at t=${fellAt.t.toFixed(2)}, attacker z at that moment=${fellAt.z.toFixed(2)}`);
  console.log(`attacker z 40 ticks later=${b.units.get(attacker).z.toFixed(2)} (waypoint target was z=5, never re-issued)`);
}
