// The on-screen interface. Every value it shows came from the server, and
// every button it offers sends an intent and waits for the verdict.
//
// Buttons do disable themselves on price and on busy slots — that is button
// *presentation*, using the catalog the server sent at match start. It is not
// a permission check: pressing anything still goes to the server, which
// re-validates and can refuse. See docs/GAME_DESIGN.md §5.2.
//
// No commander/rage row here — server/Thronefall.PositionalEngine doesn't
// have that system (yet — see docs/PROGRESS.md's open items). Unit
// positioning (build/train's payoff) happens by dragging directly on the
// battlefield, wired in main.ts, not through a HUD button.

import type { Catalog, CommandKind, MatchState, SideView } from "./protocol";
import { refusalText } from "./protocol";
import { buildingName, troopName, BUILD_IN_PROGRESS_TEXT } from "./content-text";
import { plotAnchors } from "./scene";

export type CommandSender = (kind: CommandKind, arg?: string, x?: number, z?: number) => void;

interface ActionButton {
  el: HTMLButtonElement;
  kind: CommandKind;
  arg: string;
  priceEl: HTMLSpanElement | null;
}

export class Hud {
  private readonly top: HTMLElement;
  private readonly bottom: HTMLElement;

  private clock!: HTMLElement;
  private gold!: HTMLElement;
  private income!: HTMLElement;
  private youBar!: HTMLElement;
  private enemyBar!: HTMLElement;
  private youKeepText!: HTMLElement;
  private enemyKeepText!: HTMLElement;
  private youTowers!: HTMLElement;
  private enemyTowers!: HTMLElement;
  private status!: HTMLElement;
  private toast!: HTMLElement;
  private banner!: HTMLElement;

  private actions: ActionButton[] = [];

  private catalog: Catalog | null = null;
  private toastTimer: number | undefined;

  constructor(private send: CommandSender) {
    this.top = document.querySelector<HTMLElement>("#hud-top")!;
    this.bottom = document.querySelector<HTMLElement>("#hud-bottom")!;
    this.buildTop();
    this.buildBottom();
  }

  // ---- static structure -------------------------------------------------

  private buildTop() {
    this.top.innerHTML = `
      <div class="bar-row">
        <div class="resource">
          <span class="coin"></span>
          <span class="gold-amount">—</span>
          <span class="income">/s —</span>
        </div>
        <div class="clock">—:—</div>
      </div>
      <div class="keeps">
        <div class="keep-line you">
          <span class="keep-label">You</span>
          <div class="hp-track"><div class="hp-fill you-fill"></div></div>
          <span class="keep-text">—</span>
          <span class="tower-pips you-pips"></span>
        </div>
        <div class="keep-line enemy">
          <span class="keep-label">Enemy</span>
          <div class="hp-track"><div class="hp-fill enemy-fill"></div></div>
          <span class="keep-text">—</span>
          <span class="tower-pips enemy-pips"></span>
        </div>
      </div>
      <div class="status">Connecting…</div>
    `;
    this.clock = this.top.querySelector(".clock")!;
    this.gold = this.top.querySelector(".gold-amount")!;
    this.income = this.top.querySelector(".income")!;
    this.youBar = this.top.querySelector(".you-fill")!;
    this.enemyBar = this.top.querySelector(".enemy-fill")!;
    this.youKeepText = this.top.querySelector(".keep-line.you .keep-text")!;
    this.enemyKeepText = this.top.querySelector(".keep-line.enemy .keep-text")!;
    this.youTowers = this.top.querySelector(".you-pips")!;
    this.enemyTowers = this.top.querySelector(".enemy-pips")!;
    this.status = this.top.querySelector(".status")!;
  }

  private buildBottom() {
    this.bottom.innerHTML = `
      <div class="toast" hidden></div>
      <div class="banner" hidden></div>
      <div class="row builds"></div>
      <div class="row troops"></div>
    `;
    this.toast = this.bottom.querySelector(".toast")!;
    this.banner = this.bottom.querySelector(".banner")!;
  }

  /**
   * The build/train buttons exist only once the server has told us what
   * exists and what it costs — the client ships with no content list, only
   * the English display text for whatever keys the server names (see
   * content-text.ts).
   */
  applyCatalog(catalog: Catalog) {
    this.catalog = catalog;
    const builds = this.bottom.querySelector<HTMLElement>(".builds")!;
    const troops = this.bottom.querySelector<HTMLElement>(".troops")!;
    builds.innerHTML = "";
    troops.innerHTML = "";
    this.actions = [];

    for (const key of Object.keys(catalog.buildings)) {
      builds.appendChild(this.makeAction("build", key, buildingName(key), catalog.buildings[key].cost));
    }
    builds.appendChild(this.makeAction("repair", "", "Repair", null));

    for (const [key, troop] of Object.entries(catalog.troops)) {
      troops.appendChild(this.makeAction("train", key, troopName(key), troop.cost));
    }
  }

