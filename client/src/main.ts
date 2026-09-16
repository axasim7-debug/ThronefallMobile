import * as THREE from "three";
import { buildCityScene } from "./scene";
import { Hud } from "./hud";
import { MatchConnection } from "./protocol";
import type { CommandKind, MatchState } from "./protocol";

const canvas = document.querySelector<HTMLCanvasElement>("#scene");
if (!canvas) throw new Error("missing #scene canvas");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // cap for mobile GPU cost

const city = buildCityScene();

function resize() {
  const { clientWidth: width, clientHeight: height } = canvas!;
  renderer.setSize(width, height, false);
  city.onResize(width, height);
}
window.addEventListener("resize", resize);
window.addEventListener("orientationchange", resize);
resize();

let lastFrameTime = performance.now();
function frame() {
  const now = performance.now();
  city.tick(Math.min(0.25, (now - lastFrameTime) / 1000));
  lastFrameTime = now;
  renderer.render(city.scene, city.camera);
  requestAnimationFrame(frame);
}
frame();

// --- connect to the authoritative server ---------------------------------
// Vite proxies /ws to the .NET server in dev (see vite.config.ts), so this is
// same-origin and works unchanged when the client is served by the server
// itself in production.

const params = new URLSearchParams(location.search);
const opponent = params.get("opponent") ?? "atk";
const speed = params.get("speed") ?? "1";
const scheme = location.protocol === "https:" ? "wss" : "ws";
const url = `${scheme}://${location.host}/ws/match?opponent=${encodeURIComponent(opponent)}&speed=${encodeURIComponent(speed)}`;

let latest: MatchState | null = null;

const send = (kind: CommandKind, arg = "", x?: number, z?: number) => connection.send(kind, arg, x, z);
const hud = new Hud(send);

const connection = new MatchConnection(url, {
  onStarted(message) {
    hud.applyCatalog(message.catalog);
    city.setCatalog(message.catalog);
    hud.setStatus(`Match started — opponent: ${message.opponent}`);
  },

  onState(state) {
    latest = state;
    hud.update(state);
    city.update(state);
  },

  onAck(ack) {
    // An accepted command needs no announcement: the next state frame shows
    // it. Only a refusal needs explaining, or the player is left guessing why
    // their tap did nothing.
    if (!ack.accepted) hud.showRefusal(ack.reason);
  },

  onEnded(message) {
    const tone = message.winner === "you" ? "win" : message.winner === "draw" ? "draw" : "lose";
    const text = message.winner === "you" ? "Victory!" : message.winner === "draw" ? "Draw" : "Defeat";
    hud.showBanner(`${text} — ${describeTiebreak(message.tiebreak)}`, tone);
  },

  onError(message) {
    hud.setStatus(`Error: ${message}`);
  },

  onClosed() {
    if (latest && !latest.finished) hud.showBanner("Disconnected from server", "info");
  },
});

const TIEBREAK_TEXT: Record<string, string> = {
  "keep-kill": "Keep destroyed",
  "towers-destroyed": "Towers destroyed",
  "own-keep-hp-pct": "Keep HP remaining",
  "true-draw": "True draw",
  "mutual-destruction-timing": "Mutual destruction timing",
  "mutual-destruction-same-tick": "Mutual destruction, same tick",
};

function describeTiebreak(tiebreak: string): string {
  return TIEBREAK_TEXT[tiebreak] ?? tiebreak;
}

// --- drag-to-move: the entire "control scheme" -----------------------------
// Press on one of your own units, drag, release on a spot on the field — the
// server gets one moveUnit(id, x, z) command. No camera drag, no other
// gesture; docs/GAME_DESIGN.md §2 calls for exactly this, one-thumb control.
// Same gesture drags the king (moveKing) — the physical presence Build/
// Repair require walking to a plot/tower first (see docs/PROGRESS.md's king
// walk-and-build mechanic).

function pointerToNdc(event: PointerEvent): { x: number; y: number } {
  const rect = canvas!.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
    y: -((event.clientY - rect.top) / rect.height) * 2 + 1,
  };
}

let draggingUnitId: string | null = null;
let draggingKing = false;

canvas.addEventListener("pointerdown", (event) => {
  if (!latest || latest.finished) return;
  const ndc = pointerToNdc(event);

  const unitId = city.pickOwnUnitAt(ndc.x, ndc.y);
  if (unitId) {
    draggingUnitId = unitId;
    canvas.setPointerCapture(event.pointerId);
    city.setSelected(unitId);
    city.setDragGhost(city.groundPointAt(ndc.x, ndc.y));
    return;
  }

  if (city.pickOwnKingAt(ndc.x, ndc.y)) {
    draggingKing = true;
    canvas.setPointerCapture(event.pointerId);
    city.setKingSelected(true);
    city.setDragGhost(city.groundPointAt(ndc.x, ndc.y));
  }
});

canvas.addEventListener("pointermove", (event) => {
  if (!draggingUnitId && !draggingKing) return;
  const ndc = pointerToNdc(event);
  city.setDragGhost(city.groundPointAt(ndc.x, ndc.y));
});

function endDrag(event: PointerEvent) {
  if (!draggingUnitId && !draggingKing) return;
  const ndc = pointerToNdc(event);
  const point = city.groundPointAt(ndc.x, ndc.y);
  if (draggingKing) send("moveKing", "", point.x, point.z);
  else if (draggingUnitId) send("moveUnit", draggingUnitId, point.x, point.z);
  draggingUnitId = null;
  draggingKing = false;
  city.setSelected(null);
  city.setKingSelected(false);
  city.setDragGhost(null);
}

canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

// e2e-only hook (client/e2e/smoke.mjs): projects a world (x, z) to screen
// coordinates so a test can compute where to perform a real drag gesture,
// without duplicating the camera/projection math. Mirrors the existing
// window.__thronefallSocket capture — a small, clearly-scoped test seam, not
// a general debug API.
(window as unknown as { __thronefallProject: (x: number, z: number) => { x: number; y: number } }).__thronefallProject = (
  x: number,
  z: number,
) => {
  const vector = new THREE.Vector3(x, 0.5, z).project(city.camera);
  const rect = canvas!.getBoundingClientRect();
  return {
    x: rect.left + ((vector.x + 1) / 2) * rect.width,
    y: rect.top + ((1 - vector.y) / 2) * rect.height,
  };
};
