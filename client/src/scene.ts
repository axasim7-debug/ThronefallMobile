import * as THREE from "three";

// Placeholder city scene: one player's plot (ground + keep + 2 towers),
// matching the defense shape already validated in tools/balance-sim
// (DEFENSE.towerCount = 2). This is a scaffold to prove the render
// pipeline, not final art — geometry gets swapped for real models later.

const PLOT_WIDTH = 10;
const PLOT_DEPTH = 14; // portrait-oriented: deeper than wide

export interface CityScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  onResize(width: number, height: number): void;
}

export function buildCityScene(): CityScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a2233);
  scene.fog = new THREE.Fog(0x1a2233, 18, 34);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  // elevated angled view looking down the plot — a fixed camera by design:
  // control is one-thumb tap-to-build, not camera dragging (see
  // docs/GAME_DESIGN.md §2 — single-thumb, portrait)
  camera.position.set(0, 11, 10);
  camera.lookAt(0, 0, -1);

  const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x2a2318, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d9, 1.1);
  sun.position.set(6, 12, 6);
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(PLOT_WIDTH, PLOT_DEPTH),
    new THREE.MeshStandardMaterial({ color: 0x3c6e47, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const grid = new THREE.GridHelper(Math.max(PLOT_WIDTH, PLOT_DEPTH), 14, 0x2f4d36, 0x2f4d36);
  grid.position.y = 0.01;
  scene.add(grid);

  const keep = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2.4, 2),
    new THREE.MeshStandardMaterial({ color: 0xb9a06a, roughness: 0.6 }),
  );
  keep.position.set(0, 1.2, -PLOT_DEPTH / 2 + 2);
  scene.add(keep);

  const towerGeo = new THREE.CylinderGeometry(0.8, 0.9, 1.8, 8);
  const towerMat = new THREE.MeshStandardMaterial({ color: 0x8f97a8, roughness: 0.7 });
  for (const side of [-1, 1]) {
    const tower = new THREE.Mesh(towerGeo, towerMat);
    tower.position.set(side * 3, 0.9, -PLOT_DEPTH / 2 + 3.2);
    scene.add(tower);
  }

  function onResize(width: number, height: number) {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  return { scene, camera, onResize };
}
