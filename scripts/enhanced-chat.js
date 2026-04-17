import { MODULE_ID, requestToggleStatus } from "./relay.js";
import { getMessageDamageContext, applyEnhancedChatCardDamage, getDefendContextForActorStatic, getDefendValueForModeStatic, getAvailableTargetExtrasForActor, postExtraRollCardStatic, getFuryDiceTotalForActor, openFuryDiceDialogForActor } from "./floatinghp.js";

const stateByMessage = new Map();
const DEFAULT_ARMOR_ICON_CLASS = "fa-solid fa-shield-halved";
const HEAVY_ARMOR_ICON_CLASS = "fa-solid fa-shield";
const UNARMORED_ICON_CLASS = "fa-solid fa-ban";

function getState(messageId) {
  if (!stateByMessage.has(messageId)) {
    stateByMessage.set(messageId, {
      armorMode: "normal", // normal | reduced | bypass
      resVulnMode: "normal", // normal | resistant | vulnerable
      defendMode: 0,
      extraDamage: {},
      sourceActor: null,
      sourceExtras: [],
      sourceActorKey: null,
      sourceActorPromise: null,
      sourceActorPromiseKey: null,
      targetProfile: null,
      targetProfileKey: null,
      targetProfilePromise: null,
      targetProfilePromiseKey: null
    });
  }
  return stateByMessage.get(messageId);
}

function labelArmor(mode) {
  switch (String(mode)) {
    case "reduced":
    case "reduced":
    case "down": return "Reduced Armor One Step";
    case "bypass": return "Bypassed Armor";
    default: return "Normal";
  }
}

function nextArmor(mode, armorTypes = []) {
  const types = Array.isArray(armorTypes) ? armorTypes : [];
  if (!types.length) return "normal";
  const hasHeavy = types.includes("heavy");
  if (hasHeavy) {
    switch (String(mode)) {
      case "normal": return "reduced";
      case "reduced": return "bypass";
      case "down": return "bypass";
      default: return "normal";
    }
  }
  switch (String(mode)) {
    case "normal": return "bypass";
    default: return "normal";
  }
}


function nextResVuln(mode) {
  switch (String(mode)) {
    case "normal": return "resistant";
    case "resistant": return "vulnerable";
    default: return "normal";
  }
}


function escapeAttr(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/\"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function iconForExtraKey(key, isRolled = false) {
  if (isRolled && key !== "fury") return '<i class="fa-solid fa-rotate-right" aria-hidden="true"></i>';
  if (key === "sneak") return '<i class="fa-solid fa-user-ninja" aria-hidden="true"></i>';
  if (key === "judgment" || key === "shining") return '<i class="fa-solid fa-scale-balanced" aria-hidden="true"></i>';
  if (key === "fury") return '<i class="fa-regular fa-face-angry" aria-hidden="true"></i>';
  return '<i class="fa-solid fa-dice" aria-hidden="true"></i>';
}

function getExtraTooltip(extra, rolledEntry = null) {
  if (!extra) return "Extra Damage";
  const lvl = Number(extra.level ?? 0) || 0;
  const rolledTotal = Number(rolledEntry?.total ?? 0) || 0;
  const isRolled = !!rolledEntry && extra.key !== "fury";
  let body = extra.label || "Extra Damage";
  if (extra.key === "sneak") body = `Cheat lvl ${lvl} - Sneak Attack ${extra.formula}`;
  else if (extra.key === "judgment") body = `Oathsworn lvl ${lvl} - Judgment Dice ${extra.formula}`;
  else if (extra.key === "shining") body = `Lvl ${lvl} - Shining Mandate ${extra.formula}`;
  else if (extra.key === "fury") body = "Fury Dice";
  return isRolled ? `REROLL (${rolledTotal}) - ${body}` : body;
}

function getExtraStateSummary(extraDamage) {
  const entries = extraDamage && typeof extraDamage === "object" ? Object.values(extraDamage).filter(v => v && typeof v === "object") : [];
  const total = entries.reduce((sum, entry) => sum + (Number(entry?.total ?? 0) || 0), 0);
  const display = entries.map(entry => Number(entry?.total ?? 0) || 0).filter(v => v > 0).map(v => String(v)).join(" + ");
  return { total, display };
}

async function resolveSourceActor(message) {
  const liveMessage = message?.id ? game.messages?.get?.(message.id) ?? message : message;
  const ids = [
    liveMessage?.flags?.nimble?.actorId,
    liveMessage?.speaker?.actor,
    getMessageDamageContext(liveMessage)?.speakerActorId,
    liveMessage?.actor?.id,
    liveMessage?.author?.character?.id,
    game.users?.get?.(liveMessage?.user?.id ?? liveMessage?.user)?.character?.id
  ].filter(v => typeof v === "string" && v.length);
  for (const id of ids) {
    const actor = game.actors?.get?.(id);
    if (actor) return actor;
  }
  return null;
}

async function ensureSourceExtras(message, ctx, wrapper = null) {
  const state = getState(message.id);
  const key = String(message?.id || "");
  if (state.sourceActor && state.sourceActorKey === key) return { actor: state.sourceActor, extras: state.sourceExtras || [] };
  if (!state.sourceActorPromise || state.sourceActorPromiseKey !== key) {
    state.sourceActorPromiseKey = key;
    state.sourceActorPromise = resolveSourceActor(game.messages?.get?.(message.id) ?? message).then(async (actor) => {
      state.sourceActor = actor || null;
      state.sourceExtras = actor ? (getAvailableTargetExtrasForActor(actor) || []) : [];
      state.sourceActorKey = key;
      state.sourceActorPromise = null;
      state.sourceActorPromiseKey = null;
      if (wrapper?.isConnected) refreshWrapper(message, refreshLiveContext(message, ctx), wrapper);
      return { actor: state.sourceActor, extras: state.sourceExtras };
    }).catch(() => {
      state.sourceActor = null;
      state.sourceExtras = [];
      state.sourceActorPromise = null;
      state.sourceActorPromiseKey = null;
      return { actor: null, extras: [] };
    });
  }
  return state.sourceActorPromise;
}

