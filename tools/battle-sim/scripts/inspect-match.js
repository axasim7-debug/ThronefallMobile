"use strict";
// Prints the actual numbers behind a full match — passing assertions alone
// don't prove the economy+combat pacing FEELS right, only that it's
// internally consistent. Same "look at it from another angle" philosophy as
// scripts/inspect.js.

const { simulateMatch, keepDestroyedAtT, towersLost } = require("../src/match");
const { ALL } = require("../src/match-strategies");
const content = require("../src/match-content");

function report(a, b) {
  const { battle, A, B, result } = simulateMatch(ALL[a], ALL[b]);
  const line = (label, pl) => {
    const keep = battle.structures.get(pl.keepId);
    const towers = pl.towerIds.map((id) => battle.structures.get(id));
    const diedAt = keepDestroyedAtT(battle, pl);
    console.log(
      `  ${label}: gold=${pl.gold.toFixed(0)} farms=${pl.farms} barracksT=${pl.barracksT ?? "-"} ` +
      `troops=${pl.troopsProduced} keepHP=${keep.hp.toFixed(0)}/${keep.maxHp}${keep.destroyed ? " DESTROYED" : ""} ` +
      `towersLost=${towersLost(battle, pl)}/${pl.towerIds.length}` +
      (diedAt !== null ? ` diedAt=${diedAt}s` : ""),
    );
  };
  console.log(`${a} vs ${b}  ->  ${result.winner === "draw" ? "DRAW" : result.winner + " wins"}  (${result.tiebreak})`);
  line("A", A);
  line("B", B);
}

console.log(`Match duration: ${content.ECONOMY.durationSeconds}s | Tower HP: ${content.DEFENSE.tower.hp}x${content.DEFENSE.towerCount} (range ${content.DEFENSE.tower.range}) | Keep HP: ${content.DEFENSE.keep.hp}\n`);

const MATCHUPS = [
  ["eco", "atk"], ["eco", "def"], ["def", "atk"],
  ["eco", "eco"], ["def", "def"], ["atk", "atk"],
];
for (const [a, b] of MATCHUPS) { report(a, b); console.log(""); }

// The finding under investigation: does "atk" (straight-line rush, no
// tactics — bots never reposition) actually get shredded by stationary
// tower range before it can do anything? Trace ONE infantry troop's full
// approach in isolation, mirroring the old "confirm" diagnostic in
// scripts/inspect.js, to see exactly where and why it dies.
console.log("--- isolated trace: one lone infantry, straight line, vs 2 towers + keep (no repair, no support) ---");
{
  const { Battle } = require("../src/engine");
  const b = new Battle();
  const towerZ = content.LAYOUT.tower * content.PLOT_DEPTH;
  const keepZ = content.LAYOUT.keep * content.PLOT_DEPTH;
  b.addStructure({ side: "B", x: -3, z: towerZ, ...content.DEFENSE.tower, key: "tower" });
  b.addStructure({ side: "B", x: 3, z: towerZ, ...content.DEFENSE.tower, key: "tower" });
  const keepId = b.addStructure({ side: "B", x: 0, z: keepZ, ...content.DEFENSE.keep, key: "keep" });
  const infantry = content.TROOPS.infantry;
  const unitId = b.addUnit({ side: "A", x: 0, z: -content.LAYOUT.econ * content.PLOT_DEPTH, hp: infantry.hp, dps: infantry.dps, range: infantry.range, speed: infantry.speed, key: "infantry" });
  b.moveUnit(unitId, 0, keepZ);
  console.log(`  infantry: hp=${infantry.hp} dps=${infantry.dps} speed=${infantry.speed.toFixed(2)} range=${infantry.range}`);
  let ticks = 0;
  const trace = [];
  while (b.units.get(unitId).alive && !b.structures.get(keepId).destroyed && ticks < 2000) {
    b.step();
    ticks++;
    if (ticks % 10 === 0) {
      const u = b.units.get(unitId);
      trace.push(`t=${b.time.toFixed(1)} z=${u.z.toFixed(2)} hp=${u.hp.toFixed(0)}/${infantry.hp}`);
    }
  }
  console.log(trace.join("\n"));
  const survived = b.units.get(unitId).alive;
  console.log(`  final: infantry ${survived ? "reached the keep alive" : "died"} at t=${b.time.toFixed(1)}s, z=${b.units.get(unitId).z.toFixed(2)} (keep at z=${keepZ.toFixed(2)})`);
}
