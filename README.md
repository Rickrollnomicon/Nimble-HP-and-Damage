# Nimble HP and Damage

A streamlined HP and damage control module for the **Nimble** system in Foundry VTT (v13).

This module provides a clean, fast in-play HP control panel and optional GM-routed damage handling for targeted NPCs.

Designed for speed, clarity, and minimal friction at the table.

---

## Features

- Floating HP control panel for quick damage and healing
- Apply HP changes to controlled tokens
- Optional GM-routed damage application for targeted NPCs
- Pull roll totals directly from chat
- Designed specifically for the Nimble system
- Clean interface consistent with Nimble styling
- Optional Enhanced Damage Chat Cards
- GM-selectable monster armor rule: Original / Just the Dice or Flat Reduction / Playtest

---

## Requirements

- Foundry VTT v13
- Nimble system
- SocketLib (optional — used automatically if installed)

---

## Installation (GitHub Manifest)

1. In Foundry, go to **Add-on Modules → Install Module**
2. Paste this Manifest URL:

```
https://raw.githubusercontent.com/Rickrollnomicon/Nimble-HP-and-Damage/main/module.json
```

3. Click **Install**

---

## Usage

1. Enable the module in your world.
2. Use the on-screen HP panel to apply damage or healing.
3. To apply changes to an NPC:
   - Target the token.
   - Use the panel to apply damage or healing.
   - If GM routing is enabled, the request will be processed by an active GM.

---

## Settings

The module includes configurable settings inside Foundry:

- Allow players to apply damage directly to NPCs
- Enable Enhanced Damage Chat Cards
- Enable Floating Tracker
- Show Damage Verification Chat Card
- Monster Armor Rule: Original / Just the Dice or Flat Reduction / Playtest
- Cheat Vicious Opportunist support in Enhanced Chat Cards and Floating HUD Extra Damage Options

---

## Version

Current package baseline: **v3.1.3**

---

## License

MIT License


### Development notes
- Enhanced Damage Chat Cards include a **Misc Flat Bonus** input for manually adding positive or negative flat damage not covered by current automation. The bonus is included in full damage totals but remains non-dice for Original / Just the Dice armor math.