async function syncFuryExtraState(message, ctx, wrapper = null) {
  const state = getState(message.id);
  const actor = state.sourceActor;
  if (!actor) return;
  const total = Math.max(0, Number(await getFuryDiceTotalForActor(actor)) || 0);
  if (total > 0) state.extraDamage.fury = { total, diceOnly: total, formula: "Fury Dice", label: "Fury Dice" };
  else delete state.extraDamage.fury;
  if (wrapper?.isConnected) refreshWrapper(message, refreshLiveContext(message, ctx), wrapper);
}

async function rollSimpleExtra(message, ctx, wrapper, extra) {
  const state = getState(message.id);
  const actor = state.sourceActor;
  if (!extra || !actor) return;
  try {
    const roll = await (new Roll(extra.formula)).evaluate({ async: true });
    state.extraDamage[extra.key] = { total: Number(roll.total) || 0, diceOnly: Number(roll.total) || 0, formula: extra.formula, label: extra.label, level: extra.level };
    await postExtraRollCardStatic({ roll, attackerActor: actor, label: extra.label, formula: extra.formula });
    refreshWrapper(message, refreshLiveContext(message, ctx), wrapper);
  } catch (e) {
    console.error(`${MODULE_ID} | extra damage roll failed`, e);
    ui.notifications?.error?.("Failed to roll extra damage.");
  }
}


function isPcActor(actor) {
  try {
    return !!(actor?.hasPlayerOwner || actor?.type === "character" || actor?.type === "pc");
  } catch {
    return false;
  }
}

function nextDefend(mode, hasShield = false) {
  const maxModes = hasShield ? 4 : 2;
  return (Number(mode ?? 0) + 1) % maxModes;
}

function defendButtonIconHTML(mode, defCtx = null) {
  const hasShield = (Number(defCtx?.shieldGear ?? 0) || 0) > 0;
  const m = Number(mode ?? 0) || 0;
  if (m === 1) {
    return hasShield
      ? '<i class="fa-solid fa-helmet-battle" aria-hidden="true"></i>'
      : '<i class="fa-solid fa-shield-check" aria-hidden="true"></i>';
  }
  if (m === 2) return '<i class="fa-solid fa-shield" aria-hidden="true"></i>';
  if (m === 3) return '<i class="fa-solid fa-shield-check" aria-hidden="true"></i>';
  return '<i class="fa-solid fa-ban" aria-hidden="true"></i>';
}

function defendButtonTitle(mode, defCtx = null) {
  const hasShield = (Number(defCtx?.shieldGear ?? 0) || 0) > 0;
  const m = Number(mode ?? 0) || 0;
  const val = Number(getDefendValueForModeStatic(defCtx, m) ?? 0) || 0;
  let title = "Defend: None";
  if (m === 1) title = hasShield ? `Defend Armor (${val})` : `Defend (${val})`;
  else if (m === 2) title = `Defend Shield (${val})`;
  else if (m === 3) title = `Defend Armor+Shield (${val})`;
  return `${title}
Left-click to cycle
Right-click to reset.`;
}

function getMessageTargetKey(message) {
  const liveMessage = message?.id ? game.messages?.get?.(message.id) ?? message : message;
  const targetSources = [
    liveMessage?.reactive?.system?.targets,
    liveMessage?.system?.targets,
    liveMessage?._source?.system?.targets,
    liveMessage?.flags?.nimble?.targets
  ];

  for (const src of targetSources) {
    if (!Array.isArray(src)) continue;
    const uuids = src
      .map((t) => typeof t === "string" ? t : t?.uuid ?? t?.tokenUuid ?? t?.token?.uuid ?? null)
      .filter((u) => typeof u === "string" && u.length)
      .sort();
    if (uuids.length || src.length === 0) return uuids.join("|");
  }
  return "";
}

async function buildTargetProfile(message) {
  const tokenDocs = await getCardTargetTokenDocs(message);
  const docs = Array.isArray(tokenDocs) ? tokenDocs.filter(t => t?.actor) : [];
  const pcs = docs.filter(t => isPcActor(t.actor));
  const monsters = docs.filter(t => !isPcActor(t.actor));
  let kind = "none";
  if (pcs.length === 1 && monsters.length === 0 && docs.length === 1) kind = "single-pc";
  else if (pcs.length > 0 && monsters.length === 0) kind = "pc-only";
  else if (pcs.length === 0 && monsters.length > 0) kind = "monster-only";
  else if (pcs.length > 0 && monsters.length > 0) kind = "mixed";

  return {
    kind,
    tokenDocs: docs,
    pcs,
    monsters,
    singlePC: kind === "single-pc" ? pcs[0] : null,
    defendCtx: kind === "single-pc" ? getDefendContextForActorStatic(pcs[0]?.actor) : null
  };
}

