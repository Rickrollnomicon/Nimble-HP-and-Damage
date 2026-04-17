import { registerSettings } from "./settings.js";
import { requestApplyHpDelta, requestToggleStatus, requestUndoRestore, initHPDamageRelay, MODULE_ID } from "./relay.js";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

let debugEnabled = 0;
export const log = (...args) => console.log("nimble-hp-and-damage |", ...args);
export const warn = (...args) => console.warn("nimble-hp-and-damage |", ...args);
export const error = (...args) => console.error("nimble-hp-and-damage |", ...args);

export const setting = (key) => game.settings.get("nimble-hp-and-damage", key);

let _fhpCiDialog = null; // currently open Context Inspector dialog

// ---------------- Nimble resource paths (locked) ----------------
// These paths are intentionally not configurable.
const HP_VALUE_PATH = "attributes.hp.value";
const HP_TEMP_PATH = "attributes.hp.temp";
const HP_MAX_PATH = "attributes.hp.max";
const HP_TEMPMAX_PATH = "attributes.hp.tempmax";


// ---------------- Chat output helpers (Targeted block only) ----------------
function _escape(str) {
  return foundry.utils.escapeHTML(String(str ?? ""));
}

function _getTargetedChatTargets(tokens) {
  const names = (tokens ?? []).map(t => t?.name ?? t?.document?.name ?? "").filter(Boolean);
  const total = names.length;
  const first = names.slice(0, 3);
  const more = Math.max(0, total - first.length);
  const display = total === 0 ? "" : `${first.join(", ")}${more ? ` +${more} more` : ""}`;
  const full = names.join(", ");
  return { total, display, full };
}

function _captureUndoSnapshot(actor) {
  if (!actor) return null;

  const app = game.FloatingHP?.app;
  const hasStatus = (key) => {
    try {
      return !!app?._hasStatusEffectBestEffort?.(actor, key);
    } catch {
      return false;
    }
  };

  return {
    actorId: actor.id,
    actorUuid: actor.uuid,
    hp: {
      value: Number(foundry.utils.getProperty(actor, `system.${HP_VALUE_PATH}`) ?? 0) || 0,
      temp: Number(foundry.utils.getProperty(actor, `system.${HP_TEMP_PATH}`) ?? 0) || 0,
      max: Number(foundry.utils.getProperty(actor, `system.${HP_MAX_PATH}`) ?? 0) || 0,
      tempmax: Number(foundry.utils.getProperty(actor, `system.${HP_TEMPMAX_PATH}`) ?? 0) || 0
    },
    statuses: {
      defeated: hasStatus("defeated"),
      dead: hasStatus("dead"),
      dying: hasStatus("dying")
    },
    wounds: {
      value: Number(foundry.utils.getProperty(actor, `system.attributes.wounds.value`) ?? 0) || 0
    }
  };
}

