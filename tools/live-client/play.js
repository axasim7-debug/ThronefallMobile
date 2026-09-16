#!/usr/bin/env node
// A real client for the live match protocol (server/Thronefall.Api/LiveMatch.cs),
// now speaking to Thronefall.PositionalEngine (docs/PROGRESS.md has the pivot
// history — real (x,z) unit/structure positions, continuous combat, no
// commanders/rage yet).
//
// This is the reference implementation of "what the game client does": it
// sends intents and renders what comes back. It resolves nothing — no damage,
// no timers, no winner, no state it wasn't told. Every number it prints came
// off the wire. It does compare gold against the server-sent catalog, but
// only to decide what to show as available; the server re-validates every
// command regardless, which --probe demonstrates.
//
// Usage:
//   node tools/live-client/play.js [--url ws://127.0.0.1:5199] [--opponent atk]
//                                  [--speed 60] [--quiet] [--probe]
//
//   --speed N   compress N simulated seconds into one real second (dev only)
//   --probe     also fire deliberately illegal commands to show the server
//               refusing them (used by the end-to-end check)

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const base = flag('url', 'ws://127.0.0.1:5199');
const opponent = flag('opponent', 'atk');
const speed = flag('speed', '60');
const quiet = has('quiet');
const probe = has('probe');

const url = `${base}/ws/match?opponent=${opponent}&speed=${speed}`;
const socket = new WebSocket(url);

let seq = 0;
let catalog = null;
const acks = [];
let lastState = null;
let ended = null;
let sentAttackers = false;

const send = (kind, arg, extra = {}) => {
  seq += 1;
  socket.send(JSON.stringify({ type: 'command', kind, arg, seq, ...extra }));
  return seq;
};

const log = (...a) => { if (!quiet) console.log(...a); };
const keepOf = (side) => side.structures.find((s) => s.key === 'keep');

socket.addEventListener('open', () => log(`→ connected: ${url}`));

socket.addEventListener('error', (e) => {
  console.error('socket error:', e.message ?? e);
  process.exitCode = 1;
});

socket.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);

  switch (msg.type) {
    case 'matchStarted': {
      catalog = msg.catalog;
      log(`→ match started: you are side ${msg.side} vs "${msg.opponent}", ${msg.duration}s at ${msg.speed}x`);
      log(`  catalog: ${Object.keys(catalog.troops).length} troops, ` +
          `barracks ${catalog.buildings.barracks.cost}g`);
      if (probe) {
        // the client is untrusted: prove the server refuses these
        send('build', 'wonder-of-the-world');
        send('train', 'dragon');
        send('train', 'infantry');            // no barracks yet
        send('moveUnit', 'ghost-unit', { x: 0, z: 0 }); // unit doesn't exist
        socket.send('{not json at all');
        socket.send(JSON.stringify({ type: 'command', kind: 'teleport' }));
      }
      break;
    }

    case 'ack': {
      acks.push(msg);
      const mark = msg.accepted ? '✓' : '✗';
      log(`  ${mark} t=${String(msg.tick).padStart(3)} ${msg.kind} ${msg.arg || ''}` +
          (msg.accepted ? '' : ` — refused: ${msg.reason}`));
      break;
    }

    case 'error': {
      acks.push({ accepted: false, reason: msg.message, kind: 'protocol', arg: '' });
      log(`  ✗ protocol: ${msg.message}`);
      break;
    }

    case 'state': {
      lastState = msg;
      decide(msg);
      if (msg.tick % 60 === 0) {
        const y = msg.you, e = msg.enemy;
        const yKeep = keepOf(y), eKeep = keepOf(e);
        log(`  t=${String(msg.tick).padStart(3)}  you: ${y.gold}g keep ${yKeep.hp}/${yKeep.maxHp} ` +
            `troops ${y.troopsProduced} units ${y.units.length}  |  ` +
            `enemy: keep ${eKeep.hp}/${eKeep.maxHp} troops ${e.troopsProduced} units ${e.units.length}`);
      }
      break;
    }

    case 'matchEnded': {
      ended = msg;
      log(`→ match ended at t=${msg.endedAtTick}: ${msg.winner} (${msg.tiebreak})`);
      break;
    }
  }
});

// The entire "AI" of this client: a plain build order plus "send any idle
// unit at the enemy keep" expressed as intents. Note what is absent — no
// damage maths, no notion of who is winning, no pathing. It asks; the server
// decides, and a refusal is normal.
//
// The price check below is presentation only — it is what greys out a button,
// using the catalog the server sent. It is NOT a permission check: the server
// re-validates every command regardless, which is what --probe demonstrates.
const priceOf = (kind, arg) =>
  kind === 'train' ? catalog.troops[arg]?.cost : catalog.buildings[arg]?.cost;

const canAfford = (state, kind, arg) => {
  const price = priceOf(kind, arg);
  return price === undefined || state.you.gold >= price;
};

function decide(state) {
  const you = state.you;
  if (state.finished) return;

  if (!you.hasBarracks && you.buildBusy === null) {
    if (canAfford(state, 'build', 'barracks')) send('build', 'barracks');
  } else if (you.hasBarracks && !you.troopBusy) {
    if (canAfford(state, 'train', 'cavalry')) send('train', 'cavalry');
  }

  // A live player has full manual control — nothing auto-sends a trained
  // troop. This client's "AI" is deliberately minimal: send everything
  // currently standing idle (no waypoint yet) at the enemy keep, once.
  if (!sentAttackers && you.units.some((u) => u.waypointX === null)) {
    const enemyKeep = keepOf(state.enemy);
    for (const u of you.units) {
      if (u.waypointX === null) send('moveUnit', u.id, { x: enemyKeep.x, z: enemyKeep.z });
    }
    sentAttackers = you.units.length > 0 && you.units.every((u) => u.waypointX !== null);
  }
}

socket.addEventListener('close', () => {
  const accepted = acks.filter((a) => a.accepted).length;
  const refused = acks.length - accepted;

  console.log('\n--- summary (all values reported by the server) ---');
  console.log(`commands accepted: ${accepted}   refused: ${refused}`);
  if (refused) {
    const reasons = [...new Set(acks.filter((a) => !a.accepted).map((a) => a.reason))];
    console.log(`refusal reasons:   ${reasons.join(', ')}`);
  }
  if (lastState) {
    const y = lastState.you, e = lastState.enemy;
    const yKeep = keepOf(y), eKeep = keepOf(e);
    console.log(`final tick:        ${lastState.tick}/${lastState.duration}`);
    console.log(`you:               keep ${yKeep.hp}  troops ${y.troopsProduced}  units ${y.units.length}`);
    console.log(`enemy:             keep ${eKeep.hp}  troops ${e.troopsProduced}  units ${e.units.length}`);
  }
  if (ended) console.log(`result:            ${ended.winner} by ${ended.tiebreak}`);

  // machine-readable line for the end-to-end check
  console.log(`RESULT_JSON ${JSON.stringify({
    accepted, refused,
    reasons: [...new Set(acks.filter((a) => !a.accepted).map((a) => a.reason))],
    tick: lastState?.tick ?? null,
    troops: lastState?.you.troopsProduced ?? null,
    winner: ended?.winner ?? null,
    tiebreak: ended?.tiebreak ?? null,
  })}`);
});