async function ensureTargetProfile(message, ctx, wrapper = null) {
  const state = getState(message.id);
  const key = `${message?.id || ""}:${getMessageTargetKey(message)}`;
  if (state.targetProfile && state.targetProfileKey === key) return state.targetProfile;
  if (!state.targetProfilePromise || state.targetProfilePromiseKey !== key) {
    state.targetProfilePromiseKey = key;
    state.targetProfilePromise = buildTargetProfile(game.messages?.get?.(message.id) ?? message)
      .then((profile) => {
        state.targetProfile = profile;
        state.targetProfileKey = key;
        state.targetProfilePromise = null;
        state.targetProfilePromiseKey = null;
        if (wrapper?.isConnected) refreshWrapper(message, refreshLiveContext(message, ctx), wrapper);
        return profile;
      })
      .catch(() => {
        state.targetProfile = null;
        state.targetProfilePromise = null;
        state.targetProfilePromiseKey = null;
        return null;
      });
  }
  return state.targetProfilePromise;
}
function resVulnModeTitle(mode) {
  switch (String(mode)) {
    case "resistant": return "Resistant";
    case "vulnerable": return "Vulnerable";
    default: return "Normal";
  }
}

function resVulnButtonIconHTML(mode) {
  if (mode === "resistant") return '<i class="fa-brands fa-fort-awesome" aria-hidden="true"></i>';
  if (mode === "vulnerable") return '<i class="fa-solid fa-heart-crack" aria-hidden="true"></i>';
  return '<i class="fa-solid fa-ban" aria-hidden="true"></i>';
}

function resVulnButtonTitle(mode) {
  const title = resVulnModeTitle(mode);
  const detail = (mode === "resistant")
    ? "Half damage after armor."
    : (mode === "vulnerable")
      ? "Bypasses armor if armor remains; doubles damage if effectively unarmored."
      : "Normal Damage";
  return `Damage Modifier: ${title}
${detail}
Left-click to cycle
Right-click to reset.`;
}

function getCurrentMessageDamageContext(message) {
  const liveMessage = message?.id ? game.messages?.get?.(message.id) ?? message : message;
  return getMessageDamageContext(liveMessage);
}

function getBaseDamage(message, root) {
  const ctx = getCurrentMessageDamageContext(message);
  const full = Number(ctx?.full ?? ctx?.amount ?? 0);
  if (Number.isFinite(full) && full > 0) return Math.abs(full);

  const candidates = [
    root?.querySelector?.("[data-damage-total]")?.dataset?.damageTotal,
    root?.querySelector?.("[data-total]")?.dataset?.total,
    root?.querySelector?.(".dice-total")?.textContent,
    root?.querySelector?.(".roll-total")?.textContent,
    root?.querySelector?.(".total")?.textContent
  ];

  for (const raw of candidates) {
    const n = Number(String(raw ?? "").replace(/[^\d.-]/g, ""));
    if (Number.isFinite(n)) return Math.abs(n);
  }
  return 0;
}


function buildPreviewModel(baseDamage, armorMode, resVulnMode = "normal", armorTypes = [], message = null, targetProfile = null, defendMode = 0, extraDamage = null) {
  const ctx = getCurrentMessageDamageContext(message);
  const baseFull = Number(ctx?.full ?? baseDamage ?? 0) || 0;
  const baseDiceOnly = Number(ctx?.diceOnly ?? baseFull) || baseFull;
  const extraSummary = getExtraStateSummary(extraDamage);
  const full = baseFull + extraSummary.total;
  const diceOnly = baseDiceOnly + extraSummary.total;
  const isCrit = !!ctx?.isCrit;

  const model = {
    base: baseFull,
    extraDisplay: extraSummary.total > 0 ? extraSummary.display : "",
    subtraction: 0,
    result: full
  };

  if (targetProfile?.kind === "single-pc") {
    const defendCtx = targetProfile?.defendCtx ?? null;
    const defendVal = Number(getDefendValueForModeStatic(defendCtx, defendMode) ?? 0) || 0;
    const defended = Math.min(full, Math.max(0, defendVal));
    model.subtraction = defended;
    model.result = Math.max(0, full - defended);
    return model;
  }

  const types = Array.isArray(armorTypes) ? armorTypes : [];
  const hasHeavy = types.includes("heavy");
  const hasMedium = types.includes("medium");
  const effectiveArmorMode = ((armorMode === "down" || armorMode === "reduced") && !hasHeavy)
    ? "bypass"
    : armorMode;

  let armorResult = full;
  let effectiveArmorBucket = 0;
  if (!isCrit) {
    if (effectiveArmorMode === "bypass") {
      armorResult = full;
      effectiveArmorBucket = 0;
    } else if (effectiveArmorMode === "down" || effectiveArmorMode === "reduced") {
      armorResult = diceOnly;
      effectiveArmorBucket = hasHeavy ? 1 : 0;
    } else if (hasHeavy) {
      armorResult = Math.ceil(diceOnly / 2);
      effectiveArmorBucket = 2;
    } else if (hasMedium) {
      armorResult = diceOnly;
      effectiveArmorBucket = 1;
    } else {
      armorResult = full;
      effectiveArmorBucket = 0;
    }
  }

  const armorSubtracted = Math.max(0, full - armorResult);
  model.subtraction = armorSubtracted;

  let modified = armorResult;
  if (resVulnMode === "resistant") {
    modified = Math.ceil(armorResult / 2);
  } else if (resVulnMode === "vulnerable") {
    if (isCrit) modified = armorResult;
    else if (effectiveArmorBucket === 0) modified = armorResult * 2;
    else modified = full;
  }

  model.result = modified;
  return model;
}

function computePreview(baseDamage, armorMode, resVulnMode = "normal", armorTypes = [], message = null, targetProfile = null, defendMode = 0, extraDamage = null) {
  const model = buildPreviewModel(baseDamage, armorMode, resVulnMode, armorTypes, message, targetProfile, defendMode, extraDamage);
  const parts = [String(model.base)];
  if (model.extraDisplay) parts.push(`(+${model.extraDisplay})`);
  if (model.subtraction > 0) parts.push(`(-${model.subtraction})`);
  return `Damage: ${parts.join(" ")} → ${model.result}`;
}

