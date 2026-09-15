import * as THREE from "three";
import type { Catalog, MatchState, SideView } from "./protocol";

// Placeholder city scene: one player's plot (ground + keep + 2 towers + wall
// + farms + barracks), matching the defense shape validated in
// tools/balance-sim. Geometry is deliberately primitive — this proves the
// render pipeline and the state binding, not the art direction. Real models
// and the Clash-Royale-style look replace these meshes later; the update
// logic below is what survives that swap.
//
// Nothing here decides anything. Every mesh reflects a value the server sent.

const PLOT_WIDTH = 10;
const PLOT_DEPTH = 14; // portrait-oriented: deeper than wide

const COLORS = {
  sky: 0x1a2233,
  ground: 0x3c6e47,
  grid: 0x2f4d36,
  keep: 0xb9a06a,
  tower: 0x8f97a8,
  wall: 0x7d7568,
  farm: 0xc8a13a,
  barracks: 0x9c5b3c,
  rubble: 0x3a3f4a,
};

export interface CityScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  onResize(width: number, height: number): void;
  /** static content data from the server, needed to size built structures */
  applyCatalog(catalog: Catalog): void;
  update(state: MatchState): void;
}

export function buildCityScene(): CityScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.sky);
  scene.fog = new THREE.Fog(COLORS.sky, 24, 42);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  // elevated angled view looking down the plot — a fixed camera by design:
  // control is one-thumb tap-to-build, not camera dragging (see
  // docs/GAME_DESIGN.md §2 — single-thumb, portrait)
  camera.position.set(0, 15.5, 14.5);
  camera.lookAt(0, 0, -1.5);

  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x2a2318, 0.9));
  const sun = new THREE.DirectionalLight(0xfff2d9, 1.1);
  sun.position.set(6, 12, 6);
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(PLOT_WIDTH, PLOT_DEPTH),
    new THREE.MeshStandardMaterial({ color: COLORS.ground, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const grid = new THREE.GridHelper(Math.max(PLOT_WIDTH, PLOT_DEPTH), 14, COLORS.grid, COLORS.grid);
  grid.position.y = 0.01;
  scene.add(grid);

  // --- keep ---
  const keepMat = new THREE.MeshStandardMaterial({ color: COLORS.keep, roughness: 0.6 });
  const keep = new THREE.Mesh(new THREE.BoxGeometry(2, 2.4, 2), keepMat);
  keep.position.set(0, 1.2, -PLOT_DEPTH / 2 + 2);
  scene.add(keep);

  // --- towers ---
  const towerGeo = new THREE.CylinderGeometry(0.8, 0.9, 1.8, 8);
  const towers = [-1, 1].map((side) => {
    const tower = new THREE.Mesh(
      towerGeo,
      new THREE.MeshStandardMaterial({ color: COLORS.tower, roughness: 0.7 }),
    );
    tower.position.set(side * 3, 0.9, -PLOT_DEPTH / 2 + 3.2);
    scene.add(tower);
    return tower;
  });

  // --- wall: two segments across the front of the plot ---
  const wallSegments = [-1, 1].map((side) => {
    const segment = new THREE.Mesh(
      new THREE.BoxGeometry(4, 1, 0.5),
      new THREE.MeshStandardMaterial({ color: COLORS.wall, roughness: 0.85 }),
    );
    segment.position.set(side * 2.2, 0.5, -PLOT_DEPTH / 2 + 5.4);
    segment.visible = false;
    scene.add(segment);
    return segment;
  });

  // --- farms: appear as the player builds them ---
  const farmGeo = new THREE.BoxGeometry(1.6, 0.35, 1.6);
  const farms = [-1, 1].map((side) => {
    const farm = new THREE.Mesh(
      farmGeo,
      new THREE.MeshStandardMaterial({ color: COLORS.farm, roughness: 0.9 }),
    );
    farm.position.set(side * 3.1, 0.18, -PLOT_DEPTH / 2 + 8.4);
    farm.visible = false;
    scene.add(farm);
    return farm;
  });

  // --- barracks ---
  const barracks = new THREE.Mesh(
    new THREE.BoxGeometry(2.2, 1.1, 1.6),
    new THREE.MeshStandardMaterial({ color: COLORS.barracks, roughness: 0.8 }),
  );
  barracks.position.set(0, 0.55, -PLOT_DEPTH / 2 + 8.6);
  barracks.visible = false;
  scene.add(barracks);

  let wallHpPerSegment = 0;
  function applyCatalog(catalog: Catalog) {
    wallHpPerSegment = catalog.buildings.wall?.hpPerSegment ?? 0;
  }

  // A build in progress sits low and rises as it completes, so the player can
  // see something is happening without reading the timer text.
  function applyBuildProgress(mesh: THREE.Mesh, fullHeight: number, baseY: number, progress: number) {
    const scale = Math.max(0.05, progress);
    mesh.scale.y = scale;
    mesh.position.y = baseY * scale;
    void fullHeight;
  }

  function update(state: MatchState) {
    const you = state.you;

    // keep: tint toward red as HP drops
    const keepFraction = you.keep.maxHp > 0 ? you.keep.hp / you.keep.maxHp : 0;
    keepMat.color.setHex(you.keep.destroyed ? COLORS.rubble : COLORS.keep);
    keepMat.emissive.setRGB(you.keep.destroyed ? 0 : Math.max(0, 0.22 - keepFraction * 0.22), 0, 0);

    // towers: a destroyed tower sinks into rubble
    towers.forEach((tower, i) => {
      const view = you.towers[i];
      if (!view) return;
      const material = tower.material as THREE.MeshStandardMaterial;
      if (view.destroyed) {
        material.color.setHex(COLORS.rubble);
        // clear the damage tint too, or the rubble keeps glowing red from
        // the last frame the tower was alive
        material.emissive.setRGB(0, 0, 0);
        tower.scale.y = 0.25;
        tower.position.y = 0.9 * 0.25;
      } else {
        material.color.setHex(COLORS.tower);
        tower.scale.y = 1;
        tower.position.y = 0.9;
        const fraction = view.maxHp > 0 ? view.hp / view.maxHp : 1;
        material.emissive.setRGB(Math.max(0, 0.22 - fraction * 0.22), 0, 0);
      }
    });

    // wall: one visible segment per built segment, shrinking as it takes damage.
    // Segment size has to come from the catalog — deriving it from wallMaxHp
    // is circular and always yields the full count.
    const builtSegments = wallHpPerSegment > 0 ? Math.round(you.wallMaxHp / wallHpPerSegment) : 0;
    wallSegments.forEach((segment, i) => {
      segment.visible = i < builtSegments;
      if (!segment.visible) return;
      const fraction = you.wallMaxHp > 0 ? you.wallHp / you.wallMaxHp : 0;
      segment.scale.y = Math.max(0.08, fraction);
      segment.position.y = 0.5 * segment.scale.y;
    });

    // farms
    farms.forEach((farm, i) => {
      const view: SideView["farms"][number] | undefined = you.farms[i];
      farm.visible = view !== undefined;
      if (!view) return;
      const material = farm.material as THREE.MeshStandardMaterial;
      material.color.setHex(view.hp <= 0 ? COLORS.rubble : COLORS.farm);
    });

    // barracks — shows its build progress while under construction
    if (you.hasBarracks) {
      barracks.visible = true;
      applyBuildProgress(barracks, 1.1, 0.55, 1);
    } else if (you.buildBusy === "barracks") {
      barracks.visible = true;
      // buildTimer counts down; without the catalog's total we show it rising
      // from a floor — the exact curve is cosmetic, the trigger is server state
      applyBuildProgress(barracks, 1.1, 0.55, 0.25);
    } else {
      barracks.visible = false;
    }
  }

  function onResize(width: number, height: number) {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  return { scene, camera, onResize, applyCatalog, update };
}
