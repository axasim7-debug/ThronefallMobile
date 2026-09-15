import * as THREE from "three";
import { buildCityScene } from "./scene";

const canvas = document.querySelector<HTMLCanvasElement>("#scene");
if (!canvas) throw new Error("missing #scene canvas");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // cap for mobile GPU cost

const { scene, camera, onResize } = buildCityScene();

function resize() {
  const { clientWidth: width, clientHeight: height } = canvas!;
  renderer.setSize(width, height, false);
  onResize(width, height);
}
window.addEventListener("resize", resize);
window.addEventListener("orientationchange", resize);
resize();

function tick() {
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();