function renderPreviewHTML(baseDamage, armorMode, resVulnMode = "normal", armorTypes = [], message = null, targetProfile = null, defendMode = 0, extraDamage = null) {
  const model = buildPreviewModel(baseDamage, armorMode, resVulnMode, armorTypes, message, targetProfile, defendMode, extraDamage);
  const bits = [`<span class="nhd-chat-preview-value">${model.base}</span>`];
  if (model.extraDisplay) bits.push(`<span class="nhd-chat-preview-mod nhd-chat-preview-mod--positive">(+${foundry.utils.escapeHTML(model.extraDisplay)})</span>`);
  if (model.subtraction > 0) bits.push(`<span class="nhd-chat-preview-mod nhd-chat-preview-mod--negative">(-${model.subtraction})</span>`);
  return `
    <span class="nhd-chat-preview-label">Damage</span>
    <span class="nhd-chat-preview-expression">${bits.join(" ")}</span>
    <span class="nhd-chat-preview-arrow">→</span>
    <span class="nhd-chat-preview-total">${model.result}</span>
  `;
}

function getLiveMessageRoot(messageId, fallbackRoot = null) {
  const sel = `.message[data-message-id="${messageId}"]`;
  return document.querySelector(sel) || fallbackRoot;
}

function getEffectiveRoot(root) {
  return root?.querySelector?.(".message-content") || root;
}

function getCardBodyHost(root) {
  const searchRoot = getEffectiveRoot(root);
  if (!(searchRoot instanceof HTMLElement)) return null;
  return (
    searchRoot.querySelector('.nimble-chat-card__body') ||
    searchRoot.querySelector('article.nimble-chat-card__body') ||
    searchRoot.querySelector('article') ||
    searchRoot
  );
}

function canCurrentUserUseEnhancedChatCard(message) {
  if (game.user?.isGM) return true;
  if (!game.settings.get(MODULE_ID, "allow-player-damage")) return false;
  const creatorId = message?.user?.id ?? message?.user ?? message?.author?.id ?? null;
  return !!creatorId && creatorId === game.user?.id;
}

function getProxyHost(searchRoot) {
  if (!(searchRoot instanceof HTMLElement)) return null;
  return getCardBodyHost(searchRoot) || searchRoot;
}

function getActionInsertionPoint(searchRoot, applyBtn) {
  const fallbackHost = getProxyHost(searchRoot) || searchRoot;
  if (!(fallbackHost instanceof HTMLElement)) return null;

  if (applyBtn instanceof HTMLElement) {
    const proxyWrap = applyBtn.closest('.nhd-chat-apply-proxy-wrap');
    if (proxyWrap?.parentElement instanceof HTMLElement) {
      return { host: proxyWrap.parentElement, anchor: proxyWrap, proxyMode: true };
    }
    if (applyBtn.parentElement instanceof HTMLElement) {
      return { host: applyBtn.parentElement, anchor: applyBtn, proxyMode: false };
    }
  }

  return { host: fallbackHost, anchor: null, proxyMode: false };
}

function ensureProxyApplyButton(message, searchRoot) {
  const liveMessage = game.messages?.get?.(message.id) ?? message;
  const damageCtx = getCurrentMessageDamageContext(liveMessage);
  const hasTargets = !!(liveMessage?.reactive?.system?.targets?.length || liveMessage?.system?.targets?.length || liveMessage?._source?.system?.targets?.length);
  if (!damageCtx || !hasTargets) return null;

  let proxyWrap = searchRoot.querySelector('.nhd-chat-apply-proxy-wrap');
  let applyBtn = proxyWrap?.querySelector('.nhd-chat-apply-proxy') ?? null;
  if (!proxyWrap || !applyBtn) {
    proxyWrap = document.createElement("div");
    proxyWrap.className = "nhd-chat-apply-proxy-wrap";
    applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "nhd-chat-apply-proxy";
    applyBtn.textContent = "Apply Damage";
    proxyWrap.appendChild(applyBtn);
  }

  const host = getProxyHost(searchRoot) || searchRoot;
  if (proxyWrap.parentElement !== host) host.appendChild(proxyWrap);
  return applyBtn;
}

function hasApplyHealingButton(searchRoot) {
  if (!(searchRoot instanceof HTMLElement)) return false;
  const buttons = [...searchRoot.querySelectorAll("button")];
  return buttons.some((btn) => btn.textContent?.trim().toLowerCase() === "apply healing");
}

function isHealingCard(searchRoot) {
  if (!(searchRoot instanceof HTMLElement)) return false;

  const buttons = [...searchRoot.querySelectorAll("button")];
  const hasApplyHealing = buttons.some((btn) => btn.textContent?.trim().toLowerCase() === "apply healing");
  const hasUndoHealing = buttons.some((btn) => {
    const text = btn.textContent?.trim().toLowerCase() || "";
    const title = btn.getAttribute("title")?.trim().toLowerCase() || "";
    const aria = btn.getAttribute("aria-label")?.trim().toLowerCase() || "";
    return text === "undo healing" || title === "undo healing" || aria === "undo healing";
  });
  const rootText = searchRoot.textContent?.toLowerCase() || "";
  const hasHealingApplied = rootText.includes("healing applied");

  return hasApplyHealing || hasUndoHealing || hasHealingApplied;
}

function detectContext(message, html) {
  const root = html?.[0] ?? html;
  if (!(root instanceof HTMLElement)) return null;
  if (!canCurrentUserUseEnhancedChatCard(message)) return null;

  const searchRoot = getEffectiveRoot(root);
  if (isHealingCard(searchRoot)) return null;

  const buttons = [...searchRoot.querySelectorAll("button")];
  let applyBtn = buttons.find((btn) => btn.textContent?.trim().toLowerCase() === "apply damage");

  if (!applyBtn) {
    applyBtn = ensureProxyApplyButton(message, searchRoot);
    if (!applyBtn) return null;
  }

  return { root, applyBtn };
}

