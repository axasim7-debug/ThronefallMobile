"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Battle, distance } = require("../src/engine");
const { UNIT_PROFILES, STRUCTURE_PROFILES } = require("../src/content");

// ---------------------------------------------------------------------------
// Sanity: the old engine's mirror-symmetry bug (docs/PROGRESS.md) came from
// applying one side's effects fully before the other's. This model resolves
// ALL damage off start-of-tick state before applying any of it, so a mirror
// matchup must stay exactly symmetric. Same discipline, same test shape,
// carried over on purpose.
// ---------------------------------------------------------------------------
test("sanity: an identical mirror matchup is symmetric", () => {
  const b = new Battle();
  const a = b.addUnit({ side: "A", x: 0, z: 0, ...UNIT_PROFILES.tank });
  const e = b.addUnit({ side: "B", x: 1.0, z: 0, ...UNIT_PROFILES.tank }); // within range (1.2)

  let ticks = 0;
  while (b.units.get(a).alive && b.units.get(e).alive && ticks < 1000) {
    b.step();
    ticks++;
  }
  const ua = b.units.get(a);
  const ue = b.units.get(e);
  assert.equal(ua.alive, ue.alive, "identical units facing each other must live or die together");
  assert.equal(ua.hp, ue.hp, "identical units must end with identical HP");
});

// ---------------------------------------------------------------------------
// Focus fire: three attackers on one target should kill roughly 3x faster
// than one attacker would — the model must let numbers matter linearly,
// since "how many cards you commit" is a real tactical lever.
//
// The target here is a negligible-counter-damage dummy on purpose. The first
// version of this test targeted a real tank and got a nonsense result: a
// single skirmisher (dps 25, hp 80) actually LOSES outright to a tank (dps
// 15, hp 300) — the tank kills the lone attacker at t=5.33s, before the
// attacker's 12s clock to solo the tank ever completes — so "time to kill
// the tank" was undefined for that case, and the test's timeout loop quietly
// reported the 2000-tick cap (500s) as if it were a real measurement. The
// assertion still passed, for the wrong reason (500 > 4 either way), which
// is exactly the shape of bug a green checkmark can hide. A separate test
// below keeps that real finding on record instead of discarding it.
// ---------------------------------------------------------------------------
test("focus fire: 3 attackers kill a dummy target much faster than 1", () => {
  function timeToKill(attackerCount) {
    const b = new Battle();
    const targetId = b.addStructure({ side: "B", x: 0, z: 0, ...STRUCTURE_PROFILES.dummy });
    for (let i = 0; i < attackerCount; i++) {
      b.addUnit({ side: "A", x: 0.3 * i, z: 1.0, ...UNIT_PROFILES.skirmisher });
    }
    let ticks = 0;
    while (!b.structures.get(targetId).destroyed && ticks < 2000) { b.step(); ticks++; }
    assert.ok(ticks < 2000, "the dummy should actually die, not time out");
    return b.time;
  }

  const t1 = timeToKill(1);
  const t3 = timeToKill(3);
  const expected1 = STRUCTURE_PROFILES.dummy.hp / UNIT_PROFILES.skirmisher.dps;
  const expected3 = STRUCTURE_PROFILES.dummy.hp / (3 * UNIT_PROFILES.skirmisher.dps);
  assert.ok(Math.abs(t1 - expected1) < 0.5, `1 attacker: ${t1}s should match the naive DPS math (${expected1}s)`);
  assert.ok(Math.abs(t3 - expected3) < 0.5, `3 attackers: ${t3}s should match the naive DPS math (${expected3}s)`);
  assert.ok(t3 < t1 / 2.5, `3 attackers (${t3}s) should kill much faster than 1 (${t1}s)`);
});

// ---------------------------------------------------------------------------
// The real finding above, kept as an explicit permanent fact rather than
// left as a debugging footnote: with these particular stat profiles, a lone
// skirmisher does not just take longer against a tank — it loses outright,
// because the tank's own counter-fire kills it first. That's a legitimate
// property of DPS-stacking combat (a single low-HP high-DPS unit can be
// countered by anything that kills it before its clock runs out), and it's
// worth a name so a future stat change that silently flips this doesn't go
// unnoticed.
// ---------------------------------------------------------------------------
test("a lone skirmisher loses outright to a tank — its own DPS clock never finishes", () => {
  const b = new Battle();
  const skirmisher = b.addUnit({ side: "A", x: 0, z: 1.0, ...UNIT_PROFILES.skirmisher });
  const tank = b.addUnit({ side: "B", x: 0, z: 0, ...UNIT_PROFILES.tank });
  let ticks = 0;
  while (b.units.get(skirmisher).alive && b.units.get(tank).alive && ticks < 2000) { b.step(); ticks++; }
  assert.equal(b.units.get(skirmisher).alive, false, "the skirmisher should die first");
  assert.equal(b.units.get(tank).alive, true, "the tank should survive a lone skirmisher");
  assert.ok(b.units.get(tank).hp < UNIT_PROFILES.tank.hp, "the tank should still have taken real damage first");
});

