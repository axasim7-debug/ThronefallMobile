import * as THREE from "three";
import type { MatchState, SideView } from "./protocol";

// Shared-battlefield placeholder scene: both plots visible at once — your
// base near the camera, the enemy's mirrored across a river strip, matching
// the Clash Royale reference composition (docs/art-bible.html, docs/
// ART_DIRECTION.md). Geometry is deliberately primitive; what matters here is
// the layout and the state binding, not the art. Real models replace these
// meshes later without touching update()'s shape.
//
// Nothing here decides anything. Every mesh reflects a value the server sent.
// Troop markers exist because MarchingTroopView does now (see PROGRESS.md's
// "shared battlefield" entry) — without a reported position there was
// nothing to place here at all.

const PLOT_WIDTH = 10;
const PLOT_DEPTH = 7.5; // one side's depth, river to rear
const RIVER_DEPTH = 1.6;
const HALF_SPAN = PLOT_DEPTH + RIVER_DEPTH / 2;

// Fractions of PLOT_DEPTH from the river inward — this is also the raid
// order a troop actually resolves in (tower, then farm, then keep), so it
// doubles as a rough "how far in" read even though combat itself still
// resolves in one tick on arrival, not stage by stage.
const LAYOUT = { tower: 0.36, econ: 0.58, keep: 0.86 };

const COLORS = {
  sky: 0x141b2c,
  ground: 0x3c6e47,
  river: 0x2f6f8f,
  grid: 0x2f4d36,
  keep: 0xb9a06a,
  tower: 0x8f97a8,
  farm: 0xc8a13a,
  barracks: 0x9c5b3c,
  rubble: 0x3a3f4a,
  you: 0x3b8fef,
  enemy: 0xe2564a,
};

export interface CityScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  onResize(width: number, height: number): void;
  update(state: MatchState): void;
}

/** A build in progress sits low and rises as it completes — a silhouette cue
 * that something is happening without reading the timer text. */
function applyBuildProgress(mesh: THREE.Object3D, baseY: number, progress: number) {
  const scale = Math.max(0.05, progress);
  mesh.scale.y = scale;
  mesh.position.y = baseY * scale;
}

interface Plot {
  update(side: SideView): void;
  /** world-space spawn point for this plot's outgoing troops */
  barracksAnchor: THREE.Vector3;
  /** world-space target point incoming troops march toward */
  keepAnchor: THREE.Vector3;
}

/**
 * One player's base. `direction` is +1 for the near/own plot (extends toward
 * the camera) and -1 for the far/enemy plot (mirrored across the river) —
 * every local depth below is measured from the river and then signed by it.
 */
