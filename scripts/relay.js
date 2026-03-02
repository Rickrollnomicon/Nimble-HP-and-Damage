// Nimble HP and Damage — GM Damage Relay + client helpers
//
// Purpose:
// - Allows non-GM users to apply damage/healing to NPC tokens they *target* (not control)
//   by routing the HP update through the GM account.
// - Designed to integrate with the Floating HP HUD without changing its styling.
//
// Transport:
// - Preferred: SocketLib (executeAsGM)
// - Fallback: core game.socket channel (module.<MODULE_ID>)
//
// Notes:
// - This relay intentionally mirrors the Floating HP Tracker's update math, using the
//   same update math as the HUD, using Nimble’s fixed HP paths.
// - Chat output is OPTIONAL and is only used when a caller explicitly requests it
//   (e.g., when a player applies damage to a targeted NPC via the Floating HP HUD).

export const MODULE_ID = "nimble-hp-and-damage";

// Nimble resource paths (locked)
const HP_VALUE_PATH = "attributes.hp.value";
const HP_TEMP_PATH = "attributes.hp.temp";
const HP_MAX_PATH = "attributes.hp.max";
const HP_TEMPMAX_PATH = "attributes.hp.tempmax";

let _socketlib = null; // SocketLib module socket (if available)

// Status relay is intentionally constrained.
// We only allow toggling effects that exist in CONFIG.statusEffects (by id/name).
// This prevents arbitrary strings being relayed as "status effects".

function _getSetting(key) {
  return game.settings.get(MODULE_ID, key);
}

function _getResourceValue(actor, resourceName) {
  if (!resourceName || resourceName.startsWith(".")) return 0;
  const v = foundry.utils.getProperty(actor, `system.${resourceName}`);
  return parseInt(v ?? 0);
}

// ------------------------
// Status helpers
// ------------------------

function _normalizeStatusKey(statusIdOrName) {
  return String(statusIdOrName ?? "").toLowerCase().trim();
}

function _resolveStatusIdBestEffort(statusIdOrName) {
  const key = _normalizeStatusKey(statusIdOrName);
  if (!key) return null;

  const list = (CONFIG.statusEffects ?? []);
  const byId = list.find(e => _normalizeStatusKey(e?.id) === key);
  if (byId?.id) return byId.id;

  const byName = list.find(e => {
    const n = _normalizeStatusKey(e?.name ?? e?.label);
    return n === key;
  });
  return byName?.id ?? statusIdOrName;
}

async function _toggleStatusEffectBestEffort(tokenDoc, actor, statusIdOrName, active) {
  const effectId = _resolveStatusIdBestEffort(statusIdOrName);
  if (!effectId) return;

  // Prefer token document toggle (most reliable for in-scene tokens).
  const toggleTarget = tokenDoc?.toggleStatusEffect ? tokenDoc
    : actor?.toggleStatusEffect ? actor
      : null;
  if (!toggleTarget) return;

  const statuses = (toggleTarget === tokenDoc)
    ? (tokenDoc?.actor?.statuses ?? tokenDoc?.statuses)
    : actor?.statuses;

  const exists = statuses?.has?.(effectId) ?? false;
  if (active && exists) return;
  if (!active && !exists) return;

  await toggleTarget.toggleStatusEffect(effectId, { active: !!active });
}

async function _applyDeadDyingStatusForActor(actor, tokenDoc) {
  try {
    if (!game.settings.get(MODULE_ID, "add-defeated")) return;
    if (!actor) return;

    const hp = _getResourceValue(actor, HP_VALUE_PATH);
    const isPC = !!(actor.hasPlayerOwner || actor.type === "character" || actor.type === "pc");

    if (hp <= 0) {
      if (isPC) await _toggleStatusEffectBestEffort(tokenDoc, actor, "dying", true);
      else await _toggleStatusEffectBestEffort(tokenDoc, actor, "dead", true);
    } else {
      if (isPC) await _toggleStatusEffectBestEffort(tokenDoc, actor, "dying", false);
    }
  } catch (err) {
    console.error(`[${MODULE_ID}] dead/dying status error:`, err);
  }
}


async function _applyBloodiedStatusForActor(actor, tokenDoc) {
  try {
    if (!game.settings.get(MODULE_ID, "add-defeated")) return; // keep tied to same automation toggle
    if (!actor) return;

    const hp = _getResourceValue(actor, HP_VALUE_PATH);
    const max = _getResourceValue(actor, HP_MAX_PATH);
    if (!max || max <= 0) return;

    // Nimble: Bloodied at 50% (or less) of max HP; removed when above 50%.
    // Do not keep Bloodied while at 0 HP.
    const shouldBeBloodied = (hp > 0) && (hp <= (max / 2));
    await _toggleStatusEffectBestEffort(tokenDoc, actor, "bloodied", shouldBeBloodied);
  } catch (err) {
    console.error(`[${MODULE_ID}] bloodied status error:`, err);
  }
}

