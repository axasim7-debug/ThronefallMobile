import * as THREE from "three";
import type { MatchState, SideView, StructureView } from "./protocol";

// The real-time positional battlefield. Every mesh here reflects a value
// the server sent — structures and units both carry real (x, z) from
// server/Thronefall.PositionalEngine/MatchSnapshot.cs, so this file never
// invents a position or a motion; it renders exactly what came off the wire
// and eases visually between ticks for smoothness only (see tick()).
//
// Picking/dragging is exposed here (pickOwnUnitAt, groundPointAt) but
// ORCHESTRATED in main.ts — this file stays "what does the field look like
// right now", not "what does a pointer gesture mean".

const PLOT_WIDTH = 10;
const RIVER_DEPTH = 1.6;
const HALF_SPAN = 9; // generous fixed camera framing; real plot depth comes from the server's catalog

const COLORS = {
  sky: 0x141b2c,
  ground: 0x3c6e47,
  river: 0x2f6f8f,
  grid: 0x2f4d36,
  keep: 0xb9a06a,
  tower: 0x8f97a8,
  rubble: 0x3a3f4a,
  you: 0x3b8fef,
  enemy: 0xe2564a,
  selected: 0xffe066,
  ghost: 0xffffff,
};

interface UnitEntry {
  mesh: THREE.Mesh;
  targetX: number;
  targetZ: number;
}

export interface CityScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  onResize(width: number, height: number): void;
  update(state: MatchState): void;
  /** Eases meshes toward their latest reported position — called every
   * render frame, independent of how often server ticks arrive. */
  tick(deltaSeconds: number): void;
  /** Normalized device coords (-1..1, three.js convention) -> your own unit
   * id under the pointer, or null. Only "you" units are ever returned —
   * nothing here lets a pointer pick up an enemy unit. */
  pickOwnUnitAt(ndcX: number, ndcY: number): string | null;
  /** Normalized device coords -> world (x, z) on the ground plane. */
  groundPointAt(ndcX: number, ndcY: number): { x: number; z: number };
  setSelected(unitId: string | null): void;
  setDragGhost(point: { x: number; z: number } | null): void;
}

function teamColor(whose: "you" | "enemy") {
  return whose === "you" ? COLORS.you : COLORS.enemy;
}

function createStructureMesh(key: string, whose: "you" | "enemy"): THREE.Mesh {
  const geo =
    key === "keep"
      ? new THREE.BoxGeometry(2, 2.4, 2)
      : new THREE.CylinderGeometry(0.8, 0.9, 1.8, 8);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: key === "keep" ? COLORS.keep : COLORS.tower, roughness: 0.65 }));
  mesh.position.y = key === "keep" ? 1.2 : 0.9;
  const flagWidth = key === "keep" ? 1.6 : 0.9;
  const flag = new THREE.Mesh(
    new THREE.BoxGeometry(flagWidth, 0.18, 0.18),
    new THREE.MeshStandardMaterial({ color: teamColor(whose), roughness: 0.4 }),
  );
  flag.position.y = key === "keep" ? 0.25 : 0.15;
  mesh.add(flag);
  return mesh;
}

function createUnitMesh(whose: "you" | "enemy"): THREE.Mesh {
  const geo = new THREE.SphereGeometry(0.32, 12, 10);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: teamColor(whose), roughness: 0.5 }));
  mesh.position.y = 0.5;
  return mesh;
}