function buildPlot(scene: THREE.Scene, direction: 1 | -1, teamColor: number): Plot {
  const z = (localDepth: number) => direction * localDepth;

  // team flag: a small color strip identifies whose structure this is,
  // without needing a second full material palette for the stonework itself
  function flag(width: number): THREE.Mesh {
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.18, 0.18),
      new THREE.MeshStandardMaterial({ color: teamColor, roughness: 0.4 }),
    );
    return strip;
  }

  // --- keep ---
  const keepMat = new THREE.MeshStandardMaterial({ color: COLORS.keep, roughness: 0.6 });
  const keep = new THREE.Mesh(new THREE.BoxGeometry(2, 2.4, 2), keepMat);
  keep.position.set(0, 1.2, z(LAYOUT.keep * PLOT_DEPTH));
  scene.add(keep);
  const keepFlag = flag(1.6);
  keepFlag.position.set(0, 1.45, 0);
  keep.add(keepFlag);

  // --- towers ---
  const towerGeo = new THREE.CylinderGeometry(0.8, 0.9, 1.8, 8);
  const towers = [-1, 1].map((side) => {
    const tower = new THREE.Mesh(towerGeo, new THREE.MeshStandardMaterial({ color: COLORS.tower, roughness: 0.7 }));
    tower.position.set(side * 3, 0.9, z(LAYOUT.tower * PLOT_DEPTH));
    scene.add(tower);
    const towerFlag = flag(0.9);
    towerFlag.position.set(0, 1.05, 0);
    tower.add(towerFlag);
    return tower;
  });

  // --- farms ---
  const farmGeo = new THREE.BoxGeometry(1.6, 0.35, 1.6);
  const farms = [-1, 1].map((side) => {
    const farm = new THREE.Mesh(farmGeo, new THREE.MeshStandardMaterial({ color: COLORS.farm, roughness: 0.9 }));
    farm.position.set(side * 3.4, 0.18, z(LAYOUT.econ * PLOT_DEPTH));
    farm.visible = false;
    scene.add(farm);
    return farm;
  });

  // --- barracks: alongside the farms, at the same depth ---
  const barracks = new THREE.Mesh(
    new THREE.BoxGeometry(2.2, 1.1, 1.6),
    new THREE.MeshStandardMaterial({ color: COLORS.barracks, roughness: 0.8 }),
  );
  barracks.position.set(0, 0.55, z(LAYOUT.econ * PLOT_DEPTH));
  barracks.visible = false;
  scene.add(barracks);

  const barracksAnchor = new THREE.Vector3(0, 0.7, z(LAYOUT.econ * PLOT_DEPTH));
  const keepAnchor = new THREE.Vector3(0, 0.7, z(LAYOUT.keep * PLOT_DEPTH));

  function update(side: SideView) {
    // keep: tint toward red as HP drops
    const keepFraction = side.keep.maxHp > 0 ? side.keep.hp / side.keep.maxHp : 0;
    keepMat.color.setHex(side.keep.destroyed ? COLORS.rubble : COLORS.keep);
    keepMat.emissive.setRGB(side.keep.destroyed ? 0 : Math.max(0, 0.22 - keepFraction * 0.22), 0, 0);
    keepFlag.visible = !side.keep.destroyed;

    // towers: a destroyed tower sinks into rubble
    towers.forEach((tower, i) => {
      const view = side.towers[i];
      if (!view) return;
      const material = tower.material as THREE.MeshStandardMaterial;
      const towerFlag = tower.children[0];
      if (view.destroyed) {
        material.color.setHex(COLORS.rubble);
        material.emissive.setRGB(0, 0, 0); // clear the damage tint, or the rubble keeps glowing red
        tower.scale.y = 0.25;
        tower.position.y = 0.9 * 0.25;
        towerFlag.visible = false;
      } else {
        material.color.setHex(COLORS.tower);
        tower.scale.y = 1;
        tower.position.y = 0.9;
        towerFlag.visible = true;
        const fraction = view.maxHp > 0 ? view.hp / view.maxHp : 1;
        material.emissive.setRGB(Math.max(0, 0.22 - fraction * 0.22), 0, 0);
      }
    });

    // farms
    farms.forEach((farm, i) => {
      const view = side.farms[i];
      farm.visible = view !== undefined;
      if (!view) return;
      const material = farm.material as THREE.MeshStandardMaterial;
      material.color.setHex(view.hp <= 0 ? COLORS.rubble : COLORS.farm);
    });

    // barracks — shows its build progress while under construction
    if (side.hasBarracks) {
      barracks.visible = true;
      applyBuildProgress(barracks, 0.55, 1);
    } else if (side.buildBusy === "barracks") {
      barracks.visible = true;
      // buildTimer counts down; without the catalog's total we show it
      // rising from a floor — the exact curve is cosmetic, the trigger is
      // server state
      applyBuildProgress(barracks, 0.55, 0.25);
    } else {
      barracks.visible = false;
    }
  }

  return { update, barracksAnchor, keepAnchor };
}