async function _toggleStatusAsGM({ tokenUuids = [], tokenUuid, statusId, statusKey, action = "add", active, fromUserId } = {}) {
  if (!game.user.isGM) return;

  // Fail closed if feature gate is off.
  try {
    if (!game.settings.get(MODULE_ID, "allow-player-damage")) return;
  } catch {
    return;
  }

  const key = _normalizeStatusKey(statusKey ?? statusId);
  if (!key) return;

  const resolved = _resolveStatusIdBestEffort(key);
  if (!resolved) return;

  // Must exist in CONFIG.statusEffects (by id) to be eligible.
  const exists = (CONFIG.statusEffects ?? []).some(e => _normalizeStatusKey(e?.id) === _normalizeStatusKey(resolved));
  if (!exists) return;

  const wantActive = (typeof active === "boolean")
    ? active
    : (String(action).toLowerCase() === "remove" ? false : true);

  const list = Array.isArray(tokenUuids) && tokenUuids.length
    ? tokenUuids
    : (tokenUuid ? [tokenUuid] : []);

  for (const tu of list) {
    let tDoc = null;
    try { tDoc = await fromUuid(tu); } catch { /* ignore */ }
    const actor = tDoc?.actor ?? (tDoc?.actorId ? game.actors.get(tDoc.actorId) : null);
    if (!tDoc && !actor) continue;
    await _toggleStatusEffectBestEffort(tDoc, actor, resolved, wantActive);
  }
}

async function _applyDamageAsGM({ tokenUuid, actorUuid, delta, target, note, whisperToUserId, fromUserId, chatCard } = {}) {
  if (!game.user.isGM) return;
  // Master feature gate. Even though we install listeners unconditionally for robustness,
  // we must ignore relayed requests when the feature is disabled.
  try {
    if (!game.settings.get(MODULE_ID, "allow-player-damage")) return;
  } catch {
    // If settings aren't available for some reason, fail closed.
    return;
  }
  if (!tokenUuid && !actorUuid) return;

  let tDoc = null;
  let actor = null;
  try {
    if (tokenUuid) tDoc = await fromUuid(tokenUuid);
  } catch { /* ignore */ }

  // Prefer actor from token; otherwise fall back to actorUuid.
  actor = tDoc?.actor ?? (tDoc?.actorId ? game.actors.get(tDoc.actorId) : null);
  if (!actor && actorUuid) {
    try { actor = await fromUuid(actorUuid); } catch { /* ignore */ }
  }
  if (!actor) return;

  const updates = {};
  const resourceValue = _getResourceValue(actor, HP_VALUE_PATH);
  const tempValue = _getResourceValue(actor, HP_TEMP_PATH);
  const maxValue = _getResourceValue(actor, HP_MAX_PATH);
  const tempMaxValue = _getResourceValue(actor, HP_TEMPMAX_PATH);

  const d = Number(delta ?? 0);

  if (tempMaxValue && target === "max") {
    updates[`system.${HP_TEMPMAX_PATH}`] = tempMaxValue - d;
  } else {
    let dt = 0;
    const tmpMax = tempMaxValue;

    if (tempValue || target === "temp") {
      dt = ((d > 0 || target === "temp") && target !== "regular" && target !== "max")
        ? Math.min(tempValue, d)
        : 0;
      updates[`system.${HP_TEMP_PATH}`] = tempValue - dt;
    }

    if (target !== "temp" && target !== "max" && dt >= 0) {
      const change = (d - dt);
      const min = 0;
      const max = maxValue + tmpMax;
      const dh = Math.clamp(resourceValue - change, min, max);
      updates[`system.${HP_VALUE_PATH}`] = dh;
    }
  }

  if (Object.keys(updates).length) {
    await actor.update(updates);
    await _applyDeadDyingStatusForActor(actor, tDoc);
    await _applyBloodiedStatusForActor(actor, tDoc);
  }

  // Optional: create a whispered chat card (used when a caller explicitly asks for it).
  if (chatCard) {
    try {
      const dNum = Number(delta ?? 0);
      const amount = Math.abs(dNum);
      const verb = dNum >= 0 ? "Damage" : "Healing";

      // Whisper to requesting user (if provided) + all GMs.
      const gmIds = game.users.filter(u => u.isGM).map(u => u.id);
      const whisper = Array.from(new Set([...(whisperToUserId ? [whisperToUserId] : []), ...gmIds]));

      const safeNote = (note ?? "").toString().trim();

      // Speaker: prefer an in-scene Token if available; otherwise fall back to the Actor.
let speaker;
try {
  const tokenId = tDoc.id ?? tDoc._id;
  const liveToken = canvas?.tokens?.get?.(tokenId) ?? tDoc.object ?? null;
  speaker = ChatMessage.getSpeaker({ token: liveToken, actor });
} catch {
  speaker = ChatMessage.getSpeaker({ actor });
}

const targetName = foundry.utils.escapeHTML(tDoc?.name ?? actor.name ?? "Target");

      const content = `
<div class="rms-chat-card">
  <div class="rms-chat-title">${verb} Applied</div>
  <div class="rms-chat-body">
    <div><strong>Target:</strong> ${targetName}</div>
    <div><strong>Amount:</strong> ${amount}</div>
    ${safeNote ? `<div><strong>Note:</strong> ${foundry.utils.escapeHTML(safeNote)}</div>` : ""}
  </div>
</div>`;

      await ChatMessage.create({
        type: CONST.CHAT_MESSAGE_TYPES.OOC,
        user: game.user.id,
        speaker,
        content: String(content),
        whisper
      });
} catch (err) {
      console.error(`[${MODULE_ID}] Failed creating relay chat card:`, err);
    }
  }
}

