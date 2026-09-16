import * as THREE from "three";
import type { Catalog, MatchState, SideView, StructureView } from "./protocol";

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
  crown: 0xffe066,
  plot: 0xffffff,
};

interface UnitEntry {
  mesh: THREE.Mesh;
  targetX: number;
  targetZ: number;
}

/** Fixed world anchor for each side's unbuilt farm/barracks plot — pure
 * geometry from the server's published catalog constants (Content.cs's
 * Layout/FarmPlotOffsetX), not a game decision. Farms and barracks are
 * never Battle structures (see Match.cs's header comment), so unlike a
 * tower or the keep there is no StructureView to read a position off —
 * this is the only way the client knows where to draw them or where the
 * king has to walk. */
export function plotAnchors(catalog: Catalog, side: SideView): { farm: { x: number; z: number }; barracks: { x: number; z: number } } {
  const keep = side.structures.find((s) => s.key === "keep");
  const sign = keep && keep.z < 0 ? -1 : 1;
  const z = sign * catalog.layout.econ * catalog.layout.plotDepth;
  return { farm: { x: catalog.layout.farmPlotOffsetX, z }, barracks: { x: 0, z } };
}

export interface CityScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  onResize(width: number, height: number): void;
  /** The static catalog, sent once at match start — needed here only to
   * place the unbuilt farm/barracks plot markers (see plotAnchors). */
  setCatalog(catalog: Catalog): void;
  update(state: MatchState): void;
  /** Eases meshes toward their latest reported position — called every
   * render frame, independent of how often server ticks arrive. */
  tick(deltaSeconds: number): void;
  /** Normalized device coords (-1..1, three.js convention) -> your own unit
   * id under the pointer, or null. Only "you" units are ever returned —
   * nothing here lets a pointer pick up an enemy unit. */
  pickOwnUnitAt(ndcX: number, ndcY: number): string | null;
  /** Normalized device coords -> true if your own king is under the
   * pointer. The king is deliberately not a unit (server-side it isn't a
   * Battle Unit either — see MatchPlayer.cs), so it gets its own pick. */
  pickOwnKingAt(ndcX: number, ndcY: number): boolean;
  /** Normalized device coords -> world (x, z) on the ground plane. */
  groundPointAt(ndcX: number, ndcY: number): { x: number; z: number };
  setSelected(unitId: string | null): void;
  setKingSelected(selected: boolean): void;
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

/** The king: a cone (distinct silhouette from the round unit meshes, so a
 * glance tells you which draggable thing is which) with a small gold
 * "crown" ring, in the same team color as everything else that side owns. */
function createKingMesh(whose: "you" | "enemy"): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.ConeGeometry(0.42, 0.95, 6),
    new THREE.MeshStandardMaterial({ color: teamColor(whose), roughness: 0.4 }),
  );
  mesh.position.y = 0.65;
  const crown = new THREE.Mesh(
    new THREE.TorusGeometry(0.2, 0.05, 6, 12),
    new THREE.MeshStandardMaterial({ color: COLORS.crown, roughness: 0.3 }),
  );
  crown.rotation.x = Math.PI / 2;
  crown.position.y = 0.55;
  mesh.add(crown);
  return mesh;
}

/** A shaded, walk-here-to-build plot marker for a farm or barracks — neither
 * is a Battle structure (see plotAnchors' comment), so this is the only
 * on-field cue for where those buildings will land. Hidden once built. */
function createPlotMarker(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(0.9, 24),
    new THREE.MeshBasicMaterial({ color: COLORS.plot, transparent: true, opacity: 0.16, side: THREE.DoubleSide }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.015;
  mesh.visible = false;
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

  let catalog: Catalog | null = null;

  const youKing: UnitEntry = { mesh: createKingMesh("you"), targetX: 0, targetZ: 0 };
  const enemyKing: UnitEntry = { mesh: createKingMesh("enemy"), targetX: 0, targetZ: 0 };
  scene.add(youKing.mesh);
  scene.add(enemyKing.mesh);

  const farmPlot = createPlotMarker();
  const barracksPlot = createPlotMarker();
  scene.add(farmPlot);
  scene.add(barracksPlot);

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

    const king = whose === "you" ? youKing : enemyKing;
    king.targetX = side.kingX;
    king.targetZ = side.kingZ;

    // farm/barracks plots aren't Battle structures, so this is the only
    // place their world position ever gets computed — only drawn for your
    // own side, matching "you drag your own things" everywhere else here
    if (whose === "you" && catalog) {
      const anchors = plotAnchors(catalog, side);
      const farmMax = catalog.buildings.farm.maxCount ?? Infinity;
      farmPlot.position.set(anchors.farm.x, farmPlot.position.y, anchors.farm.z);
      farmPlot.visible = side.farms < farmMax;
      barracksPlot.position.set(anchors.barracks.x, barracksPlot.position.y, anchors.barracks.z);
      barracksPlot.visible = !side.hasBarracks;
    }
  }

  function setCatalog(newCatalog: Catalog) {
    catalog = newCatalog;
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
    for (const king of [youKing, enemyKing]) {
      king.mesh.position.x += (king.targetX - king.mesh.position.x) * ease;
      king.mesh.position.z += (king.targetZ - king.mesh.position.z) * ease;
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

  function pickOwnKingAt(ndcX: number, ndcY: number): boolean {
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    return raycaster.intersectObject(youKing.mesh, true).length > 0;
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

  function setKingSelected(selected: boolean) {
    if (!selected) {
      selectionRing.visible = false;
      return;
    }
    selectionRing.visible = true;
    selectionRing.position.set(youKing.mesh.position.x, 0.03, youKing.mesh.position.z);
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

  return {
    scene,
    camera,
    onResize,
    setCatalog,
    update,
    tick,
    pickOwnUnitAt,
    pickOwnKingAt,
    groundPointAt,
    setSelected,
    setKingSelected,
    setDragGhost,
  };
}
