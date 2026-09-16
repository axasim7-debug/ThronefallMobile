// The wire contract with the authoritative server
// (server/Thronefall.Api/LiveMatch.cs). These types mirror
// server/Thronefall.PositionalEngine/MatchSnapshot.cs field for field.
//
// Nothing in this file computes a game value. The client sends intents and
// renders what comes back — docs/GAME_DESIGN.md §5.2.

export interface StructureView {
  id: string;
  key: string; // "tower" | "keep"
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  destroyed: boolean;
}

/** waypointX/Z are null when the unit has no pending order — sitting exactly
 * where it was placed, per the "nothing auto-advances" rule. */
export interface UnitView {
  id: string;
  key: string; // a troop key, e.g. "cavalry"
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  waypointX: number | null;
  waypointZ: number | null;
}

export interface SideView {
  name: string;
  gold: number;
  income: number;
  farms: number;
  hasBarracks: boolean;
  /** null when the single build slot is idle — the server always sends the key */
  buildBusy: string | null;
  buildTimer: number;
  troopBusy: boolean;
  troopTimer: number;
  troopKey: string | null;
  troopsProduced: number;
  structures: StructureView[];
  units: UnitView[];
}

export interface MatchState {
  tick: number;
  duration: number;
  finished: boolean;
  /** "you" | "enemy" | "draw" — already resolved from this client's seat */
  winner: string | null;
  tiebreak: string | null;
  you: SideView;
  enemy: SideView;
}

export interface BuildingCatalogEntry {
  cost: number;
  buildTime: number;
  maxCount?: number;
}

export interface TroopCatalogEntry {
  cost: number;
  buildTime: number;
  hp: number;
  dps: number;
  range: number;
  speed: number;
}

export interface DefenseCatalogEntry {
  hp: number;
  dps: number;
  range: number;
}

export interface Catalog {
  buildings: Record<string, BuildingCatalogEntry>;
  troops: Record<string, TroopCatalogEntry>;
  defense: { towerCount: number; tower: DefenseCatalogEntry; keep: DefenseCatalogEntry };
  layout: { plotDepth: number; tower: number; econ: number; keep: number };
}

export type CommandKind = "build" | "train" | "repair" | "moveUnit";

export interface CommandAck {
  type: "ack";
  clientSeq: number | null;
  kind: string;
  arg: string;
  accepted: boolean;
  /** stable machine-readable slug, localized by the client */
  reason: string | null;
  tick: number;
}

export interface MatchStartedMessage {
  type: "matchStarted";
  side: string;
  opponent: string;
  duration: number;
  speed: number;
  catalog: Catalog;
}

export interface MatchEndedMessage {
  type: "matchEnded";
  winner: string | null;
  absoluteWinner: string;
  tiebreak: string;
  endedAtTick: number;
}

export type ServerMessage =
  | MatchStartedMessage
  | ({ type: "state" } & MatchState)
  | CommandAck
  | MatchEndedMessage
  | { type: "error"; message: string };

export interface ConnectionHandlers {
  onStarted(message: MatchStartedMessage): void;
  onState(state: MatchState): void;
  onAck(ack: CommandAck): void;
  onEnded(message: MatchEndedMessage): void;
  onError(message: string): void;
  onClosed(): void;
}

/**
 * One live match over a WebSocket. Owns the socket and the outgoing sequence
 * counter; holds no game state of its own, so there is nothing here that can
 * disagree with the server.
 */
export class MatchConnection {
  private socket: WebSocket;
  private seq = 0;

  constructor(url: string, private handlers: ConnectionHandlers) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener("message", (event) => this.dispatch(event.data));
    this.socket.addEventListener("close", () => handlers.onClosed());
    this.socket.addEventListener("error", () => handlers.onError("connection-failed"));
  }

  private dispatch(raw: unknown) {
    let message: ServerMessage;
    try {
      message = JSON.parse(String(raw)) as ServerMessage;
    } catch {
      this.handlers.onError("unreadable-server-message");
      return;
    }
    switch (message.type) {
      case "matchStarted":
        this.handlers.onStarted(message);
        break;
      case "state":
        this.handlers.onState(message);
        break;
      case "ack":
        this.handlers.onAck(message);
        break;
      case "matchEnded":
        this.handlers.onEnded(message);
        break;
      case "error":
        this.handlers.onError(message.message);
        break;
    }
  }

  /** Fire an intent. The server decides; a refusal comes back as an ack.
   * x/z only matter for "moveUnit" (arg is the unit's id there). */
  send(kind: CommandKind, arg = "", x?: number, z?: number): number {
    if (this.socket.readyState !== WebSocket.OPEN) return -1;
    this.seq += 1;
    const payload: Record<string, unknown> = { type: "command", kind, arg, seq: this.seq };
    if (x !== undefined) payload.x = x;
    if (z !== undefined) payload.z = z;
    this.socket.send(JSON.stringify(payload));
    return this.seq;
  }

  close() {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
  }
}

/**
 * Refusal slugs rendered in the player's language. Unknown slugs fall back to
 * the raw string rather than being swallowed — a silent client is how the
 * null-omission bug hid (see docs/PROGRESS.md).
 */
const REFUSAL_TEXT: Record<string, string> = {
  "not-enough-gold": "Not enough gold",
  "build-slot-busy": "Build queue is busy",
  "training-slot-busy": "Barracks is busy",
  "no-barracks": "You need a barracks first",
  "farm-limit-reached": "Farm limit reached",
  "barracks-already-built": "Barracks already built",
  "unknown-troop": "Unknown troop",
  "unknown-building": "Unknown building",
  "nothing-to-repair-or-not-enough-gold": "Nothing to repair (or not enough gold)",
  "unknown-unit": "Unknown unit",
  "not-your-unit": "That isn't your unit",
  "unit-already-dead": "That unit is gone",
  "move-needs-coordinates": "Move command needs a destination",
  "invalid-move": "That move isn't valid",
};

export const refusalText = (reason: string | null): string =>
  reason === null ? "Rejected" : REFUSAL_TEXT[reason] ?? reason;
