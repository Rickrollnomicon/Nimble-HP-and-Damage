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
- GM routing behavior toggle

---

## Version

Current canonical release: **v2.2.43**

---

## License

MIT License