function parseArmorTypeFromTooltip(html) {
  const tip = String(html || "").toLowerCase();
  if (/\bheavy\b/.test(tip)) return "heavy";
  if (/\bmedium\b/.test(tip)) return "medium";
  if (/\blight\b/.test(tip)) return "light";
  return null;
}

function detectArmorTypeForActor(actor) {
  try {
    const a = String(actor?.system?.attributes?.armor ?? "").toLowerCase().trim();
    if (!a) return null;
    if (a === "heavy" || a.includes("heavy")) return "heavy";
    if (a === "medium" || a.includes("medium")) return "medium";
    if (a === "unarmored" || a === "none" || a === "unarm" || a.includes("unarm") || a.includes("none")) return "unarmored";
  } catch {
    return null;
  }
  return null;
}

function getTargetArmorContext(root, targetProfile = null) {
  let armorTypes = [];
  const monsterDocs = Array.isArray(targetProfile?.monsters) ? targetProfile.monsters : [];
  if (monsterDocs.length) {
    armorTypes = monsterDocs
      .map((t) => detectArmorTypeForActor(t?.actor))
      .filter((t) => t === "medium" || t === "heavy");
  }

  if (!armorTypes.length) {
    const searchRoot = getEffectiveRoot(root);
    const icons = Array.from(searchRoot.querySelectorAll(".nimble-armor-icon[data-tooltip]"));
    armorTypes = icons
      .map((el) => parseArmorTypeFromTooltip(el.getAttribute("data-tooltip") || el.dataset?.tooltip || ""))
      .filter((t) => t === "medium" || t === "heavy");
  }

  const iconClass = armorTypes.includes("heavy")
    ? HEAVY_ARMOR_ICON_CLASS
    : (armorTypes.includes("medium") ? DEFAULT_ARMOR_ICON_CLASS : UNARMORED_ICON_CLASS);

  return {
    hasArmor: armorTypes.length > 0,
    armorTypes,
    iconClass
  };
}


function refreshLiveContext(message, ctx) {
  const liveRoot = getLiveMessageRoot(message.id, ctx.root);
  if (!liveRoot) return ctx;
  const searchRoot = getEffectiveRoot(liveRoot);
  if (isHealingCard(searchRoot)) {
    return {
      root: liveRoot,
      applyBtn: null
    };
  }
  const buttons = [...searchRoot.querySelectorAll("button")];
  let liveApplyBtn = buttons.find((btn) => btn.textContent?.trim().toLowerCase() === "apply damage");

  if (!liveApplyBtn && canCurrentUserUseEnhancedChatCard(message)) {
    liveApplyBtn = ensureProxyApplyButton(message, searchRoot);
  }

  return {
    root: liveRoot,
    applyBtn: liveApplyBtn || ctx.applyBtn
  };
}

function schedulePostRenderRefresh(message, ctx, wrapper) {
  const delays = [0, 50, 150, 400];
  for (const delay of delays) {
    window.setTimeout(() => {
      const liveCtx = refreshLiveContext(message, ctx);
      if (!wrapper.isConnected && liveCtx.applyBtn) {
        const liveSearchRoot = getEffectiveRoot(liveCtx.root);
        const insertion = getActionInsertionPoint(liveSearchRoot, liveCtx.applyBtn) || { host: getProxyHost(liveSearchRoot) || liveSearchRoot, anchor: null, proxyMode: false };
        if (insertion.proxyMode) wrapper.classList.add('nhd-chat-enhanced--proxy');
        else wrapper.classList.remove('nhd-chat-enhanced--proxy');
        if (insertion.anchor) insertion.host.insertBefore(wrapper, insertion.anchor);
        else insertion.host.appendChild(wrapper);
      }
      refreshWrapper(message, liveCtx, wrapper);
    }, delay);
  }
}

function armorButtonIconHTML(mode, iconClass) {
  if (mode === "down" || mode === "reduced") return '<i class="fa-solid fa-arrow-down" aria-hidden="true"></i>';
  if (mode === "bypass") return '<i class="fa-solid fa-ban" aria-hidden="true"></i>';
  return `<i class="${iconClass}" aria-hidden="true"></i>`;
}

function armorModeTitle(mode) {
  switch (String(mode)) {
    case "reduced":
    case "down": return "Reduced Armor One Step";
    case "bypass": return "Bypassed Armor";
    default: return "Normal";
  }
}

function armorButtonTitle(mode, armorTypes = []) {
  const types = Array.isArray(armorTypes) ? armorTypes : [];
  if (!types.length) return `Armor: Unarmored\nNo armor to modify.`;
  return `Armor: ${armorModeTitle(mode)}\nLeft-click to cycle\nRight-click to reset.`;
}