/**
 * Fixed pool of simple markers for in-flight troops. Reused across ticks
 * rather than created/destroyed, and sized well above anything a real match
 * produces — a marker that isn't needed this tick is just hidden.
 * InstancedMesh is the right call once these are real models with real
 * counts; a plain pool is plenty for this many placeholder spheres.
 */
function buildTroopPool(scene: THREE.Scene, count: number, color: number): THREE.Mesh[] {
  const geo = new THREE.SphereGeometry(0.28, 10, 8);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
  const pool: THREE.Mesh[] = [];
  for (let i = 0; i < count; i++) {
    const marker = new THREE.Mesh(geo, mat);
    marker.visible = false;
    scene.add(marker);
    pool.push(marker);
  }
  return pool;
}

function placeTroops(
  pool: THREE.Mesh[],
  troops: SideView["marchingTroops"],
  from: THREE.Vector3,
  to: THREE.Vector3,
) {
  troops.forEach((troop, i) => {
    const marker = pool[i];
    if (!marker) return; // pool exhausted — cosmetic only, never drops a real troop
    marker.visible = true;
    marker.position.lerpVectors(from, to, troop.progress);
    marker.position.y = 0.5 + Math.sin(troop.progress * Math.PI) * 0.15; // a little hop, not a flat slide
  });
  for (let i = troops.length; i < pool.length; i++) pool[i].visible = false;
}

export function buildCityScene(): CityScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.sky);
  scene.fog = new THREE.Fog(COLORS.sky, 26, 46);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  // pulled back and raised to frame both plots at once — still fixed by
  // design, control is one-thumb tap-to-build, not camera dragging (see
  // docs/GAME_DESIGN.md §2 — single-thumb, portrait)
  camera.position.set(0, 19, 17);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x2a2318, 0.95));
  const sun = new THREE.DirectionalLight(0xfff2d9, 1.1);
  sun.position.set(6, 14, 6);
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(PLOT_WIDTH, HALF_SPAN * 2),
    new THREE.MeshStandardMaterial({ color: COLORS.ground, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const grid = new THREE.GridHelper(Math.max(PLOT_WIDTH, HALF_SPAN * 2), 18, COLORS.grid, COLORS.grid);
  grid.position.y = 0.01;
  scene.add(grid);

  // the river: the boundary both plots are mirrored across, and the visual
  // cue for "this is one shared field, not two disconnected screens"
  const river = new THREE.Mesh(
    new THREE.PlaneGeometry(PLOT_WIDTH, RIVER_DEPTH),
    new THREE.MeshStandardMaterial({ color: COLORS.river, roughness: 0.3, metalness: 0.1 }),
  );
  river.rotation.x = -Math.PI / 2;
  river.position.y = 0.02;
  scene.add(river);

  // Empirically verified, not assumed: with this camera's exact pitch,
  // direction=-1 (negative Z) renders nearer/lower in frame and +1 renders
  // farther/higher — the opposite of the naive "positive Z = closer to a
  // positive-Z camera" read. Swapped here rather than renaming the
  // direction parameter everywhere it's used below.
  const yours = buildPlot(scene, -1, COLORS.you);
  const enemy = buildPlot(scene, 1, COLORS.enemy);

  // one pool per direction of travel, not per side, since a troop's marker
  // needs to know which anchor pair to lerp between
  const outgoingPool = buildTroopPool(scene, 16, COLORS.you);
  const incomingPool = buildTroopPool(scene, 16, COLORS.enemy);

  function update(state: MatchState) {
    yours.update(state.you);
    enemy.update(state.enemy);

    // your outgoing troops travel from your barracks to the enemy's keep;
    // the enemy's outgoing troops travel from theirs to yours
    placeTroops(outgoingPool, state.you.marchingTroops, yours.barracksAnchor, enemy.keepAnchor);
    placeTroops(incomingPool, state.enemy.marchingTroops, enemy.barracksAnchor, yours.keepAnchor);
  }

  function onResize(width: number, height: number) {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  return { scene, camera, onResize, update };
}