// ---------------------------------------------------------------------------
// Retreat: a player-issued move order must break engagement immediately,
// even mid-fight — this is the mechanic the whole "you move everything by
// hand" design depends on.
// ---------------------------------------------------------------------------
test("retreat: moving out of range stops damage and can save a wounded unit", () => {
  const b = new Battle();
  const ranged = b.addUnit({ side: "A", x: 0, z: 0, ...UNIT_PROFILES.ranged });
  b.addUnit({ side: "B", x: 1.0, z: 0, ...UNIT_PROFILES.tank }); // within melee range of ranged unit too

  // take some damage first
  for (let i = 0; i < 4; i++) b.step();
  const hpAfterEngaging = b.units.get(ranged).hp;
  assert.ok(hpAfterEngaging < UNIT_PROFILES.ranged.hp, "the ranged unit should have taken damage while in range");

  // retreat straight back, well out of the tank's 1.2 range
  b.moveUnit(ranged, -20, 0);
  for (let i = 0; i < 40; i++) b.step();

  const u = b.units.get(ranged);
  assert.equal(u.alive, true, "retreating in time should save the unit");
  assert.ok(distance(u, { x: 1.0, z: 0 }) > UNIT_PROFILES.tank.range, "the unit should have actually left melee range");

  // one more step and confirm HP is now stable (no longer in anyone's range)
  const hpBeforeExtra = u.hp;
  b.step();
  assert.equal(b.units.get(ranged).hp, hpBeforeExtra, "out of range means no more damage, tick after tick");
});

// ---------------------------------------------------------------------------
// No auto-advance: the single most load-bearing rule in this design. Two
// armies sitting on the field with no orders must never fight on their own.
// ---------------------------------------------------------------------------
test("no auto-advance: idle armies out of range never engage on their own", () => {
  const b = new Battle();
  const a1 = b.addUnit({ side: "A", x: 0, z: 0, ...UNIT_PROFILES.tank });
  const a2 = b.addUnit({ side: "A", x: 1, z: 0, ...UNIT_PROFILES.skirmisher });
  const b1 = b.addUnit({ side: "B", x: 50, z: 50, ...UNIT_PROFILES.tank });
  const b2 = b.addUnit({ side: "B", x: 51, z: 50, ...UNIT_PROFILES.skirmisher });

  for (let i = 0; i < 400; i++) b.step(); // 100 real seconds, no orders ever given

  for (const id of [a1, a2, b1, b2]) {
    const u = b.units.get(id);
    assert.equal(u.alive, true, `${id} should never have taken damage`);
    assert.equal(u.hp, u.maxHp, `${id} should be at full HP — nothing should have moved or fought`);
  }
  assert.equal(b.log.length, 0, "no deaths should ever be logged");
});

// ---------------------------------------------------------------------------
// Structures fight the same way units do: a sustained exchange, never an
// instant one-shot resolution in either direction. This directly replaces
// the old engine's "resolve everything in one tick on arrival" model, which
// the user explicitly called out as the thing to avoid.
// ---------------------------------------------------------------------------
test("structures trade damage over time — never instant, either direction", () => {
  const b = new Battle();
  const attacker = b.addUnit({ side: "A", x: -10, z: 0, ...UNIT_PROFILES.tank });
  const tower = b.addStructure({ side: "B", x: 0, z: 0, ...STRUCTURE_PROFILES.tower });
  b.moveUnit(attacker, 0, 0); // walk in

  let firstDamageTick = null;
  let ticks = 0;
  while (b.units.get(attacker).alive && !b.structures.get(tower).destroyed && ticks < 4000) {
    const before = b.structures.get(tower).hp;
    b.step();
    ticks++;
    if (firstDamageTick === null && b.structures.get(tower).hp < before) firstDamageTick = ticks;
  }

  assert.ok(firstDamageTick !== null, "the tower should eventually take damage");
  assert.ok(ticks > firstDamageTick, "combat must span multiple ticks, not resolve on the first hit");
  assert.ok(b.time > 1, `the whole engagement took ${b.time}s — should never be a single instant`);
});

// ---------------------------------------------------------------------------
// The payoff: this is what "tactics lives in the player's head" is supposed
// to buy. Same two units, same raw stats — standing and fighting loses,
// deliberate kiting (retreat at max range, re-approach, repeat) wins.
// If this test fails, the model doesn't actually reward positioning skill
// and the whole design premise is wrong, not just this test.
// ---------------------------------------------------------------------------
test("tactics: standing still loses, kiting the same matchup wins", () => {
  // baseline: both just sit in range of each other
  const stand = new Battle();
  const rangedStand = stand.addUnit({ side: "A", x: 0, z: 0, ...UNIT_PROFILES.ranged });
  const tankStand = stand.addUnit({ side: "B", x: 1.0, z: 0, ...UNIT_PROFILES.tank });
  let ticks = 0;
  while (stand.units.get(rangedStand).alive && stand.units.get(tankStand).alive && ticks < 2000) {
    stand.step(); ticks++;
  }
  assert.equal(stand.units.get(rangedStand).alive, false, "standing still, the lower-HP ranged unit should lose");

  // kiting: ranged unit actively retreats whenever the tank gets close,
  // re-engages once it's back at safe range. The tank "AI" here is a simple
  // opposing player who always beelines for the ranged unit — a deliberately
  // naive/aggressive baseline, not a claim about how real bots should play.
  const kite = new Battle();
  const ranged = kite.addUnit({ side: "A", x: 0, z: 0, ...UNIT_PROFILES.ranged });
  const tank = kite.addUnit({ side: "B", x: 4.5, z: 0, ...UNIT_PROFILES.tank });

  let kiteTicks = 0;
  while (kite.units.get(ranged).alive && kite.units.get(tank).alive && kiteTicks < 4000) {
    const r = kite.units.get(ranged);
    const t = kite.units.get(tank);
    const d = distance(r, t);

    // naive opponent: always walk straight at the ranged unit
    kite.moveUnit(tank, r.x, r.z);

    // scripted kiting: if the tank is closing to danger range, step directly
    // away; otherwise hold ground (clear any pending order) and keep shooting
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

  assert.equal(kite.units.get(ranged).alive, true, "kiting should keep the ranged unit alive");
  assert.equal(kite.units.get(tank).alive, false, "kiting should eventually bring the tank down");
});