  private makeAction(kind: CommandKind, arg: string, label: string, price: number | null): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = "action";
    button.type = "button";
    button.innerHTML = `<span class="action-label"></span>${price === null ? "" : `<span class="action-price"></span>`}`;
    button.querySelector<HTMLElement>(".action-label")!.textContent = label;
    const priceEl = button.querySelector<HTMLSpanElement>(".action-price");
    if (priceEl && price !== null) priceEl.textContent = String(price);
    button.addEventListener("click", () => this.send(kind, arg));
    this.actions.push({ el: button, kind, arg, priceEl });
    return button;
  }

  // ---- per-tick update --------------------------------------------------

  update(state: MatchState) {
    const you = state.you;

    this.clock.textContent = formatClock(Math.max(0, state.duration - state.tick));
    this.gold.textContent = String(you.gold);
    this.income.textContent = `/s ${you.income}`;

    this.updateKeep(this.youBar, this.youKeepText, this.youTowers, you);
    this.updateKeep(this.enemyBar, this.enemyKeepText, this.enemyTowers, state.enemy);

    this.status.textContent = describeActivity(you);
    this.updateActions(you);
  }

  private updateKeep(bar: HTMLElement, text: HTMLElement, pips: HTMLElement, side: SideView) {
    const keep = side.structures.find((s) => s.key === "keep");
    const towers = side.structures.filter((s) => s.key === "tower");
    if (!keep) return;

    // maxHp already accounts for the reinforcement ramp, server-side
    const fraction = keep.maxHp > 0 ? keep.hp / keep.maxHp : 0;
    bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
    bar.classList.toggle("critical", fraction < 0.25);
    text.textContent = `${keep.hp}`;

    if (pips.childElementCount !== towers.length) {
      pips.innerHTML = towers.map(() => `<i class="pip"></i>`).join("");
    }
    towers.forEach((tower, i) => {
      pips.children[i].classList.toggle("down", tower.destroyed);
    });
  }

  private updateActions(you: SideView) {
    if (!this.catalog) return;
    for (const action of this.actions) {
      let disabled = false;

      if (action.kind === "build") {
        const entry = this.catalog.buildings[action.arg];
        disabled = you.buildBusy !== null || you.gold < entry.cost;
        if (action.arg === "farm" && you.farms >= (entry.maxCount ?? Infinity)) disabled = true;
        if (action.arg === "barracks" && you.hasBarracks) disabled = true;
        if (!disabled && this.isKingTooFarToBuild(you, action.arg)) disabled = true;
      } else if (action.kind === "train") {
        const entry = this.catalog.troops[action.arg];
        disabled = !you.hasBarracks || you.troopBusy || you.gold < entry.cost;
      } else if (action.kind === "repair") {
        disabled = you.buildBusy !== null;
      }

      action.el.disabled = disabled;
      if (action.priceEl) {
        const price =
          action.kind === "build"
            ? this.catalog.buildings[action.arg].cost
            : this.catalog.troops[action.arg]?.cost;
        action.priceEl.classList.toggle("unaffordable", price !== undefined && you.gold < price);
      }
    }
  }

  /** Build's plot is a fixed, known location (plotAnchors — pure geometry
   * from the catalog), so disabling the button early when the king hasn't
   * walked there yet is still just presentation, same as the price/slot
   * checks above. Repair gets no equivalent check: which tower needs it is
   * the engine's own decision (server/Thronefall.PositionalEngine/Match.cs's
   * FindRepairTarget), and duplicating that here would be exactly the game
   * logic this client isn't supposed to have — a stale/wrong guess would be
   * worse than just letting the server's "king-too-far" refusal surface via
   * the toast. */
  private isKingTooFarToBuild(you: SideView, building: string): boolean {
    if (!this.catalog || (building !== "farm" && building !== "barracks")) return false;
    const anchors = plotAnchors(this.catalog, you);
    const plot = building === "farm" ? anchors.farm : anchors.barracks;
    return Math.hypot(you.kingX - plot.x, you.kingZ - plot.z) > this.catalog.king.buildRadius;
  }

  // ---- feedback ---------------------------------------------------------

  setStatus(text: string) {
    this.status.textContent = text;
  }

  /** Only refusals surface — an accepted command shows up as changed state. */
  showRefusal(reason: string | null) {
    this.toast.textContent = refusalText(reason);
    this.toast.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast.hidden = true;
    }, 1600);
  }

  showBanner(text: string, tone: "win" | "lose" | "draw" | "info") {
    this.banner.textContent = text;
    this.banner.className = `banner ${tone}`;
    this.banner.hidden = false;
    for (const action of this.actions) action.el.disabled = true;
  }
}

function describeActivity(you: SideView): string {
  const parts: string[] = [];
  if (you.buildBusy) {
    const label = BUILD_IN_PROGRESS_TEXT[you.buildBusy] ?? you.buildBusy;
    parts.push(`${label} (${Math.ceil(you.buildTimer)}s)`);
  }
  if (you.troopBusy && you.troopKey) {
    parts.push(`Training ${troopName(you.troopKey)} (${Math.ceil(you.troopTimer)}s)`);
  }
  if (parts.length === 0) {
    return you.hasBarracks
      ? "Drag units on the field to move them"
      : "Drag your king to the barracks plot, then Build";
  }
  return parts.join(" · ");
}

function formatClock(secondsLeft: number): string {
  const m = Math.floor(secondsLeft / 60);
  const s = secondsLeft % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
