export type Ailment =
  | "風邪"      // -1 HP/turn, worsens to 熱病
  | "熱病"      // -2 HP/turn, worsens to 地獄病
  | "地獄病"    // -5 HP/turn, worsens to 天国病
  | "天国病"    // +5 HP/turn, worsens to instant death
  | "霧"        // attacker's target randomized; others see "???" for stats
  | "閃光"      // can only use 1 defense card per defense phase
  | "夢"        // drawn cards appear as other cards (UI cosmetic only)
  | "暗雲";     // area attacks always hit this player

export type Element =
  | "NEUTRAL"
  | "FIRE"
  | "WATER"
  | "WOOD"
  | "EARTH"
  | "LIGHT"
  | "DARK";

export type CardType =
  | "ATTACK"
  | "DEFENSE"
  | "EXCHANGE"
  | "SELL"
  | "BUY"
  | "HEAL_HP"
  | "HEAL_MP"
  /** Reflects physical (non-miracle ATTACK) attacks back to the attacker. */
  | "REFLECT_PHYSICAL"
  /** Reflects any attack (including miracle attacks) back to the attacker. */
  | "REFLECT_ALL"
  | "DISASTER"
  /** Counter-ring: defense power 0; when HP damage is taken, fires same damage back to attacker. */
  | "RING"
  /** Removes the target player's ailment. */
  | "CLEANSE"
  /** Removes up to 2 wasUsed miracle cards from target's hand. */
  | "DISPEL_MIRACLE"
  /** Heals user's MP by card power and inflicts 天国病 on the user. */
  | "HEAVEN_DISEASE_HEAL";

export type PlayerId =
  | "P1"
  | "P2"
  | "P3"
  | "P4"
  | "P5"
  | "P6"
  | "P7"
  | "P8"
  | "P9";

export type Phase =
  | "DRAW_PHASE"
  | "EXCHANGE_PHASE"
  | "DEFENSE_PHASE"
  | "RESOLVE_PHASE"
  | "END_CHECK"
  | "GAME_OVER";

export interface Card {
  readonly id: string;
  readonly name: string;
  readonly type: CardType;
  readonly element: Element;
  readonly power: number;
  readonly mpCost: number;
  /** PAY cost; falls back to MP → HP when PAY is insufficient. */
  readonly payCost?: number;
  readonly attackPlus?: boolean;
  readonly doubler?: boolean;
  /**
   * Miracle cards: cost MP when used (mpCost is consumed) and return to
   * the end of hand after use instead of being discarded.
   */
  readonly isMiracle?: boolean;
  /** True once a miracle card has been used at least once (returned to hand). Used as DISPEL_MIRACLE target. */
  readonly wasUsed?: boolean;
  /** Area attack: deals this % of total attack power to each defender. */
  readonly areaAttackPercent?: 25 | 50 | 75;
  /** Optional card image filename (e.g. "fire_sword.png") served from /card-images/. */
  readonly image?: string;
  /** For DISASTER cards: the ailment this card inflicts on the target. */
  readonly ailment?: Ailment;
  /**
   * Set when a card is drawn by a player with 夢 ailment (50% chance).
   * The card is displayed with this fake identity; clicking reveals the real card.
   * The engine always uses the real card data.
   */
  readonly illusionCard?: {
    readonly name: string;
    readonly element: Element;
    readonly type: CardType;
    readonly power: number;
  };
}

export interface PlayerStats {
  readonly hp: number;
  readonly mp: number;
  readonly pay: number;
}

export interface PlayerState {
  readonly id: PlayerId;
  readonly stats: PlayerStats;
  readonly hand: readonly Card[];
  readonly deck: readonly Card[];
  readonly discard: readonly Card[];
  /** Current status ailment afflicting this player. */
  readonly ailment?: Ailment;
}

export type DefenseCards = {
  readonly [key in PlayerId]?: readonly Card[];
};

/**
 * Describes a non-attack targeted action (HEAL to opponent, SELL, BUY, DISASTER, CLEANSE,
 * DISPEL_MIRACLE) that is staged as a DEFENSE_PHASE where the target can REFLECT.
 * On each reflect, `currentTargetId` flips between `casterId` and `originalTargetId` indefinitely.
 * Only REFLECT_PHYSICAL and REFLECT_ALL are valid defense cards in this phase.
 */
export interface PendingTargetedAction {
  readonly kind: "HEAL_HP" | "HEAL_MP" | "SELL" | "ACCEPT_BUY" | "USE_DISASTER" | "USE_CLEANSE" | "USE_DISPEL_MIRACLE";
  /** The player who initiated the action. Never changes. */
  readonly casterId: PlayerId;
  /** The original non-caster participant (e.g., the heal target, the buyer's seller). Never changes. */
  readonly originalTargetId: PlayerId;
  /** Who is currently facing the defense phase. Flips on each reflect. */
  readonly currentTargetId: PlayerId;
  /** HEAL: amount to heal. */
  readonly healAmount?: number;
  /** HEAL: which stat to restore ("hp" or "mp"). */
  readonly healStat?: "hp" | "mp";
  /** SELL / ACCEPT_BUY: the card being transferred (removed from hand during staging). */
  readonly itemCard?: Card;
  /** SELL / ACCEPT_BUY: the PAY cost of the transaction. */
  readonly price?: number;
  /** USE_DISASTER: the ailment to inflict. */
  readonly ailment?: Ailment;
}