async function _restoreUndoSnapshot(snapshot) {
  if (!snapshot) return false;

  let actor = null;
  try {
    actor = snapshot.actorUuid ? await fromUuid(snapshot.actorUuid) : null;
  } catch {
    actor = null;
  }
  actor = actor || game.actors?.get?.(snapshot.actorId) || null;
  if (!actor) return false;

  const actorUpdate = {
    [`system.${HP_VALUE_PATH}`]: Number(snapshot?.hp?.value ?? 0) || 0,
    [`system.${HP_TEMP_PATH}`]: Number(snapshot?.hp?.temp ?? 0) || 0,
    [`system.${HP_MAX_PATH}`]: Number(snapshot?.hp?.max ?? 0) || 0,
    [`system.${HP_TEMPMAX_PATH}`]: Number(snapshot?.hp?.tempmax ?? 0) || 0
  };
  if (snapshot?.wounds?.value !== undefined) actorUpdate[`system.attributes.wounds.value`] = Number(snapshot?.wounds?.value ?? 0) || 0;

  await actor.update(actorUpdate);

  const app = game.FloatingHP?.app;
  try {
    if (typeof app?._toggleStatusEffectBestEffort === "function") {
      await app._toggleStatusEffectBestEffort(actor, "defeated", !!snapshot?.statuses?.defeated);
      await app._toggleStatusEffectBestEffort(actor, "dead", !!snapshot?.statuses?.dead);
      await app._toggleStatusEffectBestEffort(actor, "dying", !!snapshot?.statuses?.dying);
    }
  } catch (err) {
    console.warn("[nimble-hp-and-damage] Undo restore: status sync failed:", err);
  }

  return true;
}
async function _postTargetedChatCard({ entries = [], verbOverride = null, armorOverride = false, transformMode = "normal", defendMeta = null, undoMeta = null }) {
  const armorOverrideMode = (typeof armorOverride === "string")
    ? String(armorOverride || "normal")
    : (armorOverride ? "bypass" : "normal");
  const transformState = String(transformMode || "normal");

  const classifyArmorBucket = (mode, overrideMode) => {
    const m = Number(mode ?? -1);
    const ov = String(overrideMode || "normal");

    if (ov === "bypass") return "manual-bypass";
    if (ov === "reduced" || ov === "down") {
      if (m === 1) return "Reduced Armor One Step";
      if (m === 0) return "Unarmored/Bypassed";
      if (m === 2) return "Heavy Armor";
      return "Unknown";
    }

    if (m === 2) return "Heavy Armor";
    if (m === 1) return "Medium Armor";
    if (m === 0) return "Unarmored";
    return "Unknown";
  };
  try {
    const list = Array.isArray(entries) ? entries : [];
    if (!list.length) return;

    // Determine verb/icon based on first non-zero delta.
    const firstDelta = list.map(e => Number(e?.delta ?? 0)).find(n => Number.isFinite(n) && n !== 0);
    // If everything is zero (e.g., Defend negated all damage), still allow a chat card
    // when we have Defend transparency metadata.
    if ((!Number.isFinite(firstDelta) || firstDelta === 0) && !(defendMeta && typeof defendMeta === "object")) return;

    const isDamage = Number.isFinite(firstDelta) ? (firstDelta > 0) : true;
    const verb = String(verbOverride ?? (isDamage ? "Damage" : "Healing"));
    const icon = isDamage ? "fa-sword" : "fa-heart";

    const tokens = list.map(e => e?.token).filter(Boolean);
    const info = _getTargetedChatTargets(tokens);
    const targetsLabel = info.total === 1 ? "Target" : "Targets";

    // For consistent headers across permission contexts, prefer an explicit alias-only speaker.
    const speaker = { alias: game.user?.name ?? "" };

    // Customize chat header alias:
    // - Players: "UserName (CharacterName)" when a linked character exists.
    // - GM: if any tokens are controlled, show controlled token names (truncated).
    try {
      if (game.user?.isGM) {
        const controlled = canvas?.tokens?.controlled ?? [];
        const names = Array.from(new Set(controlled.map(t => t?.name).filter(Boolean)));
        if (names.length) {
          const shown = names.slice(0, 3);
          const more = names.length > 3 ? ` +${names.length - 3} more` : "";
          speaker.alias = `${shown.join(", ")}${more}`;
        } else {
          speaker.alias = game.user?.name ?? speaker.alias;
        }
      } else {
        let charName = game.user?.character?.name;
        if (!charName) {
          try {
            const owned = (canvas?.tokens?.placeables ?? []).find(t => t?.actor && t.actor.isOwner && !t.document?.hidden);
            charName = owned?.actor?.name;
          } catch { /* ignore */ }
        }
        speaker.alias = charName ? `${game.user?.name ?? "Player"} (${charName})` : (game.user?.name ?? speaker.alias);
      }
    } catch { /* ignore */ }

    // Applied summary:
    // - Damage: group by armor mode (0/1/2) if provided.
    // - Healing: show a compact mixed/single badge.
    const absVals = list.map(e => Math.abs(Number(e?.delta ?? 0) || 0)).filter(n => Number.isFinite(n));
    const uniqueAbs = Array.from(new Set(absVals)).sort((a,b)=>a-b);

    let appliedBadge = uniqueAbs.length === 1 ? String(uniqueAbs[0]) : "mixed";
    let appliedDetailsHtml = "";

    // Optional Defend transparency block (single-target PC use-case).
    let defendDetailsHtml = "";
    let modifierDetailsHtml = "";
    if (isDamage && transformState !== "normal") {
      const label = transformState === "resistant" ? "Resistant" : "Vulnerable";
      const note = transformState === "resistant"
        ? "Half damage after armor."
        : "Bypasses remaining armor; doubles damage if effectively unarmored.";
      modifierDetailsHtml = `
<div class="rms-chat-breakdown">
  <div class="rms-chat-row"><span class="rms-chat-row-label">Damage Modifier</span><span class="rms-chat-row-val">${_escape(label)}</span></div>
  <div class="rms-chat-row"><span class="rms-chat-row-label"><span class="rms-chat-muted">${_escape(note)}</span></span></div>
</div>`;
    }
    if (isDamage && defendMeta && typeof defendMeta === "object") {
      try {
        const full = Number(defendMeta.full ?? 0) || 0;
        const reduced = Number(defendMeta.defended ?? 0) || 0;
        const final = Number(defendMeta.final ?? 0) || 0;
        const label = String(defendMeta.label ?? "Defend");
        const note = String(defendMeta.note ?? "");

        defendDetailsHtml = `
<div class="rms-chat-breakdown">
  <div class="rms-chat-row"><span class="rms-chat-row-label">Damage (pre-Defend)</span><span class="rms-chat-row-val">${_escape(full)}</span></div>
  <div class="rms-chat-row"><span class="rms-chat-row-label">${_escape(label)}</span><span class="rms-chat-row-val">-${_escape(reduced)}${note ? ` <span class=\"rms-chat-muted\">${_escape(note)}</span>` : ""}</span></div>
  <div class="rms-chat-row"><span class="rms-chat-row-label">Damage Applied</span><span class="rms-chat-row-val">${_escape(final)}</span></div>
</div>`;
      } catch { /* ignore */ }
    }

    // When Defend transparency is present (single-target PC use-case), omit the
    // monster armor-mode breakdown entirely to avoid showing "Unarmored" for PCs.
    // Also omit the per-bucket breakdown for single-target monster cards; the
    // badge already communicates the applied result clearly in that case.
    if (isDamage && defendMeta && typeof defendMeta === "object") {
      appliedDetailsHtml = "";
    } else if (isDamage && armorOverrideMode !== "bypass" && list.length > 1) {
      const groups = new Map(); // key -> {count, value}
      for (const e of list) {
        const key = String(e?.bucketLabel || classifyArmorBucket(e?.armorMode, armorOverrideMode));
        const v = Math.abs(Number(e?.delta ?? 0) || 0);
        const g = groups.get(key) ?? { count: 0, values: new Set() };
        g.count += 1;
        if (Number.isFinite(v)) g.values.add(v);
        groups.set(key, g);
      }

      const order = (transformState === "vulnerable")
        ? ["Vulnerable (Armor Bypassed)", "Vulnerable (Double Damage)", "Unknown"]
        : ((armorOverrideMode === "reduced" || armorOverrideMode === "down")
          ? ["Heavy Armor", "Reduced Armor One Step", "Unarmored/Bypassed", "Unknown"]
          : ["Heavy Armor", "Medium Armor", "Unarmored", "Unknown"]);
      const lines = [];
      for (const k of order) {
        const g = groups.get(k);
        if (!g) continue;
        const vals = Array.from(g.values);
        const valStr = (vals.length === 1) ? String(vals[0]) : "mixed";
        lines.push(`<div class="rms-chat-row"><span class="rms-chat-row-label">${_escape(k)} (${g.count})</span><span class="rms-chat-row-val">${_escape(valStr)}</span></div>`);
      }

      appliedDetailsHtml = lines.length ? `<div class="rms-chat-breakdown">${lines.join("")}</div>` : "";
    } else if (isDamage && armorOverrideMode === "bypass" && transformState === "normal") {
      appliedDetailsHtml = `<div class="rms-chat-breakdown"><div class="rms-chat-row"><span class="rms-chat-row-label"><strong><em>Armor values manually ignored for this attack.</em></strong></span></div></div>`;
    }
    const canUndo = Array.isArray(undoMeta?.steps) && undoMeta.steps.length > 0;
    const isUndone = !!undoMeta?.undone;

    const undoHtml = canUndo ? `
      <div class="rms-chat-actions">
        <button
          type="button"
          class="rms-control rms-chat-action-btn"
          data-action="undo-targeted-hud-card"
          ${isUndone ? "disabled" : ""}
          title="${isUndone ? "Already undone" : `Undo ${_escape(verb.toLowerCase())}`}"
        >
          <i class="fa-solid ${isUndone ? "fa-check" : "fa-rotate-left"}"></i>
          ${isUndone ? "Undone" : `Undo ${_escape(verb)}`}
        </button>
      </div>` : "";
    const content = String(`
<div class="rms-chat-card rms-apply-damage" role="article">
  <div class="rms-chat-header">
    <div class="rms-chat-icon"><i class="fas ${icon}"></i></div>
    <div class="rms-chat-headings">
      <div class="rms-chat-title">${_escape(verb)} Applied</div>
      <div class="rms-chat-subtitle">Hit</div>
    </div>
  </div>

  <div class="rms-chat-section">
    <div class="rms-chat-label">${targetsLabel}</div>
    <div class="rms-chat-value" title="${_escape(info.full)}">${_escape(info.display || info.full || "")}</div>
  </div>

  <div class="rms-chat-section rms-chat-applied">
    <div class="rms-chat-badge">${_escape(appliedBadge)}</div>
    <div class="rms-chat-label">Applied</div>
  </div>

  ${modifierDetailsHtml}

  ${defendDetailsHtml}

  ${appliedDetailsHtml}

  ${undoHtml}
</div>`);

    await ChatMessage.create({
      type: CONST.CHAT_MESSAGE_TYPES.OOC,
      user: game.user.id,
      speaker,
      content,
      flags: {
        [MODULE_ID]: {
          kind: "targeted-hud-card",
          headerLabel: speaker.alias,
          undoMeta: canUndo ? undoMeta : null
        }
      }
    });
  } catch (err) {
    console.error("[nimble-hp-and-damage] Failed to create Targeted chat card:", err);
  }
}



export function getMessageDamageContext(message) {
  try {
    return _computeAutoFillFromRollMessage(message);
  } catch {
    return null;
  }
}

function _detectArmorModeForActorStatic(actor) {
  try {
    const a = String(actor?.system?.attributes?.armor ?? "").toLowerCase().trim();
    if (!a) return 0;
    if (a === "heavy") return 2;
    if (a === "medium") return 1;
    if (a === "unarmored" || a === "none" || a === "unarm") return 0;
    if (a.includes("heavy")) return 2;
    if (a.includes("medium")) return 1;
    if (a.includes("unarm") || a.includes("none")) return 0;
  } catch {}
  return 0;
}

function _effectiveArmorModeForOverride(detected, overrideMode) {
  const ov = String(overrideMode ?? "normal");
  const base = Number(detected) || 0;
  if (ov === "bypass") return 0;
  if (ov === "down" || ov === "reduced") return base >= 2 ? 1 : 0;
  return base;
}


function _isPcActorStatic(actor) {
  try {
    return !!(actor?.hasPlayerOwner || actor?.type === "character" || actor?.type === "pc");
  } catch {
    return false;
  }
}

export function getDefendContextForActorStatic(actor) {
  try {
    if (!actor) return null;
    const armorObj = foundry.utils.getProperty(actor, "system.attributes.armor");
    const totalArmor = Number(armorObj?.value ?? 0) || 0;
    const comps = Array.isArray(armorObj?.components) ? armorObj.components : [];
    if (!Number.isFinite(totalArmor) && !comps.length) return null;

    let armorGear = 0;
    let shieldGear = 0;
    const armorNames = [];
    const shieldNames = [];

    for (const c of comps) {
      const src = String(c?.source ?? "").trim();
      const val = Number(c?.value ?? 0) || 0;
      if (!src || !Number.isFinite(val) || val === 0) continue;

      const it = (actor.items ?? []).find(i => String(i?.name ?? "") === src) ?? null;
      const ot = String(foundry.utils.getProperty(it, "system.objectType") ?? "").toLowerCase().trim();

      if (ot === "shield") {
        shieldGear += val;
        shieldNames.push(src);
      } else {
        armorGear += val;
        armorNames.push(src);
      }
    }

    const gearSum = armorGear + shieldGear;
    const basePortion = Math.max(0, (Number.isFinite(totalArmor) ? totalArmor : 0) - gearSum);

    return {
      totalArmor,
      armorGear,
      shieldGear,
      basePortion,
      armorNames,
      shieldNames
    };
  } catch {
    return null;
  }
}

export function getDefendValueForModeStatic(defCtx, mode) {
  try {
    const m = Number(mode ?? 0) || 0;
    if (!defCtx) return 0;
    if (m === 1) return (Number(defCtx.basePortion ?? 0) || 0) + (Number(defCtx.armorGear ?? 0) || 0);
    if (m === 2) return (Number(defCtx.shieldGear ?? 0) || 0);
    if (m === 3) return (Number(defCtx.basePortion ?? 0) || 0) + (Number(defCtx.armorGear ?? 0) || 0) + (Number(defCtx.shieldGear ?? 0) || 0);
    return 0;
  } catch {
    return 0;
  }
}

function _getDefendLabelForModeStatic(defCtx, mode) {
  try {
    const m = Number(mode ?? 0) || 0;
    const hasShield = (Number(defCtx?.shieldGear ?? 0) || 0) > 0;
    if (m === 1) return hasShield ? "Defend Armor" : "Defend";
    if (m === 2) return "Defend Shield";
    if (m === 3) return "Defend Armor+Shield";
    return "Defend: None";
  } catch {
    return "Defend";
  }
}
function _armorStateLabel(mode) {
  switch (String(mode ?? "normal")) {
    case "reduced":
    case "down":
      return "Reduced Armor One Step";
    case "bypass":
      return "Bypassed Armor";
    default:
      return "Normal";
  }
}

export async function applyEnhancedChatCardDamage({ message, tokenDocs = [], baseContext = null, armorOverrideMode = "normal", resVulnMode = "normal", defendMode = 0, extraDamage = null, showVerificationCard = false } = {}) {
  const liveMessage = message?.id ? game.messages?.get?.(message.id) ?? message : message;
  const tokens = (Array.isArray(tokenDocs) ? tokenDocs : []).filter(t => t?.actor && (t?.document?.uuid || t?.uuid));
  if (!tokens.length) {
    ui.notifications?.warn?.("No targets selected on this chat card.");
    return false;
  }

  const base = baseContext ?? getMessageDamageContext(liveMessage);
  const rawBaseFull = Number(base?.full ?? base?.amount ?? 0) || 0;
  const rawBaseDiceOnly = Number(base?.diceOnly ?? rawBaseFull) || 0;
  const extraEntries = extraDamage && typeof extraDamage === "object" ? Object.values(extraDamage).filter(v => v && typeof v === "object") : [];
  const extraDiceOnly = extraEntries.reduce((sum, entry) => sum + (Number(entry?.diceOnly ?? entry?.total ?? 0) || 0), 0);
  const baseFull = rawBaseFull + extraDiceOnly;
  const baseDiceOnly = rawBaseDiceOnly + extraDiceOnly;
  const isCrit = !!base?.isCrit;
  if (!Number.isFinite(baseFull) || baseFull <= 0) {
    ui.notifications?.info?.("No damage to apply.");
    return false;
  }

  const pcTokens = tokens.filter(t => _isPcActorStatic(t?.actor));
  const defendAllowed = tokens.length === 1 && pcTokens.length === 1;
  const activeDefendMode = defendAllowed ? (Number(defendMode ?? 0) || 0) : 0;
  const defendCtx = defendAllowed ? getDefendContextForActorStatic(pcTokens[0]?.actor) : null;
  const defendPotential = defendAllowed ? (getDefendValueForModeStatic(defendCtx, activeDefendMode) ?? 0) : 0;

  const entries = [];
  const undoSteps = [];
  let defendMeta = null;

  for (const t of tokens) {
    const actor = t.actor;
    const tokenUuid = t?.document?.uuid ?? t?.uuid ?? null;
    if (!actor || !tokenUuid) continue;

    const actorIsPc = _isPcActorStatic(actor);
    const detectedArmorMode = actorIsPc ? 0 : _detectArmorModeForActorStatic(actor);
    const effectiveArmorMode = (actorIsPc || isCrit) ? 0 : _effectiveArmorModeForOverride(detectedArmorMode, armorOverrideMode);

    let appliedDelta = baseFull;
    let bucketLabel = null;
    let afterArmor = baseFull;
    if (!actorIsPc && !isCrit) {
      if (effectiveArmorMode === 1) afterArmor = baseDiceOnly;
      else if (effectiveArmorMode === 2) afterArmor = Math.ceil(baseDiceOnly / 2);
      else afterArmor = baseFull;
    }

    if (!actorIsPc) {
      if (resVulnMode === "resistant") {
        appliedDelta = Math.ceil(afterArmor / 2);
      } else if (resVulnMode === "vulnerable") {
        if (isCrit) {
          appliedDelta = afterArmor;
        } else if (effectiveArmorMode === 0) {
          appliedDelta = afterArmor * 2;
          bucketLabel = "Vulnerable (Double Damage)";
        } else {
          appliedDelta = baseFull;
          bucketLabel = "Vulnerable (Armor Bypassed)";
        }
      } else {
        appliedDelta = afterArmor;
      }
    } else {
      appliedDelta = baseFull;
    }

    if (defendAllowed && actorIsPc && Number.isFinite(defendPotential) && defendPotential > 0) {
      const pre = Math.max(0, Number(appliedDelta) || 0);
      const reduced = Math.min(pre, Math.max(0, Number(defendPotential) || 0));
      const final = Math.max(0, pre - reduced);
      appliedDelta = final;
      const label = _getDefendLabelForModeStatic(defendCtx, activeDefendMode);
      defendMeta = { full: pre, defended: reduced, final, label, note: "" };
    }

    appliedDelta = Math.max(0, Number(appliedDelta) || 0);
    const undoBefore = _captureUndoSnapshot(actor);
    entries.push({ token: t, delta: appliedDelta, armorMode: effectiveArmorMode, bucketLabel });
    if (undoBefore) undoSteps.push({
      actorId: actor.id,
      actorUuid: actor.uuid,
      tokenUuid,
      before: undoBefore
    });

    await requestApplyHpDelta({
      tokenUuid,
      actorUuid: actor.uuid,
      delta: appliedDelta,
      // Use the smart/default HP application path so Temp HP is consumed
      // first, matching the floating HUD behavior.
      target: undefined,
      note: `Enhanced Chat Card (${String(armorOverrideMode)}, ${String(resVulnMode)}, defend=${String(activeDefendMode)})`,
      chatCard: false
    });
  }

  if (!entries.length) {
    ui.notifications?.info?.("No damage to apply.");
    return false;
  }

  if (showVerificationCard) {
    await _postTargetedChatCard({
      entries,
      armorOverride: armorOverrideMode,
      transformMode: defendAllowed ? "normal" : resVulnMode,
      defendMeta,
      undoMeta: undoSteps.length ? {
        steps: undoSteps,
        createdBy: game.user?.id,
        undone: false
      } : null
    });
  }

  return true;
}

// ---------------- Auto-prefill from last chat roll (Phase 2: Apply Damage reuse) ----------------
// Goal: reuse the Apply Damage macro's approach to reading the most recent visible roll total
// and detecting crits from the rendered chat card text.
let _lastChatAutoFill = {
  amount: null,
  full: null,
  diceOnly: null,
  armorMode: null,     // 0=unarmored,1=medium,2=heavy
  armorMixed: false,
  isCrit: false,
  conditions: [],
  messageId: null,
  authorId: null,
  speakerActorId: null,
  ts: 0
};

let _autoFillClearTs = 0;

function _extractConditionsFromRenderedMessage(messageId) {
  try {
    const el = document.querySelector(`li.chat-message[data-message-id="${messageId}"]`);
    if (!el) return [];

    const btns = Array.from(el.querySelectorAll('button[data-enricher-type="condition"]'));
    const out = [];
    for (const b of btns) {
      let name = String(b?.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!name) {
        const tip = String(b?.getAttribute?.("data-tooltip") ?? "");
        const m = tip.match(/<h3[^>]*>(.*?)<\/h3>/i);
        if (m?.[1]) name = String(m[1]).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }

      const iconClass = String(b?.querySelector?.("i")?.className ?? "").trim();

      // Prefer the canonical status effect icon (from CONFIG.statusEffects) over any chat-card icon.
      // Nimble (and some Foundry versions) may store the icon path under different keys (icon/img/src).
      let icon = "";
      try {
        const nmLabel = String(name ?? "").toLowerCase().trim();
        const nmId = nmLabel
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9_-]/g, "");

        const effects = Array.isArray(CONFIG?.statusEffects) ? CONFIG.statusEffects : [];
        const se = effects.find(e => {
          const idRaw = String(e?.id ?? e?.statusId ?? e?.key ?? e?._id ?? "").toLowerCase().trim();
          const labelRaw = String(e?.label ?? e?.name ?? "").toLowerCase().trim();
          return (idRaw && (idRaw === nmLabel || idRaw === nmId)) || (labelRaw && labelRaw === nmLabel);
        });

        icon = String(se?.icon ?? se?.img ?? se?.src ?? "");
      } catch { /* ignore */ }

      if (name) out.push({ name, icon, iconClass });
    }

    // Unique by name, stable order.
    const seen = new Set();
        const seenSig = new Set();
    const uniq = [];
    for (const c of out) {
      const key = String(c?.name ?? "").toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      uniq.push(c);
    }
    return uniq;
  } catch {
    return [];
  }
}


function _getMessageAuthorId(msg) {
  // Foundry versions vary: message.user may be an id string or a User document.
  return msg?.user?.id ?? msg?.user ?? msg?.author?.id ?? null;
}

function _getMessageSpeakerActorId(msg) {
  try {
    return msg?.speaker?.actor ?? null;
  } catch {
    return null;
  }
}

function _messageBelongsToCurrentUser(msg) {
  try {
    // GM should be able to pull from the latest relevant roll cards regardless of author.
    if (game.user?.isGM) return true;

    const uid = String(game.user?.id ?? "");
    if (!uid) return false;

    // Primary: authored by current user.
    if (String(_getMessageAuthorId(msg) ?? "") === uid) return true;

    // Secondary: speaker actor matches the current user's linked character.
    // (Some Nimble/system cards may be authored by another user but still represent
    // the player's roll via speaker.)
    const charId = String(game.user?.character?.id ?? "");
    if (!charId) return false;
    return String(_getMessageSpeakerActorId(msg) ?? "") === charId;
  } catch {
    return false;
  }
}

function _sumKeptDiceResults(roll) {
  let total = 0;
  const visit = (term) => {
    if (!term) return;
    if (Array.isArray(term.results)) {
      for (const r of term.results) if (!r?.discarded && !r?.rerolled) total += Number(r.result) || 0;
    }
    if (Array.isArray(term.terms)) for (const s of term.terms) visit(s);
  };
  for (const t of (roll?.terms ?? [])) visit(t);
  return total;
}

function _getRenderedMessageText(msg) {
  try {
    const el = document.querySelector(`li.chat-message[data-message-id="${msg.id}"]`);
    if (el?.innerText) return el.innerText.replace(/\s+/g, " ").trim();
  } catch { /* ignore */ }
  return String(msg?.content || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function _isRollVisibleOnCard(roll, cardText) {
  const f = String(roll?.formula ?? roll?._formula ?? "").trim();
  const t = String(Number(roll?.total));
  const hasFormula = f && cardText.includes(f);
  const hasTotal = t && new RegExp(`\\b${t}\\b`).test(cardText);
  return hasFormula || hasTotal;
}

function _computeAutoFillFromRollMessage(msg) {
  try {
    if (!msg) return null;

    // Prefer parsing Nimble's rendered chat card totals (what the user sees).
    // This preserves advantage/disadvantage "kept dice" behavior automatically.
    let domTotal = 0;
    let domDice = 0;
    let domFound = false;

    try {
      const el = document.querySelector(`li.chat-message[data-message-id="${msg.id}"]`);
      if (el) {
        // A damage section in Nimble typically has an "Apply Damage" button.
        const applyBtns = Array.from(el.querySelectorAll("button")).filter(b => {
          const t = (b.textContent || "").trim();
          return /^Apply Damage$/i.test(t);
        });

        const decodeHtml = (s) => {
          try {
            const ta = document.createElement("textarea");
            ta.innerHTML = String(s ?? "");
            return ta.value;
          } catch {
            return String(s ?? "");
          }
        };

        const parseDiceTotalFromTooltip = (tooltipHtml) => {
          try {
            const decoded = decodeHtml(tooltipHtml);
            const doc = new DOMParser().parseFromString(decoded, "text/html");
            // Sum any "roll-details total" spans found in the tooltip.
            const totals = Array.from(doc.querySelectorAll(".nimble-roll-details__total"));
            if (!totals.length) return null;
            const sum = totals.reduce((acc, n) => acc + (Number(String(n.textContent).trim()) || 0), 0);
            return Number.isFinite(sum) ? sum : null;
          } catch {
            return null;
          }
        };

        // If we can find Apply Damage buttons, scope totals to those sections.
        // Otherwise, fall back to any roll__total elements in the card.
        const sections = [];
        for (const btn of applyBtns) {
          const sec = btn.closest("section, .nimble-roll, .roll, .damage, .nimble-attack, .nimble-card, .message-content, .chat-message") || el;
          sections.push(sec);
        }

        const pickRollTotals = (root) => Array.from(root.querySelectorAll("div.roll__total"));

        const roots = sections.length ? sections : [el];
        const seen = new Set();
        const seenSig = new Set();

        for (const root of roots) {
          for (const rt of pickRollTotals(root)) {
            if (!rt) continue;
            // Avoid double-counting if multiple Apply Damage buttons share ancestors.
            if (seen.has(rt)) continue;
            seen.add(rt);

            // ALSO avoid double-counting duplicate damage lines that can appear on some Nimble cards
            // (e.g. a roll that is simultaneously marked Miss and Crit).
            // We de-dupe by a stable signature: total + tooltip payload + (best-effort) damage label context.
            const tip = rt.getAttribute("data-tooltip") || "";
            const lineEl = rt.closest(".damage, .nimble-damage, .nimble-attack, .roll, section, article, li, div") || root;
            const lineText = (lineEl?.innerText || lineEl?.textContent || "").replace(/\s+/g, " ").trim();
            // Best-effort extract a short label context (damage type + ignores-armor flag).
            let label = "";
            const m = lineText.match(/\b(Bludgeoning|Piercing|Slashing|Acid|Cold|Fire|Lightning|Poison|Psychic|Radiant|Necrotic|Thunder|Force)\b/i);
            if (m) label += m[1].toLowerCase();
            if (/Ignores Armor/i.test(lineText)) label += "|ignores-armor";
            const sig = `${Number(String(rt.textContent || "").trim())}|${label}|${tip}`;
            if (seenSig.has(sig)) continue;
            seenSig.add(sig);

            const total = Number(String(rt.textContent || "").trim());
            if (!Number.isFinite(total)) continue;

            const dice = parseDiceTotalFromTooltip(tip);

            domTotal += total;
            domDice += (Number.isFinite(dice) ? dice : 0);
            domFound = true;
          }
        }

        // Fallback: Nimble "Selected Minions" / group attack cards may not use roll__total elements.
        // Newer Nimble builds include a stable "group total" value element.
        // Minion damage totals are always dice-only (flat 0).
        if (!domFound) {
          try {
            const v = el.querySelector(".nimble-group-total__value");
            const n = v ? Number(String(v.textContent || "").trim()) : NaN;
            if (Number.isFinite(n) && n !== 0) {
              domTotal = n;
              domDice = n;
              domFound = true;
            }
          } catch { /* ignore */ }
        }

        // Legacy fallback: some cards may expose a "Total Damage" label next to a numeric total.
        if (!domFound) {
          try {
            const labelNodes = Array.from(el.querySelectorAll("*")).filter(n => {
              const t = (n.textContent || "").trim();
              return /^Total Damage$/i.test(t);
            });
            const labelEl = labelNodes[0];
            if (labelEl) {
              const container = labelEl.parentElement || labelEl;
              // Look for a sibling/descendant with a numeric value that is not the label itself.
              const nums = Array.from(container.querySelectorAll("*"))
                .map(n => (n === labelEl ? "" : (n.textContent || "").trim()))
                .filter(t => /^-?\d+$/.test(t))
                .map(t => Number(t))
                .filter(n => Number.isFinite(n));
              if (nums.length) {
                domTotal = nums[nums.length - 1];
                domDice = domTotal; // Best-effort: treat as all dice (flat 0) if breakdown isn't present.
                domFound = true;
              }
            }
          } catch { /* ignore */ }
        }


        // If we found any totals but dice parsing failed, infer dice as total (flat 0).
        if (domFound && domDice === 0) {
          // We only infer in the "no dice data at all" case; otherwise keep partial sums.
          domDice = domTotal;
        }
      }
    } catch { /* ignore DOM failures */ }

    const cardText = _getRenderedMessageText(msg);
    const isCrit = /\bCRIT\b/i.test(cardText) || /Critical Hit/i.test(cardText);

    // If DOM parsing succeeded, use it.
    if (domFound && Number.isFinite(domTotal) && domTotal !== 0) {
      const conditions = _extractConditionsFromRenderedMessage(msg.id);
      return {
        amount: domTotal,
        full: domTotal,
        diceOnly: Number.isFinite(domDice) ? domDice : 0,
        armorMode: null,
        armorMixed: false,
        isCrit,
        conditions,
        messageId: msg.id,
        authorId: _getMessageAuthorId(msg),
        speakerActorId: _getMessageSpeakerActorId(msg),
        ts: Number(msg.timestamp ?? 0) || Date.now()
      };
    }

    // Fallback: roll-based extraction (best-effort).
    if (!msg?.rolls?.length) return null;

    // Best-effort armor hint extraction from the chat card (kept for legacy use).
    let hasMedium = false;
    let hasHeavy = false;
    try {
      const el = document.querySelector(`li.chat-message[data-message-id="${msg.id}"]`);
      const icons = el ? Array.from(el.querySelectorAll("i.nimble-armor-icon")) : [];
      for (const ic of icons) {
        const cls = ic.classList;
        if (cls.contains("fa-shield-halved")) hasMedium = true;
        if (cls.contains("fa-shield") && !cls.contains("fa-shield-halved")) hasHeavy = true;
        const tip = String(ic.getAttribute("data-tooltip") || "");
        if (/\bMedium\b/i.test(tip)) hasMedium = true;
        if (/\bHeavy\b/i.test(tip)) hasHeavy = true;
      }
    } catch { /* ignore DOM failures */ }

    const html = String(msg?.content ?? "");
    const haystack = `${cardText} ${html}`;
    if (!hasMedium) {
      hasMedium = /\bMEDIUM\b/i.test(haystack)
        || /\bMedium\b/i.test(haystack)
        || /data-armor\s*=\s*['"]medium['"]/i.test(haystack)
        || /data-tooltip\s*=\s*['"][\s\S]*?\bMedium\b/i.test(haystack)
        || /armor[^a-z0-9]*medium/i.test(haystack)
        || /fa-shield-halved/.test(haystack);
    }
    if (!hasHeavy) {
      hasHeavy = /\bHEAVY\b/i.test(haystack)
        || /\bHeavy\b/i.test(haystack)
        || /data-armor\s*=\s*['"]heavy['"]/i.test(haystack)
        || /data-tooltip\s*=\s*['"][\s\S]*?\bHeavy\b/i.test(haystack)
        || /armor[^a-z0-9]*heavy/i.test(haystack)
        || /fa-shield(?!-halved)/.test(haystack);
    }

    const armorMixed = !!(hasMedium && hasHeavy);
    const armorMode = armorMixed ? null : (hasHeavy ? 2 : (hasMedium ? 1 : null));

    const visibleRolls = (msg.rolls ?? []).filter(r => _isRollVisibleOnCard(r, cardText));
    const rollsForSum = (visibleRolls.length ? visibleRolls : (msg.rolls ?? []));
    const full = rollsForSum.reduce((sum, r) => sum + (Number(r.total) || 0), 0);
    const diceOnly = rollsForSum.reduce((sum, r) => sum + (_sumKeptDiceResults(r) || 0), 0);

    const amount = Number.isFinite(full) ? full : 0;
    if (!amount) return null;
    const conditions = _extractConditionsFromRenderedMessage(msg.id);

    return {
      amount,
      full: Number.isFinite(full) ? full : amount,
      diceOnly: Number.isFinite(diceOnly) ? diceOnly : 0,
      armorMode,
      armorMixed,
      isCrit,
      conditions,
      messageId: msg.id,
      authorId: _getMessageAuthorId(msg),
      speakerActorId: _getMessageSpeakerActorId(msg),
      ts: Number(msg.timestamp ?? 0) || Date.now()
    };
  } catch {
    return null;
  }
}


function _refreshAutoFillCacheFromChat() {
  try {
    // Fail closed: if we can't find a newer eligible source, don't keep using an old cached value.
    _lastChatAutoFill = {
      amount: null,
      full: null,
      diceOnly: null,
      armorMode: null,
      armorMixed: false,
      isCrit: false,
      conditions: [],
      messageId: null,
      authorId: null,
      speakerActorId: null,
      ts: 0
    };

    const messages = game.messages?.contents ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      // If the user explicitly cleared calculations, do not repopulate the cache
      // from older chat messages. Wait until a newer roll message exists.
      try {
        const ts = Number(m?.timestamp ?? 0) || 0;
        if (_autoFillClearTs && ts && ts <= _autoFillClearTs) continue;
      } catch { /* ignore */ }
      try {
        const k = m?.flags?.[MODULE_ID]?.kind;
        if (k === "extra-roll-card") continue;
      } catch { /* ignore */ }
      try {
        // Never treat this module's own output messages as a roll source.
        if (m?.flags?.[MODULE_ID]) continue;
      } catch { /* ignore */ }
      if (!_messageBelongsToCurrentUser(m)) continue;

      // Prefer DOM-based extraction (works for standard Nimble cards AND minion group cards).
      const computed = _computeAutoFillFromRollMessage(m);
      if (computed) {
        _lastChatAutoFill = computed;
        return;
      }
    }
  } catch { /* ignore */ }
}

function _getAutoFillInfo() {
  if (_lastChatAutoFill?.amount == null) _refreshAutoFillCacheFromChat();
  // Fail closed: only use cached values that belong to this user.
  // (Authored by the user OR speaking as their linked character.)
  try {
    const uid = String(game.user?.id ?? "");
    const charId = String(game.user?.character?.id ?? "");
    const ok = (
      (uid && String(_lastChatAutoFill?.authorId ?? "") === uid) ||
      (charId && String(_lastChatAutoFill?.speakerActorId ?? "") === charId)
    );
    if (!ok) return null;
  } catch {
    return null;
  }
  if (_lastChatAutoFill?.amount == null) return null;
  return {
    amount: _lastChatAutoFill.amount,
    full: (_lastChatAutoFill.full ?? _lastChatAutoFill.amount),
    diceOnly: (_lastChatAutoFill.diceOnly ?? 0),
    messageId: _lastChatAutoFill.messageId,
    isCrit: !!_lastChatAutoFill.isCrit,
    armorMode: (_lastChatAutoFill.armorMode ?? null),
    armorMixed: !!_lastChatAutoFill.armorMixed,
    conditions: Array.isArray(_lastChatAutoFill.conditions) ? _lastChatAutoFill.conditions : []
  };
}

/**
 * Floating HP Tracker (Foundry v13, ApplicationV2)
 *
 * What it does:
 * - Shows a compact floating window for adjusting HP on the currently controlled token(s).
 * - Buttons:
 *    - Skull: set HP to 0 and apply defeated (right-click = set to 0 without defeated; shift-click = toggle defeated).
 *    - Down arrow: apply damage by the entered amount.
 *    - Up arrow: heal by the entered amount.
 *    - Heart: heal to full and clear defeated (right-click = full heal without clearing defeated).
 * - Input box:
 *    - Press Enter to apply (Controlled: absolute set; Targeted: delta with auto damage/heal).
 *    - Suffix letters can target pools: r=regular, t=temp, m=max (example: "5t" damages temp HP only).
 * - Works with temp HP, max HP, and temp max HP paths via settings (defaults to system primary token attribute).
 * - Optionally shows death saving throw pips in dnd5e when at 0 HP.
 * - Remembers window position per-user.
 * - Keybindings: Toggle window; Focus input.
 *
 * Styling:
 * - Uses Foundry's window chrome (dark mode/light mode) and only adds a small, minimal layer of layout styling.
 */

export 
// ---------------------------
// Mini context menu (right-click) — lightweight, cursor-anchored
// ---------------------------
let _fhpContextMenuEl = null;
let _fhpContextMenuCloser = null;
let _fhpContextMenuMeta = null; // optional: { x, y, buildItems, key }

function _closeFhpContextMenu() {
  try { _fhpContextMenuCloser?.(); } catch { /* ignore */ }
  _fhpContextMenuCloser = null;
  if (_fhpContextMenuEl) {
    try { _fhpContextMenuEl.remove(); } catch { /* ignore */ }
  }
  _fhpContextMenuEl = null;
  _fhpContextMenuMeta = null;
}

function _refreshFhpContextMenu() {
  try {
    if (!_fhpContextMenuMeta || typeof _fhpContextMenuMeta.buildItems !== "function") return false;
    const { x, y, buildItems } = _fhpContextMenuMeta;
    const items = buildItems();
    if (!Array.isArray(items) || !items.length) return false;
    _showFhpContextMenu({ x, y, items });
    // preserve meta across refresh
    _fhpContextMenuMeta = { x, y, buildItems, key: _fhpContextMenuMeta.key };
    return true;
  } catch {
    return false;
  }
}

function _showFhpContextMenu({ x = 0, y = 0, items = [] } = {}) {
  _closeFhpContextMenu();

  const menu = document.createElement("div");
  menu.className = "fhp-context-menu";
  menu.setAttribute("role", "menu");

  for (const it of (items ?? [])) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fhp-context-menu-item";
    btn.textContent = String(it?.label ?? "");
    if (it?.disabled) {
      btn.disabled = true;
      btn.classList.add("is-disabled");
    }
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const fn = it?.onClick;
      _closeFhpContextMenu();
      if (typeof fn === "function") {
        try { await fn(); } catch (e) { console.error("[nimble-hp-and-damage] Context menu action failed:", e); }
      }
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);

  // Clamp to viewport
  const pad = 8;
  const rect = menu.getBoundingClientRect();
  const maxLeft = Math.max(pad, window.innerWidth - rect.width - pad);
  const maxTop = Math.max(pad, window.innerHeight - rect.height - pad);
  const left = Math.min(Math.max(pad, x), maxLeft);
  const top = Math.min(Math.max(pad, y), maxTop);

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const onDocDown = (ev) => {
    // Close if clicking outside the menu
    if (!menu.contains(ev.target)) _closeFhpContextMenu();
  };
  const onEsc = (ev) => {
    if (ev.key === "Escape") _closeFhpContextMenu();
  };
  const onContext = (ev) => {
    // Right-click elsewhere closes and allows the next menu to open cleanly
    if (!menu.contains(ev.target)) _closeFhpContextMenu();
  };

  document.addEventListener("mousedown", onDocDown, true);
  document.addEventListener("keydown", onEsc, true);
  document.addEventListener("contextmenu", onContext, true);

  _fhpContextMenuEl = menu;
  _fhpContextMenuCloser = () => {
    try { document.removeEventListener("mousedown", onDocDown, true); } catch {}
    try { document.removeEventListener("keydown", onEsc, true); } catch {}
    try { document.removeEventListener("contextmenu", onContext, true); } catch {}
  };
}

class FloatingHPApp extends HandlebarsApplicationMixin(ApplicationV2) {
  tokenname = "";
  tokenstat = "";
  tokentemp = "";
  tokentooltip = "";
  color = "";
  valuePct = null;
  tempPct = null;

  static DEFAULT_OPTIONS = {
    // Keep the original app id + css class so the HUD layout/styling remains
    // identical to Floating HP Tracker v1.0.
    // (This also avoids needing to touch the established CSS selectors.)
    id: "floating-hp-tracker",
    classes: ["floating-hp-tracker"],
    window: { resizable: false },
    position: { width: 260 }
  };

  static PARTS = {
    main: { root: true, template: "modules/nimble-hp-and-damage/templates/floatinghp.html" }
  };

  nonDismissible = true;

  // Targeted Armor Base Mode (client-side only)
  // 0 = Unarmored
  // 1 = Medium
  // 2 = Heavy
  _tgtArmorMode = 0;

  // If TRUE, the user has manually overridden the default armor behavior.
  // When FALSE, the HUD uses each target's detected armor normally.
  _tgtArmorOverride = false;

  // Targeted Armor Override State
  // "normal" = use default detected armor behavior
  // "reduced" = reduce armor one step (heavy->medium, medium->unarmored)
  // "bypass" = ignore armor
  _tgtArmorOverrideState = "normal";

  // Targeted Defend Mode (single PC target only)
  // 0 = None
  // 1 = Armor (DEX/base + armor gear)
  // 2 = Shield (shield gear only)
  // 3 = Armor+Shield (DEX/base + all gear)
  _tgtDefendMode = 0;

  // If the user cycles Defend while no roll context exists, we preserve the
  // current numeric value as a "manual base" so we can update the preview
  // without compounding repeated mode switches.
  _tgtDefendManualBase = null;

  persistPosition = foundry.utils.debounce(this.onPersistPosition.bind(this), 800);

  /**
   * Apply per-user tooltip visibility to the HUD.
   *
   * We implement this by stashing any computed tooltip text in a data attribute,
   * then removing/restoring the native title attribute.
   */
  _applyTooltipSetting() {
    let showTips = true;
    try {
      // Client-scoped setting; default ON.
      showTips = setting("show-tooltips") !== false;
    } catch {
      showTips = true;
    }

    const root = this.element;
    if (!root?.querySelectorAll) return;

    const els = root.querySelectorAll("[title], [data-fhp-title]");
    for (const el of els) {
      try {
        if (showTips) {
          const stored = el.getAttribute("data-fhp-title");
          if (stored && !el.getAttribute("title")) el.setAttribute("title", stored);
        } else {
          const cur = el.getAttribute("title");
          if (cur) el.setAttribute("data-fhp-title", cur);
          el.removeAttribute("title");
        }
      } catch {
        /* ignore */
      }
    }
  }


  _dragBound = false;
  _dragState = null;

  /**
   * Bind a headerless drag handle, modeled after the Floating Resource Tracker's bounded HUD dragging.
   * We intentionally do NOT rely on Foundry's window header, since this app hides it for compactness.
   */
  _bindDragHandle() {
    if (this._dragBound) return;
    this._dragBound = true;

    const el = this.element;
    if (!el) return;

    // Drag from anywhere in the surface that is NOT an interactive control.
    const handle = el.querySelector?.(".fhp-wrap") ?? el;

    const isInteractive = (target) => {
      if (!target?.closest) return false;
      return !!target.closest(
        // NOTE: .fhp-targeted-header is treated as interactive so tooltip hover is easy and
        // doesn't fight the drag surface.
        "button, input, select, textarea, a, label, [contenteditable='true'], .fhp-btn, .fhp-input, .fhp-targeted-header, .fhp-targeted-title, .fhp-targeted-warning"
      );
    };

    const clamp = (left, top) => {
      const w = el.offsetWidth ?? 0;
      const h = el.offsetHeight ?? 0;
      const maxLeft = Math.max(0, window.innerWidth - w);
      const maxTop = Math.max(0, window.innerHeight - h);
      return {
        left: Math.max(0, Math.min(maxLeft, Math.round(left))),
        top: Math.max(0, Math.min(maxTop, Math.round(top)))
      };
    };

    handle.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;

      // Don't interfere with actual controls.
      if (isInteractive(ev.target)) return;

      ev.preventDefault();
      ev.stopPropagation();

      const rect = el.getBoundingClientRect();
      this._dragState = {
        startX: ev.clientX,
        startY: ev.clientY,
        startLeft: rect.left,
        startTop: rect.top
      };

      handle.classList.add("fhp-dragging");
      // Also mark the app root so CSS can force a "grabbing" cursor even when hovering child elements.
      el.classList.add("fhp-dragging");

      try { handle.setPointerCapture?.(ev.pointerId); } catch { /* ignore */ }
    });

    handle.addEventListener("pointermove", (ev) => {
      if (!this._dragState) return;

      const dx = ev.clientX - this._dragState.startX;
      const dy = ev.clientY - this._dragState.startY;
      const rawLeft = this._dragState.startLeft + dx;
      const rawTop = this._dragState.startTop + dy;
      const pos = clamp(rawLeft, rawTop);

      // Use super.setPosition to avoid spamming flag persistence on every mousemove.
      super.setPosition({ left: pos.left, top: pos.top });
    });

    const stop = async () => {
      if (!this._dragState) return;
      this._dragState = null;

      handle.classList.remove("fhp-dragging");
      el.classList.remove("fhp-dragging");

      const rect = el.getBoundingClientRect();
      const pos = clamp(rect.left, rect.top);
      this.setPosition({ left: pos.left, top: pos.top });
    };

    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }

  _initializeApplicationOptions(options) {
    options = super._initializeApplicationOptions(options);

    const pos = game.user.getFlag("nimble-hp-and-damage", "fhpPos");
    options.position.top = pos?.top ?? 60;
    options.position.left = pos?.left ?? (document.getElementById("board")?.offsetWidth ? (document.getElementById("board").offsetWidth / 2 - 130) : 300);

    return options;
  }

  setPosition(position) {
    position = super.setPosition(position);
    this.persistPosition(position);
    return position;
  }

  _onRender(context, options) {
    super._onRender(context, options);

    this.refreshSelected();
    const html = $(this.element);

    // Apply per-user tooltip visibility
    this._applyTooltipSetting();

    // Right-click: Context Inspector (Selected / Targeted header areas)
    html.find(".fhp-character-name").contextmenu(async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      await this._openContextInspector({ section: "selected" });
    });

    html.find(".fhp-targeted-header, .fhp-targeted-title").contextmenu(async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      await this._openContextInspector({ section: "targeted" });
    });


    // Ensure mouse-clicked buttons don't keep focus (prevents the persistent focus border)
    const blurCurrentTarget = (ev) => {
      try { ev?.currentTarget?.blur?.(); } catch { /* ignore */ }
    };

    // --- Drag (headerless) ---
    this._bindDragHandle();

    // --- Buttons ---
    // Dead/Dying toggle button
    // - Left click: apply dead/dying logic (status-aware)
    // - Right click: set HP to 0 without status automation
    html.find("#fhp-btn-dead")
      .click(async (ev) => {
        ev.preventDefault();
        blurCurrentTarget(ev);
        if (ev.shiftKey) return this.changeHP(0, null, "toggle");

        const didApply = await this.changeHP("zero", null, true);
        if (didApply) this._resetHudAfterApplySuccess();
      })
      .contextmenu(async (ev) => {
        ev.preventDefault();
        blurCurrentTarget(ev);

        const didApply = await this.changeHP("zero"); // no status changes
        if (didApply) this._resetHudAfterApplySuccess();
      });

    html.find("#fhp-btn-hurt").click(async (ev) => {
      ev.preventDefault();
      blurCurrentTarget(ev);
      const data = this.parseValue;
      if (data.value !== "") {
        data.value = Math.abs(data.value);
        const didApply = await this.changeHP(data.value, data.target);
        if (didApply) this._resetHudAfterApplySuccess();
      }
    });

    html.find("#fhp-btn-heal").click(async (ev) => {
      ev.preventDefault();
      blurCurrentTarget(ev);
      const data = this.parseValue;
      if (data.value !== "") {
        data.value = -Math.abs(data.value);
        const didApply = await this.changeHP(data.value, data.target, false);
        if (didApply) this._resetHudAfterApplySuccess();
      }
    });

    html.find("#fhp-btn-fullheal").click(async (ev) => {
      ev.preventDefault();
      blurCurrentTarget(ev);
      const didApply = await this.changeHP("full", null, false);
      if (didApply) this._resetHudAfterApplySuccess();
    }).contextmenu(async (ev) => {
      ev.preventDefault();
      blurCurrentTarget(ev);
      const didApply = await this.changeHP("full"); // no status changes
      if (didApply) this._resetHudAfterApplySuccess();
    });

    // --- Targeted block (Phase 1) ---
    html.find("#fhp-tgt-armor").click((ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      // If exactly one PC is targeted, repurpose the Armor button as a Defend cycler.
      // Otherwise, preserve legacy armor-toggle behavior.
      const singlePC = this._getSingleTargetedPC?.();
      if (singlePC?.actor) {
        this._cycleTargetDefendMode?.();
      } else {
        this._cycleTargetArmorMode();
      }
      // If a damage context menu is open, refresh its preview values immediately.
      try {
        if (_fhpContextMenuMeta?.key === "tgtDamage") _refreshFhpContextMenu();
      } catch { /* ignore */ }
    });

    // Right-click armor icon to return to AUTO armor sync (clears manual override)
    html.find("#fhp-tgt-armor").on("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try {
        const singlePC = this._getSingleTargetedPC?.();
        if (singlePC?.actor) {
          // Defend: right-click resets to No Defend.
          this._tgtDefendMode = 0;
          this._clearDefendManualBaseIfNeeded?.();
          this._setTargetArmorButtonVisual();
          this._applyArmorModeToTargetedInput();
        } else {
          this._tgtArmorOverride = false;
          this._tgtArmorOverrideState = "normal";
          // On an explicit "pull from chat" action, re-sync armor mode from the *current targets*
          // even if the user previously cycled the toggle. This prevents stale/manual states
          // from carrying forward unintentionally between different target sets.
          this._autoSetArmorModeFromTargets(true);
          this._setTargetArmorButtonVisual();
          // If we have a roll context, re-apply armor mode to the Targeted input so the field matches the synced mode.
          this._applyArmorModeToTargetedInput();
        }
        if (_fhpContextMenuMeta?.key === "tgtDamage") _refreshFhpContextMenu();
      } catch { /* ignore */ }
    });

    
    html.find("#fhp-tgt-hurt").click(async (ev) => {
      ev.preventDefault();
      blurCurrentTarget(ev);
      const data = this._parseValueFromSelector("#fhp-tgt-hp");
      const amt = (data.value === "" || data.value === 0) ? 1 : Math.abs(Number(data.value));
      const didApply = await this.changeHPForTargets(amt, data.target, { kind: "damage", mode: "normal" });
      if (didApply) this._resetHudAfterApplySuccess();
      this._clearTargetedInput();
    }).contextmenu(async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      blurCurrentTarget(ev);

      const data = this._parseValueFromSelector("#fhp-tgt-hp");
      const amt = (data.value === "" || data.value === 0) ? 1 : Math.abs(Number(data.value));
      const tokens = this._getTargetedTokens();

      if (!tokens.length) return;

      // Determine crit state once for menu labeling/logic.
      let isCrit = false;
      let baseRoll = null;
      try {
        const inputEl = this.element?.querySelector?.("#fhp-tgt-hp");
        const wasAuto = String(inputEl?.dataset?.fhpAutofill ?? "") === "1";
        baseRoll = (wasAuto && this._tgtBaseRoll) ? this._tgtBaseRoll : null;
        isCrit = !!(baseRoll?.isCrit);
      } catch { /* ignore */ }

      // Defend preview support (single targeted PC only)
      const singlePC = this._getSingleTargetedPC?.();
      const defendCtx = singlePC?.actor ? this._getDefendContextForActor?.(singlePC.actor) : null;
      const defendPotential = singlePC?.actor
        ? (this._getDefendValueForMode?.(defendCtx, this._tgtDefendMode) ?? 0)
        : 0;

      const previewFor = (mode) => {
        // compute a best-effort preview: if all targets resolve to the same applied number, show it; otherwise "mixed"
        try {
          const extraDice = this._getTargetExtraDiceTotal?.() ?? 0;
          const baseFull = baseRoll ? (Number(baseRoll.full ?? 0) || 0) + extraDice : amt;
          const baseDiceOnly = baseRoll ? (((Number(baseRoll.diceOnly ?? 0) || 0) || (Number(baseRoll.full ?? 0) || 0))) + extraDice : amt;

          const vals = [];
          for (const t of tokens) {
            const a = t?.actor;
            const armorMode = this._getEffectiveArmorModeForActor?.(a) ?? (Number(this._detectArmorModeForActor?.(a) ?? this._tgtArmorMode ?? 0) || 0);
            let afterArmor = baseFull;
            // Crit bypasses armor.
            if (!isCrit) {
              if (armorMode === 1) afterArmor = baseDiceOnly;
              else if (armorMode === 2) afterArmor = Math.ceil(baseDiceOnly / 2);
              else afterArmor = baseFull;
            }

            // Transforms (mutually exclusive): Resistant applies even on crit; Vulnerable has no additional effect on crit.
            let v = afterArmor;
            if (mode === "resistant") v = Math.ceil(afterArmor / 2);
            else if (mode === "vulnerable") v = isCrit ? afterArmor : ((armorMode === 0) ? (afterArmor * 2) : baseFull);

            // Defend is a flat reduction after all other math (single-target PC only).
            if (singlePC?.actor && a?.id === singlePC.actor.id && Number.isFinite(defendPotential) && defendPotential > 0) {
              v = Math.max(0, v - Math.min(v, Math.max(0, Number(defendPotential) || 0)));
            }

            vals.push(v);
          }
          const uniq = Array.from(new Set(vals));
          return (uniq.length === 1) ? `: ${uniq[0]}` : " (mixed)";
        } catch { return " (mixed)"; }
      };

      const buildItems = () => ([
        {
          label: `Apply Normal Damage${previewFor("normal")}${isCrit ? " (Crit bypasses armor)" : ""}`,
          onClick: async () => {
            const didApply = await this.changeHPForTargets(amt, data.target, { kind: "damage", mode: "normal" });
            if (didApply) this._resetHudAfterApplySuccess();
            this._clearTargetedInput();
          }
        },
        {
          label: `Vulnerable${previewFor("vulnerable")}${isCrit ? " (no extra effect on Crit)" : ""}`,
          onClick: async () => {
            const didApply = await this.changeHPForTargets(amt, data.target, { kind: "damage", mode: "vulnerable" });
            if (didApply) this._resetHudAfterApplySuccess();
            this._clearTargetedInput();
          }
        },
        {
          label: `Resistant${previewFor("resistant")}`,
          onClick: async () => {
            const didApply = await this.changeHPForTargets(amt, data.target, { kind: "damage", mode: "resistant" });
            if (didApply) this._resetHudAfterApplySuccess();
            this._clearTargetedInput();
          }
        }
      ]);

      _fhpContextMenuMeta = { x: ev.clientX, y: ev.clientY, buildItems, key: "tgtDamage" };
      _showFhpContextMenu({ x: ev.clientX, y: ev.clientY, items: buildItems() });
    });

    html.find("#fhp-tgt-heal").click(async (ev) => {
      ev.preventDefault();
      blurCurrentTarget(ev);
      const data = this._parseValueFromSelector("#fhp-tgt-hp");
      const amt = (data.value === "" || data.value === 0) ? -1 : -Math.abs(Number(data.value));
      const didApply = await this.changeHPForTargets(amt, data.target, { kind: "healing", mode: "normal" });
      if (didApply) this._resetHudAfterApplySuccess();
      this._clearTargetedInput();
    }).contextmenu(async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      blurCurrentTarget(ev);

      const data = this._parseValueFromSelector("#fhp-tgt-hp");
      const amt = (data.value === "" || data.value === 0) ? -1 : -Math.abs(Number(data.value));
      const tokens = this._getTargetedTokens();
      if (!tokens.length) return;

      _showFhpContextMenu({
        x: ev.clientX,
        y: ev.clientY,
        items: [
          {
            label: `Apply Normal Healing: ${Math.abs(Number(amt))}`,
            onClick: async () => {
              const didApply = await this.changeHPForTargets(amt, data.target, { kind: "healing", mode: "normal" });
              if (didApply) this._resetHudAfterApplySuccess();
              this._clearTargetedInput();
            }
          },
          {
            label: "Heal to Full",
            onClick: async () => {
              const didApply = await this.changeHPForTargets(amt, data.target, { kind: "healing", healToFull: true, mode: "normal" });
              if (didApply) this._resetHudAfterApplySuccess();
              this._clearTargetedInput();
            }
          }
        ]
      });
    });


    // Targeted: open extra-damage options dialog (Sneak Attack / Judgment / Shining Mandate, etc.)
    html.find("#fhp-tgt-extras").click(async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      await this._openTargetExtrasDialog();
    });

    // Targeted: apply pulled condition(s) only (no damage), if present
    html.on("click", ".fhp-cond-btn", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const btn = ev.currentTarget;
      const key = String(btn?.dataset?.condition ?? "").trim();
      if (!key) return;

      const tokens = Array.from(game.user.targets ?? []).map(t => t).filter(Boolean);
      if (!tokens.length) return;

      const tokenUuids = tokens.map(t => t?.document?.uuid).filter(Boolean);
      try {
        if (!game.user.isGM) {
          await requestToggleStatus({ tokenUuids, statusKey: key, action: "add", active: true });
        } else {
          for (const t of tokens) {
            const a = t?.actor;
            if (!a) continue;
            await this._toggleStatusEffectBestEffort(a, key, true);
          }
        }
      } catch (err) {
        console.error("[nimble-hp-and-damage] condition apply error:", err);
      }
    });

    html.find("#fhp-tgt-hp").focus((ev) => {
      ev.preventDefault();
      const elem = ev.target;
      if (elem?.setSelectionRange) {
        elem.focus();
        elem.setSelectionRange(0, $(elem).val().length);
      }
      // Any explicit focus/select implies user intent; stop treating this field as auto-filled.
      try {
        ev.target.dataset.fhpAutofill = "0";
      } catch { /* ignore */ }
    }).keypress(async (ev) => {
      if (ev.which !== 13) return;

      const data = this._parseValueFromSelector("#fhp-tgt-hp");
      if (data.value === "" || data.value === 0) return;

      ev.preventDefault();
      // Targeted input is ALWAYS a delta, never an absolute set.
      // Behavior on Enter (no sign support needed):
      // - If targets include ANY NPC/monster -> treat as DAMAGE.
      // - If targets are ONLY PCs -> treat as HEALING.
      const info = this._getTargetHeaderInfo();
      const delta = info.onlyPCs ? -Math.abs(Number(data.value)) : Math.abs(Number(data.value));

      const didApply = await this.changeHPForTargets(delta, data.target);
      if (didApply) this._resetHudAfterApplySuccess();
      this._clearTargetedInput();
    });

    // Right-click: pull latest roll total from chat into the Targeted input (explicit user action).
    html.find("#fhp-tgt-hp").contextmenu((ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._pullLatestChatRollIntoInput("#fhp-tgt-hp");
    });

    // If the user types in the Targeted input, don't overwrite it with auto-fill.
    html.find("#fhp-tgt-hp").on("input", (ev) => {
      try {
        ev.target.dataset.fhpAutofill = "0";
      } catch { /* ignore */ }
    });

    // --- Input ---
    html.find("#fhp-hp").focus((ev) => {
      ev.preventDefault();
      const elem = ev.target;
      if (elem?.setSelectionRange) {
        elem.focus();
        elem.setSelectionRange(0, $(elem).val().length);
      }
      // Any explicit focus/select implies user intent; stop treating this field as auto-filled.
      try {
        ev.target.dataset.fhpAutofill = "0";
      } catch { /* ignore */ }
    }).keypress(async (ev) => {
      if (ev.which !== 13) return;
      const data = this.parseValue;
      // Allow 0: absolute set to 0 HP is valid (and may trigger dead/dying automation).
      if (data.value === "") return;

      ev.preventDefault();
      // Controlled input on Enter is an ABSOLUTE set of regular HP.
      // If the entered value exceeds max HP, treat it as "Heal to Full and clear defeated".
      const didApply = await this.setControlledHpAbsolute(Number(data.value));
      if (didApply) this._resetHudAfterApplySuccess();
    });

    // Right-click: pull latest roll total from chat into the Controlled input (explicit user action).
    html.find("#fhp-hp").contextmenu((ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._pullLatestChatRollIntoInput("#fhp-hp");
    });

    // If the user types in the Controlled input, don't overwrite it with auto-fill.
    html.find("#fhp-hp").on("input", (ev) => {
      try {
        ev.target.dataset.fhpAutofill = "0";
      } catch { /* ignore */ }
    });
  }

  async close(options) {
    if (options?.properClose) {
      await super.close(options);
      game.FloatingHP.app = null;
    }
  }

  getResourceValue(actor, resourceName) {
    if (!resourceName || resourceName.startsWith(".")) return 0;
    const v = foundry.utils.getProperty(actor, `system.${resourceName}`);
    return parseInt(v ?? 0);
  }

  /**
   * Baseline OFF-mode QoL:
   * When the master setting "Allow players to apply damage directly" is OFF,
   * players should still see (and be able to operate on) their own token even
   * if they haven't actively selected it.
   *
   * This must never enable interaction with NPC/monster tokens while OFF.
   */
  _getUserDefaultToken() {
    try {
      if (game.user?.isGM) return null;
      const actor = game.user?.character;
      if (!actor) return null;

      // Prefer a token on the current canvas scene.
      const active = actor.getActiveTokens?.(true, true) ?? actor.getActiveTokens?.() ?? [];
      const onScene = (active ?? []).filter((t) => t?.document?.parent === canvas.scene);
      return (onScene[0] ?? active[0] ?? null) || null;
    } catch {
      return null;
    }
  }

  _getEffectiveTokens() {
    const controlled = canvas.tokens?.controlled ?? [];
    if (controlled.length > 0) return controlled;

    const fallback = this._getUserDefaultToken();
    return fallback ? [fallback] : [];
  }

  async changeHP(value = 0, target = null, addStatus = null) {
    // Controlled block behavior ("Me"):
    // Always operates on CONTROLLED tokens, falling back to the user's own token
    // if nothing is selected. This is independent of the player-damage setting.

    const tokenSources = this._getEffectiveTokens();

    const entries = tokenSources.flatMap((t) => {
      if (!t?.actor) return [];
      // Preserve group-token behavior for controlled tokens.
      if (t.actor?.type === "group") {
        return Array.from(t.actor?.system?.members ?? []).map((m) => ({ actor: m, tokenUuid: null }));
      }
      return [{ actor: t.actor, tokenUuid: t.document?.uuid ?? null }];
    });

    let didApply = false;
    for (const { actor: a, tokenUuid } of entries) {
      if (!a || !(a instanceof Actor)) continue;

      let tValue = foundry.utils.duplicate(value);
      const resourceValue = this.getResourceValue(a, HP_VALUE_PATH);

      if (value === "zero") {
        const tempValue = this.getResourceValue(a, HP_TEMP_PATH);
        tValue = resourceValue + tempValue;
      } else if (value === "full") {
        const maxValue = this.getResourceValue(a, HP_MAX_PATH);
        tValue = resourceValue - maxValue;
      }

      const v = (tValue?.value ?? tValue);
      if (v !== 0) { await this.applyDamageSmart(a, tValue, target, tokenUuid); didApply = true; }
    }

    this.refreshSelected();
    return didApply;
  }

  async applyDamageSmart(actor, value, target, tokenUuid = null) {
    // If the user cannot update the actor (typical for player-targeted NPCs),
    // route the change through the GM relay.
    const delta = (typeof value === "object" && value !== null) ? (value.value ?? 0) : value;

    // Controlled block never routes through GM for players because they operate on
    // their own token. Keep the helper in place for GMs / special ownership edge-cases.
    if (!game.user.isGM && tokenUuid && !actor.isOwner) {
      return requestApplyHpDelta({ tokenUuid, delta, target, note: "Floating HP HUD", chatCard: false });
    }

    return this.applyDamage(actor, value, target);
  }

  async setControlledHpAbsolute(desiredHp) {
    // Controlled block "Enter" behavior:
    // - Always sets REGULAR HP to an absolute value.
    // - If desiredHp > max HP, treat it as "Heal to Full" (and clear defeated if configured).
    const tokenSources = this._getEffectiveTokens();

    const entries = tokenSources.flatMap((t) => {
      if (!t?.actor) return [];
      if (t.actor?.type === "group") {
        return Array.from(t.actor?.system?.members ?? []).map((m) => ({ actor: m, tokenUuid: null }));
      }
      return [{ actor: t.actor, tokenUuid: t.document?.uuid ?? null }];
    });

    // If any entry exceeds max, perform the same behavior as the "heal to full" button.
    for (const { actor: a } of entries) {
      if (!a || !(a instanceof Actor)) continue;
      const maxValue = this.getResourceValue(a, HP_MAX_PATH);
      if (Number.isFinite(desiredHp) && desiredHp > maxValue) {
        return await this.changeHP("full", null, false);
      }
    }

    let didApply = false;
    for (const { actor: a, tokenUuid } of entries) {
      if (!a || !(a instanceof Actor)) continue;
      const current = this.getResourceValue(a, HP_VALUE_PATH);
      const desired = Number(desiredHp);
      if (!Number.isFinite(desired)) continue;

      // applyDamage expects a delta where positive = damage, negative = heal.
      const delta = current - desired;
      if (delta === 0) continue;
      await this.applyDamageSmart(a, { value: delta }, "regular", tokenUuid);; didApply = true
    }

    this.refreshSelected();
    return didApply;
  }

  // ---------------- Targeted block ("Them") ----------------
  _getControlledHeaderInfo(tokens) {
    const names = (tokens ?? []).map(t => t?.name ?? t?.document?.name ?? "").filter(Boolean);
    const total = names.length;
    const first = names.slice(0, 3);
    const more = Math.max(0, total - first.length);
    const display = total === 0 ? "" : `${first.join(", ")}${more ? ` +${more} more` : ""}`;
    const full = names.join(", ");
    return { total, display, full };
  }

  _getTargetedTokens() {
    try {
      return Array.from(game.user?.targets ?? []);
    } catch {
      return [];
    }
  }

  _getSingleTargetedPC() {
    try {
      const tokens = this._getTargetedTokens?.() ?? [];
      if (tokens.length !== 1) return null;
      const t = tokens[0];
      const a = t?.actor ?? null;
      if (!a) return null;
      // "PC" heuristic used elsewhere in this file.
      if (!a?.hasPlayerOwner) return null;
      return { token: t, actor: a };
    } catch {
      return null;
    }
  }

  _clearDefendManualBaseIfNeeded() {
    try {
      this._tgtDefendManualBase = null;
      const el = this.element?.querySelector?.("#fhp-tgt-hp");
      if (el) delete el.dataset.fhpDefendManualBase;
    } catch { /* ignore */ }
  }

  _getDefendContextForActor(actor) {
    // Returns a computed breakdown for Defend, based on Nimble's armor components.
    // Uses item.system.objectType discriminator ("armor" vs "shield").
    try {
      if (!actor) return null;
      const armorObj = foundry.utils.getProperty(actor, "system.attributes.armor");
      const totalArmor = Number(armorObj?.value ?? 0) || 0;
      const comps = Array.isArray(armorObj?.components) ? armorObj.components : [];
      if (!Number.isFinite(totalArmor) && !comps.length) return null;

      let armorGear = 0;
      let shieldGear = 0;
      const armorNames = [];
      const shieldNames = [];

      for (const c of comps) {
        const src = String(c?.source ?? "").trim();
        const val = Number(c?.value ?? 0) || 0;
        if (!src || !Number.isFinite(val) || val === 0) continue;

        const it = (actor.items ?? []).find(i => String(i?.name ?? "") === src) ?? null;
        const ot = String(foundry.utils.getProperty(it, "system.objectType") ?? "").toLowerCase().trim();

        if (ot === "shield") {
          shieldGear += val;
          shieldNames.push(src);
        } else {
          // Default everything else to armor (matches your observed objectType="armor").
          armorGear += val;
          armorNames.push(src);
        }
      }

      const gearSum = armorGear + shieldGear;
      const basePortion = Math.max(0, (Number.isFinite(totalArmor) ? totalArmor : 0) - gearSum);

      return {
        totalArmor,
        armorGear,
        shieldGear,
        basePortion,
        armorNames,
        shieldNames
      };
    } catch {
      return null;
    }
  }

  _getDefendValueForMode(defCtx, mode) {
    try {
      const m = Number(mode ?? 0) || 0;
      if (!defCtx) return 0;
      if (m === 1) return (Number(defCtx.basePortion ?? 0) || 0) + (Number(defCtx.armorGear ?? 0) || 0);
      if (m === 2) return (Number(defCtx.shieldGear ?? 0) || 0);
      if (m === 3) return (Number(defCtx.basePortion ?? 0) || 0) + (Number(defCtx.armorGear ?? 0) || 0) + (Number(defCtx.shieldGear ?? 0) || 0);
      return 0;
    } catch {
      return 0;
    }
  }

  _getTargetHeaderInfo() {
    const tokens = this._getTargetedTokens();
    const names = tokens.map(t => t?.name ?? t?.document?.name ?? "").filter(Boolean);
    const total = names.length;
    const first = names.slice(0, 3);
    const more = Math.max(0, total - first.length);
    const display = total === 0 ? "" : `${first.join(", ")}${more ? ` +${more} more` : ""}`;
    const full = names.join(", ");

    // Friendly-fire indicator rules (per spec):
    // - mixed PCs + NPCs => warning icon (tooltip)
    // - only PCs => accent green (handled via css class)
    const actors = tokens.map(t => t?.actor).filter(Boolean);
    const anyPC = actors.some(a => a?.hasPlayerOwner);
    const anyNPC = actors.some(a => !(a?.hasPlayerOwner));
    const onlyPCs = (anyPC && !anyNPC);
    const mixed = (anyPC && anyNPC);

    return { total, display, full, onlyPCs, mixed };
  }

  _parseValueFromSelector(selector) {
    const raw = String($(selector, this.element).val() ?? "");
    const result = { value: raw, target: null, raw };

    if (/[rR]/.test(result.value)) { result.target = "regular"; result.value = result.value.replace(/[rR]/g, ""); }
    if (/[tT]/.test(result.value)) { result.target = "temp"; result.value = result.value.replace(/[tT]/g, ""); }
    if (/[mM]/.test(result.value)) { result.target = "max"; result.value = result.value.replace(/[mM]/g, ""); }

    const n = parseInt(result.value);
    result.value = isNaN(n) ? "" : n;
    return result;
  }

  _clearTargetedInput() {
    $("#fhp-tgt-hp", this.element).val("");
  }

_autoSetArmorModeFromTargets(force = false) {
    try {
      if (!force && this._tgtArmorOverride) return;
      const tokens = this._getTargetedTokens?.() ?? [];
      if (!tokens.length) {
        this._tgtArmorMode = 0;
        return;
      }

      const modes = [];
      for (const t of tokens) {
        const a = t?.actor;
        const m = this._detectArmorModeForActor?.(a);
        if (m == null) continue;
        modes.push(Number(m) || 0);
      }

      if (!modes.length) {
        this._tgtArmorMode = 0;
        return;
      }

      // For display purposes, prefer the highest armor tier among the current targets.
      // Actual damage math still evaluates per-target armor unless an override is active.
      this._tgtArmorMode = Math.max(...modes);
      if (force) this._tgtArmorOverrideState = "normal";
    } catch { /* ignore */ }
  }

  _getTargetArmorBaseType() {
    try {
      const tokens = this._getTargetedTokens?.() ?? [];
      if (!tokens.length) return 0;
      const modes = tokens
        .map(t => this._detectArmorModeForActor?.(t?.actor))
        .filter(m => m != null)
        .map(m => Number(m) || 0);
      if (!modes.length) return Number(this._tgtArmorMode ?? 0) || 0;
      return Math.max(...modes);
    } catch {
      return Number(this._tgtArmorMode ?? 0) || 0;
    }
  }

  _getEffectiveArmorModeForActor(actor) {
    try {
      const detected = Number(this._detectArmorModeForActor?.(actor) ?? 0) || 0;
      if (!this._tgtArmorOverride) return detected;
      return _effectiveArmorModeForOverride(detected, this._tgtArmorOverrideState);
    } catch {
      return Number(this._tgtArmorMode ?? 0) || 0;
    }
  }

  _setTargetArmorButtonVisual() {
    try {
      const btn = this.element?.querySelector?.("#fhp-tgt-armor");
      if (!btn) return;

      // Single targeted PC: this button becomes Defend.
      const singlePC = this._getSingleTargetedPC?.();
      if (singlePC?.actor) {
        // Visually differentiate "Defend context" with a subtle green background (background only).
        try { btn.classList.add("fhp-defend-context"); } catch { /* ignore */ }

        const defCtx = this._getDefendContextForActor?.(singlePC.actor);
        const hasShield = (Number(defCtx?.shieldGear ?? 0) || 0) > 0;

        // Smart equipment detection:
        // - If no shield is equipped, only expose two Defend options: None + Defend.
        // - If a shield is equipped, expose the full four options.
        let mode = Number(this._tgtDefendMode ?? 0) || 0;
        if (!hasShield && mode > 1) {
          mode = (mode === 0) ? 0 : 1;
          this._tgtDefendMode = mode;
        }

        const defVal = Number(this._getDefendValueForMode?.(defCtx, mode) ?? 0) || 0;

        let title = "Defend: None";
        let icon = `<i class="fa-solid fa-ban fhp-armor-icon" aria-hidden="true"></i>`;

        if (mode === 1) {
          if (hasShield) {
            title = `Defend Armor (${defVal})`;
            icon = `<i class="fa-solid fa-helmet-battle fhp-armor-icon" aria-hidden="true"></i>`;
          } else {
            title = `Defend (${defVal})`;
            icon = `<i class="fa-solid fa-shield-check fhp-armor-icon" aria-hidden="true"></i>`;
          }
        } else if (mode === 2) {
          title = `Defend Shield (${defVal})`;
          icon = `<i class="fa-solid fa-shield fhp-armor-icon" aria-hidden="true"></i>`;
        } else if (mode === 3) {
          title = `Defend Armor+Shield (${defVal})`;
          icon = `<i class="fa-solid fa-shield-check fhp-armor-icon" aria-hidden="true"></i>`;
        }

        // Tooltip text (respects "show-tooltips" setting)
        const suffix = `
Click to cycle
Right-click to reset`;
        const showTips = game.settings.get("nimble-hp-and-damage", "show-tooltips") !== false;
        if (showTips) {
          btn.setAttribute("title", title + suffix);
          btn.removeAttribute("data-fhp-title");
        } else {
          btn.setAttribute("data-fhp-title", title + suffix);
          btn.removeAttribute("title");
        }

        btn.innerHTML = icon;
        btn.dataset.defendMode = String(mode);
        btn.dataset.armorMode = "";
        return;
      }

      try { btn.classList.remove("fhp-defend-context"); } catch { /* ignore */ }

      const baseType = this._getTargetArmorBaseType?.() ?? (Number(this._tgtArmorMode ?? 0) || 0);
      const overrideState = String(this._tgtArmorOverrideState ?? "normal");
      let title = "Armor: Normal";
      let suffix = "\nClick to cycle/manual override\nRight-click to re-sync with targeted token armor";
      // Unarmored: use a clearly distinct icon from Heavy armor (requested: fa-solid fa-ban)
      let icon = `<i class="fa-solid fa-ban fhp-armor-icon fhp-armor-unarmored" aria-hidden="true"></i>`;

      if (baseType <= 0) {
        title = "Armor: Unarmored";
        suffix = "\nNo armor to modify";
      } else if (baseType === 1) {
        if (overrideState === "bypass") {
          title = "Armor: Bypassed Armor";
          icon = `<i class="fa-solid fa-ban fhp-armor-icon fhp-armor-unarmored" aria-hidden="true"></i>`;
        } else {
          title = "Armor: Normal";
          icon = `<i class="fa-solid fa-shield-halved fhp-armor-icon fhp-armor-medium" aria-hidden="true"></i>`;
        }
      } else {
        if (overrideState === "reduced") {
          title = "Armor: Reduced Armor One Step";
          icon = `<i class="fa-solid fa-arrow-down fhp-armor-icon" aria-hidden="true"></i>`;
        } else if (overrideState === "bypass") {
          title = "Armor: Bypassed Armor";
          icon = `<i class="fa-solid fa-ban fhp-armor-icon fhp-armor-unarmored" aria-hidden="true"></i>`;
        } else {
          title = "Armor: Normal";
          icon = `<i class="fa-solid fa-shield fhp-armor-icon fhp-armor-heavy" aria-hidden="true"></i>`;
        }
      }

      const showTips = game.settings.get("nimble-hp-and-damage", "show-tooltips") !== false;
      if (showTips) {
        btn.setAttribute("title", title + suffix);
        btn.removeAttribute("data-fhp-title");
      } else {
        // Stash the computed title so it can be restored later if tooltips are enabled
        btn.setAttribute("data-fhp-title", title + suffix);
        btn.removeAttribute("title");
      }
      btn.innerHTML = icon;
      btn.dataset.armorMode = String(baseType);
      btn.dataset.armorOverrideState = overrideState;
      btn.dataset.defendMode = "";
    } catch { /* ignore */ }
  }

  _renderTargetedConditions() {
    try {
      const wrap = this.element?.querySelector?.(".fhp-targeted-conditions");
      if (!wrap) return;

      const condsRaw = Array.isArray(this._tgtBaseRoll?.conditions) ? this._tgtBaseRoll.conditions : [];
      const conds = condsRaw
        .map(c => (typeof c === "string" ? { name: c, icon: "", iconClass: "" } : c))
        .filter(c => String(c?.name ?? "").trim().length > 0);

      if (!conds.length) {
        wrap.style.display = "none";
        wrap.innerHTML = "";
        return;
      }

      wrap.style.display = "flex";

      const esc = (s) => {
        try { return foundry.utils.escapeHTML(String(s ?? "")); } catch { return String(s ?? ""); }
      };

      wrap.innerHTML = conds.map((c, i) => {
        const name = String(c.name ?? "").replace(/\s+/g, " ").trim();
        const icon = String(c.icon ?? "").trim();
        const iconClass = String(c.iconClass ?? "").trim();
        const label = esc(name);
        const attr = esc(name);
        // Icon-only button (name is already visible via tooltip/title).
        const iconHtml = icon
          ? `<img class="fhp-cond-icon" src="${esc(icon)}" alt="${label}">`
          : (iconClass
              ? `<i class="${esc(iconClass)}" aria-hidden="true"></i>`
              : `<i class="fa-solid fa-biohazard" aria-hidden="true"></i>`);
        return `<button type="button" class="fhp-btn fhp-cond-btn" data-condition="${attr}" title="Apply ${label}">${iconHtml}</button>`;
      }).join("");
    } catch {
      /* ignore */
    }
  }


  _computeTargetedValueFromLastRoll() {
    // IMPORTANT: Once a base roll has been pulled into the Targeted box,
    // armor toggles and extra-damage additions must be computed from that
    // SAME base roll (not "latest roll in chat"). Otherwise, rolling an
    // extra-damage die would become the "latest roll" and break recalcs.
    // IMPORTANT: We only recompute from an explicit "base roll context" that was
    // created by a right-click pull (or intentionally initialized by extras).
    // Never fall back to a "last roll" cache here, otherwise toggling armor with
    // an empty box can inject seemingly random stale values.
    const singlePC = this._getSingleTargetedPC?.();
    const base = this._tgtBaseRoll ?? null;

    // If no base roll context exists, allow Defend mode cycling to preview
    // against a preserved manual base (single-target PC only).
    if (!base) {
      if (singlePC?.actor && Number.isFinite(this._tgtDefendManualBase)) {
        const defCtx = this._getDefendContextForActor?.(singlePC.actor);
        const defPotential = this._getDefendValueForMode?.(defCtx, this._tgtDefendMode) ?? 0;
        const pre = Math.max(0, Number(this._tgtDefendManualBase) || 0);
        const reduced = Math.min(pre, Math.max(0, Number(defPotential) || 0));
        return Math.max(0, pre - reduced);
      }
      return null;
    }

    const baseFull = Number(base.full ?? 0) || 0;
    const baseDiceOnly = Number(base.diceOnly ?? 0) || 0;
    const isCrit = !!base.isCrit;

    const extraDice = this._getTargetExtraDiceTotal?.() ?? 0;

    const full = baseFull + extraDice;
    const diceOnly = (baseDiceOnly || baseFull) + extraDice;

    const tgtInfo = this._getTargetHeaderInfo();
    const onlyPCs = !!tgtInfo.onlyPCs;

    // Crit bypasses armor.
    if (isCrit) {
      // Defend still applies on crit for the single-PC Defend use-case.
      if (singlePC?.actor) {
        const defCtx = this._getDefendContextForActor?.(singlePC.actor);
        const defPotential = this._getDefendValueForMode?.(defCtx, this._tgtDefendMode) ?? 0;
        const reduced = Math.min(full, Math.max(0, Number(defPotential) || 0));
        return Math.max(0, full - reduced);
      }
      return full;
    }

    // Healing use-case: armor doesn't apply.
    // For PCs, armor math is skipped; Defend may still apply if a single PC is targeted.
    if (onlyPCs) {
      if (singlePC?.actor) {
        const defCtx = this._getDefendContextForActor?.(singlePC.actor);
        const defPotential = this._getDefendValueForMode?.(defCtx, this._tgtDefendMode) ?? 0;
        const reduced = Math.min(full, Math.max(0, Number(defPotential) || 0));
        return Math.max(0, full - reduced);
      }
      return full;
    }

    const targetTokens = this._getTargetedTokens?.() ?? [];
    const armorVals = targetTokens.map(t => {
      const a = t?.actor;
      let v = this._getEffectiveArmorModeForActor?.(a);
      if (v == null) v = this._detectArmorModeForActor?.(a);
      return Number(v ?? this._tgtArmorMode ?? 0) || 0;
    });
    const uniqArmor = Array.from(new Set(armorVals));
    const mode = uniqArmor.length === 1 ? uniqArmor[0] : null;
    let out = full;
    if (mode === 1) out = diceOnly;
    else if (mode === 2) out = Math.ceil(diceOnly / 2);
    else out = full;

    // Defend applies as a flat reduction after armor math, single-PC only.
    if (singlePC?.actor) {
      const defCtx = this._getDefendContextForActor?.(singlePC.actor);
      const defPotential = this._getDefendValueForMode?.(defCtx, this._tgtDefendMode) ?? 0;
      const reduced = Math.min(out, Math.max(0, Number(defPotential) || 0));
      out = Math.max(0, out - reduced);
    }

    return out;
  }

  _applyArmorModeToTargetedInput() {
    try {
      const el = this.element?.querySelector?.("#fhp-tgt-hp");
      if (!el) return;
      const hasBase = !!this._tgtBaseRoll;
      const extraDice = this._getTargetExtraDiceTotal?.() ?? 0;

      // If there is no roll context, we normally avoid auto-filling.
      // Exception: single-target PC Defend cycling should still update preview.
      const singlePC = this._getSingleTargetedPC?.();
      const rawNum = Number(String(el.value ?? "").trim());
      const hasManualNum = Number.isFinite(rawNum) && rawNum !== 0;

      if (!hasBase && !extraDice) {
        if (!(singlePC?.actor && hasManualNum)) return;
        // Preserve a manual base so mode cycling doesn't compound.
        if (!Number.isFinite(this._tgtDefendManualBase)) {
          this._tgtDefendManualBase = Math.abs(rawNum);
          try { el.dataset.fhpDefendManualBase = String(this._tgtDefendManualBase); } catch { /* ignore */ }
        }
      } else {
        // If we're operating from a roll context, never use the manual base.
        this._clearDefendManualBaseIfNeeded?.();
      }

      const val = this._computeTargetedValueFromLastRoll();
      if (val == null || !Number.isFinite(val)) return;
      el.value = String(val);
      try {
        el.dataset.fhpAutofill = "1";
        el.dataset.fhpAutofillValue = String(val);
        if (this._tgtBaseRoll?.messageId) el.dataset.fhpAutofillMsgId = String(this._tgtBaseRoll.messageId);
      } catch { /* ignore */ }
    } catch { /* ignore */ }
  }

  _cycleTargetArmorMode() {
    const baseType = this._getTargetArmorBaseType?.() ?? 0;
    if (baseType <= 0) {
      this._tgtArmorOverride = false;
      this._tgtArmorOverrideState = "normal";
      this._setTargetArmorButtonVisual();
      return;
    }

    // Manual interaction implies user intent to override default armor behavior.
    this._tgtArmorOverride = true;

    const current = String(this._tgtArmorOverrideState ?? "normal");
    if (baseType === 1) {
      this._tgtArmorOverrideState = (current === "bypass") ? "normal" : "bypass";
    } else {
      if (current === "normal") this._tgtArmorOverrideState = "reduced";
      else if (current === "reduced") this._tgtArmorOverrideState = "bypass";
      else this._tgtArmorOverrideState = "normal";
    }

    this._setTargetArmorButtonVisual();
    // Per requirements: toggling can overwrite manual input.
    this._applyArmorModeToTargetedInput();
  }

  _cycleTargetDefendMode() {
    // Single-target PC only. Cycles through Defend modes and updates preview immediately.
    try {
      const singlePC = this._getSingleTargetedPC?.();
      const defCtx = singlePC?.actor ? this._getDefendContextForActor?.(singlePC.actor) : null;
      const hasShield = (Number(defCtx?.shieldGear ?? 0) || 0) > 0;
      const maxModes = hasShield ? 4 : 2;
      this._tgtDefendMode = (Number(this._tgtDefendMode ?? 0) + 1) % maxModes;
    } catch {
      this._tgtDefendMode = (Number(this._tgtDefendMode ?? 0) + 1) % 4;
    }
    this._setTargetArmorButtonVisual();
    this._applyArmorModeToTargetedInput();
  }

  // ---------------------------
  // Extra damage features (Phase 2)
  // ---------------------------

  _resetTargetExtras() {
    this._tgtExtras = {};
  }

  _getTargetExtraDiceTotal() {
    const extras = this._tgtExtras || {};
    let sum = 0;
    for (const k of Object.keys(extras)) {
      sum += Number(extras[k]?.total ?? 0) || 0;
    }
    return sum;
  }

  _getAttackerActorForExtras() {
    try {
      // Players: linked character
      if (!game.user?.isGM) {
        return game.user.character ?? null;
      }

      // GM: first controlled token actor
      const ctrl = canvas?.tokens?.controlled ?? [];
      if (ctrl.length > 0) return ctrl[0]?.actor ?? null;

      // Fallback: linked character if GM has one
      return game.user.character ?? null;
    } catch {
      return null;
    }
  }

  _getActorLevel(actor) {
    const lvlA = Number(foundry.utils.getProperty(actor, "system.classData.levels.length"));
    if (Number.isFinite(lvlA) && lvlA > 0) return lvlA;

    const lvlB = Number(foundry.utils.getProperty(actor, "system.details.level"));
    if (Number.isFinite(lvlB) && lvlB > 0) return lvlB;

    const lvlC = Number(foundry.utils.getProperty(actor, "system.level"));
    if (Number.isFinite(lvlC) && lvlC > 0) return lvlC;

    return 1;
  }

  _getStartingClassIdentifier(actor) {
    return String(foundry.utils.getProperty(actor, "system.classData.startingClass") ?? "").trim();
  }

  _getChartFormulaForLevel(chart, level) {
    let best = null;
    for (const row of chart) {
      if (level >= row.level) best = row.formula;
      else break;
    }
    return best;
  }

  _actorHasItemIdentifier(actor, identifier) {
    const id = String(identifier || "").trim();
    if (!id) return false;
    return (actor?.items ?? []).some(it => String(foundry.utils.getProperty(it, "system.identifier") ?? "").trim() === id);
  }

  _getAvailableTargetExtras(attackerActor) {
    if (!attackerActor) return [];

    // Progression tables (copied from Apply Damage macro)
    const SNEAK_ATTACK_BY_LEVEL = [
      { level: 1,  formula: "1d6"  },
      { level: 3,  formula: "1d8"  },
      { level: 7,  formula: "2d8"  },
      { level: 9,  formula: "2d10" },
      { level: 11, formula: "2d12" },
      { level: 15, formula: "2d20" },
      { level: 17, formula: "3d20" }
    ];

    const JUDGMENT_DICE_BY_LEVEL = [
      { level: 1,  formula: "2d6"  },
      { level: 3,  formula: "2d8"  },
      { level: 5,  formula: "2d10" },
      { level: 8,  formula: "2d12" },
      { level: 10, formula: "2d20" },
      { level: 14, formula: "3d20" }
    ];

    const SHINING_MANDATE_DAMAGE_BY_LEVEL = [
      { level: 1,  formula: "1d6"  },
      { level: 3,  formula: "1d8"  },
      { level: 5,  formula: "1d10" },
      { level: 8,  formula: "1d12" },
      { level: 10, formula: "1d20" }
    ];

    const lvl = this._getActorLevel(attackerActor);
    const starting = this._getStartingClassIdentifier(attackerActor);

    const extras = [];
    if (starting === "the-cheat") {
      const formula = this._getChartFormulaForLevel(SNEAK_ATTACK_BY_LEVEL, lvl);
      if (formula) extras.push({ key: "sneak", label: "Sneak Attack", formula, level: lvl });
    }
    if (starting === "oathsworn") {
      const formula = this._getChartFormulaForLevel(JUDGMENT_DICE_BY_LEVEL, lvl);
      if (formula) extras.push({ key: "judgment", label: "Judgment Dice", formula, level: lvl });
    }
    if (this._actorHasItemIdentifier(attackerActor, "shining-mandate-damage")) {
      const formula = this._getChartFormulaForLevel(SHINING_MANDATE_DAMAGE_BY_LEVEL, lvl);
      if (formula) extras.push({ key: "shining", label: "Shining Mandate", formula, level: lvl });
    }


  // Fury Dice (Berserker)
  if (this._getStartingClassIdLower(attackerActor) === "berserker") {
    extras.push({ key: "fury", label: "Fury Dice", type: "fury" });
  }

  return extras;
}

async _postExtraRollCard({ roll, attackerActor, label, formula }) {
    try {
      if (!roll) return;
      // Extra-damage rolls should give visual feedback without adding chat clutter.
      // Prefer Dice So Nice when available; otherwise quietly do nothing here.
      const dsn = game?.dice3d;
      if (dsn?.showForRoll) {
        try {
          await dsn.showForRoll(roll, game.user, true, null, false);
          return;
        } catch {
          try {
            await dsn.showForRoll(roll, game.user, true);
            return;
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  _applyExtrasAndRefreshTargetedInput() {
    // Recompute based on last pulled roll context, armor toggle, and extras.
    this._applyArmorModeToTargetedInput();
  }

  async _openTargetExtrasDialog() {
    const attacker = this._getAttackerActorForExtras();
    const extras = this._getAvailableTargetExtras(attacker);

    const hasFury = extras.some(ex => ex && ex.key === "fury");
    const baseExtras = extras.filter(ex => ex && ex.key !== "fury");

    // sync Fury into preview on open
if (hasFury) {
  try {
    const st0 = await this._getFuryDiceState(attacker);
    const furyTotal0 = this._sumNums(st0.dice);
    this._syncFuryIntoExtras(furyTotal0);

        if (this._furyAppliedToInput == null) this._furyAppliedToInput = furyTotal0;

    // Edge-case helper: if the Targeted damage input is blank, seed it with Fury total
// (matches how other extra rolls can be applied "standalone".)
try {
  const inputEl = document.getElementById("fhp-tgt-hp");
  const cur = String(inputEl?.value ?? "").trim();
  if (inputEl && !cur && furyTotal0 > 0) {
    inputEl.value = String(furyTotal0);
    this._furySeededOnly = true;
    this._furyLastSeeded = furyTotal0;
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
  }
} catch (_e2) {}

    if (typeof this._applyExtrasAndRefreshTargetedInput === "function") this._applyExtrasAndRefreshTargetedInput();
  } catch (_e) {}
}

    if (!baseExtras.length && !hasFury) {
      ui.notifications?.info?.("No extra damage features detected.");
      return;
    }

    // Build dialog content (match the HUD styling; keep the layout simple)
    const rows = baseExtras.map(ex => {
      const current = Number(this._tgtExtras?.[ex.key]?.total ?? 0) || 0;
      const btnLabel = current > 0 ? "Re-roll" : "Roll";
      return `
      <div class="fhp-ex-row" data-key="${ex.key}">
        <div class="fhp-ex-meta">
          <div class="fhp-ex-title">${foundry.utils.escapeHTML(ex.label)}</div>
          <div class="fhp-ex-sub">Roll ${foundry.utils.escapeHTML(ex.formula)} (Lvl ${Number(ex.level) || ""})</div>
          <div class="fhp-ex-sub">Current: ${current || 0}</div>
        </div>
        <div class="fhp-ex-actions">
          <button type="button" class="fhp-ex-roll fhp-ex-roll-btn" data-key="${ex.key}">${btnLabel}</button>
        </div>
      </div>`;
}).join("");

let furySectionHtml = "";
if (hasFury) {
  try { furySectionHtml = await this._renderFurySection(attacker, { includeClose: (!baseExtras.length) }); } catch (_e) { furySectionHtml = ""; }
}

const content = String(`
      <div class="fhp-extras-wrap">
        ${rows}
        ${furySectionHtml}
        ${(!hasFury || baseExtras.length) ? `<div class="fhp-ex-footer">
          <button type="button" class="fhp-ex-close fhp-ex-roll-btn">Close</button>
        </div>` : ``}
      </div>
    `);

    // Persist per-user window position for the extras dialog.
    const persistPos = async () => {
      try {
        const pos = dlg?.position;
        const left = Number(pos?.left);
        const top = Number(pos?.top);
        if (Number.isFinite(left) && Number.isFinite(top)) {
          await game.user.setFlag(MODULE_ID, "extrasDialogPos", { left, top });
        }
      } catch {
        /* ignore */
      }
    };

    const dlg = new Dialog({
      title: "Extra Damage",
      content,
      buttons: {},
      default: "",
      render: (html) => {

// Fury Dice handlers (inline) - isolated from generic extra roll buttons
if (hasFury) {
  const applyFuryToTargetInput = (newTotal) => {
  try {
    const inputEl = document.getElementById("fhp-tgt-hp");
    if (!inputEl) return;

    const curRaw = String(inputEl.value ?? "").trim();
    const newNum = Math.max(0, Number(newTotal) || 0);

    if (curRaw === "") {
      if (newNum > 0) {
        inputEl.value = String(newNum);
        this._furySeededOnly = true;
        this._furyLastSeeded = newNum;
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        inputEl.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }

    if (this._furySeededOnly) {
      inputEl.value = String(newNum);
      this._furyLastSeeded = newNum;
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    }
  } catch (_e) {}
};

const rerender = async () => {
    dlg.close();
    await this._openTargetExtrasDialog();
  };

  html.find('[data-action="fury-roll"]').off("click").on("click", async (ev) => {
    ev.preventDefault();
    try {
      const st = await this._getFuryDiceState(attacker);
      const cap = this._getFuryCap(attacker);
      const dice = Array.isArray(st.dice) ? st.dice.slice() : [];
      const roll = await this._rollFuryDie(st.faces);
      await this._postExtraRollCard({ roll, attackerActor: attacker, label: "Fury Dice", formula: `1d${st.faces}` });

      const value = Number(roll.total) || 0;
      if (cap > 0 && dice.length >= cap) {
        const hasLower = dice.some(v => value > (Number(v) || 0));
        if (!hasLower) {
          ui.notifications?.info?.(`Rolled ${value}. No existing die is lower to replace.`);
          return;
        }
        // At cap: don't mutate the pool yet. Show an inline replace panel in the Fury Dice section.
        this._furyPendingReplace = { actorId: attacker.id, rolledValue: value };
        await rerender();
        return;
      }

      dice.push(value);
      await this._setFuryDiceState(attacker, { active: true, dice });
            this._syncFuryIntoExtras(this._sumNums(dice));
            applyFuryToTargetInput(this._sumNums(dice));
            this._applyExtrasAndRefreshTargetedInput();
      await rerender();
    } catch (e) {
      console.error("Fury roll failed", e);
      ui.notifications?.error?.("Failed to roll Fury Die.");
    }
  });

  html.find('[data-action="fury-end"]').off("click").on("click", async (ev) => {
    ev.preventDefault();
    try {
      if (this._furyPendingReplace?.actorId === attacker.id) this._furyPendingReplace = null;
      await this._setFuryDiceState(attacker, { active: false, dice: [] });
      this._syncFuryIntoExtras(0);
              applyFuryToTargetInput(0);
      this._applyExtrasAndRefreshTargetedInput();
      await rerender();
    } catch (e) {
      console.error("End Rage failed", e);
      ui.notifications?.error?.("Failed to end Rage.");
    }
  });


html.find('[data-action="fury-close"]').off("click").on("click", (ev) => {
  ev.preventDefault();
  try {
    // If we are in pending-replace mode, treat Close as "keep current pool"
    if (this._furyPendingReplace?.actorId === attacker.id) this._furyPendingReplace = null;
    dlg.close();
  } catch (_e) {
    try { dlg.close(); } catch {}
  }
});

  html.find('[data-action="fury-remove"]').off("click").on("click", async (ev) => {
    ev.preventDefault();
    try {
      const idx = Number(ev.currentTarget?.dataset?.i);

// If we are in a pending Roll/Replace choice state, clicking a die's × selects it for replacement.
const pending = (this._furyPendingReplace?.actorId === attacker.id) ? this._furyPendingReplace : null;

const st = await this._getFuryDiceState(attacker);
const dice = Array.isArray(st.dice) ? st.dice.slice() : [];

if (pending) {
  const rolled = Number(pending.rolledValue) || 0;
  if (Number.isFinite(idx) && idx >= 0 && idx < dice.length) {
    const cur = Number(dice[idx]) || 0;
    if (rolled > cur) {
      dice[idx] = rolled;
      await this._setFuryDiceState(attacker, { active: true, dice });
      this._syncFuryIntoExtras(this._sumNums(dice));
      applyFuryToTargetInput(this._sumNums(dice));
      this._applyExtrasAndRefreshTargetedInput();
    }
  }
  this._furyPendingReplace = null;
  await rerender();
  return;
}

// Normal behavior: spend/remove die from the pool
      if (Number.isFinite(idx) && idx >= 0 && idx < dice.length) {
        dice.splice(idx, 1);
        await this._setFuryDiceState(attacker, { active: true, dice });
        this._syncFuryIntoExtras(this._sumNums(dice));
                applyFuryToTargetInput(this._sumNums(dice));
        this._applyExtrasAndRefreshTargetedInput();
        await rerender();
      }
    } catch (e) {
      console.error("Spend die failed", e);
      ui.notifications?.error?.("Failed to spend Fury Die.");
    }

// Inline replace panel (Option A): choose a die to replace or keep the roll.
html.off("click.fhpFuryReplace").on("click.fhpFuryReplace", '[data-action="fury-replace"]', async (ev) => {
  ev.preventDefault();
  try {
    const st = await this._getFuryDiceState(attacker);
    const cap = this._getFuryCap(attacker);
    const dice = Array.isArray(st.dice) ? st.dice.slice() : [];
    const idx = Number(ev.currentTarget?.dataset?.i);
    const rolled = Number(this._furyPendingReplace?.rolledValue) || 0;

    // Proceed only if a pending decision exists.
    if (!this._furyPendingReplace || rolled <= 0) return;

    if (cap > 0 && dice.length >= cap && Number.isFinite(idx) && idx >= 0 && idx < dice.length) {
      const cur = Number(dice[idx]) || 0;
      if (rolled > cur) dice[idx] = rolled;

      await this._setFuryDiceState(attacker, { active: true, dice });
      this._syncFuryIntoExtras(this._sumNums(dice));
      applyFuryToTargetInput(this._sumNums(dice));
      this._applyExtrasAndRefreshTargetedInput();
    }

    this._furyPendingReplace = null;
    await rerender();
  } catch (e) {
    console.error("Fury replace failed", e);
    ui.notifications?.error?.("Failed to replace Fury Die.");
  }
});

html.off("click.fhpFuryKeep").on("click.fhpFuryKeep", '[data-action="fury-keep"]', async (ev) => {
  ev.preventDefault();
  try {
    if (this._furyPendingReplace?.actorId === attacker.id) this._furyPendingReplace = null;
    await rerender();
  } catch (_e) {}


// Direct bindings (in addition to delegated) to ensure compatibility across Foundry/jQuery versions.
html.find('[data-action="fury-replace"]').off("click").on("click", async (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  try {
    const st = await this._getFuryDiceState(attacker);
    const cap = this._getFuryCap(attacker);
    const dice = Array.isArray(st.dice) ? st.dice.slice() : [];
    const idx = Number(ev.currentTarget?.dataset?.i);
    const rolled = Number(this._furyPendingReplace?.rolledValue) || 0;

    if (this._furyPendingReplace?.actorId !== attacker.id || rolled <= 0) return;

    if (cap > 0 && dice.length >= cap && Number.isFinite(idx) && idx >= 0 && idx < dice.length) {
      const cur = Number(dice[idx]) || 0;
      if (rolled > cur) dice[idx] = rolled;

      await this._setFuryDiceState(attacker, { active: true, dice });
      this._syncFuryIntoExtras(this._sumNums(dice));
      applyFuryToTargetInput(this._sumNums(dice));
      this._applyExtrasAndRefreshTargetedInput();
    }

    this._furyPendingReplace = null;
    await rerender();
  } catch (e) {
    console.error("Fury replace failed", e);
    ui.notifications?.error?.("Failed to replace Fury Die.");
  }
});

html.find('[data-action="fury-keep"]').off("click").on("click", async (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  try {
    if (this._furyPendingReplace?.actorId === attacker.id) this._furyPendingReplace = null;
    await rerender();
  } catch (_e) {}
});
});

  });
}

        // Styling handled by CSS classes on the dialog.

        // Drag anywhere in the dialog body (except interactive controls), like the main HUD.
        const $app = html.closest(".app");
        const $content = $app.find(".window-content");
        const isInteractive = (el) => {
          if (!el) return false;
          const tag = (el.tagName || "").toLowerCase();
          if (["button","input","textarea","select","a","label"].includes(tag)) return true;
          // Anything inside a button-like control
          if (el.closest?.("button, input, textarea, select, a, label")) return true;
          return false;
        };

        let dragging = false;
        let startX = 0, startY = 0, startLeft = 0, startTop = 0;

        const onMove = (e) => {
          if (!dragging) return;
          const dx = e.clientX - startX;
          const dy = e.clientY - startY;
          dlg.setPosition({ left: startLeft + dx, top: startTop + dy });
        };

        const stopDrag = () => {
          if (!dragging) return;
          dragging = false;
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", stopDrag);
          persistPos();
        };

        $content.on("mousedown", (e) => {
          if (e.button !== 0) return; // left only
          if (isInteractive(e.target)) return;
          dragging = true;
          startX = e.clientX;
          startY = e.clientY;
          startLeft = dlg.position.left ?? 0;
          startTop = dlg.position.top ?? 0;
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", stopDrag);
        });


        const maybeAutoClose = () => {
          try {
            const allRolled = extras.every(e => (Number(this._tgtExtras?.[e.key]?.total ?? 0) || 0) > 0);
            if (allRolled) {
              persistPos();
              dlg.close();
            }
          } catch {
            /* ignore */
          }
        };

        html.find(".fhp-ex-close").on("click", async (ev) => {
          ev.preventDefault();
          persistPos();
          dlg.close();
        });

        // Bind row actions
        html.find(".fhp-ex-roll").on("click", async (ev) => {
          ev.preventDefault();
          const key = ev.currentTarget?.dataset?.key;
          const ex = extras.find(e => e.key === key);
          if (!ex) return;

          try {
            // If the user rolls an Extra Damage feature without having pulled a base roll
            // into the Targeted textbox, treat the base as 0 so we don't accidentally
            // add to a stale auto-fill cache value.
            if (!this._tgtBaseRoll) {
              this._tgtBaseRoll = { full: 0, diceOnly: 0, isCrit: false };
            }

            const roll = await (new Roll(ex.formula)).evaluate({ async: true });
            // Store as dice component
            this._tgtExtras = this._tgtExtras || {};
            this._tgtExtras[ex.key] = { total: Number(roll.total) || 0, formula: ex.formula, label: ex.label };

            await this._postExtraRollCard({ roll, attackerActor: attacker, label: ex.label, formula: ex.formula });

            this._applyExtrasAndRefreshTargetedInput();

            // Update UI in-place (Current line + button label)
            try {
              const $row = $(ev.currentTarget).closest('.fhp-ex-row');
              const total = Number(roll.total) || 0;
              $row.find('.fhp-ex-sub').last().text(`Current: ${total}`);
              $(ev.currentTarget).text('Re-roll');
            } catch { /* ignore */ }

            // Auto-close only when ALL available extras have been rolled
            maybeAutoClose();
          } catch (e) {
            console.error(e);
            ui.notifications?.error?.("Failed to roll extra damage.");
          }
        });

        // Restore position after first render (best-effort).
        (async () => {
          try {
            const saved = await game.user.getFlag(MODULE_ID, "extrasDialogPos");
            if (saved && (saved.left != null) && (saved.top != null)) {
              dlg.setPosition({ left: saved.left, top: saved.top });
            }
          } catch {
            /* ignore */
          }
        })();
      }
    }, {
      width: (hasFury ? 420 : 260),
      classes: ["floating-hp-tracker", "fhp-extras-dialog"]
    });

    // Persist position on any close path.
    try {
      const _close = dlg.close.bind(dlg);
      dlg.close = (...args) => {
        persistPos();
        return _close(...args);
      };
    } catch { /* ignore */ }

    dlg.render(true);
  }

  async changeHPForTargets(delta = 0, targetPool = null, options = {}) {
    // Targeted block ("Them") apply path.
    // Supports per-target armor math and optional transforms (Resistant/Vulnerable).
    //
    // options:
    // - mode: "normal" | "resistant" | "vulnerable"
    // - kind: "damage" | "healing"
    // - healToFull: boolean (healing only)

    const mode = String(options?.mode ?? "normal");
    const kind = String(options?.kind ?? (Number(delta) > 0 ? "damage" : "healing"));
    const healToFull = !!options?.healToFull;

    // GM should always have targeted functionality regardless of the master player setting.
    if (!game.user.isGM && !setting("allow-player-damage")) return;

    const tokens = this._getTargetedTokens();
    if (!tokens.length) return false;

    // Defend is supported only when exactly one PC is targeted.
    const singlePC = this._getSingleTargetedPC?.();
    const defendCtx = singlePC?.actor ? this._getDefendContextForActor?.(singlePC.actor) : null;
    const defendPotential = (singlePC?.actor && kind === "damage")
      ? (this._getDefendValueForMode?.(defendCtx, this._tgtDefendMode) ?? 0)
      : 0;
    let defendMeta = null;

    // Determine whether the Targeted input was auto-filled from a pulled roll.
    const inputEl = this.element?.querySelector?.("#fhp-tgt-hp");
    const wasAuto = String(inputEl?.dataset?.fhpAutofill ?? "") === "1";

    // Build a deterministic base context for calculations.
    const extraDice = this._getTargetExtraDiceTotal?.() ?? 0;
    const baseRoll = (wasAuto && this._tgtBaseRoll) ? this._tgtBaseRoll : null;

    // Helper to compute per-target armor mode (best effort).
    const getArmorMode = (actor) => {
      const effective = this._getEffectiveArmorModeForActor?.(actor);
      if (effective != null) return Number(effective) || 0;
      const detected = this._detectArmorModeForActor?.(actor);
      if (detected == null) return Number(this._tgtArmorMode ?? 0) || 0; // fallback to current display mode
      return Number(detected) || 0;
    };

    // Compute desired deltas per target.
    const entries = [];
    const undoSteps = [];
    for (const t of tokens) {
      const a = t?.actor;
      const tokenUuid = t?.document?.uuid ?? null;
      const actorUuid = a?.uuid ?? null;
      if (!a || !(a instanceof Actor) || !tokenUuid) continue;
      const undoBefore = _captureUndoSnapshot(a);

      let appliedDelta = 0;
      let armorMode = 0;

      if (healToFull) {
        // Heal to full: set HP to max HP (temp HP unaffected).
        const cur = Number(this.getResourceValue(a, HP_VALUE_PATH) ?? 0) || 0;
        const max = Number(this.getResourceValue(a, HP_MAX_PATH) ?? 0) || 0;
        const d = cur - max; // negative means heal
        if (!Number.isFinite(d) || d === 0) continue; // already full -> silent no-op
        appliedDelta = d;
        armorMode = 0;
      } else if (kind === "healing") {
        const amt = (delta === "" || delta === 0) ? -1 : -Math.abs(Number(delta));
        if (!Number.isFinite(amt) || amt === 0) continue;
        appliedDelta = amt;
        armorMode = 0;
      } else {
        // Damage: compute from base roll context (if present) so Dice-only/Flat are preserved.
        const amt = (delta === "" || delta === 0) ? 1 : Math.abs(Number(delta));
        if (!Number.isFinite(amt) || amt === 0) continue;

        const isCrit = !!(baseRoll?.isCrit);
        const baseFull = baseRoll ? (Number(baseRoll.full ?? 0) || 0) + extraDice : amt;
        const baseDiceOnly = baseRoll ? ((Number(baseRoll.diceOnly ?? 0) || 0) || (Number(baseRoll.full ?? 0) || 0)) + extraDice : amt;

        armorMode = getArmorMode(a);

        // Armor application
        let afterArmor = baseFull;
        if (!isCrit) {
          if (armorMode === 1) afterArmor = baseDiceOnly;
          else if (armorMode === 2) afterArmor = Math.ceil(baseDiceOnly / 2);
          else afterArmor = baseFull;
        }

        // Transforms (mutually exclusive)
        // - Crit bypasses armor.
        // - Resistant always halves after armor/crit (round up).
        // - Vulnerable has no additional effect on crit.
        if (mode === "resistant") {
          appliedDelta = Math.ceil(afterArmor / 2);
        } else if (mode === "vulnerable") {
          if (isCrit) appliedDelta = afterArmor;
          else if (armorMode === 0) appliedDelta = afterArmor * 2;
          else appliedDelta = baseFull; // bypass armor like crit
        } else {
          appliedDelta = afterArmor;
        }

        // Defend (single PC only): flat reduction after all other math.
        if (singlePC?.actor && a?.id === singlePC.actor.id && Number.isFinite(defendPotential) && defendPotential > 0) {
          const pre = Math.max(0, Number(appliedDelta) || 0);
          const reduced = Math.min(pre, Math.max(0, Number(defendPotential) || 0));
          const final = Math.max(0, pre - reduced);
          appliedDelta = final;

          // Build a one-off transparency block for the chat card.
          try {
            const dm = Number(this._tgtDefendMode ?? 0) || 0;
            const hasShield = (Number(defendCtx?.shieldGear ?? 0) || 0) > 0;
            let label = "Defend";
            if (dm === 1) label = hasShield ? "Defend Armor" : "Defend";
            else if (dm === 2) label = "Defend Shield";
            else if (dm === 3) label = "Defend Armor+Shield";
            else label = "Defend: None";

            defendMeta = { full: pre, defended: reduced, final, label, note: "" };
          } catch { /* ignore */ }
        }
      }

      // If Defend reduced the PC's damage to 0, still post a chat card indicating
      // the outcome (but don't apply a no-op delta to the actor).
      if (!Number.isFinite(appliedDelta)) continue;
      if (appliedDelta === 0) {
        if (defendMeta && kind !== "healing" && kind !== "healToFull") {
          entries.push({ token: t, delta: 0, armorMode });
        }
        continue;
      }

      // Route through GM for non-GM users.
      if (!game.user.isGM) {
        await requestApplyHpDelta({
          tokenUuid,
          actorUuid,
          delta: appliedDelta,
          target: targetPool,
          note: "Targeted HP HUD",
          chatCard: false
        });
      } else {
        await this.applyDamage(a, { value: appliedDelta }, targetPool);
      }

      const undoAfter = _captureUndoSnapshot(a);
      if (undoBefore && undoAfter) {
        undoSteps.push({
          actorId: a.id,
          actorUuid,
          tokenUuid,
          before: undoBefore,
          after: undoAfter
      });
}

entries.push({ token: t, delta: appliedDelta, armorMode });
    }

    // Public chat card: post a single aggregated message only if enabled.
    const showVerificationCard = !!game.settings.get(MODULE_ID, "show-damage-verification-card");

    if (showVerificationCard) {
      await _postTargetedChatCard({
        entries,
        armorOverride: this._tgtArmorOverride ? this._tgtArmorOverrideState : "normal",
        transformMode: mode,
        defendMeta,
        undoMeta: {
          undone: false,
          createdBy: game.user?.id ?? null,
          steps: undoSteps
        }
      });
    }

    this.refreshSelected();

    // After applying Targeted damage/healing, clear any pending "extra damage" state
    // and deterministic base roll context to prevent resurrection.
    try { this._resetTargetExtras?.(); } catch { /* ignore */ }
    this._tgtBaseRoll = null;
    this._tgtBaseMsgId = null;

    // Defend defaults to none after an apply.
    try {
      this._tgtDefendMode = 0;
      this._clearDefendManualBaseIfNeeded?.();
      this._setTargetArmorButtonVisual();
    } catch { /* ignore */ }
    try {
      const el = this.element?.querySelector?.("#fhp-tgt-hp");
      if (el) {
        delete el.dataset.fhpAutofill;
        delete el.dataset.fhpAutofillValue;
        delete el.dataset.fhpAutofillMsgId;
      }
    } catch { /* ignore */ }

    try { this._renderTargetedConditions(); } catch { /* ignore */ }
    return entries.length > 0;
  }

  _detectArmorModeForActor(actor) {
    // Nimble canonical armor field:
    // actor.system.attributes.armor is expected to be a string: "unarmored"/"none", "medium", or "heavy".
    try {
      const a = String(actor?.system?.attributes?.armor ?? "").toLowerCase().trim();
      if (!a) return null;
      if (a === "heavy") return 2;
      if (a === "medium") return 1;
      // Nimble typically stores unarmored as "unarmored"; tolerate common variants.
      if (a === "unarmored" || a === "none" || a === "unarm") return 0;
      // If Nimble ever emits other strings, fall back to contains matching.
      if (a.includes("heavy")) return 2;
      if (a.includes("medium")) return 1;
      if (a.includes("unarm") || a.includes("none")) return 0;
    } catch { /* ignore */ }
    return null;
  }

  _clearCalculationsPreserveInput() {
    // Clears all stored roll/armor/condition/extra state without touching the numeric input field.
    try { this._resetTargetExtras?.(); } catch { /* ignore */ }
    this._tgtBaseRoll = null;
    this._tgtBaseMsgId = null;
    // Clear global autofill cache so inspectors don't immediately repopulate from the last roll.
    try { _autoFillClearTs = Date.now(); } catch { /* ignore */ }
    try { _lastChatAutoFill = { ..._lastChatAutoFill, amount: null, full: null, diceOnly: null, armorMode: null, armorMixed: false, isCrit: false, conditions: [], messageId: null, authorId: null, speakerActorId: null, ts: 0 }; } catch { /* ignore */ }

    try { this._tgtArmorMode = 0; this._tgtArmorOverrideState = "normal"; this._setTargetArmorButtonVisual(); } catch { /* ignore */ }
    try { this._renderTargetedConditions(); } catch { /* ignore */ }

    // Also clear the targeted input's autofill markers so a future pull is treated as fresh.
    try {
      const el = this.element?.querySelector?.("#fhp-tgt-hp");
      if (el) {
        delete el.dataset.fhpAutofill;
        delete el.dataset.fhpAutofillValue;
        delete el.dataset.fhpAutofillMsgId;
      }
    } catch { /* ignore */ }
  }


  _resetHudAfterApplySuccess() {
    // After a successful damage/heal application, reset the HUD to a clean slate:
    // - Clear all roll/condition/extra caches
    // - Reset armor mode to Unarmored
    // - Clear BOTH numeric input fields
    // This prevents any lingering state from confusing the next action.
    try { this._clearCalculationsPreserveInput(); } catch { /* ignore */ }

    // Reset armor toggle to Unarmored and clear manual override.
    try { this._tgtArmorOverride = false; } catch { /* ignore */ }
    try { this._tgtArmorOverrideState = "normal"; } catch { /* ignore */ }
    try { this._tgtArmorMode = 0; } catch { /* ignore */ }
    try { this._setTargetArmorButtonVisual(); } catch { /* ignore */ }

    // Clear inputs and autofill markers.
    try { $("#fhp-hp", this.element).val(""); } catch { /* ignore */ }
    try { $("#fhp-tgt-hp", this.element).val(""); } catch { /* ignore */ }
    try {
      const elA = this.element?.querySelector?.("#fhp-hp");
      if (elA) {
        delete elA.dataset.fhpAutofill;
        delete elA.dataset.fhpAutofillValue;
        delete elA.dataset.fhpAutofillMsgId;
      }
      const elB = this.element?.querySelector?.("#fhp-tgt-hp");
      if (elB) {
        delete elB.dataset.fhpAutofill;
        delete elB.dataset.fhpAutofillValue;
        delete elB.dataset.fhpAutofillMsgId;
      }
    } catch { /* ignore */ }

    // Close the Context Inspector if it's open (it may otherwise reopen showing stale values).
    try { _fhpCiDialog?.close?.(); } catch { /* ignore */ }
    _fhpCiDialog = null;
  }

  async _openContextInspector({ section = "targeted" } = {}) {
    const isGM = !!game.user?.isGM;

    // Determine the base roll context (prefer deterministic Targeted context when available; otherwise fall back to auto-fill).
    let baseFull = 0;
    let baseDiceOnly = 0;
    let isCrit = false;
    let msgId = "";
    let conditions = [];
    let cacheSource = "";
    let relayRoute = "";

    const extraDice = this._getTargetExtraDiceTotal?.() ?? 0;

    if (this._tgtBaseRoll) {
      msgId = String(this._tgtBaseRoll.messageId ?? "");
      baseFull = (Number(this._tgtBaseRoll.full ?? 0) || 0) + extraDice;
      baseDiceOnly = (((Number(this._tgtBaseRoll.diceOnly ?? 0) || 0) || (Number(this._tgtBaseRoll.full ?? 0) || 0))) + extraDice;
      isCrit = !!this._tgtBaseRoll.isCrit;
      conditions = Array.isArray(this._tgtBaseRoll.conditions) ? this._tgtBaseRoll.conditions : [];
      cacheSource = "Targeted base roll";
    } else {
      // Best effort: read current autofill info cache (if available)
      try {
        _refreshAutoFillCacheFromChat();
        const info = _getAutoFillInfo();
        msgId = String(info?.messageId ?? "");
        baseFull = Number(info?.full ?? info?.amount ?? 0) || 0;
        baseDiceOnly = Number(info?.diceOnly ?? 0) || 0;
        isCrit = !!info?.isCrit;
        conditions = Array.isArray(info?.conditions) ? info.conditions : [];
        cacheSource = info?.source ? String(info.source) : "Auto-fill cache";
      } catch { /* ignore */ }
    }

    const flat = Math.max(0, (Number(baseFull) || 0) - (Number(baseDiceOnly) || 0));

    // For crit, armor is bypassed (show applied = baseFull across all modes).
    const uDice = Number(baseDiceOnly) || 0;
    const uFlat = flat;
    const uApplied = Number(baseFull) || 0;

    const mDice = Number(baseDiceOnly) || 0;
    const mFlat = 0;
    const mApplied = isCrit ? uApplied : mDice;

    const hDice = Math.ceil((Number(baseDiceOnly) || 0) / 2);
    const hFlat = 0;
    const hApplied = isCrit ? uApplied : hDice;

    const total = Number(baseFull) || 0;

    const condList = (conditions ?? []).map(c => {
      const name = String(c?.name ?? c?.label ?? c?.text ?? "").trim();
      return name ? `<li>${_escape(name)}</li>` : "";
    }).filter(Boolean).join("");

    const condHtml = condList ? `<ul class="fhp-ci-list">${condList}</ul>` : `<div class="fhp-ci-muted">None</div>`;

    const gmExtra = isGM ? `
      <hr class="fhp-ci-hr" />
      <div class="fhp-ci-kv"><span class="fhp-ci-k">messageId</span><span class="fhp-ci-v">${_escape(msgId || "(none)")}</span></div>
      <div class="fhp-ci-kv"><span class="fhp-ci-k">cache</span><span class="fhp-ci-v">${_escape(cacheSource || "(unknown)")}</span></div>
      <div class="fhp-ci-kv"><span class="fhp-ci-k">relay</span><span class="fhp-ci-v">${_escape(relayRoute || "(n/a)")}</span></div>
    ` : "";

    const content = `
      <div class="fhp-ci">
        <div class="fhp-ci-row"><span class="fhp-ci-label">Total</span><span class="fhp-ci-val">${_escape(String(total))}</span></div>
        <div class="fhp-ci-row"><span class="fhp-ci-label">Dice-only</span><span class="fhp-ci-val">${_escape(String(uDice))}</span></div>
        <div class="fhp-ci-row"><span class="fhp-ci-label">Flat</span><span class="fhp-ci-val">${_escape(String(uFlat))}</span></div>
        <div class="fhp-ci-row"><span class="fhp-ci-label">Crit</span><span class="fhp-ci-val">${isCrit ? "Yes" : "No"}</span></div>

        <hr class="fhp-ci-hr" />
        <div class="fhp-ci-title">Armor breakdown${isCrit ? " — Bypassing armor for Crit" : ""}</div>
        <div class="fhp-ci-kv"><span class="fhp-ci-k">Unarmored</span><span class="fhp-ci-v">Dice: ${uDice} | Flat: ${uFlat} | Applied: ${uApplied}</span></div>
        <div class="fhp-ci-kv"><span class="fhp-ci-k">Medium</span><span class="fhp-ci-v">Dice: ${mDice} | Flat: ${mFlat} | Applied: ${mApplied}</span></div>
        <div class="fhp-ci-kv"><span class="fhp-ci-k">Heavy</span><span class="fhp-ci-v">Dice: ${hDice} | Flat: ${hFlat} | Applied: ${hApplied}</span></div>

        <hr class="fhp-ci-hr" />
        <div class="fhp-ci-title">Conditions detected</div>
        ${condHtml}
        ${gmExtra}
      </div>
    `;

    const dlg = new Dialog({
      title: "Context Inspector",
      content,
      buttons: {
        clear: {
          icon: '<i class="fa-solid fa-broom"></i>',
          label: "Clear Calculations",
          callback: () => {
            try { this._clearCalculationsPreserveInput(); } catch { /* ignore */ }
            // Close after clearing.
            try { dlg.close(); } catch { /* ignore */ }
          }
        },
        close: {
          icon: '<i class="fa-solid fa-xmark"></i>',
          label: "Close",
          callback: () => {
            try { if (this._furyPendingReplace?.actorId === attacker?.id) this._furyPendingReplace = null; } catch (_e) {}
          }
        }
      },
      default: "close",
      render: (html) => {
// v2.2.26: Capture-phase router for Fury inline replace buttons.
// This bypasses cases where drag layers or jQuery prevent click handlers firing.
try {
  const appEl = html?.closest?.(".app")?.[0] ?? html?.[0];
  const rootEl = appEl ?? html?.[0];
  if (rootEl && !rootEl.__fhpFuryCaptureRouter) {
    rootEl.__fhpFuryCaptureRouter = true;
    rootEl.addEventListener("click", async (ev) => {
      const btn = ev.target?.closest?.('[data-action="fury-replace"],[data-action="fury-keep"]');
      if (!btn) return;

      const action = btn.dataset?.action;
      if (action !== "fury-replace" && action !== "fury-keep") return;

      if (!this._furyPendingReplace || this._furyPendingReplace.actorId !== attacker?.id) return;

      ev.preventDefault();
      ev.stopPropagation();

      if (action === "fury-keep") {
        this._furyPendingReplace = null;
        await rerender();
        return;
      }

      const st = await this._getFuryDiceState(attacker);
      const cap = this._getFuryCap(attacker);
      const dice = Array.isArray(st.dice) ? st.dice.slice() : [];
      const idx = Number(btn.dataset?.i);
      const rolled = Number(this._furyPendingReplace?.rolledValue) || 0;

      if (cap > 0 && dice.length >= cap && Number.isFinite(idx) && idx >= 0 && idx < dice.length) {
        const cur = Number(dice[idx]) || 0;
        if (rolled > cur) dice[idx] = rolled;

        await this._setFuryDiceState(attacker, { active: true, dice });
        this._syncFuryIntoExtras(this._sumNums(dice));
        applyFuryToTargetInput(this._sumNums(dice));
        this._applyExtrasAndRefreshTargetedInput();
      }

      this._furyPendingReplace = null;
      await rerender();
    }, true);
  }
} catch (_e) {}

        try {
          const appEl = html?.closest?.(".app")?.[0] ?? html?.[0];
          if (appEl) appEl.classList.add("fhp-ci-dialog");
        } catch { /* ignore */ }
      }
    }, { classes: ["fhp-ci-dialog"] });

    // Track this dialog so we can close it when the HUD resets.
    try {
      _fhpCiDialog = dlg;
      const _close = dlg.close.bind(dlg);
      dlg.close = (...args) => {
        try { _fhpCiDialog = null; } catch { /* ignore */ }
        return _close(...args);
      };
    } catch { /* ignore */ }

    dlg.render(true);
  }





  async applyDamage(actor, value, target) {
    // Wounds/Dying logic needs to know whether the actor was already dying
    // before this change, and whether this change was damage.
    const isPC = !!(actor?.hasPlayerOwner || actor?.type === "character" || actor?.type === "pc");
    const preDying = isPC ? this._hasStatusEffectBestEffort(actor, "dying") : false;

    const updates = {};
    const resourceValue = this.getResourceValue(actor, HP_VALUE_PATH);
    const tempValue = this.getResourceValue(actor, HP_TEMP_PATH);
    const maxValue = this.getResourceValue(actor, HP_MAX_PATH);
    const tempMaxValue = this.getResourceValue(actor, HP_TEMPMAX_PATH);

    // Support both "number" and {value:number} shapes, handling either shape
    const delta = (typeof value === "object" && value !== null) ? (value.value ?? 0) : value;

    if (tempMaxValue && target === "max") {
      updates[`system.${HP_TEMPMAX_PATH}`] = tempMaxValue - delta;
    } else {
      let dt = 0;
      let tmpMax = tempMaxValue;

      if (tempValue || target === "temp") {
        dt = ((delta > 0 || target === "temp") && target !== "regular" && target !== "max")
          ? Math.min(tempValue, delta)
          : 0;
        updates[`system.${HP_TEMP_PATH}`] = tempValue - dt;
      }

      if (target !== "temp" && target !== "max" && dt >= 0) {
        const change = (delta - dt);
        const min = 0;
        const max = maxValue + tmpMax;
        const dh = Math.clamp(resourceValue - change, min, max);
        updates[`system.${HP_VALUE_PATH}`] = dh;
      }
    }
    const _res = await actor.update(updates);

    try {
      await this._applyDeadDyingStatusForActor(actor, { isPC, preDying, delta });
    } catch (e) {
      console.error("[nimble-hp-and-damage] dead/dying status error:", e);
    }
    return _res;
  }


  async _applyDeadDyingStatusForActor(actor, ctx = {}) {
    try {
      if (!setting("add-defeated")) return;
      if (!actor || !(actor instanceof Actor)) return;

      const hp = this.getResourceValue(actor, HP_VALUE_PATH);
      const isPC = (typeof ctx?.isPC === "boolean")
        ? ctx.isPC
        : !!(actor.hasPlayerOwner || actor.type === "character" || actor.type === "pc");

      const preDying = !!ctx?.preDying;
      const delta = Number(ctx?.delta ?? 0);

      if (hp <= 0) {
        if (isPC) {
          // Apply dying and add wounds.
          // - When dying is first applied, add 1 wound.
          // - When already dying and additional damage is applied, add 1 wound.
          const alreadyDying = this._hasStatusEffectBestEffort(actor, "dying");
          await this._toggleStatusEffectBestEffort(actor, "dying", true);

          // First time dropping to 0 (not previously dying)
          if (!preDying && !alreadyDying) {
            await this._incrementWoundsBestEffort(actor, 1);
          }

          // Additional damage while dying
          if (preDying && delta > 0) {
            await this._incrementWoundsBestEffort(actor, 1);
          }
        } else {
          await this._toggleStatusEffectBestEffort(actor, "dead", true);
        }
      } else {
        if (isPC) {
          // If a PC is brought above 0 HP by any means, clear dying immediately.
          await this._toggleStatusEffectBestEffort(actor, "dying", false);
        }
      }
    } catch (err) {
      console.error("[nimble-hp-and-damage] _applyDeadDyingStatusForActor failed:", err);
    }
  }

  _resolveStatusEffectIdBestEffort(effectIdOrName) {
    const key = String(effectIdOrName ?? "").toLowerCase().trim();
    if (!key) return null;

    let status = (CONFIG.statusEffects ?? []).find(e => (String(e?.id ?? "")).toLowerCase() === key);
    if (!status) {
      status = (CONFIG.statusEffects ?? []).find(e => {
        const n = String(e?.name ?? e?.label ?? "").toLowerCase().trim();
        return n === key;
      });
    }
    return status?.id ?? effectIdOrName;
  }

  _hasStatusEffectBestEffort(actor, effectIdOrName) {
    const eff = this._resolveStatusEffectIdBestEffort(effectIdOrName);
    if (!eff) return false;
    return actor?.statuses?.has?.(eff) ?? false;
  }

  async _incrementWoundsBestEffort(actor, amount = 1) {
    try {
      const amt = Number(amount ?? 0);
      if (!actor || !Number.isFinite(amt) || amt === 0) return;

      const path = "system.attributes.wounds.value";
      const current = foundry.utils.getProperty(actor, path);
      if (current === undefined || current === null || Number.isNaN(Number(current))) return;
      const next = Math.max(0, Number(current) + amt);
      await actor.update({ [path]: next });
    } catch (e) {
      console.error("[nimble-hp-and-damage] Failed to increment wounds:", e);
    }
  }

  async _toggleStatusEffectBestEffort(actor, effectIdOrName, active) {
    if (!actor?.toggleStatusEffect) return;
    const key = String(effectIdOrName ?? "").toLowerCase().trim();
    if (!key) return;

    // Try exact id match first
    let status = (CONFIG.statusEffects ?? []).find(e => (String(e?.id ?? "")).toLowerCase() === key);
    // Then try label/name matches
    if (!status) {
      status = (CONFIG.statusEffects ?? []).find(e => {
        const n = String(e?.name ?? e?.label ?? "").toLowerCase().trim();
        return n === key;
      });
    }

    const effect = status?.id ?? effectIdOrName;
    const exists = actor.statuses?.has?.(effect) ?? false;
    if (active && exists) return;
    if (!active && !exists) return;

    await actor.toggleStatusEffect(effect, { active: !!active });
  }

  refreshSelected() {
    this.valuePct = null;
    this.tempPct = null;
    this.tokenstat = "";
    this.tokentemp = "";
    this.tokentooltip = "";
    this.tokennametitle = "";

    const controlled = this._getEffectiveTokens();
    if (controlled.length === 0) {
      this.tokenname = "";
    } else if (controlled.length === 1) {
      const a = controlled[0].actor;
      if (!a) {
        this.tokenname = "";
      } else {
        let resourceValue = this.getResourceValue(a, HP_VALUE_PATH);
        const maxValue = this.getResourceValue(a, HP_MAX_PATH);
        const tempValue = this.getResourceValue(a, HP_TEMP_PATH);
        const tempMaxValue = this.getResourceValue(a, HP_TEMPMAX_PATH);

        const effectiveMax = Math.max(0, maxValue + tempMaxValue);
        const displayMax = maxValue + (tempMaxValue > 0 ? tempMaxValue : 0);

        const tempPct = displayMax ? (Math.clamp(tempValue, 0, displayMax) / displayMax) : 0;
        const valuePct = displayMax ? (Math.clamp(resourceValue, 0, effectiveMax) / displayMax) : 0;

        this.valuePct = valuePct;
        this.tempPct = tempPct;

        // Match Nimble sheet behavior: stay green above 50%, red at or below 50%.
        const isAboveHalf = this.valuePct > 0.5;
        const color = isAboveHalf ? [0, 1, 0] : [1, 0, 0];
// Darken the computed bar color so the white HP number remains readable.
const r = Math.round(color[0] * 255);
const g = Math.round(color[1] * 255);
const b = Math.round(color[2] * 255);
// Multiply RGB by a factor to darken; keep alpha high for consistency with translucent surface.
const darken = 0.55;
this.color = `rgba(${Math.round(r * darken)},${Math.round(g * darken)},${Math.round(b * darken)}, 1)`;

        this.tokenname = controlled[0]?.name ?? controlled[0]?.data?.name ?? "";
        this.tokenstat = resourceValue;
        this.tokentemp = tempValue;
        this.tokentooltip = `HP: ${resourceValue}, Temp: ${tempValue}, Max: ${maxValue}`;
      }
    } else {
      // Multiple controlled tokens
      // - Players: keep legacy behavior (simple count)
      // - GM: show a truncated list like the Targeted header (with full list on hover)
      if (game.user?.isGM) {
        const info = this._getControlledHeaderInfo(controlled);
        this.tokenname = `Selected (${info.total}): ${info.display}`;
        this.tokennametitle = `Selected (${info.total}): ${info.full}`;
      } else {
        this.tokenname = `${"Tokens selected:"} <span class="fhp-count">${controlled.length}</span>`;
      }
    }

    this.changeToken();
  }

  changeToken() {
    if (!this.element) return;

    // Expose the computed "healthy" accent color on the root so other UI elements
    // (like the Targeted header in "only PCs targeted" mode) can match the same
    // green used by the HP pill/bar for visual consistency.
    try {
      if (this.color) this.element.style.setProperty("--fhp-health-accent", this.color);
      // Also expose the "full health" accent as a static reference (used for Targeted-only-PCs header).
      // This should remain constant (full health), not track the current HP gradient.
      this.element.style.setProperty("--fhp-health-full", "rgba(70,140,0, 1)");
    } catch { /* ignore */ }

    const tokens = this._getEffectiveTokens();

    // Flag selection state (used for compact layout tweaks).
    const hasAny = (tokens.length > 0);
    const hasSingle = (tokens.length === 1);
    this.element.toggleClass?.("fhp-has-any", hasAny);
    this.element.toggleClass?.("fhp-has-single", hasSingle);

    $(".fhp-character-name", this.element).html(this.tokenname);
    // Add hover title for the GM multi-select display.
    if (this.tokennametitle) {
      $(".fhp-character-name", this.element).attr("title", this.tokennametitle);
    } else {
      $(".fhp-character-name", this.element).removeAttr("title");
    }
    $(".fhp-token-stats", this.element)
      .attr("title", this.tokentooltip)
      .html((this.tokentemp ? `<div class="fhp-stat fhp-temp">${this.tokentemp}</div>` : "")
        + (this.tokenstat !== "" ? `<div class="fhp-stat" style="--fhp-hpbg:${this.color}">${this.tokenstat}</div>` : ""));

    const actor = (tokens.length === 1 ? tokens[0].actor : null);
    const data = actor?.system;

    // Hide the top section entirely when nothing is selected (keeps controls centered).
    const showTop = (tokens.length > 0);
    $(".fhp-top", this.element).toggle(showTop);

    $(".fhp-resource", this.element).toggle(tokens.length === 1 && this.valuePct !== null);
    if (this.valuePct !== null) {
      $(".fhp-resource .fhp-bar", this.element).css({ width: (this.valuePct * 100) + "%", backgroundColor: this.color });
      $(".fhp-resource .fhp-temp-bar", this.element).toggle((this.tempPct ?? 0) > 0).css({ width: ((this.tempPct ?? 0) * 100) + "%" });
    }

    // Targeted section (auto-expand when targets exist AND feature is enabled)
    // Targeted section visibility:
    // - GM: always show when targets exist
    // - Players: only show when the master setting is enabled
    const allowTargets = game.user.isGM || setting("allow-player-damage");
    const tgtInfo = this._getTargetHeaderInfo();
    const showTargets = allowTargets && tgtInfo.total > 0;

    // If we are currently in "open up" mode (Targeted block above) and targets disappear,
    // we must re-anchor the HUD to its bottom edge while shrinking back down.
    const wasUpBefore = !!this.element?.classList?.contains?.("fhp-open-up");
    const bottomBeforeHide = wasUpBefore && this.element?.getBoundingClientRect
      ? this.element.getBoundingClientRect().bottom
      : null;

    const $tgt = $(".fhp-targeted", this.element);
    $tgt.toggle(showTargets);
    try { this._renderTargetedConditions(); } catch { /* ignore */ }

    if (showTargets) {
      const title = `Targeted (${tgtInfo.total}): ${tgtInfo.display}`;
      $(".fhp-targeted-title", this.element).text(title);
      $(".fhp-targeted-header", this.element).attr("title", tgtInfo.full || title);

      // Mixed PC+NPC => warning icon
      $(".fhp-targeted-warning", this.element).toggle(tgtInfo.mixed);

      // Mixed indicator class (used for red warning icon positioning/color)
      try { this.element?.classList?.toggle("fhp-targeted-mixed", !!tgtInfo.mixed); } catch { /* ignore */ }

      // Only PCs targeted => green accent (likely healing)
      try { this.element?.classList?.toggle("fhp-targeted-onlypcs", !!tgtInfo.onlyPCs); } catch { /* ignore */ }

      // If the HUD is parked near the bottom edge, open the Targeted block upward.
      this._adjustTargetedOpenDirection();

      // Sync the armor toggle to the targeted actors (when they all share the same mode)
      // unless the user has explicitly overridden it.
      this._autoSetArmorModeFromTargets();

      // Defend is single-target PC only. If targeting no longer matches, reset to No Defend.
      if (!this._getSingleTargetedPC?.()) {
        this._tgtDefendMode = 0;
        this._clearDefendManualBaseIfNeeded?.();
      }

      // Ensure the armor toggle visual matches current mode.
      this._setTargetArmorButtonVisual();
    } else {
      try { this.element?.classList?.toggle("fhp-targeted-onlypcs", false); } catch { /* ignore */ }
      try { this.element?.classList?.toggle("fhp-targeted-mixed", false); } catch { /* ignore */ }
      try { this.element?.classList?.toggle("fhp-open-up", false); } catch { /* ignore */ }

      // If we were previously "open up", keep the HUD bottom anchored as the Targeted block collapses.
      if (wasUpBefore && bottomBeforeHide !== null) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            try {
              if (!this.element) return;
              const rectAfter = this.element.getBoundingClientRect();
              const desiredTop = bottomBeforeHide - rectAfter.height;
              const maxTop = Math.max(0, window.innerHeight - rectAfter.height);
              const clampedTop = Math.max(0, Math.min(maxTop, desiredTop));
              this.element.style.top = `${clampedTop}px`;
              if (this.position) this.position.top = clampedTop;
            } catch { /* ignore */ }
          });
        });
      }
    }

    // Phase 2: We capture the latest roll value from chat, but we do not auto-push into fields.
    // Users explicitly pull the latest value via right-click on the input box.
  }

  _maybeAutofillFromChat() {
    try {
      if (!this.element) return;
      const info = _getAutoFillInfo();
      if (!info) return;
      const amt = info.amount;
      const msgId = String(info.messageId ?? "");
      if (amt == null || !msgId) return;

      const tgtEl = this.element.querySelector?.("#fhp-tgt-hp");
      const ctrlEl = this.element.querySelector?.("#fhp-hp");
      const tgtVisible = !!(tgtEl && this.element.querySelector?.(".fhp-targeted") && (window.getComputedStyle(this.element.querySelector(".fhp-targeted")).display !== "none"));

      let inputEl = null;
      if (tgtVisible) inputEl = tgtEl;
      else if (game.user?.isGM) inputEl = ctrlEl;
      else return;

      if (!inputEl) return;

      const current = String(inputEl.value ?? "").trim();
      const wasAuto = (inputEl.dataset?.fhpAutofill === "1");
      const lastAutoVal = String(inputEl.dataset?.fhpAutofillValue ?? "");
      const lastMsgId = String(inputEl.dataset?.fhpAutofillMsgId ?? "");
      const nextVal = String(amt);

      // Only push on a *new* roll message (or if the field is empty and has never been auto-filled).
      const isNewRollForField = (msgId && msgId !== lastMsgId);
      const isEmptyAndNeverAuto = (current === "" && !wasAuto);
      if (!isNewRollForField && !isEmptyAndNeverAuto) return;

      // Only set if empty OR previously auto-filled.
      // If previously auto-filled with a different value, update it.
      if (current === "" || wasAuto) {
        if (current !== nextVal || lastAutoVal !== nextVal) {
          inputEl.value = nextVal;
          inputEl.dataset.fhpAutofill = "1";
          inputEl.dataset.fhpAutofillValue = nextVal;
          inputEl.dataset.fhpAutofillMsgId = msgId;
        }
      }
    } catch {
      /* ignore */
    }
  }

  _pullLatestChatRollIntoInput(selector) {
    try {
      _refreshAutoFillCacheFromChat();
      const info = _getAutoFillInfo();
      if (!info?.amount) {
        ui.notifications?.warn?.("No recent roll found.");
        return;
      }

      const el = this.element?.querySelector?.(selector);
      if (!el) return;

      // For Targeted input, apply the current armor toggle (unless crit / only-PC targets).
      let nextVal = Number(info.amount);
      if (selector === "#fhp-tgt-hp") {
        // If this is a new source roll, reset any extra-damage components.
        const newMsgId = String(info.messageId ?? "");
        if (newMsgId && newMsgId !== String(this._tgtBaseMsgId ?? "")) {
          this._tgtBaseMsgId = newMsgId;
          this._resetTargetExtras?.();
        }

        // Prefer syncing armor mode from the *currently targeted* actors.
        // This keeps the HUD consistent even when the chat card doesn't expose armor hints.
        this._autoSetArmorModeFromTargets();
        this._setTargetArmorButtonVisual();

        // Persist the pulled base roll context so armor toggles and extras can
        // recompute deterministically even after other rolls (e.g. extra dice)
        // are posted to chat.
        this._tgtBaseRoll = {
          messageId: String(info.messageId ?? ""),
          full: Number(info.full ?? info.amount ?? 0) || 0,
          diceOnly: Number(info.diceOnly ?? 0) || 0,
          isCrit: !!info.isCrit,
          conditions: Array.isArray(info.conditions) ? info.conditions : []
        };
        try { this._renderTargetedConditions(); } catch { /* ignore */ }
        const computed = this._computeTargetedValueFromLastRoll();
        if (computed != null && Number.isFinite(computed)) nextVal = Number(computed);
      }

      el.value = String(nextVal);
      try {
        // Mark as roll-derived so armor toggles can reliably recompute.
        el.dataset.fhpAutofill = "1";
        el.dataset.fhpAutofillValue = String(nextVal);
        el.dataset.fhpAutofillMsgId = String(info.messageId ?? "");
      } catch { /* ignore */ }
    } catch { /* ignore */ }
  }

  _adjustTargetedOpenDirection() {
    try {
      if (!this.element) return;
      const tgt = this.element.querySelector?.(".fhp-targeted");
      if (!tgt) return;

      // Only evaluate when the Targeted block is visible.
      const style = window.getComputedStyle(tgt);
      if (style?.display === "none") return;

      const wasUp = this.element.classList.contains("fhp-open-up");
      const rectBefore = this.element.getBoundingClientRect();
      const bottomBefore = rectBefore.bottom;
      const tgtH = tgt.scrollHeight ?? tgt.getBoundingClientRect().height ?? 0;

      // If there isn't enough room below, flip it above the main controls.
      const padding = 8;
      const needsUp = (rectBefore.bottom + tgtH + padding) > window.innerHeight;
      this.element.classList.toggle("fhp-open-up", needsUp);

      // When toggling open-direction (either opening upward OR collapsing back down),
      // anchor the HUD's bottom edge so it stays aligned with the screen edge.
      if (needsUp || (wasUp && !needsUp)) {
        // Defer until layout reflects the class toggle.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            try {
              if (!this.element) return;
              const rectAfter = this.element.getBoundingClientRect();
              const desiredTop = bottomBefore - rectAfter.height;
              const maxTop = Math.max(0, window.innerHeight - rectAfter.height);
              const clampedTop = Math.max(0, Math.min(maxTop, desiredTop));

              // Apply to the element and to the app position so Foundry persists it.
              this.element.style.top = `${clampedTop}px`;
              if (this.position) this.position.top = clampedTop;
            } catch { /* ignore */ }
          });
        });
      }
    } catch { /* ignore */ }
  }

  get parseValue() {
    const raw = String($("#fhp-hp", this.element).val() ?? "");
    const result = { value: raw, target: null };

    if (/[rR]/.test(result.value)) { result.target = "regular"; result.value = result.value.replace(/[rR]/g, ""); }
    if (/[tT]/.test(result.value)) { result.target = "temp"; result.value = result.value.replace(/[tT]/g, ""); }
    if (/[mM]/.test(result.value)) { result.target = "max"; result.value = result.value.replace(/[mM]/g, ""); }

    const n = parseInt(result.value);
    result.value = isNaN(n) ? 1 : n;
    return result;
  }

  clearInput() {
    $("#fhp-hp", this.element).val("");
  }

onPersistPosition(position) {
    game.user.setFlag("nimble-hp-and-damage", "fhpPos", { left: position.left, top: position.top });
  }

  static canLoad() {
    return true;
  }

// ---------------- Fury Dice (Berserker) ----------------
_getStartingClassIdLower(actor) {
  try {
    const raw = foundry.utils.getProperty(actor, "system.classData.startingClass");
    return String(raw || "").trim().toLowerCase();
  } catch (_e) { return ""; }
}

_getActorLevelSafe(actor) {
  const lvlA = foundry.utils.getProperty(actor, "system.classData.levels.length");
  if (Number.isFinite(lvlA) && lvlA > 0) return Number(lvlA);
  const lvlB = foundry.utils.getProperty(actor, "system.details.level");
  if (Number.isFinite(lvlB) && lvlB > 0) return Number(lvlB);
  const lvlC = foundry.utils.getProperty(actor, "system.level");
  if (Number.isFinite(lvlC) && lvlC > 0) return Number(lvlC);
  return 1;
}

_getFuryDieFacesForLevel(level) {
  const lvl = Math.max(1, Number(level) || 1);
  if (lvl >= 17) return 12;
  if (lvl >= 13) return 10;
  if (lvl >= 9) return 8;
  if (lvl >= 6) return 6;
  return 4;
}

_getFuryCap(actor) {
  const str = Number(foundry.utils.getProperty(actor, "system.abilities.strength.mod")) || 0;
  const dex = Number(foundry.utils.getProperty(actor, "system.abilities.dexterity.mod")) || 0;
  return Math.max(str, dex, 0);
}

async _getFuryDiceState(actor) {
  const flags = await actor?.getFlag?.("nimble-hp-and-damage", "furyDice");
  const dice = Array.isArray(flags?.dice) ? flags.dice.map(n => Number(n)).filter(n => Number.isFinite(n) && n > 0) : [];
  const active = Boolean(flags?.active);
  const faces = this._getFuryDieFacesForLevel(this._getActorLevelSafe(actor));
  return { active, faces, dice };
}

async _setFuryDiceState(actor, state) {
  const clean = {
    active: Boolean(state?.active),
    dice: Array.isArray(state?.dice) ? state.dice.map(n => Number(n)).filter(n => Number.isFinite(n) && n > 0) : []
  };
  await actor.setFlag("nimble-hp-and-damage", "furyDice", clean);
}

_sumNums(nums) { return (Array.isArray(nums) ? nums : []).reduce((a,b)=>a+(Number(b)||0), 0); }

async _rollFuryDie(faces) {
  const roll = new Roll(`1d${faces}`);
  await roll.evaluate({ async: true });
  return roll;
}

_syncFuryIntoExtras(total) {
  const t = Math.max(0, Number(total) || 0);
  if (!this._tgtExtras) this._tgtExtras = {};
  if (t <= 0) { delete this._tgtExtras.fury; return; }
  this._tgtExtras.fury = { total: t, label: "Fury Dice", formula: "Fury Dice" };
}

async _renderFurySection(attackerActor, { includeClose=false } = {}) {
            const furyLevel = this._getActorLevel(attackerActor);
  const st = await this._getFuryDiceState(attackerActor);
  const cap = this._getFuryCap(attackerActor);
  const total = this._sumNums(st.dice);
  const atCap = (cap > 0) && (st.dice.length >= cap);
  const rollLabel = atCap ? "Roll/Replace" : "Roll";
  const pending = (this._furyPendingReplace?.actorId === attackerActor.id) ? this._furyPendingReplace : null;

  const diceHtml = st.dice.length
    ? st.dice.map((v,i)=>`
      <div class="fhp-fury-die">
        <div class="fhp-fury-die-num">${v}</div>
        <button type="button" class="fhp-fury-die-x" data-action="fury-remove" data-i="${i}" title="${pending ? `Replace this die` : `Spend die`}">×</button>
      </div>`).join("")
    : `<div class="fhp-ex-sub">No Fury Dice yet.</div>`;

  return `
    <div class="fhp-fury-section">
      <div class="fhp-fury-top">
        <div class="fhp-fury-meta">
          <div class="fhp-ex-title">Fury Dice</div>
          <div class="fhp-ex-sub">
            Die: 1d${st.faces} (Lvl ${furyLevel}) &nbsp;|&nbsp; Cap: ${cap} &nbsp;|&nbsp;
            <span class="fhp-fury-current">Current: ${total}</span>
          </div>
        </div>
      </div>

      <div class="fhp-fury-pool">
        <div class="fhp-fury-dice">${diceHtml}</div>
      </div>

      

      ${pending ? `<div class="fhp-fury-pendingline">Rolled ${Number(pending.rolledValue)||0}: choose a die to replace or Close to keep current pool.</div>` : ""}

<div class="fhp-fury-actions">
<button type="button" class="fhp-ex-roll-btn" data-action="fury-roll" ${pending ? "disabled" : ""}>${rollLabel}</button>
        <button type="button" class="fhp-ex-roll-btn" data-action="fury-end">End Rage</button>
        ${includeClose ? `<button type="button" class="fhp-ex-roll-btn fhp-ex-close-inline" data-action="fury-close">Close</button>` : ``}
      </div>
    </div>
  `;
}

async _openReplaceDieDialog({ dice, rolledValue, onDone }) {
  const choices = dice.map((v,i)=>({v,i}));
  const btns = {};
  for (const c of choices) {
    btns[`r${c.i}`] = { label: `Replace ${c.v}`, callback: async () => { if (rolledValue > c.v) dice[c.i] = rolledValue; } };
  }
  btns.none = { label: "No Replacement", callback: () => {} };

  const dlg = new Dialog({
      title: `Replace Die (Rolled ${rolledValue})`,
      content: "",
      buttons: btns,
    default: "none",
    close: async () => { try { await onDone(); } catch (_e) {} }
  }, {
    width: 300,
      resizable: false,
      classes: ["floating-hp-tracker","fhp-fury-replace-dialog"]
  });

  dlg.render(true);

  setTimeout(() => {
    try { applyReplaceDieInlineTheme(dlg.element?.[0]); } catch (_e) {}

    try {
      const el = dlg.element;
      for (const c of choices) {
        if (rolledValue <= c.v) el.find(`button[data-button="r${c.i}"]`).prop("disabled", true);
      }
    } catch (_e) {}
  }, 0);
}


}

Hooks.on("init", () => {
  registerSettings();

  // --- Chat header override for Targeted HUD cards ---
  // Foundry's message header (sender line) is based on message.author, not speaker.alias.
  // For our Targeted HUD result cards, we want the header to show:
  // - Players: "User (Character)"
  // - GM: controlled token(s) when any are controlled
  // We store that label in flags and swap the visible header text at render time.
  Hooks.on("renderChatMessage", (message, html) => {
  try {
    const f = message?.flags?.[MODULE_ID];
    if (f?.kind !== "targeted-hud-card" && f?.kind !== "extra-roll-card") return;
    const label = (f?.headerLabel ?? "").toString().trim();
    if (!label) return;

    const root = html?.[0];
    if (!root) return;

    const undoMeta = f?.undoMeta;
    const btn = root.querySelector('[data-action="undo-targeted-hud-card"]');

    if (btn && f?.kind === "targeted-hud-card" && undoMeta) {
      const allowPlayer = game.settings.get(MODULE_ID, "allow-player-damage");
      const isGM = game.user?.isGM;
      const isOwner = undoMeta?.createdBy === game.user?.id;

      const canUndo = isGM || (allowPlayer && isOwner);

      if (!canUndo) {
        btn.disabled = true;
        btn.title = "You cannot undo this.";
      } else if (undoMeta?.undone) {
        btn.disabled = true;
        btn.title = "Already undone.";
        btn.innerHTML = `<i class="fa-solid fa-check"></i> Undone`;
      } else {
        btn.addEventListener("click", async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();

          btn.disabled = true;

          try {
            const steps = Array.isArray(undoMeta.steps)
              ? undoMeta.steps.slice().reverse()
              : [];

            if (!game.user.isGM) {
              await requestUndoRestore({ steps });
            } else {
              for (const step of steps) {
               await _restoreUndoSnapshot(step.before);
              }
            }

            await message.setFlag(MODULE_ID, "undoMeta", {
              ...undoMeta,
              undone: true
            });

            btn.disabled = true;
            btn.title = "Already undone.";
            btn.innerHTML = `<i class="fa-solid fa-check"></i> Undone`;

            game.FloatingHP?.refresh?.();
          } catch (err) {
            console.error("Undo failed:", err);
            btn.disabled = false;
          }
        });
      }
    }

    const el = root.querySelector(".message-header .message-sender")
      || root.querySelector("header .message-sender")
      || root.querySelector(".message-sender");
    if (el) el.textContent = label;
  } catch {
    /* ignore */
  }
});

  // Track the most recent *rendered* roll totals so we can prefill the HUD.
  // Important differences vs naive createChatMessage:
  // - We only consider rolls authored by *this* user.
  // - We compute from rendered chat DOM (same trick as the Apply Damage macro),
  //   because message.content often doesn't include the visible formula/total.
  Hooks.on("renderChatMessage", (message, html) => {
    try {
      if (!message?.rolls?.length) return;
      if (_getMessageAuthorId(message) !== game.user?.id) return;

      const computed = _computeAutoFillFromRollMessage(message);
      if (!computed) return;

      // Only advance on a new message (or newer timestamp).
      const isNew = (computed.messageId && computed.messageId !== _lastChatAutoFill?.messageId)
        || (computed.ts && computed.ts > (_lastChatAutoFill?.ts ?? 0));
      if (!isNew) return;

      _lastChatAutoFill = computed;
      // We intentionally do not auto-fill fields; this cache is pulled on demand (right-click).
    } catch { /* ignore */ }
  });

  // Install the relay plumbing unconditionally so we never miss SocketLib readiness events
  // and so the GM listener is always present after reloads.
  // The master feature gate is enforced inside the relay handler itself, so when
  // "Allow players to apply damage directly" is OFF, relayed updates are ignored.
  initHPDamageRelay();

  // --- STYLE HOOK: Ensure Replace Die dialog styling is applied (some themes override CSS) ---
if (!game.__nimbleHpDamageReplaceHookInstalled) {
  game.__nimbleHpDamageReplaceHookInstalled = true;
  Hooks.on("renderDialog", (app, html) => {
    try {
      const classes = app?.options?.classes || [];
      if (!classes.includes("fhp-fury-replace-dialog")) return;
      const el = html?.[0] || html;
      if (!el) return;

      // Apply inline surface + text styling
      el.style.background = "var(--nimble-sheet-background, rgba(18, 18, 26, 0.88))";
      el.style.border = "1px solid rgba(231, 209, 177, 0.35)";
      el.style.borderRadius = "14px";
      el.style.boxShadow = "0 10px 30px rgba(0,0,0,0.35)";
      el.style.overflow = "hidden";

      const header = el.querySelector(".window-header");
      if (header) {
        header.style.background = "transparent";
        header.style.borderBottom = "none";
      }

      const title = el.querySelector(".window-title");
      if (title) {
        title.style.color = "var(--nimble-dark-text-color, #E7D1B1)";
        title.style.fontFamily = '"Roboto Condensed", var(--font-primary, sans-serif)';
        title.style.fontWeight = "800";
      }

      for (const hb of el.querySelectorAll(".header-button")) {
        hb.style.color = "var(--nimble-dark-text-color, #E7D1B1)";
      }

      const content = el.querySelector(".window-content");
      if (content) {
        content.style.background = "transparent";
        content.style.color = "var(--nimble-dark-text-color, #E7D1B1)";
        content.style.fontFamily = '"Roboto Condensed", var(--font-primary, sans-serif)';
      }

      for (const btn of el.querySelectorAll(".dialog-buttons button")) {
        btn.style.width = "100%";
        btn.style.border = "1px solid rgba(231, 209, 177, 0.35)";
        btn.style.background = "rgba(0, 0, 0, 0.16)";
        btn.style.color = "var(--nimble-dark-text-color, #E7D1B1)";
        btn.style.borderRadius = "10px";
        btn.style.padding = "7px 10px";
        btn.style.fontWeight = "750";
        btn.style.fontFamily = '"Roboto Condensed", var(--font-primary, sans-serif)';
        btn.style.outline = "none";
        btn.style.boxShadow = "none";
      }
    } catch (_e) {}
  });
}

/* ------------------------------------------------------------
 * Replace Die Dialog: hard inline styling on render (v13-safe)
 * ------------------------------------------------------------ */
if (!game.__nimbleHpDamageReplaceStyleHook) {
  game.__nimbleHpDamageReplaceStyleHook = true;

  const applyReplaceStyle = (app, html) => {
    try {
      const classes = app?.options?.classes || [];
      if (!classes.includes("fhp-fury-replace-dialog")) return;

      const el = html?.[0] || html;
      if (!el || !el.querySelector) return;

      // Root surface
      el.style.background = "var(--nimble-input-background-color, rgba(18, 18, 26, 0.92))";
      el.style.border = "1px solid var(--nimble-input-border-color)";
      el.style.borderRadius = "14px";
      el.style.boxShadow = "0 10px 30px rgba(0,0,0,0.35)";
      el.style.overflow = "hidden";

      // Header + content surfaces
      const header = el.querySelector(".window-header, header");
      if (header) {
        header.style.background = "var(--nimble-input-background-color, rgba(18, 18, 26, 0.92))";
        header.style.borderBottom = "1px solid var(--nimble-input-border-color)";
        header.style.padding = "8px 10px 6px";
      }

      const title = el.querySelector(".window-title");
      if (title) {
        title.style.color = "var(--nimble-input-text-color, var(--nimble-sheet-text, #e9e9ee))";
        title.style.fontFamily = '"Roboto Condensed", var(--font-primary, sans-serif)';
        title.style.fontWeight = "800";
      }

      for (const hb of el.querySelectorAll(".header-button, a.header-button")) {
        hb.style.color = "var(--nimble-input-text-color, var(--nimble-sheet-text, #e9e9ee))";
      }

      const wc = el.querySelector(".window-content, section.window-content");
      if (wc) {
        wc.style.background = "var(--nimble-input-background-color, rgba(18, 18, 26, 0.92))";
        wc.style.color = "var(--nimble-input-text-color, var(--nimble-sheet-text, #e9e9ee))";
        wc.style.padding = "0 10px 10px";
      }

      // Buttons
      for (const btn of el.querySelectorAll(".dialog-buttons button")) {
        btn.style.width = "100%";
        btn.style.border = "1px solid var(--nimble-input-border-color)";
        btn.style.background = "rgba(0,0,0,0.16)";
        btn.style.color = "var(--nimble-input-text-color, var(--nimble-sheet-text, #e9e9ee))";
        btn.style.borderRadius = "10px";
        btn.style.padding = "7px 10px";
        btn.style.fontWeight = "750";
        btn.style.fontFamily = '"Roboto Condensed", var(--font-primary, sans-serif)';
        btn.style.outline = "none";
        btn.style.boxShadow = "none";
      }
    } catch (_e) {}
  };

  Hooks.on("renderDialog", applyReplaceStyle);
  Hooks.on("renderApplication", applyReplaceStyle);
  Hooks.on("renderApplicationV2", applyReplaceStyle);
}

Hooks.once("ready", () => initHPDamageRelay());

  game.keybindings.register("nimble-hp-and-damage", "toggle-key", {
    name: "Toggle Nimble HP HUD",
    hint: "Show or hide the Nimble HP HUD.",
    editable: [],
    onDown: () => game.FloatingHP?.toggleApp()
  });

  game.keybindings.register("nimble-hp-and-damage", "focus-key", {
    name: "Focus Nimble HP HUD",
    hint: "Bring the Nimble HP HUD to the front.",
    editable: [],
    onDown: () => {
      if (!game.FloatingHP.app) {
        game.FloatingHP.app = new FloatingHPApp();
        game.FloatingHP.app.render(true);
      } else game.FloatingHP.app.bringToTop();
      $("#fhp-hp", game.FloatingHP.app.element).focus();
    }
  });

  game.FloatingHP = {
    app: null,
    toggleApp: (show = "toggle") => {
      if (show === "toggle") show = !game.FloatingHP.app;
      if (show && !game.FloatingHP.app) {
        game.FloatingHP.app = new FloatingHPApp();
        game.FloatingHP.app.render(true);
      } else if (!show && game.FloatingHP.app) {
        game.FloatingHP.app.close({ properClose: true });
      }
    },
    refresh: () => game.FloatingHP.app?.refreshSelected()
  };
});

Hooks.on("ready", async () => {
  // --- Migration (best-effort) from old Floating HP Tracker keys ---
  try {
    const oldPos = await game.user.getFlag("floating-hp-tracker", "fhpPos");
    const newPos = await game.user.getFlag(MODULE_ID, "fhpPos");
    if (oldPos && !newPos) await game.user.setFlag(MODULE_ID, "fhpPos", oldPos);
  } catch { /* ignore */ }

  if (game.user.isGM) {
    try {
      const worldStore = game.settings.storage?.get?.("world");
      const clientStore = game.settings.storage?.get?.("client");
      const copyIfPresent = async (scope, key) => {
        const store = (scope === "world") ? worldStore : clientStore;
        const oldK = `floating-hp-tracker.${key}`;
        const newK = `${MODULE_ID}.${key}`;
        const oldV = store?.get?.(oldK);
        if (oldV === undefined) return;
        // Only overwrite if the new setting is still at its default value.
        const newV = store?.get?.(newK);
        if (newV === undefined) return;
        if (newV !== game.settings.settings.get(newK)?.default) return;
        await game.settings.set(MODULE_ID, key, oldV);
      };

      // Only migrate settings that still exist in this module.
      await copyIfPresent("client", "show-dialog");
      await copyIfPresent("world", "add-defeated");
    } catch { /* ignore */ }
  }

  // Auto-open based on the toggle button state.
  if (setting("enable-floating-tracker") && setting("show-dialog") && FloatingHPApp.canLoad()) {
    game.FloatingHP.toggleApp(true);
  }
});

Hooks.on("controlToken", () => {
  game.FloatingHP.refresh();
});

// Keep the Targeted block in sync with live targeting changes.
Hooks.on("targetToken", () => {
  game.FloatingHP.refresh();
});

Hooks.on("updateActor", (actor, data) => {
  const app = game.FloatingHP?.app;
  const tokens = app?._getEffectiveTokens?.() ?? (canvas.tokens.controlled ?? []);
  const isRelevantActor = (tokens ?? []).some(t => t?.actor?.id === actor.id);
  if (
    isRelevantActor &&
    (foundry.utils.getProperty(data, "system.attributes.death") !== undefined ||
      foundry.utils.getProperty(data, "system.attributes.hp.temp") !== undefined ||
      foundry.utils.getProperty(data, `system.${HP_VALUE_PATH}`) !== undefined)
  ) {
    game.FloatingHP.refresh();
  }
});


Hooks.on("getSceneControlButtons", (controls) => {
  if (!FloatingHPApp.canLoad()) return;

  const tokenControls = controls.tokens;
  tokenControls.tools.fhptoggle = {
    name: "fhptoggle",
    title: "Nimble HP HUD",
    icon: "fas fa-heart-pulse",
    toggle: true,
    active: setting("enable-floating-tracker") && setting("show-dialog"),
    onClick: (toggled) => {
      if (!setting("enable-floating-tracker")) return;
      game.settings.set("nimble-hp-and-damage", "show-dialog", toggled);
      game.FloatingHP.toggleApp(toggled);
    }
  };
});

export function getAvailableTargetExtrasForActor(actor) {
  try {
    const app = game?.FloatingHP?.app;
    if (app?._getAvailableTargetExtras) return app._getAvailableTargetExtras(actor) ?? [];
  } catch {}
  if (!actor) return [];
  const lvl = Number(foundry.utils.getProperty(actor, "system.details.level") ?? foundry.utils.getProperty(actor, "system.level") ?? 1) || 1;
  const starting = String(foundry.utils.getProperty(actor, "system.details.startingClass") ?? foundry.utils.getProperty(actor, "system.startingClass") ?? "").toLowerCase().trim();
  const extras = [];
  const pick = (table) => {
    let best = null;
    for (const row of table) {
      if ((Number(row?.level) || 0) <= lvl) best = String(row?.formula || "");
    }
    return best;
  };
  const hasIdentifier = (identifier) => (actor?.items ?? []).some(it => String(foundry.utils.getProperty(it, "system.identifier") ?? "").trim() === String(identifier || "").trim());
  if (starting === "the-cheat") {
    const formula = pick([{ level: 1, formula: "1d6" },{ level: 3, formula: "1d8" },{ level: 7, formula: "2d8" },{ level: 9, formula: "2d10" },{ level: 11, formula: "2d12" },{ level: 15, formula: "2d20" },{ level: 17, formula: "3d20" }]);
    if (formula) extras.push({ key: "sneak", label: "Sneak Attack", formula, level: lvl });
  }
  if (starting === "oathsworn") {
    const formula = pick([{ level: 1, formula: "2d6" },{ level: 3, formula: "2d8" },{ level: 5, formula: "2d10" },{ level: 8, formula: "2d12" },{ level: 10, formula: "2d20" },{ level: 14, formula: "3d20" }]);
    if (formula) extras.push({ key: "judgment", label: "Judgment Dice", formula, level: lvl });
  }
  if (hasIdentifier("shining-mandate-damage")) {
    const formula = pick([{ level: 1, formula: "1d6" },{ level: 3, formula: "1d8" },{ level: 5, formula: "1d10" },{ level: 8, formula: "1d12" },{ level: 10, formula: "1d20" }]);
    if (formula) extras.push({ key: "shining", label: "Shining Mandate", formula, level: lvl });
  }
  if (starting === "berserker") extras.push({ key: "fury", label: "Fury Dice", type: "fury", level: lvl });
  return extras;
}

export async function postExtraRollCardStatic({ roll, attackerActor, label, formula }) {
  try {
    const app = game?.FloatingHP?.app;
    if (app?._postExtraRollCard) return await app._postExtraRollCard({ roll, attackerActor, label, formula });
  } catch {}
  try {
    if (!roll) return;
    const dsn = game?.dice3d;
    if (dsn?.showForRoll) {
      try {
        await dsn.showForRoll(roll, game.user, true, null, false);
        return;
      } catch {
        try {
          await dsn.showForRoll(roll, game.user, true);
          return;
        } catch {
          /* ignore */
        }
      }
    }
  } catch {}
}

export async function getFuryDiceTotalForActor(actor) {
  try {
    const flags = await actor?.getFlag?.(MODULE_ID, "furyDice");
    const dice = Array.isArray(flags?.dice) ? flags.dice : [];
    return dice.reduce((sum, v) => sum + (Number(v) || 0), 0);
  } catch {
    return 0;
  }
}

export async function openFuryDiceDialogForActor(actor, { onChange=null, onClose=null } = {}) {
  const app = game?.FloatingHP?.app;
  if (!actor || !app?._renderFurySection) return false;
  const getStoredPos = async () => {
    try {
      const pos = await game.user?.getFlag?.(MODULE_ID, "extrasDialogPos");
      const left = Number(pos?.left);
      const top = Number(pos?.top);
      if (Number.isFinite(left) && Number.isFinite(top)) return { left, top };
    } catch {}
    return null;
  };
  const persistPos = async () => {
    try {
      const pos = dlg?.position;
      const left = Number(pos?.left);
      const top = Number(pos?.top);
      if (Number.isFinite(left) && Number.isFinite(top)) {
        await game.user.setFlag(MODULE_ID, "extrasDialogPos", { left, top });
      }
    } catch {}
  };
  const fireChange = async () => {
    try {
      const total = await getFuryDiceTotalForActor(actor);
      if (typeof onChange === "function") await onChange(total);
    } catch {}
  };
  const rerender = async () => {
    try {
      await persistPos();
      dlg.close();
    } catch {}
    await openFuryDiceDialogForActor(actor, { onChange, onClose });
  };
  let dlg = null;
  const content = await app._renderFurySection(actor, { includeClose: true });
  const storedPos = await getStoredPos();
  dlg = new Dialog({
    title: "Fury Dice",
    content: `<div class="fhp-extras-wrap">${content}</div>`,
    buttons: {},
    render: (html) => {
      // Drag anywhere in the dialog body except interactive controls, matching the main HUD/extras dialog behavior.
      try {
        const $app = html.closest(".app");
        const $content = $app.find(".window-content");
        const isInteractive = (el) => {
          if (!el) return false;
          const tag = String(el.tagName || "").toLowerCase();
          if (["button", "input", "textarea", "select", "a", "label"].includes(tag)) return true;
          if (el.closest?.("button, input, textarea, select, a, label")) return true;
          return false;
        };
        let dragging = false;
        let startX = 0, startY = 0, startLeft = 0, startTop = 0;
        const onMove = (e) => {
          if (!dragging) return;
          const dx = e.clientX - startX;
          const dy = e.clientY - startY;
          dlg.setPosition({ left: startLeft + dx, top: startTop + dy });
        };
        const stopDrag = () => {
          if (!dragging) return;
          dragging = false;
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", stopDrag);
          persistPos();
        };
        $content.off("mousedown.fhpFuryDrag").on("mousedown.fhpFuryDrag", (e) => {
          if (e.button !== 0) return;
          if (isInteractive(e.target)) return;
          dragging = true;
          startX = e.clientX;
          startY = e.clientY;
          startLeft = dlg.position.left ?? 0;
          startTop = dlg.position.top ?? 0;
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", stopDrag);
        });
      } catch {}
      html.find('[data-action="fury-roll"]').off('click').on('click', async (ev) => {
        ev.preventDefault();
        try {
          const st = await app._getFuryDiceState(actor);
          const cap = app._getFuryCap(actor);
          const dice = Array.isArray(st.dice) ? st.dice.slice() : [];
          const roll = await app._rollFuryDie(st.faces);
          await postExtraRollCardStatic({ roll, attackerActor: actor, label: "Fury Dice", formula: `1d${st.faces}` });
          const value = Number(roll.total) || 0;
          if (cap > 0 && dice.length >= cap) {
            const hasLower = dice.some(v => value > (Number(v) || 0));
            if (!hasLower) { ui.notifications?.info?.(`Rolled ${value}. No existing die is lower to replace.`); return; }
            app._furyPendingReplace = { actorId: actor.id, rolledValue: value };
            await rerender();
            return;
          }
          dice.push(value);
          await app._setFuryDiceState(actor, { active: true, dice });
          await fireChange();
          await rerender();
        } catch (e) { console.error("Fury roll failed", e); ui.notifications?.error?.("Failed to roll Fury Die."); }
      });
      html.find('[data-action="fury-end"]').off('click').on('click', async (ev) => {
        ev.preventDefault();
        try {
          if (app._furyPendingReplace?.actorId === actor.id) app._furyPendingReplace = null;
          await app._setFuryDiceState(actor, { active: false, dice: [] });
          await fireChange();
          await rerender();
        } catch (e) { console.error("End Rage failed", e); ui.notifications?.error?.("Failed to end Rage."); }
      });
      html.find('[data-action="fury-close"]').off('click').on('click', async (ev) => {
        ev.preventDefault();
        try { if (app._furyPendingReplace?.actorId === actor.id) app._furyPendingReplace = null; } catch {}
        try { await persistPos(); } catch {}
        try { dlg.close(); } catch {}
      });
      html.find('[data-action="fury-remove"]').off('click').on('click', async (ev) => {
        ev.preventDefault();
        try {
          const idx = Number(ev.currentTarget?.dataset?.i);
          const pending = (app._furyPendingReplace?.actorId === actor.id) ? app._furyPendingReplace : null;
          const st = await app._getFuryDiceState(actor);
          const dice = Array.isArray(st.dice) ? st.dice.slice() : [];
          if (pending) {
            const rolled = Number(pending.rolledValue) || 0;
            if (Number.isFinite(idx) && idx >= 0 && idx < dice.length) {
              const cur = Number(dice[idx]) || 0;
              if (rolled > cur) dice[idx] = rolled;
              await app._setFuryDiceState(actor, { active: true, dice });
              await fireChange();
            }
            app._furyPendingReplace = null;
            await rerender();
            return;
          }
          if (Number.isFinite(idx) && idx >= 0 && idx < dice.length) {
            dice.splice(idx, 1);
            await app._setFuryDiceState(actor, { active: true, dice });
            await fireChange();
            await rerender();
          }
        } catch (e) { console.error("Spend die failed", e); ui.notifications?.error?.("Failed to spend Fury Die."); }
      });
    },
    close: async () => {
      try { await persistPos(); } catch {}
      try { if (typeof onClose === "function") await onClose(); } catch {}
    }
  }, { width: 420, classes: ["floating-hp-tracker", "fhp-extras-dialog"], left: storedPos?.left, top: storedPos?.top });
  dlg.render(true);
  return true;
}
