// NOTE: Do not import from floatinghp.js here.
// settings.js is loaded as an ES module and floatinghp.js imports settings.js;
// importing back can create a circular dependency that can break initialization.

export const registerSettings = function () {
  const modulename = "nimble-hp-and-damage";

  // Master feature gate for ALL player-to-NPC damage routing.
  game.settings.register(modulename, "allow-player-damage", {
    name: "Allow players to apply damage directly",
    hint: "When enabled, players may target NPC tokens and apply damage/healing via the Floating HUD or Enhanced Chat Cards. (SocketLib module optional but recommended for best damage routing)",
    scope: "world",
    restricted: true,
    config: true,
    default: false,
    type: Boolean,
    requiresReload: true
  });

  game.settings.register(modulename, "enable-enhanced-chat-cards", {
    name: "Enable Enhanced Chat Cards",
    hint: "Adds enhanced damage application functionality to damage chat cards, including armor reduction/bypass, resistances/vulnerabilities, and select class abilities.",
    scope: "world",
    restricted: true,
    config: true,
    default: true,
    type: Boolean
  });

  game.settings.register(modulename, "enable-floating-tracker", {
    name: "Enable Floating HUD",
    hint: "Enable use of the Floating HUD. Individual players can choose to show/hide using a button in the left menu.",
    scope: "world",
    restricted: true,
    config: true,
    default: true,
    type: Boolean
  });

  game.settings.register(modulename, "show-damage-verification-card", {
    name: "Show Damage Verification Chat Card",
    hint: "When enhanced application is used, always post the verification chat card.",
    scope: "world",
    restricted: true,
    config: true,
    default: true,
    type: Boolean
  });

  game.settings.register(modulename, "enable-alternate-dice-pools", {
    name: "Enable enhanced/alternate dice pool functionality",
    hint: "Enables alternate (legacy) pool management for Judgment and Fury Dice, adding options to the enhanced chat card and floating HUD.",
    scope: "world",
    restricted: true,
    config: true,
    default: false,
    type: Boolean
  });

  game.settings.register(modulename, "monster-armor-rule", {
    name: "Monster Armor Rule",
    hint: "Choose how monster Medium/Heavy Armor reduces damage in the Floating HUD and Enhanced Chat Cards. Original uses dice-only damage; Flat Reduction is the current playtest rule.",
    scope: "world",
    restricted: true,
    config: true,
    default: "original",
    type: String,
    choices: {
      original: "Original / Just the Dice",
      flat: "Flat Reduction / Playtest"
    }
  });

  // Dead/Dying automation gate.
  game.settings.register(modulename, "add-defeated", {
    name: "Auto-apply Dying & Wounds to PCs",
    hint: "Automatically apply the Dying condition and add one Wound to player characters when Hit Points reach zero. Additional damage adds an additional Wound.",
    scope: "world",
    restricted: true,
    default: true,
    type: Boolean,
    config: true
  }); 

  // Internal client-side toggle state for the Token Controls button.
  // Hidden on purpose.
  game.settings.register(modulename, "show-dialog", {
    scope: "client",
    default: true,
    type: Boolean,
    config: false
  });

  // Client-side tooltip toggle (per-user).
  game.settings.register(modulename, "show-tooltips", {
    name: "Show tooltips",
    hint: "Show hover tooltips on the Nimble HP HUD controls.",
    scope: "client",
    config: true,
    restricted: false,
    default: true,
    type: Boolean,
    onChange: (value) => {
      try { game.FloatingHP?.app?._applyTooltipSetting?.(); } catch (_) {}
    }
  });
};