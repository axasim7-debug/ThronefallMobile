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

function frame() {
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

const send = (kind: CommandKind, arg = "") => connection.send(kind, arg);
const hud = new Hud(send);

const connection = new MatchConnection(url, {
  onStarted(message) {
    hud.applyCatalog(message.catalog);
    city.applyCatalog(message.catalog);
    hud.setStatus(`المباراة بدأت — الخصم: ${message.opponent}`);
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
    const text =
      message.winner === "you" ? "فزت!" : message.winner === "draw" ? "تعادل" : "خسرت";
    hud.showBanner(`${text} — ${describeTiebreak(message.tiebreak)}`, tone);
  },

  onError(message) {
    hud.setStatus(`خطأ: ${message}`);
  },

  onClosed() {
    if (latest && !latest.finished) hud.showBanner("انقطع الاتصال بالخادم", "info");
  },
});

const TIEBREAK_TEXT: Record<string, string> = {
  "keep-kill": "تدمير القلعة",
  "towers-destroyed": "عدد الأبراج المدمَّرة",
  "own-keep-hp-pct": "نسبة HP القلعة المتبقية",
  "true-draw": "تعادل تام",
  "mutual-destruction-timing": "توقيت التدمير المتبادل",
  "mutual-destruction-same-tick": "تدمير متبادل في نفس اللحظة",
};

function describeTiebreak(tiebreak: string): string {
  return TIEBREAK_TEXT[tiebreak] ?? tiebreak;
}