export interface GameState {
  readonly players: {
    readonly [key in PlayerId]?: PlayerState;
  };
  readonly playerOrder: readonly PlayerId[];
  readonly activePlayerIndex: number;
  readonly phase: Phase;
  readonly attackCards: readonly Card[];
  readonly defenseCards: DefenseCards;
  readonly confirmedDefenders: readonly PlayerId[];
  readonly winner?: PlayerId;
  readonly attackPlusActive: boolean;
  readonly attackElementOverride?: Element;
  /** Target of the current attack: a specific player or "ALL" for area attacks. */
  readonly attackTarget?: PlayerId | "ALL";
  /** Percentage of attack power applied per defender for area attacks. */
  readonly attackAreaPercent?: 25 | 50 | 75;
  /** True if a miracle attack card was used this turn (reset on DRAW). */
  readonly miracleUsedThisTurn: boolean;
  /** True if any action card (attack/exchange/heal/buy/sell) was used this turn. */
  readonly actionUsedThisTurn: boolean;
  /**
   * Per-player hit/miss results for area attacks.
   * Computed at attack time (areaAttackPercent = hit probability %).
   * Only present during DEFENSE_PHASE when an area attack is in play.
   */
  readonly areaHitResults?: readonly { readonly playerId: PlayerId; readonly hit: boolean }[];
  /** Set when a BUY card is played; the buyer reviews the card and decides. */
  readonly pendingBuyConsent?: {
    readonly buyerId: PlayerId;
    readonly targetId: PlayerId;
    /** The card randomly drawn from target's hand for the buyer to inspect. */
    readonly revealedCard: Card;
  };
  /** Set when an attack was reflected; the original attacker now defends against it. */
  readonly pendingReflect?: {
    readonly damage: number;
    readonly element: Element;
  };
  /** Set when a ring counter-attack is pending: the original attacker must resolve this damage. */
  readonly pendingRingAttack?: {
    readonly damage: number;
    readonly fromPlayerId: PlayerId;
    readonly element: Element;
  };
  /** True if all remaining players reached HP=0 simultaneously (draw condition). */
  readonly isDraw?: boolean;
  /**
   * Remaining targets to process in a sequential area attack.
   * When set (even if empty), indicates we're in sequential area attack mode.
   * Each target gets their own hit/miss roll and defense phase.
   */
  readonly pendingAreaTargets?: readonly PlayerId[];
  /**
   * Set when a non-attack targeted action (HEAL to opponent, SELL, BUY, DISASTER, CLEANSE,
   * DISPEL_MIRACLE) is staged as a DEFENSE_PHASE. Cleared after the effect is applied.
   */
  readonly pendingTargetedAction?: PendingTargetedAction;
}

export type GameAction =
  | { readonly type: "DRAW" }
  | {
      readonly type: "EXCHANGE";
      readonly allocations: PlayerStats;
      /** ID of the EXCHANGE card in hand to consume. Required to use stat reallocation. */
      readonly cardId?: string;
    }
  | { readonly type: "END_EXCHANGE" }
  | {
      readonly type: "ATTACK";
      readonly cards: readonly Card[];
      readonly lightAsElement?: Element;
      /** Specific target player, or "ALL" for area attacks. Defaults to all defenders. */
      readonly target?: PlayerId | "ALL";
    }
  | { readonly type: "CONFIRM_ATTACK" }
  | { readonly type: "PRAY" }
  | {
      readonly type: "DEFEND";
      readonly playerId: PlayerId;
      readonly cards: readonly Card[];
    }
  | { readonly type: "CONFIRM_DEFENSE"; readonly playerId: PlayerId }
  | { readonly type: "RESOLVE" }
  | { readonly type: "END_TURN" }
  | {
      /** Use a BUY card to take a random card from target's hand (costs the card's payCost). */
      readonly type: "BUY";
      readonly buyCardId: string;
      readonly targetId: PlayerId;
    }
  | {
      /** Use a SELL card to give itemCard to target; target pays the item's payCost. */
      readonly type: "SELL";
      readonly sellCardId: string;
      readonly itemCardId: string;
      readonly targetId: PlayerId;
    }
  | {
      /** Use a HEAL_HP or HEAL_MP card during EXCHANGE_PHASE. */
      readonly type: "USE_HEAL";
      readonly cardId: string;
      /** Target to heal; defaults to the active player if not specified. */
      readonly targetId?: PlayerId;
    }
  | { readonly type: "ACCEPT_BUY"; readonly playerId: PlayerId }
  | { readonly type: "DECLINE_BUY"; readonly playerId: PlayerId }
  | { readonly type: "USE_DISASTER"; readonly playerId: PlayerId; readonly cardId: string; readonly targetId: PlayerId }
  | {
      /** Use a CLEANSE card to remove the target's ailment. */
      readonly type: "USE_CLEANSE";
      readonly cardId: string;
      readonly targetId: PlayerId;
    }
  | {
      /** Use a DISPEL_MIRACLE card to remove up to 2 wasUsed miracle cards from target's hand. */
      readonly type: "USE_DISPEL_MIRACLE";
      readonly cardId: string;
      readonly targetId: PlayerId;
    };
