# Nimble-HP-and-Damage

A streamlined HP and damage control module for the Nimble system in Foundry VTT.

Designed for fast in-play adjustments, this module provides an on-screen HP control panel and optional GM-routed damage handling for targeted NPCs.

##Features

Floating HP control panel for quick damage and healing.

Apply damage/healing to controlled tokens.

Optional GM-routed damage application to targeted NPCs.

Pull roll totals directly from chat.

Designed specifically for the Nimble system.

Clean, minimal interface consistent with Nimble styling.

##Requirements

Foundry VTT v13

Nimble system

SocketLib (optional; used automatically if present)

##Installation

Install via GitHub manifest:

https://raw.githubusercontent.com/Rickrollnomicon/Nimble-HP-and-Damage/main/module.json

Paste this URL into:

Add-on Modules → Install Module → Manifest URL

##Usage

Enable the module in your world.

Use the on-screen HP panel to apply damage or healing.

To apply changes to an NPC:

Target the token.

Use the panel to apply damage or healing.

If GM routing is enabled, the request will be processed by an active GM.

##Settings

Allow players to apply damage directly to NPCs.

Additional behavior is controlled through Foundry’s standard module settings.

##License

MIT License.

