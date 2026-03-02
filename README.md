# Nimble-HP-and-Damage

A lightweight Foundry VTT module for the Nimble system that provides an on-screen HP control panel for fast adjustments, plus optional GM-routed damage/healing so players can apply changes to NPCs they target (with GM control).

What it does:

Adds an on-screen HP control panel for quick damage/healing entry and application.

Optionally allows players to apply damage/healing to targeted NPCs by routing the request to an active GM.

Supports pulling roll totals from chat and applying them to targets (including condition-style buttons from the same chat card, when present).

Requirements"

Foundry VTT v13

SocketLib: optional (used if installed; otherwise core sockets are used)

Quick start:

Enable the module in your world.

As GM- log in normally (no additional startup steps).

As player-

Control your own token for normal HP adjustments.

To apply damage/healing to an NPC/monster: target the token (bullseye) and use the panel to apply damage/healing.

#Permissions and safety

Player → NPC damage/healing is controlled by the module setting: “Allow players to apply damage directly”.

The panel displays HP for controlled tokens; targeting an NPC does not display the NPC’s HP.

Notes:

HP data paths are Nimble-specific and not configurable in this build.
