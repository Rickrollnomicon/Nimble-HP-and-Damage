// NOTE: Do not import from floatinghp.js here.
// settings.js is loaded as an ES module and floatinghp.js imports settings.js;
// importing back can create a circular dependency that can break initialization.

export const registerSettings = function () {
  const modulename = "nimble-hp-and-damage";

  // Master feature gate for ALL player-to-NPC damage routing.
  // Default OFF to preserve standalone Floating HP Tracker behavior.
  game.settings.register(modulename, "allow-player-damage", {
    name: "Allow players to apply damage directly",
    hint: "When enabled, players may target NPC tokens and apply damage/healing via the Floating HP HUD (routed through the GM). Requires reload.",
    scope: "world",
    restricted: true,
    config: true,
    default: false,
    type: Boolean,
    requiresReload: true
  });

  game.settings.register(modulename, "enable-enhanced-chat-cards", {
    name: "Enable Enhanced Damage Chat Cards",
    hint: "Adds an enhanced control strip above compatible Nimble Apply Damage buttons. Current build is a foundation pass.",
    scope: "world",
    restricted: true,
    config: true,
    default: false,
    type: Boolean
  });

  game.settings.register(modulename, "enable-floating-tracker", {
    name: "Enable Floating Tracker",
    hint: "Show the Nimble HP and Damage floating tracker.",
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

  // Dead/Dying automation gate.
  game.settings.register(modulename, "add-defeated", {
    name: "Auto-apply Dead/Dying",
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