export function buildCityScene(): CityScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.sky);
  scene.fog = new THREE.Fog(COLORS.sky, 26, 46);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  // pulled back and raised to frame the whole field — fixed by design,
  // control is drag-to-move on units, not camera dragging (docs/GAME_DESIGN.md §2)
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

  // the river: the boundary both bases are mirrored across, and the visual
  // cue for "this is one shared field"
  const river = new THREE.Mesh(
    new THREE.PlaneGeometry(PLOT_WIDTH, RIVER_DEPTH),
    new THREE.MeshStandardMaterial({ color: COLORS.river, roughness: 0.3, metalness: 0.1 }),
  );
  river.rotation.x = -Math.PI / 2;
  river.position.y = 0.02;
  scene.add(river);

  const structureMeshes = new Map<string, THREE.Mesh>();
  const youUnits = new Map<string, UnitEntry>();
  const enemyUnits = new Map<string, UnitEntry>();

  const selectionRing = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.52, 24),
    new THREE.MeshBasicMaterial({ color: COLORS.selected, side: THREE.DoubleSide }),
  );
  selectionRing.rotation.x = -Math.PI / 2;
  selectionRing.visible = false;
  scene.add(selectionRing);

  const dragGhost = new THREE.Mesh(
    new THREE.RingGeometry(0.3, 0.4, 20),
    new THREE.MeshBasicMaterial({ color: COLORS.ghost, transparent: true, opacity: 0.6, side: THREE.DoubleSide }),
  );
  dragGhost.rotation.x = -Math.PI / 2;
  dragGhost.visible = false;
  scene.add(dragGhost);

  function updateStructureAppearance(mesh: THREE.Mesh, view: StructureView) {
    const material = mesh.material as THREE.MeshStandardMaterial;
    if (view.destroyed) {
      material.color.setHex(COLORS.rubble);
      material.emissive.setRGB(0, 0, 0);
      mesh.scale.y = 0.25;
      mesh.children.forEach((c) => (c.visible = false));
    } else {
      material.color.setHex(view.key === "keep" ? COLORS.keep : COLORS.tower);
      mesh.scale.y = 1;
      mesh.children.forEach((c) => (c.visible = true));
      const fraction = view.maxHp > 0 ? view.hp / view.maxHp : 1;
      material.emissive.setRGB(Math.max(0, 0.22 - fraction * 0.22), 0, 0);
    }
  }

  function updateSide(side: SideView, whose: "you" | "enemy") {
    for (const s of side.structures) {
      let mesh = structureMeshes.get(s.id);
      if (!mesh) {
        mesh = createStructureMesh(s.key, whose);
        scene.add(mesh);
        structureMeshes.set(s.id, mesh);
      }
      const baseY = mesh.position.y || (s.key === "keep" ? 1.2 : 0.9);
      mesh.position.set(s.x, baseY, s.z);
      updateStructureAppearance(mesh, s);
    }

    const pool = whose === "you" ? youUnits : enemyUnits;
    const seen = new Set<string>();
    for (const u of side.units) {
      seen.add(u.id);
      let entry = pool.get(u.id);
      if (!entry) {
        const mesh = createUnitMesh(whose);
        mesh.position.set(u.x, mesh.position.y, u.z);
        scene.add(mesh);
        entry = { mesh, targetX: u.x, targetZ: u.z };
        pool.set(u.id, entry);
      }
      entry.targetX = u.x;
      entry.targetZ = u.z;
      const fraction = u.maxHp > 0 ? u.hp / u.maxHp : 1;
      const material = entry.mesh.material as THREE.MeshStandardMaterial;
      material.emissive.setRGB(Math.max(0, 0.35 - fraction * 0.35), 0, 0);
    }
    for (const [id, entry] of pool) {
      if (!seen.has(id)) {
        scene.remove(entry.mesh);
        pool.delete(id);
      }
    }
  }

  function update(state: MatchState) {
    updateSide(state.you, "you");
    updateSide(state.enemy, "enemy");
  }

  function tick(deltaSeconds: number) {
    // exponential ease toward the latest reported position — ticks arrive
    // once per simulated second, so this is purely cosmetic smoothing, never
    // a source of truth for where anything actually is
    const ease = 1 - Math.pow(0.001, deltaSeconds);
    for (const pool of [youUnits, enemyUnits]) {
      for (const entry of pool.values()) {
        entry.mesh.position.x += (entry.targetX - entry.mesh.position.x) * ease;
        entry.mesh.position.z += (entry.targetZ - entry.mesh.position.z) * ease;
      }
    }
  }

  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  function groundPointAt(ndcX: number, ndcY: number): { x: number; z: number } {
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    const hit = new THREE.Vector3();
    raycaster.ray.intersectPlane(groundPlane, hit);
    return { x: hit.x, z: hit.z };
  }

  function pickOwnUnitAt(ndcX: number, ndcY: number): string | null {
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    const meshes = [...youUnits.values()].map((e) => e.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;
    for (const [id, entry] of youUnits) if (entry.mesh === hits[0].object) return id;
    return null;
  }

  function setSelected(unitId: string | null) {
    if (unitId === null) {
      selectionRing.visible = false;
      return;
    }
    const entry = youUnits.get(unitId);
    if (!entry) {
      selectionRing.visible = false;
      return;
    }
    selectionRing.visible = true;
    selectionRing.position.set(entry.mesh.position.x, 0.03, entry.mesh.position.z);
  }

  function setDragGhost(point: { x: number; z: number } | null) {
    if (point === null) {
      dragGhost.visible = false;
      return;
    }
    dragGhost.visible = true;
    dragGhost.position.set(point.x, 0.03, point.z);
  }

  function onResize(width: number, height: number) {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  return { scene, camera, onResize, update, tick, pickOwnUnitAt, groundPointAt, setSelected, setDragGhost };
}
