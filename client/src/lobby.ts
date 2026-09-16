// The screen between "app opened" and "a match is running" — Clash-Royale-
// style home base: a tab bar, a big Battle button, and placeholder panels for
// everything that isn't built yet. Structure only, per docs/UI_UX_IDENTITY.md
// §10 step 1 — no generated art, no real shop/social/progression logic. The
// only functional exit from this screen is the Battle button.

import { TROOP_TEXT } from "./content-text";

export type LobbyTab = "shop" | "cards" | "battle" | "social" | "ranking";

const TAB_LABEL: Record<LobbyTab, string> = {
  shop: "Shop",
  cards: "Cards",
  battle: "Battle",
  social: "Clan",
  ranking: "Ranking",
};

export class Lobby {
  private readonly root: HTMLElement;
  private content!: HTMLElement;

  constructor(private onBattle: () => void) {
    this.root = document.querySelector<HTMLElement>("#lobby")!;
    this.build();
  }

  show() {
    this.root.hidden = false;
  }

  hide() {
    this.root.hidden = true;
  }

  private build() {
    this.root.innerHTML = `
      <div class="lobby-top">
        <div class="resource"><span class="coin"></span><span class="lobby-gold">1000</span></div>
        <div class="resource gem"><span class="gem-icon"></span><span>0</span></div>
      </div>
      <div class="lobby-content"></div>
      <div class="lobby-cta">
        <button class="cta-side" type="button" data-tab="cards">
          <span class="cta-side-icon cards-icon"></span>
        </button>
        <button class="cta-battle" type="button">Battle</button>
        <button class="cta-side" type="button" data-tab="ranking">
          <span class="cta-side-icon trophy-icon"></span>
        </button>
      </div>
      <div class="tab-bar">
        ${(Object.keys(TAB_LABEL) as LobbyTab[])
          .map((tab) => `<button class="tab" type="button" data-tab="${tab}">${TAB_LABEL[tab]}</button>`)
          .join("")}
      </div>
    `;

    this.content = this.root.querySelector(".lobby-content")!;

    this.root.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => this.setTab(button.dataset.tab as LobbyTab));
    });
    this.root.querySelector(".cta-battle")!.addEventListener("click", () => this.onBattle());

    this.setTab("battle");
  }

  private setTab(tab: LobbyTab) {
    this.root.querySelectorAll<HTMLButtonElement>(".tab").forEach((button) => {
      button.classList.toggle("active", button.dataset.tab === tab);
    });
    this.content.innerHTML = this.renderTab(tab);
  }

  private renderTab(tab: LobbyTab): string {
    switch (tab) {
      case "battle":
        return this.renderHome();
      case "cards":
        return this.renderCards();
      default:
        return `<div class="lobby-placeholder">${TAB_LABEL[tab]} — coming soon</div>`;
    }
  }

  private renderHome(): string {
    return `
      <div class="lobby-chests">
        ${Array.from({ length: 4 }, () => `<div class="chest"></div>`).join("")}
      </div>
    `;
  }

  private renderCards(): string {
    const cards = Object.entries(TROOP_TEXT)
      .map(
        ([, text]) => `
          <div class="card">
            <div class="card-art"></div>
            <div class="card-name">${text.name}</div>
            <div class="card-blurb">${text.blurb}</div>
          </div>
        `,
      )
      .join("");
    return `<div class="card-grid">${cards}</div>`;
  }
}
