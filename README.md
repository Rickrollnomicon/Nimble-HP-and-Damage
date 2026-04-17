# Nimble HP and Damage

A streamlined HP and damage control module for the **Nimble** system in Foundry VTT (v13).

This module provides both a fast in-play HP control panel and a fully integrated chat-based damage system.

Designed for speed, clarity, and minimal friction at the table.

---

## Features

### Core Functionality
- Floating HP control panel for quick damage and healing
- Apply HP changes to controlled tokens
- Optional GM-routed damage application for targeted NPCs
- Pull roll totals directly from chat
- Designed specifically for the Nimble system
- Clean interface consistent with Nimble styling

### Enhanced Chat Cards (v3.0)
- Apply damage directly from chat cards with an integrated control panel
- Fully message-driven (no canvas dependency)
- Real-time target updates within chat cards
- Inline damage preview showing calculation adjustments
- Right-click support for pulling values from recent rolls

#### Damage Controls
- Armor interaction (Heavy / Medium / Bypass)
- Resist / Vulnerable toggles
- Defend states for PCs

#### System Integration
- Unified damage pipeline shared with floating tracker
- Temp HP is consumed before primary HP
- Automatic Dying condition when PCs reach 0 HP
- Wound system integration:
  - +1 Wound when Dying is applied
  - Additional Wounds for further damage while Dying
- Healing above 0 HP removes Dying

#### Undo & Verification
- Undo restores HP, Temp HP, Dying, and Wounds
- Verification chat cards only appear after confirmed HP application

---

## Requirements

- Foundry VTT v13
- Nimble system
- SocketLib (optional — used automatically if installed - RECOMMENDED if using option to allow PCs to apply damage directly)

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

### Floating HP Panel
1. Enable the module in your world
2. Use the on-screen HP panel to apply damage or healing

### Chat Card Damage Application
1. Roll damage as normal in Nimble
2. Use the enhanced controls in the chat card
3. Adjust modifiers if needed (armor, resist, etc.)
4. Apply damage directly from the chat card

### NPC Targeting
- Target the token before applying damage
- If GM routing is enabled, actions will be processed by an active GM

---

## Settings

The module includes configurable settings inside Foundry:

- Allow players to apply damage directly to NPCs
- GM routing behavior toggle

---

## Version

Current canonical release: **v3.0.0**

---

## License

MIT License