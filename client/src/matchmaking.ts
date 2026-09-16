// "Searching for opponent" — the screen between pressing Battle and a match
// actually starting. Real games use this dead time for a rotating tip; we do
// the same here since it costs nothing and the tip content already exists
// (hud.ts's own idle-state text), see docs/UI_UX_IDENTITY.md §1.

const TIPS = [
  "Walk your king to a plot before building — Build and Repair both need him nearby.",
  "Ninjas slip past the towers entirely, but the keep still sees them coming.",
  "A destroyed farm keeps hurting your income for a while after it falls.",
  "Drag a unit again mid-fight to pull it back — retreat is a real, instant move.",
];

export class Matchmaking {
  private readonly root: HTMLElement;

  constructor(private onCancel: () => void) {
    this.root = document.querySelector<HTMLElement>("#matchmaking")!;
    this.build();
  }

  private build() {
    this.root.innerHTML = `
      <div class="mm-title">Searching for opponent…</div>
      <div class="mm-spinner"></div>
      <button class="mm-cancel" type="button">Cancel</button>
      <div class="mm-tip"></div>
    `;
    this.root.querySelector(".mm-cancel")!.addEventListener("click", () => this.onCancel());
  }

  show() {
    this.root.hidden = false;
    this.root.querySelector(".mm-tip")!.textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
  }

  hide() {
    this.root.hidden = true;
  }
}
