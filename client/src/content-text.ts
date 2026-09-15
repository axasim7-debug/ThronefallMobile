// English display text, keyed by the same stable keys the engine ships
// ("cavalry", "warlord", "farm", ...). This is the ONLY place game content
// has a name — the engine never sends one (see Content.cs's header comment).
//
// Adding a language later means adding a sibling table here (or a lookup by
// locale), not touching the server or the wire protocol.

export interface TroopText {
  name: string;
  blurb: string;
}

export const TROOP_TEXT: Record<string, TroopText> = {
  infantry: { name: "Infantry", blurb: "Heavy armor, slow" },
  archer: { name: "Archer", blurb: "Long range" },
  cavalry: { name: "Cavalry", blurb: "Fast shock" },
  ninja: { name: "Ninja", blurb: "Slips past the towers" },
  fire: { name: "Firestarter", blurb: "Burns what it reaches" },
  engineer: { name: "Siege Engineer", blurb: "Wrecks defenses" },
};

export interface CommanderText {
  name: string;
  rageSkill: string;
}

export const COMMANDER_TEXT: Record<string, CommanderText> = {
  warlord: { name: "Warlord", rageSkill: "Sweeping Strike" },
  guardian: { name: "Guardian", rageSkill: "Bulwark" },
  shadow: { name: "Shadow", rageSkill: "Swift Raid" },
};

export const BUILDING_TEXT: Record<string, string> = {
  farm: "Farm",
  barracks: "Barracks",
};

export const BUILD_IN_PROGRESS_TEXT: Record<string, string> = {
  farm: "Building farm",
  barracks: "Building barracks",
  repairTower: "Repairing tower",
};

export const troopName = (key: string): string => TROOP_TEXT[key]?.name ?? key;
export const commanderName = (key: string): string => COMMANDER_TEXT[key]?.name ?? key;
export const buildingName = (key: string): string => BUILDING_TEXT[key] ?? key;