function renderWrapper(message, ctx) {
  const searchRoot = getEffectiveRoot(ctx.root);
  const existing = searchRoot.querySelector(".nhd-chat-enhanced");
  if (existing) existing.remove();

  const armorCtx = getTargetArmorContext(ctx.root, getState(message.id).targetProfile);
  const wrapper = document.createElement("div");
  wrapper.className = "nhd-chat-enhanced";
  wrapper.dataset.messageId = message.id;
  wrapper.innerHTML = `
    <div class="nhd-chat-controls"></div>
    <div class="nhd-chat-preview"><span class="nhd-chat-preview-label">Damage</span><span class="nhd-chat-preview-expression">—</span></div>
  `;

  const insertion = getActionInsertionPoint(searchRoot, ctx.applyBtn) || { host: getProxyHost(searchRoot) || searchRoot, anchor: null, proxyMode: false };
  if (insertion.proxyMode) wrapper.classList.add('nhd-chat-enhanced--proxy');
  else wrapper.classList.remove('nhd-chat-enhanced--proxy');
  if (insertion.anchor) insertion.host.insertBefore(wrapper, insertion.anchor);
  else insertion.host.appendChild(wrapper);
  refreshWrapper(message, ctx, wrapper, armorCtx);
  ensureTargetProfile(message, ctx, wrapper);
  ensureSourceExtras(message, ctx, wrapper);
  bindWrapper(message, ctx, wrapper);
  bindRootRefresh(message, ctx, wrapper);
  bindConditionRouting(message, ctx);
  bindApply(message, ctx);
  schedulePostRenderRefresh(message, ctx, wrapper);
}

function refreshWrapper(message, ctx, wrapper, armorCtx = getTargetArmorContext(ctx.root, getState(message.id).targetProfile)) {
  const state = getState(message.id);
  const baseDamage = getBaseDamage(message, ctx.root);
  const controls = wrapper.querySelector(".nhd-chat-controls");
  const preview = wrapper.querySelector(".nhd-chat-preview");
  const targetProfile = state.targetProfile;
  const profileKind = String(targetProfile?.kind || "");
  const showDefend = profileKind === "single-pc";
  const hasArmoredMonsterTarget = Array.isArray(armorCtx?.armorTypes)
    && armorCtx.armorTypes.some((t) => t === "medium" || t === "heavy");
  const useMonsterControls = profileKind === "monster-only" || profileKind === "mixed" || (!profileKind && armorCtx.hasArmor);
  const sourceExtras = Array.isArray(state.sourceExtras) ? state.sourceExtras : [];

  if (controls) {
    if (showDefend) {
      state.armorMode = "normal";
      state.resVulnMode = "normal";
      const defendCtx = targetProfile?.defendCtx ?? null;
      const hasShield = (Number(defendCtx?.shieldGear ?? 0) || 0) > 0;
      let mode = Number(state.defendMode ?? 0) || 0;
      if (!hasShield && mode > 1) {
        mode = 1;
        state.defendMode = mode;
      }
      controls.innerHTML = `
        <div class="nhd-chat-control">
          <span class="nhd-chat-label">Defend</span>
          <button type="button" class="nhd-chat-cycle nhd-chat-cycle--icon${mode ? " nhd-chat-cycle--active" : ""}" data-cycle="defend" title="${defendButtonTitle(mode, defendCtx).replace(/"/g, "&quot;")}">
            ${defendButtonIconHTML(mode, defendCtx)}
          </button>
        </div>
      `;
      wrapper.dataset.hasArmor = "0";
      wrapper.dataset.defend = "1";
    } else if (useMonsterControls) {
      if ((state.armorMode === "down" || state.armorMode === "reduced") && !armorCtx.armorTypes.includes("heavy")) {
        state.armorMode = "bypass";
      }
      state.defendMode = 0;
      if (!hasArmoredMonsterTarget) state.armorMode = "normal";
      controls.innerHTML = `${hasArmoredMonsterTarget ? `
        <div class="nhd-chat-control">
          <span class="nhd-chat-label">Armor</span>
          <button type="button" class="nhd-chat-cycle nhd-chat-cycle--icon${state.armorMode !== "normal" ? " nhd-chat-cycle--active" : ""}" data-cycle="armor" title="${armorButtonTitle(state.armorMode, armorCtx.armorTypes).replace(/"/g, "&quot;")}">
            ${armorButtonIconHTML(state.armorMode, armorCtx.iconClass)}
          </button>
        </div>` : ""}
        <div class="nhd-chat-control">
          <span class="nhd-chat-label">Res/Vuln</span>
          <button type="button" class="nhd-chat-cycle nhd-chat-cycle--icon${state.resVulnMode !== "normal" ? " nhd-chat-cycle--active" : ""}" data-cycle="res-vuln" title="${resVulnButtonTitle(state.resVulnMode).replace(/"/g, "&quot;")}">
            ${resVulnButtonIconHTML(state.resVulnMode)}
          </button>
        </div>
      `;
      wrapper.dataset.hasArmor = hasArmoredMonsterTarget ? "1" : "0";
      wrapper.dataset.defend = "0";
    } else {
      state.armorMode = "normal";
      state.resVulnMode = "normal";
      state.defendMode = 0;
      controls.innerHTML = "";
      wrapper.dataset.hasArmor = "0";
      wrapper.dataset.defend = "0";
    }
  }

  if (controls && sourceExtras.length) {
    const extraRows = sourceExtras.map((extra) => {
      const rolledEntry = state.extraDamage?.[extra.key] ?? null;
      const rolled = !!rolledEntry;
      return `
        <div class="nhd-chat-control">
          <span class="nhd-chat-label">${foundry.utils.escapeHTML(extra.label)}</span>
          <button type="button" class="nhd-chat-cycle nhd-chat-cycle--icon${rolled ? " nhd-chat-cycle--active" : ""}" data-extra="${escapeAttr(extra.key)}" title="${escapeAttr(getExtraTooltip(extra, rolledEntry))}">
            ${iconForExtraKey(extra.key, rolled)}
          </button>
        </div>`;
    }).join("");
    controls.insertAdjacentHTML("beforeend", extraRows);
  }

  if (preview) {
    preview.innerHTML = renderPreviewHTML(baseDamage, state.armorMode, state.resVulnMode, armorCtx.armorTypes, message, targetProfile, state.defendMode, state.extraDamage);
    preview.setAttribute("aria-label", computePreview(baseDamage, state.armorMode, state.resVulnMode, armorCtx.armorTypes, message, targetProfile, state.defendMode, state.extraDamage));
  }
}