function _installFallbackListenerOnce() {
  // GM-only listener, but safe to install on all clients.
  if (globalThis.__nimbleHPDamage_fallbackInstalled) return;
  globalThis.__nimbleHPDamage_fallbackInstalled = true;

  const channel = `module.${MODULE_ID}`;

  game.socket.on(channel, async (data) => {
    try {
      if (!game.user.isGM) return;
      if (!data) return;
      if (data.type === "applyHpDelta") {
        await _applyDamageAsGM(data.payload);
      } else if (data.type === "toggleStatus") {
        await _toggleStatusAsGM(data.payload);
      }
    } catch (err) {
      console.error(`[${MODULE_ID}] Fallback relay error:`, err);
    }
  });
}

function _installSystemNimbleCompatListenerOnce() {
  // Compatibility bridge for existing macros that emit on the Nimble system socket.
  // Example: the user's "Apply Damage" macro emits:
  //   game.socket.emit("system.nimble", { type: "nimble-apply-damage", payload: { tokenUuid, delta, ... } })
  // Their original GM relay macro listened on the same channel.
  //
  // This module's preferred transport is SocketLib, but we also accept these legacy
  // packets so users don't have to re-run / re-install GM-only macros each session.

  if (globalThis.__nimbleHPDamage_systemNimbleInstalled) return;
  globalThis.__nimbleHPDamage_systemNimbleInstalled = true;

  game.socket.on("system.nimble", async (data) => {
    try {
      if (!game.user.isGM) return;
      if (!data?.type?.startsWith?.("nimble-")) return;
      if (data.type !== "nimble-apply-damage") return;

      const { tokenUuid, delta, note, whisperToUserId, fromUserId } = data.payload ?? {};
      // Compatibility behavior: apply ONLY.
      // Many player-side macros already create their own chat card; producing one here
      // can cause duplicate messages.
      await _applyDamageAsGM({ tokenUuid, delta, target: undefined, note, whisperToUserId, fromUserId, chatCard: false });
    } catch (err) {
      console.error(`[${MODULE_ID}] system.nimble compat relay error:`, err);
    }
  });
}

function _installSocketLibOnce() {
  if (!game.modules.get("socketlib")?.active) return;

  const tryRegister = () => {
    try {
      _socketlib = socketlib.registerModule(MODULE_ID);
      if (!_socketlib) throw new Error("SocketLib returned undefined socket (check module manifest has 'socket': true)");
      _socketlib.register("applyHpDelta", _applyDamageAsGM);
      _socketlib.register("toggleStatus", _toggleStatusAsGM);
      return true;
    } catch (err) {
      console.error(`[${MODULE_ID}] SocketLib setup error:`, err);
      return false;
    }
  };

  // If SocketLib is already ready, register immediately; otherwise wait for the hook.
  if (!tryRegister()) {
    Hooks.once("socketlib.ready", () => { tryRegister(); });
  }
}

export function initHPDamageRelay() {
  _installFallbackListenerOnce();
  _installSystemNimbleCompatListenerOnce();
  _installSocketLibOnce();
}

export async function requestApplyHpDelta({ tokenUuid, actorUuid, delta, target, note, chatCard } = {}) {
  if (!tokenUuid) return;

  const payload = {
    tokenUuid,
    actorUuid,
    delta,
    target,
    note: note ?? "",
    chatCard: !!chatCard,
    // used for whisper routing when chatCard=true
    whisperToUserId: game.user?.id,
    fromUserId: game.user?.id
  };

  // Prefer SocketLib if present.
  if (_socketlib?.executeAsGM) {
    try {
      return await _socketlib.executeAsGM("applyHpDelta", payload);
    } catch (err) {
      console.warn(`[${MODULE_ID}] SocketLib executeAsGM failed; falling back to game.socket.`, err);
    }
  }

  // Fallback: core socket.
  const channel = `module.${MODULE_ID}`;
  return game.socket.emit(channel, {
    type: "applyHpDelta",
    payload
  });
}

export async function requestToggleStatus({ tokenUuids = [], tokenUuid, statusKey, statusId, action = "add", active } = {}) {
  const payload = {
    tokenUuids,
    tokenUuid,
    statusKey,
    statusId,
    action,
    active,
    fromUserId: game.user?.id
  };

  // Prefer SocketLib if present.
  if (_socketlib?.executeAsGM) {
    try {
      return await _socketlib.executeAsGM("toggleStatus", payload);
    } catch (err) {
      console.warn(`[${MODULE_ID}] SocketLib executeAsGM failed; falling back to game.socket.`, err);
    }
  }

  const channel = `module.${MODULE_ID}`;
  return game.socket.emit(channel, {
    type: "toggleStatus",
    payload
  });
}
