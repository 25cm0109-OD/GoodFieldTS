import {
  GameState,
  GameAction,
  PlayerId,
  Card,
  PlayerState,
  PlayerStats,
  Phase,
  Element as GameElement,
  Ailment,
  PendingTargetedAction,
} from "../domain/types";
import {
  canDefend,
  resolveAttackElementWithLight,
} from "./elementSystem";
import { drawRandomCard, MAX_HAND_SIZE } from "./initialState";

// ---------------------------------------------------------------------------
// Constants & utilities
// ---------------------------------------------------------------------------

export const MAX_STAT = 99;
export const MIN_STAT = 0;

// ---------------------------------------------------------------------------
// Ailment progression tables
// ---------------------------------------------------------------------------

const AILMENT_WORSEN: Partial<Record<Ailment, Ailment | "DEATH">> = {
  "風邪":   "熱病",
  "熱病":   "地獄病",
  "地獄病": "天国病",
  "天国病": "DEATH",
};

const AILMENT_DAMAGE: Partial<Record<Ailment, number>> = {
  "風邪":   1,
  "熱病":   2,
  "地獄病": 5,
};

const AILMENT_HEAL: Partial<Record<Ailment, number>> = {
  "天国病": 5,
};

/** Clamps a stat value to the valid range [0, 99]. */
export function clampStat(value: number): number {
  return Math.min(MAX_STAT, Math.max(MIN_STAT, value));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Draws one card from the pool into the player's hand.
 * If the hand is already at MAX_HAND_SIZE, the draw is skipped (no discard).
 */
function drawCardToHand(player: PlayerState): PlayerState {
  if (player.hand.length >= MAX_HAND_SIZE) {
    return player; // Hand full: skip draw
  }
  const drawn = drawRandomCard();
  return { ...player, hand: [...player.hand, drawn] };
}

function getActivePlayerId(state: GameState): PlayerId {
  return state.playerOrder[state.activePlayerIndex];
}

function getDefenderIds(state: GameState): PlayerId[] {
  // PendingTargetedAction phase: only the currentTargetId faces the defense phase
  if (state.pendingTargetedAction) {
    return [state.pendingTargetedAction.currentTargetId];
  }
  // Ring counter-attack phase: original attacker is now the sole "defender"
  if (state.pendingRingAttack) {
    return [state.playerOrder[state.activePlayerIndex]!];
  }
  // Reflect phase: original attacker defends against the reflected damage
  if (state.pendingReflect) {
    return [state.playerOrder[state.activePlayerIndex]!];
  }
  const activeId = getActivePlayerId(state);
  const alivePlayers = state.playerOrder.filter(
    (id) => id !== activeId && (state.players[id]?.stats.hp ?? 0) > 0
  ) as PlayerId[];
  // Area attack: only players who were hit (by probability roll) need to defend
  if (state.areaHitResults) {
    const hitIds = state.areaHitResults.filter((r) => r.hit).map((r) => r.playerId);
    return alivePlayers.filter((id) => hitIds.includes(id));
  }
  // For single-target attacks only the target needs to confirm defense
  if (state.attackTarget && state.attackTarget !== "ALL") {
    const t = state.attackTarget as PlayerId;
    return alivePlayers.includes(t) ? [t] : [];
  }
  return alivePlayers;
}

function isAttackCard(card: Card): boolean {
  return card.type === "ATTACK";
}

function isDefenseCard(card: Card): boolean {
  return (
    card.type === "DEFENSE" ||
    card.type === "REFLECT_PHYSICAL" ||
    card.type === "REFLECT_ALL" ||
    card.type === "RING"
  );
}

/** Remove the first occurrence of each card (by id) in `cards` from `hand`. */
function removeFromHand(
  hand: readonly Card[],
  cards: readonly Card[]
): Card[] {
  const toRemove = [...cards];
  const result: Card[] = [];
  for (const c of hand) {
    const idx = toRemove.findIndex((r) => r.id === c.id);
    if (idx !== -1) {
      toRemove.splice(idx, 1);
    } else {
      result.push(c);
    }
  }
  return result;
}

/**
 * Plays cards from a player's hand:
 * - Cards with `isMiracle: true` return to the END of the hand with `wasUsed: true`.
 * - All other cards go to the discard pile.
 */
function playCards(player: PlayerState, cards: readonly Card[]): PlayerState {
  const miracle: Card[] = [];
  const toDiscard: Card[] = [];
  for (const c of cards) {
    if (c.isMiracle) miracle.push({ ...c, wasUsed: true });
    else toDiscard.push(c);
  }
  const newHand = [...removeFromHand(player.hand, cards), ...miracle];
  return {
    ...player,
    hand: newHand,
    discard: [...player.discard, ...toDiscard],
  };
}

/**
 * Consume `amount` PAY, falling back to MP then HP if PAY is insufficient.
 * Returns null if the total cost cannot be paid at all.
 */
function consumePay(stats: PlayerStats, amount: number): PlayerStats | null {
  if (amount <= 0) return stats;
  let { hp, mp, pay } = stats;
  let remaining = amount;

  const payUsed = Math.min(pay, remaining);
  pay -= payUsed;
  remaining -= payUsed;

  if (remaining > 0) {
    const mpUsed = Math.min(mp, remaining);
    mp -= mpUsed;
    remaining -= mpUsed;
  }

  if (remaining > 0) {
    const hpUsed = Math.min(hp, remaining);
    hp -= hpUsed;
    remaining -= hpUsed;
  }

  if (remaining > 0) return null; // cannot afford
  return { hp: clampStat(hp), mp: clampStat(mp), pay: clampStat(pay) };
}

/** Apply raw damage to a defender's HP (clamped). */
function applyDamage(
  state: GameState,
  defenderId: PlayerId,
  damage: number
): GameState {
  const defender = state.players[defenderId];
  if (!defender) return state;
  const newHp = clampStat(defender.stats.hp - damage);
  const newDefender: PlayerState = {
    ...defender,
    stats: { ...defender.stats, hp: newHp },
  };
  return {
    ...state,
    players: { ...state.players, [defenderId]: newDefender },
  };
}

/** Draws n cards into the player's hand (respecting MAX_HAND_SIZE). */
function drawNCards(player: PlayerState, n: number): PlayerState {
  let p = player;
  for (let i = 0; i < n; i++) {
    p = drawCardToHand(p);
  }
  return p;
}

/** Shared reset fields applied at end of turn / after PRAY. */
const TURN_RESET: Partial<GameState> = {
  attackCards: [],
  defenseCards: {},
  confirmedDefenders: [],
  attackPlusActive: false,
  attackElementOverride: undefined,
  attackTarget: undefined,
  attackAreaPercent: undefined,
  areaHitResults: undefined,
  miracleUsedThisTurn: false,
  actionUsedThisTurn: false,
  pendingBuyConsent: undefined,
  pendingReflect: undefined,
  pendingRingAttack: undefined,
  pendingAreaTargets: undefined,
  pendingTargetedAction: undefined,
};

// ---------------------------------------------------------------------------
// Sequential area attack helpers
// ---------------------------------------------------------------------------

/**
 * Apply damage from the current sequential area target (state.attackTarget) to that player.
 * Handles reflection by accumulating into pendingReflect.
 * Does NOT modify phase or playerOrder.
 */
function applyAreaTargetDamage(state: GameState): GameState {
  const targetId = state.attackTarget;
  if (!targetId || (targetId as string) === "ALL") return state;
  const tid = targetId as PlayerId;

  const attackElements = state.attackCards.map((c) => c.element);
  const attackElement = resolveAttackElementWithLight(attackElements, state.attackElementOverride);
  const totalAttack = state.attackCards.reduce((sum, c) => sum + c.power, 0);

  const defCards = state.defenseCards[tid] ?? [];
  const hasReflectAll = defCards.some((c) => c.type === "REFLECT_ALL");
  const hasReflectPhys = defCards.some((c) => c.type === "REFLECT_PHYSICAL");
  const hasPhysical = state.attackCards.some((c) => c.type === "ATTACK");
  const hasMagic = state.attackCards.some((c) => !!c.isMiracle);
  const isReflected = hasReflectAll || (hasReflectPhys && hasPhysical && !hasMagic);

  if (isReflected) {
    // Accumulate into pendingReflect so the attacker gets a DEFENSE_PHASE
    const reflectDamage = attackElement === "DARK" ? MAX_STAT : totalAttack;
    const prev = state.pendingReflect;
    const newDamage = prev ? Math.max(prev.damage, reflectDamage) : reflectDamage;
    return {
      ...state,
      pendingReflect: { damage: newDamage, element: attackElement as import("../domain/types").Element },
    };
  }

  const effectiveDefense = defCards
    .filter((c) => canDefend(attackElement as GameElement, c.element))
    .reduce((sum, c) => sum + c.power, 0);
  const rawDamage = Math.max(0, totalAttack - effectiveDefense);

  if (rawDamage === 0) return state;
  if (attackElement === "DARK") {
    return applyDamage(state, tid, MAX_STAT);
  }
  return applyDamage(state, tid, rawDamage);
}

/**
 * Pop the next target from pendingAreaTargets, roll hit/miss, and transition:
 * - If hit → DEFENSE_PHASE for that player (attackTarget = that player)
 * - If miss → recurse to next target
 * - If none left → remove dead players, check game-over, go to END_CHECK (or pendingReflect DEFENSE_PHASE)
 */
function processNextAreaTarget(state: GameState): GameState {
  const pending = state.pendingAreaTargets;
  if (!pending || pending.length === 0) {
    // All area targets processed — remove dead players then continue
    const deadIds = state.playerOrder.filter(
      (id) => (state.players[id]?.stats.hp ?? 0) === 0
    );
    let newState: GameState = state;
    if (deadIds.length > 0) {
      const newOrder = state.playerOrder.filter((id) => !deadIds.includes(id));
      newState = { ...state, playerOrder: newOrder };
      const survivors = newOrder.filter((id) => (newState.players[id]?.stats.hp ?? 0) > 0);
      if (survivors.length <= 1) {
        const isDraw = survivors.length === 0;
        return { ...newState, pendingAreaTargets: undefined, phase: "GAME_OVER", winner: survivors[0], ...(isDraw && { isDraw: true }) };
      }
    }

    // If any reflection occurred, enter DEFENSE_PHASE for the attacker
    if (newState.pendingReflect) {
      const attackerId = getActivePlayerId(newState);
      return {
        ...newState,
        pendingAreaTargets: undefined,
        phase: "DEFENSE_PHASE",
        confirmedDefenders: [],
        defenseCards: { ...newState.defenseCards, [attackerId]: [] },
      };
    }

    return { ...newState, pendingAreaTargets: undefined, phase: "END_CHECK" };
  }

  const [nextTarget, ...remaining] = pending as PlayerId[];
  const areaPercent = state.attackAreaPercent ?? 50;
  const hit =
    state.players[nextTarget]?.ailment === "暗雲" ||
    Math.random() * 100 < areaPercent;

  const newAreaHitResults = [
    ...(state.areaHitResults ?? []),
    { playerId: nextTarget, hit },
  ];
  const newState: GameState = {
    ...state,
    areaHitResults: newAreaHitResults as readonly { readonly playerId: PlayerId; readonly hit: boolean }[],
    pendingAreaTargets: remaining,
  };

  if (hit) {
    return {
      ...newState,
      attackTarget: nextTarget,
      confirmedDefenders: [],
      phase: "DEFENSE_PHASE",
    };
  }
  return processNextAreaTarget(newState);
}

// ---------------------------------------------------------------------------
// Phase resolution
// ---------------------------------------------------------------------------

function resolvePhase(state: GameState): GameState {
  const activeId = getActivePlayerId(state);

  // ── PendingTargetedAction resolve ──────────────────────────────────────────
  if (state.pendingTargetedAction) {
    const pta = state.pendingTargetedAction;
    const defCards = state.defenseCards[pta.currentTargetId] ?? [];
    const hasReflect = defCards.some(
      (c) => c.type === "REFLECT_ALL" || c.type === "REFLECT_PHYSICAL"
    );

    const cleared: GameState = {
      ...state,
      defenseCards: {},
      confirmedDefenders: [],
      pendingTargetedAction: undefined,
    };

    if (hasReflect) {
      // Flip currentTargetId to the other participant and re-enter DEFENSE_PHASE
      const newTarget =
        pta.currentTargetId === pta.casterId
          ? pta.originalTargetId
          : pta.casterId;
      return {
        ...state,
        defenseCards: {},
        confirmedDefenders: [],
        pendingTargetedAction: { ...pta, currentTargetId: newTarget },
        phase: "DEFENSE_PHASE",
      };
    }

    // Apply the effect to currentTargetId
    let newState: GameState = cleared;
    const targetId = pta.currentTargetId;
    const casterId = pta.casterId;

    switch (pta.kind) {
      case "HEAL_HP":
      case "HEAL_MP": {
        const target = newState.players[targetId];
        if (target && pta.healStat && pta.healAmount != null) {
          const newStats = {
            ...target.stats,
            [pta.healStat]: clampStat(target.stats[pta.healStat] + pta.healAmount),
          };
          newState = {
            ...newState,
            players: { ...newState.players, [targetId]: { ...target, stats: newStats } },
          };
        }
        break;
      }
      case "SELL": {
        const item = pta.itemCard;
        const price = pta.price ?? 0;
        const seller = newState.players[casterId];
        const buyer = newState.players[targetId];
        if (!item || !seller || !buyer) break;

        if (targetId === pta.originalTargetId) {
          // Forward: buyer pays, gets item; seller receives PAY, draws 1
          const newBuyerStats = consumePay(buyer.stats, price);
          if (!newBuyerStats) break;
          const sellerPayGain = clampStat(seller.stats.pay + price);
          const newSeller = { ...seller, stats: { ...seller.stats, pay: sellerPayGain } };
          if (buyer.hand.length < MAX_HAND_SIZE) {
            const newBuyer = { ...buyer, stats: newBuyerStats, hand: [...buyer.hand, item] };
            newState = {
              ...newState,
              players: { ...newState.players, [casterId]: newSeller, [targetId]: newBuyer },
            };
          }
          // Draw 1 for the item card removal
          const updatedSeller = newState.players[casterId];
          if (updatedSeller) {
            newState = {
              ...newState,
              players: { ...newState.players, [casterId]: drawNCards(updatedSeller, 1) },
            };
          }
        } else {
          // Reverse: seller (casterId) pays price; item is discarded
          const newSellerStats = consumePay(seller.stats, price);
          const updatedSeller = {
            ...seller,
            stats: newSellerStats ?? seller.stats,
            discard: [...seller.discard, item],
          };
          newState = {
            ...newState,
            players: { ...newState.players, [casterId]: updatedSeller },
          };
        }
        break;
      }
      case "ACCEPT_BUY": {
        const item = pta.itemCard;
        const price = pta.price ?? 0;
        const buyer = newState.players[casterId];
        const seller = newState.players[pta.originalTargetId];
        if (!item || !buyer || !seller) break;

        if (targetId === pta.originalTargetId) {
          // Forward: seller loses item, buyer gains item, buyer pays price
          const newBuyerStats = consumePay(buyer.stats, price);
          if (!newBuyerStats) break;
          const newSellerHand = seller.hand.filter((c) => c.id !== item.id);
          if (buyer.hand.length < MAX_HAND_SIZE) {
            newState = {
              ...newState,
              players: {
                ...newState.players,
                [casterId]: { ...buyer, stats: newBuyerStats, hand: [...buyer.hand, item] },
                [pta.originalTargetId]: { ...seller, hand: newSellerHand },
              },
            };
          }
        } else {
          // Reverse: buyer (casterId = currentTargetId) loses a random card from their hand
          if (buyer.hand.length > 0) {
            const randomIdx = Math.floor(Math.random() * buyer.hand.length);
            const lostCard = buyer.hand[randomIdx]!;
            const newBuyerHand = buyer.hand.filter((_, i) => i !== randomIdx);
            newState = {
              ...newState,
              players: {
                ...newState.players,
                [casterId]: {
                  ...buyer,
                  hand: newBuyerHand,
                  discard: lostCard.isMiracle ? buyer.discard : [...buyer.discard, lostCard],
                },
              },
            };
          }
        }
        break;
      }
      case "USE_DISASTER": {
        const target = newState.players[targetId];
        if (!target || !pta.ailment) break;
        const DISEASE_AILMENTS: Ailment[] = ["風邪", "熱病", "地獄病", "天国病"];
        let newAilment: Ailment | null = pta.ailment;
        let instantDeath = false;
        if (
          DISEASE_AILMENTS.includes(pta.ailment) &&
          target.ailment &&
          DISEASE_AILMENTS.includes(target.ailment)
        ) {
          const worsened = AILMENT_WORSEN[target.ailment];
          if (worsened === "DEATH") {
            instantDeath = true;
            newAilment = null;
          } else if (worsened) {
            newAilment = worsened as Ailment;
          }
        }
        if (instantDeath) {
          newState = applyDamage(newState, targetId, MAX_STAT);
        } else {
          newState = {
            ...newState,
            players: {
              ...newState.players,
              [targetId]: { ...target, ailment: newAilment ?? pta.ailment },
            },
          };
        }
        break;
      }
      case "USE_CLEANSE": {
        const target = newState.players[targetId];
        if (target) {
          newState = {
            ...newState,
            players: { ...newState.players, [targetId]: { ...target, ailment: undefined } },
          };
        }
        break;
      }
      case "USE_DISPEL_MIRACLE": {
        const target = newState.players[targetId];
        if (target) {
          let removed = 0;
          const newHand = target.hand.filter((c) => {
            if (c.isMiracle && c.wasUsed && removed < 2) { removed++; return false; }
            return true;
          });
          newState = {
            ...newState,
            players: { ...newState.players, [targetId]: { ...target, hand: newHand } },
          };
        }
        break;
      }
    }

    // Check for eliminations (e.g., DISASTER instant-death)
    const survivorsPTA = state.playerOrder.filter(
      (id) => (newState.players[id]?.stats.hp ?? 0) > 0
    );
    if (survivorsPTA.length <= 1) {
      const isDraw = survivorsPTA.length === 0;
      return {
        ...newState,
        phase: "GAME_OVER",
        winner: survivorsPTA[0],
        ...(isDraw && { isDraw: true }),
      };
    }
    const eliminatedPTA = state.playerOrder.filter(
      (id) => (newState.players[id]?.stats.hp ?? 0) === 0
    );
    if (eliminatedPTA.length > 0) {
      return {
        ...newState,
        phase: "END_CHECK",
        playerOrder: state.playerOrder.filter((id) => !eliminatedPTA.includes(id)),
      };
    }
    return { ...newState, phase: "END_CHECK" };
  }

  // ── Reflect resolve: original attacker defends against reflected damage ──
  if (state.pendingReflect) {
    const { damage, element: reflectElement } = state.pendingReflect;
    const attackerDefCards = state.defenseCards[activeId] ?? [];
    const attackerEffectiveDefense = attackerDefCards
      .filter((c) => canDefend(reflectElement as GameElement, c.element))
      .reduce((sum, c) => sum + c.power, 0);
    const rawDamage = Math.max(0, damage - attackerEffectiveDefense);

    let newState: GameState = { ...state, pendingReflect: undefined };
    if (rawDamage > 0) {
      newState = applyDamage(newState, activeId, rawDamage);
    }

    const survivors = state.playerOrder.filter(
      (id) => (newState.players[id]?.stats.hp ?? 0) > 0
    );
    if (survivors.length <= 1) {
      const isDraw = survivors.length === 0;
      return { ...newState, phase: "GAME_OVER", winner: survivors[0], ...(isDraw && { isDraw: true }) };
    }
    const eliminatedIds = state.playerOrder.filter(
      (id) => (newState.players[id]?.stats.hp ?? 0) === 0
    );
    if (eliminatedIds.length > 0) {
      return { ...newState, phase: "END_CHECK", playerOrder: state.playerOrder.filter((id) => !eliminatedIds.includes(id)) };
    }
    return { ...newState, phase: "END_CHECK" };
  }

  // ── Ring counter-attack resolve: original attacker defends against ring damage ──
  if (state.pendingRingAttack) {
    const { damage, element: ringElement } = state.pendingRingAttack;
    const attackerDefCards = state.defenseCards[activeId] ?? [];
    const attackerEffectiveDefense = attackerDefCards
      .filter((c) => canDefend(ringElement as GameElement, c.element))
      .reduce((sum, c) => sum + c.power, 0);
    const rawDamage = Math.max(0, damage - attackerEffectiveDefense);

    let newState: GameState = { ...state, pendingRingAttack: undefined };
    if (rawDamage > 0) {
      newState = applyDamage(newState, activeId, rawDamage);
    }

    const survivors = state.playerOrder.filter(
      (id) => (newState.players[id]?.stats.hp ?? 0) > 0
    );
    if (survivors.length <= 1) {
      const isDraw = survivors.length === 0;
      return { ...newState, phase: "GAME_OVER", winner: survivors[0], ...(isDraw && { isDraw: true }) };
    }
    const eliminatedIds = state.playerOrder.filter(
      (id) => (newState.players[id]?.stats.hp ?? 0) === 0
    );
    if (eliminatedIds.length > 0) {
      return { ...newState, phase: "END_CHECK", playerOrder: state.playerOrder.filter((id) => !eliminatedIds.includes(id)) };
    }
    return { ...newState, phase: "END_CHECK" };
  }

  // ── Normal attack resolution ──
  const attackElements = state.attackCards.map((c) => c.element);
  const attackElement = resolveAttackElementWithLight(
    attackElements,
    state.attackElementOverride
  );
  const totalAttack = state.attackCards.reduce((sum, c) => sum + c.power, 0);

  const allDefenders = getDefenderIds(state);

  const targets: PlayerId[] =
    state.areaHitResults
      ? (state.areaHitResults.filter((r) => r.hit).map((r) => r.playerId) as PlayerId[])
      : state.attackTarget === "ALL"
      ? allDefenders
      : state.attackTarget
      ? [state.attackTarget as PlayerId]
      : [allDefenders[Math.floor(Math.random() * allDefenders.length)]!];

  const hasPhysicalAttack = state.attackCards.some((c) => c.type === "ATTACK" && !c.isMiracle);
  const hasMagicAttack = state.attackCards.some((c) => !!c.isMiracle);

  let newState: GameState = state;
  let totalRingCounterDamage = 0;
  let ringCounterElement: GameElement = "NEUTRAL";

  for (const defenderId of targets) {
    const defCards = state.defenseCards[defenderId] ?? [];

    const hasReflectAll = defCards.some((c) => c.type === "REFLECT_ALL");
    const hasReflectPhys = defCards.some((c) => c.type === "REFLECT_PHYSICAL");
    const isReflected =
      hasReflectAll || (hasReflectPhys && hasPhysicalAttack && !hasMagicAttack);

    if (isReflected) {
      // Reflected: attacker defends in a new DEFENSE_PHASE (pendingReflect)
      const reflectDamage = attackElement === "DARK" ? MAX_STAT : totalAttack;
      return {
        ...newState,
        phase: "DEFENSE_PHASE",
        confirmedDefenders: [],
        defenseCards: { ...newState.defenseCards, [activeId]: [] },
        pendingReflect: { damage: reflectDamage, element: attackElement as import("../domain/types").Element },
      };
    } else {
      const ringCards = defCards.filter((c) => c.type === "RING");
      const nonRingDefCards = defCards.filter(
        (c) => c.type !== "RING" && canDefend(attackElement, c.element)
      );
      const effectiveDefense = nonRingDefCards.reduce((sum, c) => sum + c.power, 0);
      const rawDamage = Math.max(0, totalAttack - effectiveDefense);

      if (rawDamage > 0) {
        if (attackElement === "DARK") {
          newState = applyDamage(newState, defenderId, MAX_STAT);
        } else {
          newState = applyDamage(newState, defenderId, rawDamage);
        }
        // RING counter: accumulate counter damage
        if (ringCards.length > 0) {
          totalRingCounterDamage += rawDamage;
          ringCounterElement = (ringCards[0]!.element as GameElement) ?? "NEUTRAL";
        }
      }
    }
  }

  // If ring counter damage, enter a defense phase for the original attacker
  if (totalRingCounterDamage > 0) {
    return {
      ...newState,
      phase: "DEFENSE_PHASE",
      confirmedDefenders: [],
      defenseCards: { ...newState.defenseCards, [activeId]: [] },
      pendingRingAttack: { damage: totalRingCounterDamage, element: ringCounterElement, fromPlayerId: targets[0]! },
    };
  }

  // No ring counter: check for eliminations then proceed
  const eliminatedIds = state.playerOrder.filter(
    (id) => (newState.players[id]?.stats.hp ?? 0) === 0
  );
  if (eliminatedIds.length > 0) {
    const survivors = state.playerOrder.filter(
      (id) => (newState.players[id]?.stats.hp ?? 0) > 0
    );
    if (survivors.length <= 1) {
      const isDraw = survivors.length === 0;
      return { ...newState, phase: "GAME_OVER", winner: survivors[0], ...(isDraw && { isDraw: true }) };
    }
    const newOrder = state.playerOrder.filter(
      (id) => !eliminatedIds.includes(id)
    );
    return { ...newState, phase: "END_CHECK", playerOrder: newOrder };
  }

  return { ...newState, phase: "END_CHECK" };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function gameReducer(state: GameState, action: GameAction): GameState {
  if (state.phase === "GAME_OVER") return state;

  const activeId = getActivePlayerId(state);
  const activePlayer = state.players[activeId];
  if (!activePlayer) return state;

  switch (action.type) {
    // ----- DRAW_PHASE -------------------------------------------------------
    case "DRAW": {
      if (state.phase !== "DRAW_PHASE") return state;

      // Apply ailment effects for the active player
      let newState: GameState = state;
      const activePlayer = state.players[activeId];
      if (activePlayer?.ailment) {
        const ailment = activePlayer.ailment;

        // Apply per-turn damage or heal
        const dmg = AILMENT_DAMAGE[ailment];
        const heal = AILMENT_HEAL[ailment];
        if (dmg) {
          newState = applyDamage(newState, activeId, dmg);
        } else if (heal) {
          const p = newState.players[activeId]!;
          const newHp = clampStat(p.stats.hp + heal);
          newState = {
            ...newState,
            players: {
              ...newState.players,
              [activeId]: { ...p, stats: { ...p.stats, hp: newHp } },
            },
          };
          // 天国病: 5% chance of instant death
          if (ailment === "天国病" && Math.random() < 0.05) {
            newState = applyDamage(newState, activeId, MAX_STAT);
          }
        }

        // 5% chance of natural worsening each turn
        if (Math.random() < 0.05) {
          const nextAilment = AILMENT_WORSEN[ailment];
          if (nextAilment === "DEATH") {
            newState = applyDamage(newState, activeId, MAX_STAT);
          } else if (nextAilment) {
            const p2 = newState.players[activeId];
            if (p2) {
              newState = {
                ...newState,
                players: {
                  ...newState.players,
                  [activeId]: { ...p2, ailment: nextAilment as Ailment },
                },
              };
            }
          }
        }

        // Check if player died from ailment damage
        const hpAfter = newState.players[activeId]?.stats.hp ?? 0;
        if (hpAfter === 0) {
          const survivors = state.playerOrder.filter(
            (id) => (newState.players[id]?.stats.hp ?? 0) > 0
          );
          if (survivors.length <= 1) {
            const isDraw = survivors.length === 0;
            return { ...newState, phase: "GAME_OVER", winner: survivors[0], ...(isDraw && { isDraw: true }) };
          }
          const newOrder = state.playerOrder.filter(
            (id) => (newState.players[id]?.stats.hp ?? 0) > 0
          );
          const nextIndex = newOrder.indexOf(survivors[0]!);
          return {
            ...newState,
            phase: "DRAW_PHASE",
            playerOrder: newOrder,
            activePlayerIndex: nextIndex >= 0 ? nextIndex : 0,
          };
        }
      }

      return {
        ...newState,
        phase: "EXCHANGE_PHASE",
        miracleUsedThisTurn: false,
        actionUsedThisTurn: false,
      };
    }

    // ----- EXCHANGE_PHASE ---------------------------------------------------
    case "EXCHANGE": {
      if (state.phase !== "EXCHANGE_PHASE") return state;
      // 1 action per turn
      if (state.actionUsedThisTurn) return state;

      const { allocations, cardId } = action;
      const { hp, mp, pay } = allocations;

      // Must provide a cardId and the card must be in hand
      if (!cardId) return state;
      const exchangeCard = activePlayer.hand.find(
        (c) => c.id === cardId && c.type === "EXCHANGE"
      );
      if (!exchangeCard) return state;

      if (hp < 0 || mp < 0 || pay < 0) return state;
      if (hp > 99 || mp > 99 || pay > 99) return state;

      const currentTotal =
        activePlayer.stats.hp + activePlayer.stats.mp + activePlayer.stats.pay;
      if (hp + mp + pay !== currentTotal) return state;

      const newStats = { hp: clampStat(hp), mp: clampStat(mp), pay: clampStat(pay) };
      // Play the exchange card then draw 1 (non-permanent → 1 draw)
      let newPlayer = playCards(activePlayer, [exchangeCard]);
      newPlayer = drawNCards(newPlayer, 1);
      newPlayer = { ...newPlayer, stats: newStats };

      const newState: GameState = {
        ...state,
        players: { ...state.players, [activeId]: newPlayer },
        actionUsedThisTurn: true,
      };

      if (hp === 0) {
        const winner = getDefenderIds(state)[0];
        return { ...newState, phase: "GAME_OVER", winner };
      }

      return newState;
    }

    case "END_EXCHANGE": {
      if (state.phase !== "EXCHANGE_PHASE") return state;
      // Attack already transitions to DEFENSE_PHASE itself, so if we're still here
      // no attack was made → skip defense/resolve and advance to next turn directly.
      const nextIndex = (state.activePlayerIndex + 1) % state.playerOrder.length;
      return {
        ...state,
        activePlayerIndex: nextIndex,
        phase: "DRAW_PHASE",
        ...TURN_RESET,
      };
    }

    // ----- BUY (EXCHANGE_PHASE) --------------------------------------------
    case "BUY": {
      if (state.phase !== "EXCHANGE_PHASE") return state;
      // 1 action per turn
      if (state.actionUsedThisTurn) return state;
      const { buyCardId, targetId } = action;

      const buyCard = activePlayer.hand.find(
        (c) => c.id === buyCardId && c.type === "BUY"
      );
      if (!buyCard) return state;

      const target = state.players[targetId];
      if (!target || target.hand.length === 0) return state;

      // Randomly reveal a card from target's hand (not removed yet)
      const revealIdx = Math.floor(Math.random() * target.hand.length);
      const revealedCard = target.hand[revealIdx]!;

      // Consume the BUY card and draw 1 (cost is charged only on ACCEPT_BUY)
      let newBuyer = playCards(activePlayer, [buyCard]);
      newBuyer = drawNCards(newBuyer, 1);

      return {
        ...state,
        players: { ...state.players, [activeId]: newBuyer },
        actionUsedThisTurn: true,
        pendingBuyConsent: { buyerId: activeId, targetId, revealedCard },
      };
    }

    // ----- ACCEPT_BUY / DECLINE_BUY (buyer decides after seeing the card) ---
    case "ACCEPT_BUY": {
      if (!state.pendingBuyConsent) return state;
      const { buyerId, targetId: sellerId, revealedCard } = state.pendingBuyConsent;
      if (action.playerId !== buyerId) return state;

      const buyer = state.players[buyerId];
      const seller = state.players[sellerId];
      if (!buyer || !seller) return { ...state, pendingBuyConsent: undefined };

      // Verify the card is still in seller's hand
      const stillInHand = seller.hand.some((c) => c.id === revealedCard.id);
      if (!stillInHand) return { ...state, pendingBuyConsent: undefined };

      // Verify buyer has room
      if (buyer.hand.length >= MAX_HAND_SIZE) return { ...state, pendingBuyConsent: undefined };

      // Verify buyer can afford (pre-check only; actual payment happens in resolve)
      const cost = revealedCard.payCost ?? 0;
      const testBuyerStats = consumePay(buyer.stats, cost);
      if (!testBuyerStats) return { ...state, pendingBuyConsent: undefined };

      // Stage: enter DEFENSE_PHASE for the seller to react
      return {
        ...state,
        pendingBuyConsent: undefined,
        pendingTargetedAction: {
          kind: "ACCEPT_BUY",
          casterId: buyerId,
          originalTargetId: sellerId,
          currentTargetId: sellerId,
          itemCard: revealedCard,
          price: cost,
        },
        phase: "DEFENSE_PHASE",
        defenseCards: {},
        confirmedDefenders: [],
      };
    }

    case "DECLINE_BUY": {
      if (!state.pendingBuyConsent) return state;
      if (action.playerId !== state.pendingBuyConsent.buyerId) return state;
      return { ...state, pendingBuyConsent: undefined };
    }

    // ----- SELL (EXCHANGE_PHASE) -------------------------------------------
    case "SELL": {
      if (state.phase !== "EXCHANGE_PHASE") return state;
      // 1 action per turn
      if (state.actionUsedThisTurn) return state;
      const { sellCardId, itemCardId, targetId } = action;

      const sellCard = activePlayer.hand.find(
        (c) => c.id === sellCardId && c.type === "SELL"
      );
      const itemCard = activePlayer.hand.find((c) => c.id === itemCardId);
      if (!sellCard || !itemCard || sellCard.id === itemCard.id) return state;
      // Cannot sell a once-used miracle card
      if (itemCard.isMiracle && itemCard.wasUsed) return state;

      const target = state.players[targetId];
      if (!target) return state;

      const price = itemCard.payCost ?? 0;

      // Play SELL card (draw 1), remove item from hand for staging
      let newSeller = playCards(activePlayer, [sellCard]);
      newSeller = drawNCards(newSeller, 1);
      // Remove item from seller's hand — stored in PTA; draw happens after resolve
      newSeller = {
        ...newSeller,
        hand: newSeller.hand.filter((c) => c.id !== itemCard.id),
      };

      return {
        ...state,
        players: { ...state.players, [activeId]: newSeller },
        actionUsedThisTurn: true,
        pendingTargetedAction: {
          kind: "SELL",
          casterId: activeId,
          originalTargetId: targetId,
          currentTargetId: targetId,
          itemCard,
          price,
        },
        phase: "DEFENSE_PHASE",
        defenseCards: {},
        confirmedDefenders: [],
      };
    }

    // ----- USE_HEAL (EXCHANGE_PHASE) ----------------------------------------
    case "USE_HEAL": {
      if (state.phase !== "EXCHANGE_PHASE") return state;
      // 1 action per turn
      if (state.actionUsedThisTurn) return state;
      const healCard = activePlayer.hand.find(
        (c) => c.id === action.cardId &&
          (c.type === "HEAL_HP" || c.type === "HEAL_MP" || c.type === "HEAVEN_DISEASE_HEAL")
      );
      if (!healCard) return state;

      // HEAVEN_DISEASE_HEAL: restores MP to self and applies 天国病 ailment to self
      if (healCard.type === "HEAVEN_DISEASE_HEAL") {
        const newMp = clampStat(activePlayer.stats.mp + healCard.power);
        let newActivePlayer = playCards(activePlayer, [healCard]);
        newActivePlayer = drawNCards(newActivePlayer, 1);
        newActivePlayer = {
          ...newActivePlayer,
          stats: { ...newActivePlayer.stats, mp: newMp },
          ailment: "天国病",
        };
        return {
          ...state,
          players: { ...state.players, [activeId]: newActivePlayer },
          actionUsedThisTurn: true,
        };
      }

      const healTargetId = action.targetId ?? activeId;
      const healTarget = state.players[healTargetId];
      if (!healTarget) return state;

      const stat = healCard.type === "HEAL_HP" ? "hp" : "mp";

      // Remove card from active player's hand and draw
      let newActivePlayer = playCards(activePlayer, [healCard]);
      if (!healCard.isMiracle) {
        newActivePlayer = drawNCards(newActivePlayer, 1);
      }

      // Targeting an opponent: stage as PendingTargetedAction → DEFENSE_PHASE
      if (healTargetId !== activeId) {
        return {
          ...state,
          players: { ...state.players, [activeId]: newActivePlayer },
          actionUsedThisTurn: true,
          pendingTargetedAction: {
            kind: healCard.type as "HEAL_HP" | "HEAL_MP",
            casterId: activeId,
            originalTargetId: healTargetId,
            currentTargetId: healTargetId,
            healAmount: healCard.power,
            healStat: stat,
          },
          phase: "DEFENSE_PHASE",
          defenseCards: {},
          confirmedDefenders: [],
        };
      }

      // Self-target: apply heal immediately
      const newTargetStats = {
        ...healTarget.stats,
        [stat]: clampStat(healTarget.stats[stat] + healCard.power),
      };
      return {
        ...state,
        players: {
          ...state.players,
          [activeId]: { ...newActivePlayer, stats: newTargetStats },
        },
        actionUsedThisTurn: true,
      };
    }

    // ----- USE_CLEANSE (EXCHANGE_PHASE) ----------------------------------------
    case "USE_CLEANSE": {
      if (state.phase !== "EXCHANGE_PHASE") return state;
      if (state.actionUsedThisTurn) return state;
      const cleanseCard = activePlayer.hand.find(
        (c) => c.id === action.cardId && c.type === "CLEANSE"
      );
      if (!cleanseCard) return state;

      const targetId = action.targetId ?? activeId;
      const target = state.players[targetId];
      if (!target) return state;

      // Pay the PAY cost
      const cost = cleanseCard.payCost ?? 0;
      if (activePlayer.stats.pay < cost) return state;

      let newActivePlayer = {
        ...activePlayer,
        stats: { ...activePlayer.stats, pay: clampStat(activePlayer.stats.pay - cost) },
      };
      newActivePlayer = playCards(newActivePlayer, [cleanseCard]);
      newActivePlayer = drawNCards(newActivePlayer, 1);

      // Targeting an opponent: stage as PendingTargetedAction → DEFENSE_PHASE
      if (targetId !== activeId) {
        return {
          ...state,
          players: { ...state.players, [activeId]: newActivePlayer },
          actionUsedThisTurn: true,
          pendingTargetedAction: {
            kind: "USE_CLEANSE",
            casterId: activeId,
            originalTargetId: targetId,
            currentTargetId: targetId,
          },
          phase: "DEFENSE_PHASE",
          defenseCards: {},
          confirmedDefenders: [],
        };
      }

      // Self-target: apply immediately
      return {
        ...state,
        players: { ...state.players, [activeId]: { ...newActivePlayer, ailment: undefined } },
        actionUsedThisTurn: true,
      };
    }

    // ----- USE_DISPEL_MIRACLE (EXCHANGE_PHASE) ----------------------------------------
    case "USE_DISPEL_MIRACLE": {
      if (state.phase !== "EXCHANGE_PHASE") return state;
      if (state.actionUsedThisTurn) return state;
      const dispelCard = activePlayer.hand.find(
        (c) => c.id === action.cardId && c.type === "DISPEL_MIRACLE"
      );
      if (!dispelCard) return state;

      const targetId = action.targetId;
      const target = state.players[targetId];
      if (!target) return state;

      // Pay the PAY cost
      const cost = dispelCard.payCost ?? 0;
      if (activePlayer.stats.pay < cost) return state;

      let newActivePlayer = {
        ...activePlayer,
        stats: { ...activePlayer.stats, pay: clampStat(activePlayer.stats.pay - cost) },
      };
      newActivePlayer = playCards(newActivePlayer, [dispelCard]);
      newActivePlayer = drawNCards(newActivePlayer, 1);

      // Always stage as PendingTargetedAction (targetId is always explicit for DISPEL_MIRACLE)
      return {
        ...state,
        players: { ...state.players, [activeId]: newActivePlayer },
        actionUsedThisTurn: true,
        pendingTargetedAction: {
          kind: "USE_DISPEL_MIRACLE",
          casterId: activeId,
          originalTargetId: targetId,
          currentTargetId: targetId,
        },
        phase: "DEFENSE_PHASE",
        defenseCards: {},
        confirmedDefenders: [],
      };
    }

    // ----- ATTACK (EXCHANGE_PHASE) ------------------------------------------
    case "ATTACK": {
      if (state.phase !== "EXCHANGE_PHASE") return state;
      // 1 action per turn (attack is the exception only for +card bundles, not after other actions)
      if (state.actionUsedThisTurn) return state;

      const { cards, lightAsElement, target } = action;
      if (cards.length === 0) return state;
      if (!cards.every(isAttackCard)) return state;

      // At most 1 non-bonus (main) attack card; any number of attackPlus/doubler cards.
      // attackPlus/doubler cards may also be used solo (mainCards.length === 0).
      const mainCards = cards.filter((c) => !c.attackPlus && !c.doubler);
      if (mainCards.length > 1) return state;
      // Must have at least 1 card total with actual attack (main OR attackPlus solo)
      if (mainCards.length === 0 && !cards.some((c) => c.attackPlus || c.doubler)) return state;

      // Miracle attack: once per turn
      const hasMiracle = cards.some((c) => !!c.isMiracle);
      if (hasMiracle && state.miracleUsedThisTurn) return state;

      // Only miracle cards cost MP; normal ATTACK cards are free
      const totalMpCost = cards
        .filter((c) => !!c.isMiracle)
        .reduce((sum, c) => sum + c.mpCost, 0);
      if (activePlayer.stats.mp < totalMpCost) return state;

      const newMp = clampStat(activePlayer.stats.mp - totalMpCost);
      // Play cards; miracle ones return to hand
      let newPlayer = playCards(
        { ...activePlayer, stats: { ...activePlayer.stats, mp: newMp } },
        cards
      );
      // Draw for each non-miracle card played
      const nonMiracleCount = cards.filter((c) => !c.isMiracle).length;
      newPlayer = drawNCards(newPlayer, nonMiracleCount);

      const hasAttackPlus = cards.some((c) => c.attackPlus || c.doubler);

      // Area attack: derive target and percent from card properties
      const areaPercent = cards.find((c) => c.areaAttackPercent)?.areaAttackPercent;
      const newTarget: PlayerId | "ALL" | undefined = areaPercent
        ? "ALL"
        : target ?? state.attackTarget;

      // 霧: if the attacker has 霧, randomize single-target attacks
      let finalTarget = newTarget;
      if (activePlayer.ailment === "霧" && finalTarget && finalTarget !== "ALL") {
        const aliveEnemies2 = state.playerOrder.filter(
          (id) => id !== activeId && (state.players[id]?.stats.hp ?? 0) > 0
        ) as PlayerId[];
        if (aliveEnemies2.length > 0) {
          finalTarget = aliveEnemies2[Math.floor(Math.random() * aliveEnemies2.length)]!;
        }
      }

      // Self-targeted attack: no one needs to defend, skip straight to RESOLVE
      const selfTargeted = finalTarget === activeId;

      // Auto-pick target when there's exactly one alive enemy and no target is specified
      if (!areaPercent && !finalTarget) {
        const aliveEnemies3 = state.playerOrder.filter(
          (id) => id !== activeId && (state.players[id]?.stats.hp ?? 0) > 0
        ) as PlayerId[];
        if (aliveEnemies3.length === 1) {
          finalTarget = aliveEnemies3[0]!;
        }
      }
      // Guard: for non-area attacks, require an explicit target
      if (!areaPercent && !finalTarget) return state;

      const baseState: GameState = {
        ...state,
        players: { ...state.players, [activeId]: newPlayer },
        attackCards: [...state.attackCards, ...cards],
        attackPlusActive: hasAttackPlus,
        attackElementOverride: lightAsElement ?? state.attackElementOverride,
        attackTarget: finalTarget,
        attackAreaPercent: areaPercent ?? state.attackAreaPercent,
        areaHitResults: areaPercent ? [] : undefined,
        miracleUsedThisTurn: hasMiracle ? true : state.miracleUsedThisTurn,
        actionUsedThisTurn: true,
      };

      if (selfTargeted) {
        return { ...baseState, phase: "RESOLVE_PHASE" };
      }

      if (areaPercent) {
        // Sequential area attack: collect alive enemies, process one-by-one
        const aliveEnemies = state.playerOrder.filter(
          (id) => id !== activeId && (state.players[id]?.stats.hp ?? 0) > 0
        ) as PlayerId[];
        return processNextAreaTarget({ ...baseState, pendingAreaTargets: aliveEnemies });
      }

      return { ...baseState, phase: "DEFENSE_PHASE" };
    }

    case "CONFIRM_ATTACK": {
      // No-op: ATTACK_PHASE no longer exists; kept for backward compatibility
      return state;
    }

    case "PRAY": {
      if (state.phase !== "EXCHANGE_PHASE") return state;
      if (activePlayer.hand.some(isAttackCard)) return state;

      const newPlayer = drawCardToHand(activePlayer);
      const nextIndex =
        (state.activePlayerIndex + 1) % state.playerOrder.length;

      return {
        ...state,
        players: { ...state.players, [activeId]: newPlayer },
        activePlayerIndex: nextIndex,
        phase: "DRAW_PHASE",
        ...TURN_RESET,
      };
    }

    // ----- DEFENSE_PHASE ----------------------------------------------------
    case "DEFEND": {
      if (state.phase !== "DEFENSE_PHASE") return state;
      const { playerId, cards: defCards } = action;

      // Only allow actual defenders (includes attacker during ring counter-attack phase)
      if (!getDefenderIds(state).includes(playerId)) return state;
      if (!defCards.every(isDefenseCard)) return state;

      // PendingTargetedAction phase: only REFLECT cards are valid
      if (state.pendingTargetedAction) {
        if (!defCards.every((c) => c.type === "REFLECT_ALL" || c.type === "REFLECT_PHYSICAL")) {
          return state;
        }
      }

      // 閃光 ailment: can only use 1 defense card
      const defenderAilment = state.players[playerId]?.ailment;
      if (defenderAilment === "閃光" && defCards.length > 1) return state;

      const defender = state.players[playerId];
      if (!defender) return state;

      // Only miracle cards cost MP; limit 1 miracle card per DEFEND action
      const miracleDefCards = defCards.filter((c) => !!c.isMiracle);
      if (miracleDefCards.length > 1) return state;
      const miracleCost = miracleDefCards.reduce((sum, c) => sum + c.mpCost, 0);
      if (defender.stats.mp < miracleCost) return state;

      const newMp = clampStat(defender.stats.mp - miracleCost);
      let newDefender = playCards(
        { ...defender, stats: { ...defender.stats, mp: newMp } },
        defCards
      );

      // Draw for each non-miracle defense card used
      const nonMiracleDefCount = defCards.filter((c) => !c.isMiracle).length;
      for (let i = 0; i < nonMiracleDefCount; i++) {
        newDefender = drawCardToHand(newDefender);
      }

      const existing = state.defenseCards[playerId] ?? [];
      return {
        ...state,
        players: { ...state.players, [playerId]: newDefender },
        defenseCards: {
          ...state.defenseCards,
          [playerId]: [...existing, ...defCards],
        },
      };
    }

    case "CONFIRM_DEFENSE": {
      if (state.phase !== "DEFENSE_PHASE") return state;
      const { playerId } = action;

      if (!getDefenderIds(state).includes(playerId)) return state;

      const newConfirmed = state.confirmedDefenders.includes(playerId)
        ? state.confirmedDefenders
        : [...state.confirmedDefenders, playerId];

      const allDefenders = getDefenderIds(state);
      const allConfirmed = allDefenders.every((id) =>
        newConfirmed.includes(id)
      );

      if (allConfirmed) {
        // Sequential area attack: apply damage for this target then process next
        if (state.pendingAreaTargets !== undefined) {
          const dmgState = applyAreaTargetDamage({ ...state, confirmedDefenders: newConfirmed });
          return processNextAreaTarget(dmgState);
        }
        // Normal: go to RESOLVE_PHASE
        return { ...state, confirmedDefenders: newConfirmed, phase: "RESOLVE_PHASE" };
      }
      return { ...state, confirmedDefenders: newConfirmed };
    }

    // ----- RESOLVE_PHASE ----------------------------------------------------
    case "RESOLVE": {
      if (state.phase !== "RESOLVE_PHASE") return state;
      return resolvePhase(state);
    }

    // ----- END_CHECK --------------------------------------------------------
    case "END_TURN": {
      if (state.phase !== "END_CHECK") return state;
      const nextIndex =
        (state.activePlayerIndex + 1) % state.playerOrder.length;
      return {
        ...state,
        activePlayerIndex: nextIndex,
        phase: "DRAW_PHASE",
        ...TURN_RESET,
      };
    }

    // ----- USE_DISASTER (EXCHANGE_PHASE) ----------------------------------------
    case "USE_DISASTER": {
      if (state.phase !== "EXCHANGE_PHASE") return state;
      if (state.actionUsedThisTurn) return state;
      const disasterCard = activePlayer.hand.find(
        (c) => c.id === action.cardId && c.type === "DISASTER"
      );
      if (!disasterCard?.ailment) return state;

      const targetId = action.targetId;
      const targetPlayer = state.players[targetId];
      if (!targetPlayer) return state;

      // Pay the PAY cost
      const cost = disasterCard.payCost ?? 0;
      if (activePlayer.stats.pay < cost) return state;

      // Remove disaster card from active player's hand and draw a replacement
      let newActivePlayer: PlayerState = {
        ...activePlayer,
        stats: { ...activePlayer.stats, pay: clampStat(activePlayer.stats.pay - cost) },
      };
      newActivePlayer = playCards(newActivePlayer, [disasterCard]);
      newActivePlayer = drawNCards(newActivePlayer, 1);

      // Targeting an opponent: stage as PendingTargetedAction → DEFENSE_PHASE
      if (targetId !== activeId) {
        return {
          ...state,
          players: { ...state.players, [activeId]: newActivePlayer },
          actionUsedThisTurn: true,
          pendingTargetedAction: {
            kind: "USE_DISASTER",
            casterId: activeId,
            originalTargetId: targetId,
            currentTargetId: targetId,
            ailment: disasterCard.ailment,
          },
          phase: "DEFENSE_PHASE",
          defenseCards: {},
          confirmedDefenders: [],
        };
      }

      // Self-target: apply immediately (disease chain handled inline)
      const ailmentToApply = disasterCard.ailment;
      const DISEASE_AILMENTS: Ailment[] = ["風邪", "熱病", "地獄病", "天国病"];
      let newAilment: Ailment | null = ailmentToApply;
      let instantDeath = false;
      if (
        DISEASE_AILMENTS.includes(ailmentToApply) &&
        newActivePlayer.ailment &&
        DISEASE_AILMENTS.includes(newActivePlayer.ailment)
      ) {
        const worsened = AILMENT_WORSEN[newActivePlayer.ailment];
        if (worsened === "DEATH") { instantDeath = true; newAilment = null; }
        else if (worsened) { newAilment = worsened as Ailment; }
      }
      const selfAfter = instantDeath
        ? { ...newActivePlayer, stats: { ...newActivePlayer.stats, hp: 0 } }
        : { ...newActivePlayer, ailment: newAilment ?? ailmentToApply };
      const selfGameState: GameState = {
        ...state,
        players: { ...state.players, [activeId]: selfAfter },
        actionUsedThisTurn: true,
      };
      if (instantDeath) {
        const survivors = state.playerOrder.filter(id => (selfGameState.players[id]?.stats.hp ?? 0) > 0);
        if (survivors.length <= 1) {
          const isDraw = survivors.length === 0;
          return { ...selfGameState, phase: "GAME_OVER", winner: survivors[0], ...(isDraw && { isDraw: true }) };
        }
        const newOrder = state.playerOrder.filter(id => (selfGameState.players[id]?.stats.hp ?? 0) > 0);
        return { ...selfGameState, phase: "END_CHECK", playerOrder: newOrder };
      }
      return selfGameState;
    }

    default:
      return state;
  }
}