function bindRootRefresh(message, ctx, wrapper) {
  const root = getEffectiveRoot(ctx.root);
  if (!(root instanceof HTMLElement)) return;
  if (root.dataset.nhdRefreshBound === "1") return;
  root.dataset.nhdRefreshBound = "1";

  let refreshTimer = null;
  const queueRefresh = () => {
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      const liveCtx = refreshLiveContext(message, ctx);
      ensureTargetProfile(message, liveCtx, wrapper).finally(() => {
        if (wrapper.isConnected) refreshWrapper(message, liveCtx, wrapper);
      });
    }, 30);
  };

  root.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof Node && wrapper.contains(target)) return;
    queueRefresh();
  });

}

function bindWrapper(message, ctx, wrapper) {
  if (wrapper.dataset.bound === "1") return;
  wrapper.dataset.bound = "1";

  wrapper.addEventListener("click", (event) => {
    const btn = event.target.closest('[data-cycle],[data-extra]');
    if (!btn) return;
    event.preventDefault();
    const state = getState(message.id);
    const cycleType = String(btn.dataset.cycle || "");
    if (cycleType === "armor") {
      const liveCtx = refreshLiveContext(message, ctx);
      const armorCtx = getTargetArmorContext(liveCtx.root, state.targetProfile);
      state.armorMode = nextArmor(state.armorMode, armorCtx.armorTypes);
      refreshWrapper(message, refreshLiveContext(message, ctx), wrapper);
      return;
    } else if (cycleType === "res-vuln") {
      state.resVulnMode = nextResVuln(state.resVulnMode);
      refreshWrapper(message, refreshLiveContext(message, ctx), wrapper);
      return;
    } else if (cycleType === "defend") {
      const defendCtx = state.targetProfile?.defendCtx ?? null;
      const hasShield = (Number(defendCtx?.shieldGear ?? 0) || 0) > 0;
      state.defendMode = nextDefend(state.defendMode, hasShield);
      refreshWrapper(message, refreshLiveContext(message, ctx), wrapper);
      return;
    }
    const extraKey = String(btn.dataset.extra || "");
    if (extraKey) {
      const extra = (state.sourceExtras || []).find(ex => ex.key === extraKey);
      if (!extra) return;
      if (extra.key === "fury") {
        openFuryDiceDialogForActor(state.sourceActor, {
          onChange: async () => { await syncFuryExtraState(message, ctx, wrapper); },
          onClose: async () => { await syncFuryExtraState(message, ctx, wrapper); }
        });
        return;
      }
      rollSimpleExtra(message, ctx, wrapper, extra);
      return;
    }
  });

  wrapper.addEventListener("contextmenu", (event) => {
    const btn = event.target.closest('[data-cycle],[data-extra]');
    if (!btn) return;
    event.preventDefault();
    const state = getState(message.id);
    const cycleType = String(btn.dataset.cycle || "");
    if (cycleType === "armor") state.armorMode = "normal";
    else if (cycleType === "res-vuln") state.resVulnMode = "normal";
    else if (cycleType === "defend") state.defendMode = 0;
    const extraKey = String(btn.dataset.extra || "");
    if (extraKey && extraKey !== "fury") delete state.extraDamage[extraKey];
    refreshWrapper(message, refreshLiveContext(message, ctx), wrapper);
  });
}

async function getCardTargetTokenDocs(message) {
  const liveMessage = message?.id ? game.messages?.get?.(message.id) ?? message : message;
  const targetSources = [
    liveMessage?.reactive?.system?.targets,
    liveMessage?.system?.targets,
    liveMessage?._source?.system?.targets,
    liveMessage?.flags?.nimble?.targets
  ];

  let uuids = [];
  for (const src of targetSources) {
    if (Array.isArray(src) && src.length) {
      uuids = src
        .map((t) => typeof t === "string" ? t : t?.uuid ?? t?.tokenUuid ?? t?.token?.uuid ?? null)
        .filter((u) => typeof u === "string" && u.length);
      if (uuids.length) break;
    }
  }

  const docs = [];
  for (const uuid of uuids) {
    try {
      const doc = await fromUuid(uuid);
      if (doc?.actor) docs.push(doc);
    } catch {}
  }
  return docs;
}

function getConditionKeyFromEnricherButton(btn) {
  try {
    if (!btn) return "";

    const direct = String(
      btn?.dataset?.condition
      ?? btn?.dataset?.statusKey
      ?? btn?.dataset?.statusId
      ?? ""
    ).trim();
    if (direct) return direct;

    let name = String(btn?.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!name) {
      const tip = String(btn?.getAttribute?.("data-tooltip") ?? "");
      const match = tip.match(/<h3[^>]*>(.*?)<\/h3>/i);
      if (match?.[1]) {
        name = String(match[1])
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
    }

    return name;
  } catch {
    return "";
  }
}

async function toggleStatusOnTokenDocsBestEffort(tokenDocs, statusKey, active = true) {
  const docs = Array.isArray(tokenDocs) ? tokenDocs.filter(Boolean) : [];
  const key = String(statusKey ?? "").trim();
  if (!docs.length || !key) return;

  if (!game.user.isGM) {
    const tokenUuids = docs.map((t) => t?.uuid).filter(Boolean);
    if (!tokenUuids.length) return;
    await requestToggleStatus({
      tokenUuids,
      statusKey: key,
      action: active ? "add" : "remove",
      active: !!active
    });
    return;
  }

  const normalized = String(key).toLowerCase().trim();
  let status = (CONFIG.statusEffects ?? []).find(
    (e) => String(e?.id ?? "").toLowerCase().trim() === normalized
  );

  if (!status) {
    status = (CONFIG.statusEffects ?? []).find((e) => {
      const name = String(e?.name ?? e?.label ?? "").toLowerCase().trim();
      return name === normalized;
    });
  }

  const effect = status?.id ?? key;

  for (const tokenDoc of docs) {
    const actor = tokenDoc?.actor ?? null;
    const toggleTarget = tokenDoc?.toggleStatusEffect
      ? tokenDoc
      : actor?.toggleStatusEffect
        ? actor
        : null;
    if (!toggleTarget) continue;

    const statuses = toggleTarget === tokenDoc
      ? (tokenDoc?.actor?.statuses ?? tokenDoc?.statuses)
      : actor?.statuses;

    const exists = statuses?.has?.(effect) ?? false;
    if (active && exists) continue;
    if (!active && !exists) continue;

    await toggleTarget.toggleStatusEffect(effect, { active: !!active });
  }
}

function bindConditionRouting(message, ctx) {
  const root = getEffectiveRoot(ctx.root);
  if (!(root instanceof HTMLElement)) return;
  if (root.dataset.nhdConditionBound === "1") return;
  root.dataset.nhdConditionBound = "1";

  root.addEventListener("click", async (event) => {
    const btn = event.target?.closest?.('button[data-enricher-type="condition"]');
    if (!btn) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    try {
      const liveMessage = game.messages?.get?.(message.id) ?? message;
      const tokenDocs = await getCardTargetTokenDocs(liveMessage);

      if (!tokenDocs.length) {
        ui.notifications?.warn?.("No targets selected on this chat card.");
        return;
      }

      const key = getConditionKeyFromEnricherButton(btn);
      if (!key) return;

      await toggleStatusOnTokenDocsBestEffort(tokenDocs, key, true);
    } catch (err) {
      console.error(`${MODULE_ID} | condition reroute failed`, err);
      ui.notifications?.error?.("Failed to apply condition from chat card.");
    }
  }, true);
}


async function cleanupDyingAfterHealingCard(message) {
  try {
    const liveMessage = game.messages?.get?.(message.id) ?? message;
    const tokenDocs = await getCardTargetTokenDocs(liveMessage);
    const tokenUuids = [];
    for (const t of tokenDocs) {
      const actor = t?.actor;
      const isPC = !!(actor?.hasPlayerOwner || actor?.type === "character" || actor?.type === "pc");
      const hp = Number(foundry.utils.getProperty(actor, "system.attributes.hp.value") ?? 0) || 0;
      const tokenUuid = t?.document?.uuid ?? t?.uuid ?? null;
      if (isPC && hp > 0 && tokenUuid) tokenUuids.push(tokenUuid);
    }
    if (tokenUuids.length) {
      await requestToggleStatus({ tokenUuids, statusKey: "dying", action: "remove", active: false });
    }
  } catch (err) {
    console.error(`${MODULE_ID} | healing status cleanup failed`, err);
  }
}

function bindHealingStatusCleanup(message, root) {
  const searchRoot = getEffectiveRoot(root);
  if (!(searchRoot instanceof HTMLElement)) return;
  const buttons = [...searchRoot.querySelectorAll("button")].filter((btn) => {
    const text = btn.textContent?.trim().toLowerCase() || "";
    const title = btn.getAttribute("title")?.trim().toLowerCase() || "";
    const aria = btn.getAttribute("aria-label")?.trim().toLowerCase() || "";
    return text === "apply healing" || text === "undo healing" || title === "undo healing" || aria === "undo healing";
  });
  for (const btn of buttons) {
    if (btn.dataset.nhdHealingBound === "1") continue;
    btn.dataset.nhdHealingBound = "1";
    btn.addEventListener("click", () => {
      for (const delay of [0, 50, 150, 400]) {
        window.setTimeout(() => { cleanupDyingAfterHealingCard(message); }, delay);
      }
    }, true);
  }
}

function bindApply(message, ctx) {
  if (ctx.applyBtn.dataset.nhdBound === "1") return;
  ctx.applyBtn.dataset.nhdBound = "1";

  ctx.applyBtn.addEventListener("click", async (event) => {
    if (!canCurrentUserUseEnhancedChatCard(message)) return;
    const state = getState(message.id);

    // Always route Apply Damage through the module-managed path so the
    // verification card and undo metadata are generated even when the user
    // accepts the default armor result with no enhanced modifier active.
    event.preventDefault();
    event.stopImmediatePropagation();

    const liveMessage = game.messages?.get?.(message.id) ?? message;
    const tokenDocs = await getCardTargetTokenDocs(liveMessage);
    const baseContext = getCurrentMessageDamageContext(liveMessage);
    const showVerificationCard = !!game.settings.get(MODULE_ID, "show-damage-verification-card");

    await applyEnhancedChatCardDamage({
      message: liveMessage,
      tokenDocs,
      baseContext,
      armorOverrideMode: state.armorMode,
      resVulnMode: state.resVulnMode,
      defendMode: state.defendMode,
      extraDamage: state.extraDamage,
      showVerificationCard
    });
  }, true);
}

Hooks.on("renderChatMessage", (message, html) => {
  try {
    if (!game.settings.get(MODULE_ID, "enable-enhanced-chat-cards")) return;
    const root = html?.[0] ?? html;
    if (root instanceof HTMLElement) bindHealingStatusCleanup(message, root);
    const ctx = detectContext(message, html);
    if (!ctx) return;
    renderWrapper(message, ctx);
  } catch (err) {
    console.error(`${MODULE_ID} | enhanced chat card render failed`, err);
  }
});
