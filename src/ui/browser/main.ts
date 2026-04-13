import { GameState, GameAction, Card, PlayerId, Element } from "../../domain/types";
import { createInitialState } from "../../engine/initialState";
import { gameReducer, MAX_STAT } from "../../engine/gameEngine";
import { canDefend } from "../../engine/elementSystem";
// ブラウザUIとオンラインUIで重複していた表示定数/判定は shared に集約する。
import { isAttackCard, isDefenseCard } from "../shared/cardPredicates";
import {
  ELEMENT_EMOJI,
  ELEMENT_LABEL,
  TYPE_LABEL,
  PHASE_LABEL,
} from "../shared/cardUiLabels";
import {
  isAnimPlaying,
  runAreaAttackAnim,
  triggerScreenShake,
  cancelAnim,
} from "./battleAnimController";
// ─── Constants ────────────────────────────────────────────────────────────────

const LOCAL_PLAYER: PlayerId = "P1";
const AI_PLAYER: PlayerId = "P2";
/** Number of card slots shown in the hand area (initial draw = 7, +1 per draw). */
const HAND_DISPLAY_SLOTS = 8;

// ─── Mutable State ────────────────────────────────────────────────────────────

let gameState: GameState = createInitialState([LOCAL_PLAYER, AI_PLAYER]);
let selectedCards: Card[] = [];
let selectedTarget: PlayerId | null = null;
let hoveredCard: Card | null = null;
let turnCount = 1;
let logMessages: string[] = [];
let showLog = false;
let autoAdvanceTimer: ReturnType<typeof setTimeout> | null = null;
let phaseTimerTimeout: ReturnType<typeof setTimeout> | null = null;
let phaseTimerStartTime: number | null = null;
let phaseTimerInterval: ReturnType<typeof setInterval> | null = null;
let phaseTimerKey: string | null = null;
const PHASE_TIMER_MS = 25000;
/** Persisted exchange form values across re-renders */
let exchangeFormHp: number | null = null;
let exchangeFormMp: number | null = null;
let newlyDrawnCardIds: Set<string> = new Set();
let revealTimer: ReturnType<typeof setTimeout> | null = null;
let ascendingPlayers: string[] = [];
let ascensionDisplayTimer: ReturnType<typeof setTimeout> | null = null;
let showMiraclePanel = false;
/** True while a global-attack animation is running; blocks UI input and auto-advance. */
let uiLocked = false;

interface PreviewEvent {
  casterLabel: string;
  targetLabel: string;
  cards: Card[];
  defCards?: Card[];
  summaryText?: string;
  key: number;
}
/** Live defense-phase view (overrides queue display while active). */
interface DefenseContext {
  attackerLabel: string;
  defenderLabel: string;
  targetId: string;
  attackCards: Card[];
  defenseCards: Card[];
}
let defenseContext: DefenseContext | null = null;
let latestPreview: PreviewEvent | null = null;
let previewQueue: PreviewEvent[] = [];
let previewAdvanceTimer: ReturnType<typeof setTimeout> | null = null;
const PREVIEW_DURATION = 2000;

function pushPreview(evt: PreviewEvent): void {
  previewQueue.push(evt);
  if (previewAdvanceTimer === null) showNextPreview();
}
function showNextPreview(): void {
  if (previewAdvanceTimer !== null) { clearTimeout(previewAdvanceTimer); previewAdvanceTimer = null; }
  if (previewQueue.length === 0) return;
  latestPreview = previewQueue.shift()!;
  render();
  if (previewQueue.length > 0) {
    previewAdvanceTimer = setTimeout(showNextPreview, PREVIEW_DURATION);
  }
}


function getActiveId(): PlayerId {
  return gameState.playerOrder[gameState.activePlayerIndex];
}

function isLocalPlayerActive(): boolean {
  return getActiveId() === LOCAL_PLAYER;
}

function addLog(msg: string): void {
  const now = new Date();
  const ts = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;
  logMessages.push(`[${ts}] ${msg}`);
  if (logMessages.length > 100) logMessages.shift();
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

function dispatch(action: GameAction): void {
  const prev = gameState;
  const prevActiveId = getActiveId();
  gameState = gameReducer(gameState, action);
  // Detect newly drawn cards
  const prevHand = prev.players[LOCAL_PLAYER]?.hand ?? [];
  const newHand = gameState.players[LOCAL_PLAYER]?.hand ?? [];
  if (newHand.length > prevHand.length) {
    const prevIds = new Set(prevHand.map((c) => c.id));
    for (const c of newHand) {
      if (!prevIds.has(c.id)) newlyDrawnCardIds.add(c.id);
    }
  }

  // RESOLVE_PHASE完了後 750ms で伏せ解除
  if (prev.phase === "RESOLVE_PHASE" && gameState.phase !== "RESOLVE_PHASE") {
    if (revealTimer) clearTimeout(revealTimer);
    revealTimer = setTimeout(() => {
      newlyDrawnCardIds = new Set();
      revealTimer = null;
      render();
    }, 750);
  }
  // Increment turn counter on player change
  if (prev.activePlayerIndex !== gameState.activePlayerIndex) {
    turnCount++;
  }
  const nameOf = (id: string | undefined) => {
    if (!id) return "?";
    return id === LOCAL_PLAYER ? "自分" : id;
  };
  const who = nameOf(prevActiveId);

  if (action.type === "ATTACK") {
    // Set up live defense context if transitioning to DEFENSE_PHASE
    if (gameState.phase === "DEFENSE_PHASE" && gameState.attackCards.length > 0) {
      const tgt = gameState.attackTarget;
      const tLabel = (!tgt || tgt === "ALL") ? "全体" : nameOf(tgt);
      defenseContext = {
        attackerLabel: who,
        defenderLabel: tLabel,
        targetId: (!tgt || tgt === "ALL") ? "" : tgt,
        attackCards: [...gameState.attackCards],
        defenseCards: [],
      };
    } else {
      // Went straight to resolve (area attack all missed, etc.)
      pushPreview({ casterLabel: who, cards: [...action.cards], targetLabel: (!action.target || action.target === "ALL") ? "全体" : nameOf(action.target), key: Date.now() });
    }
  } else if (action.type === "DEFEND") {
    // Update live defense context with all current defense cards
    const playerId = action.playerId as PlayerId;
    const allDefCards = gameState.defenseCards[playerId] ?? [];
    if (defenseContext) {
      defenseContext = { ...defenseContext, defenseCards: [...allDefCards] };
    }
    // (rendered below via defenseContext, not queue)
  } else if (action.type === "CONFIRM_DEFENSE" && action.playerId === LOCAL_PLAYER) {
    if ((prev.defenseCards[LOCAL_PLAYER] ?? []).length === 0) {
      // "Forgive" — update defenseContext to show empty defense if active
      // (no queue push needed; defenseContext already shows the attack card with no defense)
    }
  } else if (action.type === "RESOLVE" && prev.phase === "RESOLVE_PHASE") {
    // Push final battle result to queue
    if (prev.attackCards.length > 0) {
      const attackerId = prev.playerOrder[prev.activePlayerIndex];
      let primaryTarget: string | undefined;
      if (prev.attackTarget && prev.attackTarget !== "ALL") {
        primaryTarget = prev.attackTarget as string;
      } else {
        const hitResult = prev.areaHitResults?.find((r) => r.hit);
        primaryTarget = hitResult?.playerId as string | undefined;
      }
      const atkPower = prev.attackCards.reduce((s, c) => s + (c.power ?? 0), 0);
      const defCards = primaryTarget ? (prev.defenseCards[primaryTarget as PlayerId] ?? []) : [];
      const defPower = defCards.reduce((s, c) => s + (c.power ?? 0), 0);
      let summaryText = `⚔${atkPower}  🛡${defPower}`;
      if (primaryTarget) {
        const hpBefore = prev.players[primaryTarget as PlayerId]?.stats.hp ?? 0;
        const hpAfter = gameState.players[primaryTarget as PlayerId]?.stats.hp ?? 0;
        const dmg = Math.max(0, hpBefore - hpAfter);
        summaryText += `  💥${dmg}`;
      }
      pushPreview({
        casterLabel: nameOf(attackerId),
        targetLabel: nameOf(primaryTarget),
        cards: [...prev.attackCards],
        defCards: [...defCards],
        summaryText,
        key: Date.now(),
      });
    }
    defenseContext = null;
  } else if (action.type === "USE_HEAL") {
    const card = prev.players[prevActiveId]?.hand.find((c) => c.id === action.cardId);
    const tgt = action.targetId ?? prevActiveId;
    pushPreview({ casterLabel: who, cards: card ? [card] : [], targetLabel: nameOf(tgt), key: Date.now() });
  } else if (action.type === "USE_DISASTER") {
    const card = prev.players[prevActiveId]?.hand.find((c) => c.id === action.cardId);
    pushPreview({ casterLabel: who, cards: card ? [card] : [], targetLabel: nameOf(action.targetId), key: Date.now() });
  } else if (action.type === "SELL") {
    const item = prev.players[prevActiveId]?.hand.find((c) => c.id === action.itemCardId);
    pushPreview({ casterLabel: who, cards: item ? [item] : [], targetLabel: nameOf(action.targetId), key: Date.now() });
  } else if (action.type === "ACCEPT_BUY") {
    if (prev.pendingBuyConsent) {
      const card = prev.pendingBuyConsent.revealedCard;
      pushPreview({ casterLabel: who, cards: [card], targetLabel: nameOf(prev.pendingBuyConsent.targetId), key: Date.now() });
    }
  } else if (action.type === "EXCHANGE") {
    const card = prev.players[prevActiveId]?.hand.find((c) => c.type === "EXCHANGE");
    pushPreview({ casterLabel: who, cards: card ? [card] : [], targetLabel: `HP${action.allocations.hp} MP${action.allocations.mp} ¥${action.allocations.pay}`, key: Date.now() });
  } else if (action.type === "PRAY") {
    pushPreview({ casterLabel: who, cards: [], targetLabel: "祈る🙏", key: Date.now() });
  }

  // Area miss detection
  const prevHits = prev.areaHitResults ?? [];
  const newHits = gameState.areaHitResults ?? [];
  if (newHits.length > prevHits.length) {
    const atkCard = prev.attackCards[0] ?? gameState.attackCards[0];
    for (const r of newHits.slice(prevHits.length)) {
      if (!r.hit) {
        pushPreview({ casterLabel: who, cards: atkCard ? [atkCard] : [], targetLabel: `${nameOf(r.playerId as string)}に外れ！`, key: Date.now() + Math.random() });
      }
    }
  }

  // PTA reflect chain detection
  if (prev.pendingTargetedAction && gameState.pendingTargetedAction &&
      prev.pendingTargetedAction.currentTargetId !== gameState.pendingTargetedAction.currentTargetId) {
    const pta = gameState.pendingTargetedAction;
    pushPreview({ casterLabel: "🔄 跳ね返し", cards: [], targetLabel: nameOf(pta.currentTargetId), key: Date.now() });
  }

  // ── Area attack animation pipeline ──────────────────────────────────────
  // Fires when an ATTACK with areaAttackPercent is processed and areaHitResults
  // are first populated. Locks UI for the duration of the visual pipeline.
  if (
    action.type === "ATTACK" &&
    !prev.areaHitResults &&
    gameState.areaHitResults &&
    gameState.areaHitResults.length > 0
  ) {
    const atkCard = gameState.attackCards[0];
    if (atkCard?.areaAttackPercent) {
      uiLocked = true;
      clearPhaseTimer(); // reset timer; restarts after animation
      const hitResults = gameState.areaHitResults.map(r => ({
        playerId: r.playerId as string,
        hit: r.hit,
      }));
      runAreaAttackAnim({
        cardName: atkCard.name,
        hitResults,
        getTargetRow: (pid) =>
          document.querySelector<HTMLElement>(`[data-player-id="${pid}"]`),
        onComplete: () => {
          uiLocked = false;
          render();
          scheduleAutoAdvance();
          schedulePhaseTimer();
        },
      });
    }
  }

  selectedCards = [];
  selectedTarget = null;
  // RESOLVE_PHASE後のHP=0プレイヤーを検出
  if (prev.phase === "RESOLVE_PHASE" && gameState.phase !== "RESOLVE_PHASE") {
    const newlyDead: string[] = [];
    for (const pid of prev.playerOrder) {
      const prevHp = prev.players[pid]?.stats.hp ?? 0;
      const newHp = gameState.players[pid]?.stats.hp ?? 0;
      if (prevHp > 0 && newHp <= 0) {
        newlyDead.push(pid === LOCAL_PLAYER ? "自分" : pid);
      }
    }
    if (newlyDead.length > 0) {
      ascendingPlayers = newlyDead;
      triggerScreenShake(200);
      if (ascensionDisplayTimer) clearTimeout(ascensionDisplayTimer);
      ascensionDisplayTimer = setTimeout(() => {
        ascendingPlayers = [];
        ascensionDisplayTimer = null;
        render();
      }, 2500);
    }
  }
  render();
  scheduleAutoAdvance();
  schedulePhaseTimer();
}

// ─── Auto-Advance ────────────────────────────────────────────────────────────

function scheduleAutoAdvance(): void {
  if (isAnimPlaying()) return; // animation pipeline controls timing
  if (autoAdvanceTimer !== null) {
    clearTimeout(autoAdvanceTimer);
    autoAdvanceTimer = null;
  }

  if (gameState.phase === "GAME_OVER") return;

  // BUY consent: auto-respond when the BUYER is an AI player
  if (gameState.pendingBuyConsent) {
    const { buyerId } = gameState.pendingBuyConsent;
    if (buyerId !== LOCAL_PLAYER) {
      // AI buyer always accepts
      autoAdvanceTimer = setTimeout(() => {
        addLog(`${buyerId}は購入を決めました`);
        dispatch({ type: "ACCEPT_BUY", playerId: buyerId });
      }, 800);
    }
    // If buyerId is LOCAL_PLAYER, they decide via UI — no auto-advance
    return;
  }

  const activeId = getActiveId();

  // Always auto-advance RESOLVE_PHASE and END_CHECK regardless of who is active
  if (gameState.phase === "RESOLVE_PHASE") {
    autoAdvanceTimer = setTimeout(() => {
      dispatch({ type: "RESOLVE" });
    }, 800);
    return;
  }

  if (gameState.phase === "END_CHECK") {
    autoAdvanceTimer = setTimeout(() => {
      dispatch({ type: "END_TURN" });
    }, 600);
    return;
  }

  // AI's turn
  if (activeId === AI_PLAYER) {
    handleAITurn();
    return;
  }

  // Local player's turn
  if (activeId === LOCAL_PLAYER) {
    // Auto-advance DRAW_PHASE: no card drawn, just start the action phase
    if (gameState.phase === "DRAW_PHASE") {
      autoAdvanceTimer = setTimeout(() => {
        addLog("ターン開始");
        dispatch({ type: "DRAW" });
      }, 400);
      return;
    }

    if (gameState.phase === "EXCHANGE_PHASE") {
      if (gameState.actionUsedThisTurn && !gameState.pendingTargetedAction) {
        autoAdvanceTimer = setTimeout(() => {
          dispatch({ type: "END_EXCHANGE" });
        }, 0);
      }
      return;
    }
  }

  // DEFENSE_PHASE: handle all non-active player confirmations
  if (gameState.phase === "DEFENSE_PHASE") {
    // PTA defense phase
    if (gameState.pendingTargetedAction) {
      const pta = gameState.pendingTargetedAction;
      // If AI is the PTA defender, auto-confirm (AI never reflects)
      if (pta.currentTargetId === AI_PLAYER && !gameState.confirmedDefenders.includes(AI_PLAYER)) {
        autoAdvanceTimer = setTimeout(() => {
          dispatch({ type: "CONFIRM_DEFENSE", playerId: AI_PLAYER });
        }, 600);
      }
      // LOCAL_PLAYER defends manually
      return;
    }

    // RING counter-attack: the original attacker (now defending) may be AI
    if (gameState.pendingRingAttack) {
      if (activeId === AI_PLAYER && !gameState.confirmedDefenders.includes(AI_PLAYER)) {
        autoAdvanceTimer = setTimeout(() => {
          dispatch({ type: "CONFIRM_DEFENSE", playerId: AI_PLAYER });
        }, 600);
      }
      // When LOCAL_PLAYER is the original attacker who got ring-countered, they defend manually
      return;
    }

    // Compute actual defenders (mirrors getDefenderIds logic from engine)
    const aliveNonActive = gameState.playerOrder.filter(
      (id) => id !== activeId && (gameState.players[id]?.stats.hp ?? 0) > 0
    ) as PlayerId[];
    let actualDefenders: PlayerId[];
    if (gameState.areaHitResults) {
      const hitIds = gameState.areaHitResults.filter((r) => r.hit).map((r) => r.playerId);
      actualDefenders = aliveNonActive.filter((id) => hitIds.includes(id));
    } else if (gameState.attackTarget && gameState.attackTarget !== "ALL") {
      const t = gameState.attackTarget as PlayerId;
      actualDefenders = aliveNonActive.includes(t) ? [t] : [];
    } else {
      actualDefenders = aliveNonActive;
    }

    // Auto-confirm AI's defense (when P1 is attacking)
    if (
      activeId === LOCAL_PLAYER &&
      actualDefenders.includes(AI_PLAYER) &&
      !gameState.confirmedDefenders.includes(AI_PLAYER)
    ) {
      autoAdvanceTimer = setTimeout(() => {
        dispatch({ type: "CONFIRM_DEFENSE", playerId: AI_PLAYER });
      }, 600);
    }
    // When P2 is attacking, P1 defends manually — no auto-advance
  }
}

function clearPhaseTimer(): void {
  if (phaseTimerTimeout !== null) { clearTimeout(phaseTimerTimeout); phaseTimerTimeout = null; }
  if (phaseTimerInterval !== null) { clearInterval(phaseTimerInterval); phaseTimerInterval = null; }
  phaseTimerStartTime = null;
}

function executeLocalExchangeAction(): void {
  const gs = gameState;
  const opponents = gs.playerOrder.filter((id) => id !== LOCAL_PLAYER) as PlayerId[];
  const sellCard = selectedCards.find((c) => c.type === "SELL");
  // When SELL is staged, any other card (except used miracles) is the item
  const itemCard = sellCard
    ? selectedCards.find((c) => c.id !== sellCard.id && !(c.isMiracle && c.wasUsed))
    : undefined;
  const attackCards = itemCard ? [] : selectedCards.filter(isAttackCard);
  const healCard = itemCard ? undefined : selectedCards.find((c) => c.type === "HEAL_HP" || c.type === "HEAL_MP");
  const disasterCard = itemCard ? undefined : selectedCards.find((c) => c.type === "DISASTER");
  const cleanseCard = itemCard ? undefined : selectedCards.find((c) => c.type === "CLEANSE");
  const dispelCard = itemCard ? undefined : selectedCards.find((c) => c.type === "DISPEL_MIRACLE");
  const buyCardFromHand = gs.players[LOCAL_PLAYER]?.hand.find((c) => c.type === "BUY");
  const target = selectedTarget ?? (opponents.length === 1 ? opponents[0] : undefined);
  selectedCards = [];
  if (sellCard && itemCard && target) {
    dispatch({ type: "SELL", sellCardId: sellCard.id, itemCardId: itemCard.id, targetId: target });
  } else if (attackCards.length > 0 && target) {
    dispatch({ type: "ATTACK", cards: [...attackCards], target });
  } else if (healCard) {
    dispatch({ type: "USE_HEAL", cardId: healCard.id, targetId: selectedTarget ?? LOCAL_PLAYER });
  } else if (disasterCard && target) {
    dispatch({ type: "USE_DISASTER", playerId: LOCAL_PLAYER, cardId: disasterCard.id, targetId: target });
  } else if (cleanseCard && target) {
    dispatch({ type: "USE_CLEANSE", cardId: cleanseCard.id, targetId: target });
  } else if (dispelCard && target) {
    dispatch({ type: "USE_DISPEL_MIRACLE", cardId: dispelCard.id, targetId: target });
  } else if (sellCard && itemCard && target) {
    dispatch({ type: "SELL", sellCardId: sellCard.id, itemCardId: itemCard.id, targetId: target });
  } else if (buyCardFromHand && target) {
    dispatch({ type: "BUY", buyCardId: buyCardFromHand.id, targetId: target });
  } else {
    dispatch({ type: "END_EXCHANGE" });
  }
}

function executeLocalDefenseAction(): void {
  const defCards = selectedCards.filter(isDefenseCard);
  selectedCards = [];
  if (defCards.length > 0) {
    dispatch({ type: "DEFEND", playerId: LOCAL_PLAYER, cards: [...defCards] });
  }
  dispatch({ type: "CONFIRM_DEFENSE", playerId: LOCAL_PLAYER });
}

function schedulePhaseTimer(): void {
  if (isAnimPlaying()) return; // animation pipeline controls timing
  const gs = gameState;
  const activeId = getActiveId();
  const { phase } = gs;
  let timerKey: string | null = null;

  if (phase === "EXCHANGE_PHASE" && activeId === LOCAL_PLAYER) {
    timerKey = `exchange-${gs.activePlayerIndex}`;
  } else if (phase === "DEFENSE_PHASE") {
    if (gs.pendingTargetedAction) {
      const pta = gs.pendingTargetedAction;
      if (pta.currentTargetId === LOCAL_PLAYER && !gs.confirmedDefenders.includes(LOCAL_PLAYER)) {
        timerKey = `defense-pta-${gs.activePlayerIndex}-${pta.casterId}-${pta.originalTargetId}`;
      }
    } else if ((gs.pendingRingAttack || gs.pendingReflect) && activeId === LOCAL_PLAYER && !gs.confirmedDefenders.includes(LOCAL_PLAYER)) {
      timerKey = `defense-ring-reflect-${gs.activePlayerIndex}`;
    } else if (!gs.pendingRingAttack && !gs.pendingReflect) {
      const aliveNonActive = gs.playerOrder.filter(
        (id) => id !== activeId && (gs.players[id]?.stats.hp ?? 0) > 0
      ) as PlayerId[];
      let defenders: PlayerId[];
      if (gs.areaHitResults) {
        const hitIds = gs.areaHitResults.filter((r) => r.hit).map((r) => r.playerId);
        defenders = aliveNonActive.filter((id) => hitIds.includes(id)) as PlayerId[];
      } else if (gs.attackTarget && gs.attackTarget !== "ALL") {
        const t = gs.attackTarget as PlayerId;
        defenders = aliveNonActive.includes(t) ? [t] : [];
      } else {
        defenders = aliveNonActive;
      }
      if (defenders.includes(LOCAL_PLAYER) && !gs.confirmedDefenders.includes(LOCAL_PLAYER)) {
        timerKey = `defense-normal-${gs.activePlayerIndex}`;
      }
    }
  }

  if (!timerKey) {
    clearPhaseTimer();
    phaseTimerKey = null;
    return;
  }
  if (timerKey === phaseTimerKey) return;
  clearPhaseTimer();
  phaseTimerKey = timerKey;
  phaseTimerStartTime = Date.now();
  phaseTimerInterval = setInterval(() => { render(); }, 1000);
  const isExchange = phase === "EXCHANGE_PHASE";
  phaseTimerTimeout = setTimeout(() => {
    clearPhaseTimer();
    phaseTimerKey = null;
    if (isExchange) executeLocalExchangeAction();
    else executeLocalDefenseAction();
  }, PHASE_TIMER_MS);
}

function handleAITurn(): void {
  const ai = gameState.players[AI_PLAYER];
  if (!ai) return;

  if (gameState.phase === "DRAW_PHASE") {
    autoAdvanceTimer = setTimeout(() => {
      addLog("P2のターン開始");
      dispatch({ type: "DRAW" });
    }, 900);
    return;
  }

  if (gameState.phase === "EXCHANGE_PHASE") {
    // AI: attack if possible, otherwise BUY/PRAY or END_EXCHANGE
    const usableMainAttacks = ai.hand.filter(
      (c) => isAttackCard(c) && !c.attackPlus && !c.doubler && ai.stats.mp >= c.mpCost
    );
    const hasAnyAttackInHand = ai.hand.some((c) => isAttackCard(c));
    const buyCard = ai.hand.find((c) => c.type === "BUY");
    const p1 = gameState.players[LOCAL_PLAYER];

    if (usableMainAttacks.length > 0) {
      const mainCard = usableMainAttacks[Math.floor(Math.random() * usableMainAttacks.length)]!;
      const bonusCards = ai.hand.filter((c) => (c.attackPlus || c.doubler) && c.id !== mainCard.id);
      const bundle = bonusCards.length > 0 && Math.random() < 0.5
        ? [mainCard, bonusCards[0]!]
        : [mainCard];
      autoAdvanceTimer = setTimeout(() => {
        addLog(`P2が「${mainCard.name}」で攻撃！`);
        dispatch({ type: "ATTACK", cards: bundle });
      }, 1000);
    } else if (buyCard && p1 && p1.hand.length > 0 && Math.random() < 0.4) {
      // AI occasionally tries to buy from P1
      autoAdvanceTimer = setTimeout(() => {
        addLog("P2が買い付けを試みます...");
        dispatch({ type: "BUY", buyCardId: buyCard.id, targetId: LOCAL_PLAYER });
      }, 1000);
    } else if (!hasAnyAttackInHand) {
      autoAdvanceTimer = setTimeout(() => {
        addLog("P2は祈りを捧げました（カードをドロー）");
        dispatch({ type: "PRAY" });
      }, 1000);
    } else {
      autoAdvanceTimer = setTimeout(() => {
        dispatch({ type: "END_EXCHANGE" });
      }, 600);
    }
    return;
  }

  // DEFENSE_PHASE when AI is the active attacker — do nothing, P1 defends manually
}

// ─── Player Actions ───────────────────────────────────────────────────────────

function handlePray(): void {
  if (!isLocalPlayerActive()) return;
  if (gameState.phase !== "EXCHANGE_PHASE") return;
  addLog("祈りを捧げました（カードをドロー）");
  dispatch({ type: "PRAY" });
}

function handleDefend(): void {
  if (gameState.phase !== "DEFENSE_PHASE") return;
  if (selectedCards.length === 0) {
    // Confirm with no cards
    addLog("防御なしで確定");
    dispatch({ type: "CONFIRM_DEFENSE", playerId: LOCAL_PLAYER });
    return;
  }
  if (!selectedCards.every(isDefenseCard)) {
    addLog("防御カードのみ選択してください");
    return;
  }
  const cardsToDefend = [...selectedCards];
  dispatch({ type: "DEFEND", playerId: LOCAL_PLAYER, cards: cardsToDefend });
  addLog(`防御カードを使用: ${cardsToDefend.map((c) => c.name).join(", ")}`);
  dispatch({ type: "CONFIRM_DEFENSE", playerId: LOCAL_PLAYER });
}

function handleCardClick(card: Card): void {
  const idx = selectedCards.findIndex((c) => c.id === card.id);
  if (idx !== -1) {
    selectedCards = selectedCards.filter((_, i) => i !== idx);
  } else {
    selectedCards = [...selectedCards, card];
  }
  render();
}

function handleRestart(): void {
  if (autoAdvanceTimer !== null) {
    clearTimeout(autoAdvanceTimer);
    autoAdvanceTimer = null;
  }
  cancelAnim();
  uiLocked = false;
  clearPhaseTimer();
  gameState = createInitialState([LOCAL_PLAYER, AI_PLAYER]);
  selectedCards = [];
  hoveredCard = null;
  turnCount = 1;
  logMessages = [];
  newlyDrawnCardIds = new Set();
  ascendingPlayers = [];
  showMiraclePanel = false;
  addLog("新しいゲームを開始しました");
  render();
  scheduleAutoAdvance();
}

// ─── Render Helpers ───────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean> = {},
  ...children: (HTMLElement | string | null)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "className") e.className = String(v);
    else if (k === "textContent") e.textContent = String(v);
    else if (k.startsWith("data-")) e.setAttribute(k, String(v));
    else if (typeof v === "boolean") {
      if (v) e.setAttribute(k, "");
    } else {
      (e as unknown as Record<string, string>)[k] = v;
    }
  }
  for (const child of children) {
    if (child === null) continue;
    if (typeof child === "string") e.appendChild(document.createTextNode(child));
    else e.appendChild(child);
  }
  return e;
}

function makeCardTile(card: Card, selected: boolean, onClick?: () => void, small = false): HTMLElement {
  const cls = small ? "card-tile-sm" : "card-tile";
  const baseLabel = TYPE_LABEL[card.type] ?? card.type;
  const miraclePrefix = card.isMiracle ? (card.wasUsed ? "✨(使用済)" : "✨") : "";
  const typeLabel = `${miraclePrefix}${baseLabel}`;
  const powerText = card.power > 0 ? `${typeLabel}${card.power}` : typeLabel;

  // Bottom info: area%, PAY, MP (only show if > 0)
  const infoParts: string[] = [];
  if (card.areaAttackPercent) infoParts.push(`${card.areaAttackPercent}%全`);
  if (card.mpCost > 0) infoParts.push(`MP:${card.mpCost}`);
  if (card.payCost !== undefined && card.payCost > 0) infoParts.push(`¥${card.payCost}`);
  const infoText = infoParts.join(" ") || "—";

  const tile = el("div", { className: `${cls} el-${card.element}${selected ? " selected" : ""}${card.isMiracle ? " card-tile--miracle" : ""}${card.wasUsed ? " card-tile--used" : ""}` });

  // Image or emoji
  let iconEl: HTMLElement;
  if (card.image) {
    const img = document.createElement("img");
    img.src = `/card-images/${card.image}`;
    img.alt = card.name;
    img.className = `${cls}__img`;
    iconEl = img;
  } else {
    iconEl = el("span", { className: `${cls}__element`, textContent: ELEMENT_EMOJI[card.element] });
  }

  const nameEl = el("span", { className: `${cls}__name`, textContent: card.name });
  const powerEl = el("span", { className: `${cls}__power`, textContent: powerText });

  if (!small) {
    const typeEl = el("span", { className: "card-tile__type", textContent: infoText });
    tile.append(iconEl, nameEl, powerEl, typeEl);
  } else {
    tile.append(iconEl, nameEl, powerEl);
  }

  tile.addEventListener("mouseenter", () => {
    hoveredCard = card;
    renderCardDetail();
  });

  if (onClick) {
    tile.addEventListener("click", onClick);
  }

  return tile;
}

function makeCardPanel(card: Card): HTMLElement {
  const panel = el("div", { className: `card-panel el-${card.element}` });

  const iconEl = el("div", { className: "card-panel__icon" });
  if (card.image) {
    const img = document.createElement("img");
    img.src = `/card-images/${card.image}`;
    img.alt = card.name;
    img.className = "card-panel__img";
    iconEl.appendChild(img);
  } else {
    iconEl.textContent = ELEMENT_EMOJI[card.element];
  }
  panel.appendChild(iconEl);

  const info = el("div", { className: "card-panel__info" });
  info.appendChild(el("span", {
    className: "card-panel__name",
    textContent: (card.isMiracle ? "✨ " : "") + card.name,
  }));
  const typeShort = TYPE_LABEL[card.type] ?? card.type;
  info.appendChild(el("span", {
    className: "card-panel__power",
    textContent: typeShort + (card.power > 0 ? " " + card.power : ""),
  }));
  if ((card.payCost ?? 0) > 0) {
    info.appendChild(el("span", { className: "card-panel__price", textContent: "¥" + card.payCost }));
  }
  panel.appendChild(info);

  panel.addEventListener("mouseenter", () => { hoveredCard = card; renderCardDetail(); });
  return panel;
}

// ─── Component Renders ────────────────────────────────────────────────────────

let cardDetailContainer: HTMLElement | null = null;
/** Track last rendered card id to skip redundant redraws */
let _lastDetailCardId: string | null | undefined = undefined;

function renderCardDetail(): void {
  if (!cardDetailContainer) return;
  const cardId = hoveredCard?.id ?? null;
  if (cardId === _lastDetailCardId) return; // nothing changed, skip reflow
  _lastDetailCardId = cardId;

  cardDetailContainer.innerHTML = "";

  const h3 = el("h3", { textContent: "カード詳細" });
  cardDetailContainer.appendChild(h3);

  if (!hoveredCard) {
    cardDetailContainer.appendChild(el("p", { className: "card-detail-empty", textContent: "カードにホバーで詳細表示" }));
    return;
  }

  const c = hoveredCard;
  const thumb = el("div", { className: `card-detail__thumb el-${c.element}` });
  thumb.appendChild(el("span", { textContent: ELEMENT_EMOJI[c.element] }));
  thumb.appendChild(el("span", { textContent: c.name, className: "card-detail__name" }));

  const rows: [string, string][] = [
    ["属性", `${ELEMENT_EMOJI[c.element]} ${ELEMENT_LABEL[c.element]}`],
    ["タイプ", (c.isMiracle ? "✨ 奇跡/" : "") + (TYPE_LABEL[c.type] ?? c.type)],
    ["威力", c.power > 0 ? String(c.power) : "—"],
    ...(c.mpCost > 0 ? [["MPコスト", String(c.mpCost)] as [string, string]] : []),
    ...(c.payCost !== undefined ? [["PAYコスト", `¥${c.payCost}`] as [string, string]] : []),
    ...(c.areaAttackPercent ? [["全体攻撃", `${c.areaAttackPercent}%`] as [string, string]] : []),
    ...(c.attackPlus ? [["追加攻撃", "あり (+同時使用可)"] as [string, string]] : []),
    ...(c.isMiracle ? [["奇跡効果", "MP消費・使用後手札に戻る"] as [string, string]] : []),
  ];

  cardDetailContainer.appendChild(thumb);
  for (const [label, val] of rows) {
    const row = el("div", { className: "card-detail__row" });
    row.appendChild(el("span", { textContent: label }));
    row.appendChild(el("span", { className: "card-detail__val", textContent: val }));
    cardDetailContainer.appendChild(row);
  }
}

// ─── Combat Banner / Event Strip / Miracle Panel ─────────────────────────────

function buildCombatBanner(): HTMLElement | null {
  const phase = gameState.phase;
  if (
    (phase !== "DEFENSE_PHASE" && phase !== "RESOLVE_PHASE" && phase !== "END_CHECK") ||
    gameState.attackCards.length === 0
  ) return null;

  const activeId = getActiveId();
  const atkName = activeId === LOCAL_PLAYER ? "自分" : activeId;
  const tgt = gameState.attackTarget;
  const tgtName = !tgt || tgt === "ALL" ? "全体" : tgt === LOCAL_PLAYER ? "自分" : tgt;

  const atkPill = el("div", { className: "combat-pill attacker" });
  atkPill.appendChild(el("span", { className: "combat-pill-dot" }));
  atkPill.appendChild(document.createTextNode(atkName));

  const tgtPill = el("div", { className: "combat-pill target" });
  tgtPill.appendChild(el("span", { className: "combat-pill-dot" }));
  tgtPill.appendChild(document.createTextNode(tgtName));

  return el("div", { className: "combat-banner" },
    atkPill,
    el("span", { className: "combat-arrow-large", textContent: "→" }),
    tgtPill,
  );
}

function buildEventStrip(): HTMLElement {
  return el("div", { className: "event-strip" });
}

function buildAscensionOverlay(): HTMLElement {
  const overlay = el("div", { className: "ascension-overlay" });
  for (const name of ascendingPlayers) {
    const banner = el("div", { className: "ascension-banner" });
    banner.appendChild(el("span", { className: "ascension-text", textContent: "昇天" }));
    banner.appendChild(el("span", { className: "ascension-name", textContent: name }));
    overlay.appendChild(banner);
  }
  return overlay;
}

function buildMiraclePanel(): HTMLElement {
  const overlay = el("div", { className: "miracle-panel-overlay" });
  const panel = el("div", { className: "miracle-panel" });

  const header = el("div", { className: "miracle-panel__header" });
  header.appendChild(el("span", { textContent: "※ 起こした奇跡" }));
  const closeBtn = el("button", { className: "btn-icon", textContent: "✕" });
  closeBtn.addEventListener("click", () => { showMiraclePanel = false; render(); });
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const body = el("div", { className: "miracle-panel__body" });
  let hasAny = false;
  for (const pid of gameState.playerOrder) {
    const p = gameState.players[pid];
    if (!p) continue;
    const usedMiracles = p.hand.filter((c) => c.isMiracle && c.wasUsed);
    if (usedMiracles.length === 0) continue;
    hasAny = true;
    const playerLabel = pid === LOCAL_PLAYER ? `${pid} (自分)` : pid;
    body.appendChild(el("div", { className: "miracle-panel__player-label", textContent: playerLabel }));
    for (const c of usedMiracles) {
      body.appendChild(makeCardPanel(c));
    }
  }
  if (!hasAny) {
    body.appendChild(el("p", { className: "miracle-panel__empty", textContent: "使用済みの奇跡はまだありません" }));
  }
  panel.appendChild(body);
  overlay.appendChild(panel);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) { showMiraclePanel = false; render(); }
  });
  return overlay;
}

// ─── Full Render ──────────────────────────────────────────────────────────────

function render(): void {
  const app = document.getElementById("app");
  if (!app) return;

  _lastDetailCardId = undefined; // force detail panel redraw after full render
  app.innerHTML = "";

  if (uiLocked) app.classList.add("ui-locked");
  else app.classList.remove("ui-locked");

  app.appendChild(buildTopBar());
  const banner = buildCombatBanner();
  if (banner) app.appendChild(banner);
  app.appendChild(buildMainArea());
  app.appendChild(buildEventStrip());
  app.appendChild(buildHandArea());
  app.appendChild(buildBottomBar());

  if (gameState.phase === "GAME_OVER") {
    app.appendChild(buildGameOverOverlay());
  }

  if (ascendingPlayers.length > 0) {
    app.appendChild(buildAscensionOverlay());
  }

  if (showMiraclePanel) {
    app.appendChild(buildMiraclePanel());
  }

  if (showLog) {
    app.appendChild(buildLogPanel());
  }
}

function buildTopBar(): HTMLElement {
  const bar = el("div", { className: "top-bar" });

  // Left
  const left = el("div", { className: "top-bar__left" });
  const backBtn = el("button", { className: "btn-icon", textContent: "← 戻る" });
  backBtn.addEventListener("click", () => {
    if (confirm("ゲームを終了しますか？")) handleRestart();
  });
  const stageLabel = el("span", { className: "top-bar__stage", textContent: "ステージ 1" });
  left.append(backBtn, stageLabel);

  // Center
  const center = el("div", { className: "top-bar__center" });
  const gfLabel = el("span", { className: "top-bar__gf", textContent: `G.F.  ${turnCount} / 99` });

  // Phase badge
  const activeId = getActiveId();
  const phaseName = PHASE_LABEL[gameState.phase] ?? gameState.phase;
  const isAiPhase = activeId === AI_PLAYER && gameState.phase !== "GAME_OVER";
  const phaseClass = `phase-badge${isAiPhase ? " ai" : " active"}`;
  const phaseBadge = el("span", { className: phaseClass, textContent: phaseName });
  if (isAiPhase) {
    phaseBadge.appendChild(el("span", { className: "thinking-dot" }));
  }
  center.append(gfLabel, phaseBadge);

  // Right
  const right = el("div", { className: "top-bar__right" });
  const miracleBtn = el("button", { className: "btn-icon", textContent: "✨ 起こした奇跡" });
  miracleBtn.addEventListener("click", () => {
    showMiraclePanel = !showMiraclePanel;
    render();
  });
  const bagBtn = el("button", { className: "btn-icon", textContent: "🎒" });
  const codexBtn = el("button", { className: "btn-icon", textContent: "📖 教典" });
  right.append(miracleBtn, bagBtn, codexBtn);

  bar.append(left, center, right);
  return bar;
}

function buildMainArea(): HTMLElement {
  const main = el("div", { className: "main-area" });
  main.appendChild(buildFieldArea());
  main.appendChild(buildPreviewPanel());
  const right = el("div", { className: "right-column" });
  right.appendChild(buildOpponentsArea());
  right.appendChild(buildPlayerGrid());
  right.appendChild(buildMiddleRow());
  main.appendChild(right);
  return main;
}

function buildFieldArea(): HTMLElement {
  const area = el("div", { className: "field-area" });
  const activeId = getActiveId();
  const phase = gameState.phase;

  if (phase === "EXCHANGE_PHASE") {
    area.appendChild(buildStagingView());
    return area;
  }

  // DEFENSE_PHASE: when P1 is an active unconfirmed defender, show the defense staging view
  if (phase === "DEFENSE_PHASE") {
    const alreadyConfirmed = gameState.confirmedDefenders.includes(LOCAL_PLAYER);

    if (gameState.pendingTargetedAction) {
      const pta = gameState.pendingTargetedAction;
      if (pta.currentTargetId === LOCAL_PLAYER && !alreadyConfirmed) {
        area.appendChild(buildDefenseStagingView());
        return area;
      }
    } else if (gameState.pendingRingAttack) {
      // RING counter: original attacker (activeId) needs to defend
      if (activeId === LOCAL_PLAYER && !alreadyConfirmed) {
        area.appendChild(buildDefenseStagingView());
        return area;
      }
    } else if (gameState.pendingReflect) {
      // Reflect: original attacker (activeId) needs to defend against reflected damage
      if (activeId === LOCAL_PLAYER && !alreadyConfirmed) {
        area.appendChild(buildDefenseStagingView());
        return area;
      }
    } else {
      const aliveNonActive = gameState.playerOrder.filter(
        (id) => id !== activeId && (gameState.players[id]?.stats.hp ?? 0) > 0
      ) as PlayerId[];
      let actualDefenders: PlayerId[];
      if (gameState.areaHitResults) {
        const hitIds = gameState.areaHitResults.filter((r) => r.hit).map((r) => r.playerId);
        actualDefenders = aliveNonActive.filter((id) => hitIds.includes(id));
      } else if (gameState.attackTarget && gameState.attackTarget !== "ALL") {
        const t = gameState.attackTarget as PlayerId;
        actualDefenders = aliveNonActive.includes(t) ? [t] : [];
      } else {
        actualDefenders = aliveNonActive;
      }
      if (actualDefenders.includes(LOCAL_PLAYER) && !alreadyConfirmed) {
        area.appendChild(buildDefenseStagingView());
        return area;
      }
    }
  }

  const isAttacker = activeId === LOCAL_PLAYER;

  // Combat header: attacker → target
  const header = el("div", { className: "field-combat-header" });
  if (phase === "DEFENSE_PHASE" || phase === "RESOLVE_PHASE") {
    if (gameState.pendingRingAttack) {
      // Show RING counter context: original attacker is now defending
      header.appendChild(el("span", { className: "combat-badge target", textContent: "💍 指輪カウンター" }));
      header.appendChild(el("span", { className: "combat-arrow", textContent: "→" }));
      const atkName = isAttacker ? "自分" : activeId;
      header.appendChild(el("span", { className: "combat-badge attacker", textContent: atkName }));
    } else {
      const atkName = isAttacker ? "自分" : activeId;
      const tgt = gameState.attackTarget;
      const tgtName = !tgt || tgt === "ALL" ? "全体" : tgt === LOCAL_PLAYER ? "自分" : tgt;
      header.appendChild(el("span", { className: "combat-badge attacker", textContent: atkName }));
      header.appendChild(el("span", { className: "combat-arrow", textContent: "→" }));
      header.appendChild(el("span", { className: "combat-badge target", textContent: tgtName }));
    }
  }
  area.appendChild(header);

  // Two card columns side by side
  const cols = el("div", { className: "field-columns" });
  cols.appendChild(buildMyCardsCol(isAttacker, phase));
  cols.appendChild(buildOppCardsCol(isAttacker, phase));
  area.appendChild(cols);

  return area;
}

function buildStagingView(): HTMLElement {
  const wrapper = el("div", { className: "staging-wrapper" });
  const p1 = gameState.players[LOCAL_PLAYER];
  const activeId = getActiveId();
  const isMyTurn = activeId === LOCAL_PLAYER;
  const actionDone = gameState.actionUsedThisTurn;
  const opponents = gameState.playerOrder.filter((id) => id !== LOCAL_PLAYER) as PlayerId[];

  // Player badge
  const badge = el("div", { className: "staging-badge" });
  badge.appendChild(el("div", { className: "avatar p1", textContent: "P1" }));
  badge.appendChild(el("span", { className: "staging-badge-name", textContent: "Player 1 (自分)" }));
  wrapper.appendChild(badge);

  const timerBar = buildPhaseTimerBar();
  if (timerBar) wrapper.appendChild(timerBar);

  // Card staging zone
  const zone = el("div", { className: "staging-card-zone" });

  const attackCards = selectedCards.filter(isAttackCard);
  const healCard = selectedCards.find((c) => c.type === "HEAL_HP" || c.type === "HEAL_MP");
  const disasterCard = selectedCards.find((c) => c.type === "DISASTER");
  const cleanseCard = selectedCards.find((c) => c.type === "CLEANSE");
  const dispelCard = selectedCards.find((c) => c.type === "DISPEL_MIRACLE");
  const exchangeCard = selectedCards.find((c) => c.type === "EXCHANGE");
  const buyCardFromHand = p1?.hand.find((c) => c.type === "BUY");
  const sellCardFromHand = selectedCards.find((c) => c.type === "SELL");
  const itemCard = selectedCards.find(
    (c) => c.type !== "SELL" && !(c.isMiracle && c.wasUsed)
  );
  const target = selectedTarget ?? (opponents.length === 1 ? opponents[0] : undefined);
  const total = (p1?.stats.hp ?? 0) + (p1?.stats.mp ?? 0) + (p1?.stats.pay ?? 0);
  const hasAnyAttackInHand = p1?.hand.some((c) => isAttackCard(c)) ?? false;
  let execHandler: (() => void) | null = null;
  let execLabel = "▶ 実行";
  let execEnabled = false;
  let hintText = "手札のカードを選択してアクションを実行";

  if (isMyTurn && !actionDone) {
    if (sellCardFromHand && itemCard) {
      // SELL has highest priority once sell card + item card are both staged
      const sellTarget = target ?? (opponents.length === 1 ? opponents[0] : undefined);
      execLabel = `💰「${itemCard.name}」を売る${sellTarget ? ` → ${sellTarget}` : ""}`;
      execEnabled = !!sellTarget;
      execHandler = sellTarget ? () => {
        addLog(`「${itemCard.name}」を${sellTarget}に売却`);
        dispatch({ type: "SELL", sellCardId: sellCardFromHand.id, itemCardId: itemCard.id, targetId: sellTarget });
        selectedCards = [];
      } : null;
      hintText = sellTarget ? `→ ${sellTarget}に売りつける` : "対象を選択してください";
      zone.appendChild(makeCardTile(sellCardFromHand, true, undefined, true));
      zone.appendChild(makeCardTile(itemCard, true, undefined, true));
    } else if (sellCardFromHand && !itemCard) {
      hintText = "売りつけるカードを手札から選んでください";
      zone.appendChild(makeCardTile(sellCardFromHand, true, undefined, true));
    } else if (attackCards.length > 0) {
      const atkTarget = selectedTarget ?? (opponents.length === 1 ? opponents[0] : undefined);
      const atkTargetLabel = atkTarget === LOCAL_PLAYER
        ? " → 自分"
        : atkTarget ? ` → ${atkTarget}` : " (対象未選択)";
      execLabel = "⚔ 攻撃";
      execEnabled = !!atkTarget;
      execHandler = () => {
        addLog(`「${attackCards[0]!.name}」で攻撃！`);
        dispatch({ type: "ATTACK", cards: [...selectedCards], target: atkTarget });
        selectedCards = [];
      };
      hintText = `${attackCards.map((c) => c.name).join(" + ")}${atkTargetLabel}`;
      for (const c of selectedCards) zone.appendChild(makeCardTile(c, true, undefined, true));
    } else if (healCard) {
      const healTarget = selectedTarget ?? LOCAL_PLAYER;
      const healTargetLabel = healTarget === LOCAL_PLAYER ? "自分" : healTarget;
      execLabel = `💊 ${healCard.name} → ${healTargetLabel}`;
      execEnabled = true;
      execHandler = () => {
        addLog(`「${healCard.name}」使用`);
        dispatch({ type: "USE_HEAL", cardId: healCard.id, targetId: healTarget });
        selectedCards = [];
      };
      hintText = `対象: ${healTargetLabel} (プレイヤー行をクリックで変更)`;
      for (const c of selectedCards) zone.appendChild(makeCardTile(c, true, undefined, true));
    } else if (disasterCard) {
      const disasterTarget = selectedTarget ?? (opponents.length === 1 ? opponents[0] : undefined);
      const disasterTargetLabel = disasterTarget === LOCAL_PLAYER ? "自分" : disasterTarget ?? "未選択";
      execLabel = `💀 ${disasterCard.name} → ${disasterTargetLabel}`;
      execEnabled = !!disasterTarget;
      execHandler = disasterTarget ? () => {
        addLog(`「${disasterCard.name}」で${disasterTargetLabel}に災いを与えた！`);
        dispatch({ type: "USE_DISASTER", playerId: LOCAL_PLAYER, cardId: disasterCard.id, targetId: disasterTarget });
        selectedCards = [];
      } : null;
      hintText = `対象: ${disasterTargetLabel} (プレイヤー行をクリックで変更)`;
      for (const c of selectedCards) zone.appendChild(makeCardTile(c, true, undefined, true));
    } else if (cleanseCard) {
      const cleanseTarget = selectedTarget ?? (opponents.length === 1 ? opponents[0] : undefined);
      const cleanseTargetLabel = cleanseTarget === LOCAL_PLAYER ? "自分" : cleanseTarget ?? "未選択";
      execLabel = `🌿 ${cleanseCard.name} → ${cleanseTargetLabel}`;
      execEnabled = !!cleanseTarget;
      execHandler = cleanseTarget ? () => {
        addLog(`「${cleanseCard.name}」で${cleanseTargetLabel}の状態異常を解除！`);
        dispatch({ type: "USE_CLEANSE", cardId: cleanseCard.id, targetId: cleanseTarget });
        selectedCards = [];
      } : null;
      hintText = `対象: ${cleanseTargetLabel} (プレイヤー行をクリックで変更)`;
      for (const c of selectedCards) zone.appendChild(makeCardTile(c, true, undefined, true));
    } else if (dispelCard) {
      const dispelTarget = selectedTarget ?? (opponents.length === 1 ? opponents[0] : undefined);
      const dispelTargetLabel = dispelTarget === LOCAL_PLAYER ? "自分" : dispelTarget ?? "未選択";
      execLabel = `✨ ${dispelCard.name} → ${dispelTargetLabel}`;
      execEnabled = !!dispelTarget;
      execHandler = dispelTarget ? () => {
        addLog(`「${dispelCard.name}」で${dispelTargetLabel}の奇跡を解除！`);
        dispatch({ type: "USE_DISPEL_MIRACLE", cardId: dispelCard.id, targetId: dispelTarget });
        selectedCards = [];
      } : null;
      hintText = `対象: ${dispelTargetLabel} (プレイヤー行をクリックで変更)`;
      for (const c of selectedCards) zone.appendChild(makeCardTile(c, true, undefined, true));
    } else if (exchangeCard) {
      hintText = `🔄 両替 — 合計 ${total}`;
      zone.appendChild(el("div", { className: "staging-hint", textContent: hintText }));
    } else if (buyCardFromHand) {
      const buyTarget = target ?? (opponents.length === 1 ? opponents[0] : undefined);
      execLabel = `🛒 買い付け${buyTarget ? ` → ${buyTarget}` : ""}`;
      execEnabled = !!buyTarget;
      execHandler = buyTarget ? () => {
        addLog(`${buyTarget}から購入`);
        dispatch({ type: "BUY", buyCardId: buyCardFromHand.id, targetId: buyTarget });
        selectedCards = [];
      } : null;
      hintText = buyTarget ? `${buyTarget}からランダムで公開して購入判断` : "対象を選択してください";
      const buyTile = makeCardTile(buyCardFromHand, false, undefined, true);
      zone.appendChild(buyTile);
      zone.appendChild(el("div", { className: "staging-hint", textContent: `→ ${buyTarget ?? "?"} から買い付け` }));
    } else {
      zone.appendChild(el("div", { className: "staging-placeholder" }));
    }
  } else if (actionDone) {
    hintText = "✔ アクション済み";
    zone.appendChild(el("div", { className: "staging-hint", textContent: "✔ アクション済み — 手動でターン終了してください" }));
  } else {
    zone.appendChild(el("div", { className: "staging-placeholder" }));
  }

  if (execHandler && !exchangeCard) {
    zone.classList.add("is-clickable");
    zone.addEventListener("click", execHandler);
  }
  wrapper.appendChild(zone);

  // Action buttons row (exec + pray) — replaces standalone pray button
  const btnRow = el("div", { className: "staging-action-btns" });
  if (isMyTurn && !actionDone && !exchangeCard) {
    const execBtn = el("button", { className: "btn-action attack", textContent: execLabel });
    if (!execEnabled) execBtn.setAttribute("disabled", "");
    if (execHandler) execBtn.addEventListener("click", execHandler);
    btnRow.appendChild(execBtn);
  }
  const prayBtn = el("button", { className: "btn-action pray", textContent: "🙏 祈る" });
  if (hasAnyAttackInHand || actionDone || !isMyTurn) prayBtn.setAttribute("disabled", "");
  prayBtn.addEventListener("click", handlePray);
  btnRow.appendChild(prayBtn);
  wrapper.appendChild(btnRow);

  // 🔄 両替 inline form (moved from buildActionsPanel)
  if (exchangeCard && !actionDone && isMyTurn && p1) {
    // Initialize persisted form values when exchange card is first selected
    if (exchangeFormHp === null) exchangeFormHp = p1.stats.hp;
    if (exchangeFormMp === null) exchangeFormMp = p1.stats.mp;

    const exForm = el("div", { className: "exchange-form" });
    exForm.appendChild(el("span", { className: "exchange-form__title", textContent: `🔄 両替 — 合計 ${total}` }));
    const inputs = el("div", { className: "exchange-form__inputs" });

    const hpInput = document.createElement("input");
    hpInput.type = "number"; hpInput.min = "0"; hpInput.max = String(total);
    hpInput.value = String(exchangeFormHp); hpInput.className = "exchange-input hp"; hpInput.placeholder = "HP";

    const mpInput = document.createElement("input");
    mpInput.type = "number"; mpInput.min = "0"; mpInput.max = String(total);
    mpInput.value = String(exchangeFormMp); mpInput.className = "exchange-input mp"; mpInput.placeholder = "MP";

    const payLabel = el("span", { className: "exchange-pay-label", textContent: `PAY: ${total - (exchangeFormHp ?? 0) - (exchangeFormMp ?? 0)}` });
    const updatePay = () => {
      exchangeFormHp = parseInt(hpInput.value, 10) || 0;
      exchangeFormMp = parseInt(mpInput.value, 10) || 0;
      const pay = total - exchangeFormHp - exchangeFormMp;
      payLabel.textContent = `PAY: ${pay < 0 ? "❌" : pay}`;
    };
    hpInput.addEventListener("input", updatePay);
    mpInput.addEventListener("input", updatePay);

    const exBtn = el("button", { className: "btn-action exchange", textContent: "実行" });
    exBtn.addEventListener("click", () => {
      const hp = parseInt(hpInput.value, 10);
      const mp = parseInt(mpInput.value, 10);
      const pay = total - hp - mp;
      if (isNaN(hp) || isNaN(mp) || hp < 0 || mp < 0 || pay < 0) {
        console.warn("無効な値です"); return;
      }
      exchangeFormHp = null;
      exchangeFormMp = null;
      addLog(`両替: HP${hp} MP${mp} PAY${pay}`);
      dispatch({ type: "EXCHANGE", cardId: exchangeCard.id, allocations: { hp, mp, pay } });
      selectedCards = [];
    });

    inputs.append(
      el("label", { className: "exchange-label", textContent: "HP" }), hpInput,
      el("label", { className: "exchange-label", textContent: "MP" }), mpInput,
      payLabel, exBtn,
    );
    exForm.appendChild(inputs);
    wrapper.appendChild(exForm);
  } else {
    // Clear persisted values when exchange form is not visible
    exchangeFormHp = null;
    exchangeFormMp = null;
  }

  // Hint text
  if (isMyTurn) {
    wrapper.appendChild(el("p", { className: "action-hint", textContent: hintText }));
  }

  return wrapper;
}

function buildAttackInfoBlock(): HTMLElement {
  const block = el("div", { className: "attack-info-block" });
  const activeId = getActiveId();
  const atkName = activeId === LOCAL_PLAYER ? "自分" : activeId;
  const atkCards = gameState.attackCards;
  const atkElement: Element = (gameState.attackElementOverride ?? atkCards[0]?.element ?? "NEUTRAL") as Element;
  const totalPower = atkCards.reduce((s, c) => s + (c.power ?? 0), 0);

  const header = el("div", { className: "attack-info-header" });
  header.appendChild(el("span", { className: "attack-info-attacker", textContent: `${atkName} ⚔` }));
  header.appendChild(el("span", {
    className: "attack-info-element",
    textContent: ` ${ELEMENT_EMOJI[atkElement]}${ELEMENT_LABEL[atkElement]}`,
  }));
  header.appendChild(el("span", { className: "attack-info-power", textContent: ` 攻撃力 ${totalPower}` }));
  block.appendChild(header);

  if (atkCards.length > 0) {
    const cardRow = el("div", { className: "attack-info-cards" });
    for (const c of atkCards) cardRow.appendChild(makeCardTile(c, false, undefined, true));
    block.appendChild(cardRow);
  }
  return block;
}

function buildPhaseTimerBar(): HTMLElement | null {
  if (!phaseTimerStartTime) return null;
  const elapsed = Date.now() - phaseTimerStartTime;
  const remaining = Math.max(0, Math.ceil((PHASE_TIMER_MS - elapsed) / 1000));
  const pct = Math.max(0, (PHASE_TIMER_MS - elapsed) / PHASE_TIMER_MS) * 100;
  const urgency = remaining <= 5 ? " urgent" : remaining <= 10 ? " warning" : "";
  const bar = el("div", { className: "phase-timer-bar" });
  bar.appendChild(el("span", { className: `phase-timer-text${urgency}`, textContent: `⏱ 残り ${remaining}秒` }));
  const track = el("div", { className: "phase-timer-track" });
  const fill = el("div", { className: `phase-timer-fill${urgency}` });
  fill.style.width = `${pct}%`;
  track.appendChild(fill);
  bar.appendChild(track);
  return bar;
}

function buildDefenseStagingView(): HTMLElement {
  const wrapper = el("div", { className: "staging-wrapper" });
  const p1 = gameState.players[LOCAL_PLAYER];
  if (!p1) return wrapper;
  const pta = gameState.pendingTargetedAction;

  const atkElement: Element = gameState.pendingRingAttack
    ? (gameState.pendingRingAttack.element as Element)
    : gameState.pendingReflect
    ? (gameState.pendingReflect.element as Element)
    : (gameState.attackElementOverride ?? gameState.attackCards[0]?.element ?? "NEUTRAL") as Element;

  // Player badge
  const badge = el("div", { className: "staging-badge" });
  badge.appendChild(el("div", { className: "avatar p1", textContent: "P1" }));
  badge.appendChild(el("span", { className: "staging-badge-name", textContent: "Player 1 (自分)" }));
  wrapper.appendChild(badge);

  const timerBar = buildPhaseTimerBar();
  if (timerBar) wrapper.appendChild(timerBar);

  // Incoming action info
  if (pta) {
    const casterLabel = pta.casterId === LOCAL_PLAYER ? "自分" : pta.casterId;
    let desc = "";
    switch (pta.kind) {
      case "HEAL_HP": desc = `❤️ HP+${pta.healAmount}（回復）`; break;
      case "HEAL_MP": desc = `💧 MP+${pta.healAmount}（回復）`; break;
      case "SELL": desc = `🏷️ 売りつけ「${pta.itemCard?.name ?? "?"}」¥${pta.price ?? 0}`; break;
      case "ACCEPT_BUY": desc = `💰 買付け「${pta.itemCard?.name ?? "?"}」¥${pta.price ?? 0}`; break;
      case "USE_DISASTER": desc = `☠️ 呪い（${pta.ailment}）`; break;
      case "USE_CLEANSE": desc = "✨ 厄払い（状態異常除去）"; break;
      case "USE_DISPEL_MIRACLE": desc = "🚫 奇跡消し"; break;
    }
    wrapper.appendChild(el("p", {
      className: "action-hint ring-incoming",
      textContent: `${casterLabel} → あなた: ${desc}`,
    }));
    wrapper.appendChild(el("p", {
      className: "action-hint",
      textContent: "🔄 跳ね返しカードのみ有効です",
    }));
  } else if (gameState.pendingRingAttack) {
    const ring = gameState.pendingRingAttack;
    wrapper.appendChild(el("p", {
      className: "action-hint ring-incoming",
      textContent: `💍 指輪カウンター！指輪の反射ダメージ: ${ring.damage} ${ELEMENT_EMOJI[ring.element]}${ELEMENT_LABEL[ring.element]}`,
    }));
  } else if (gameState.pendingReflect) {
    const ref = gameState.pendingReflect;
    wrapper.appendChild(el("p", {
      className: "action-hint ring-incoming",
      textContent: `🔄 反射！跳ね返しダメージ: ${ref.damage} ${ELEMENT_EMOJI[ref.element as Element]}${ELEMENT_LABEL[ref.element as Element]}`,
    }));
  } else {
    wrapper.appendChild(buildAttackInfoBlock());
  }

  // Selected defense cards staging zone — clicking confirms defense or allows damage
  const zone = el("div", { className: "staging-card-zone is-clickable" });
  const selectedDefCards = selectedCards.filter(isDefenseCard);
  if (selectedDefCards.length > 0) {
    for (const c of selectedDefCards) zone.appendChild(makeCardTile(c, true, undefined, true));
    zone.appendChild(el("div", { className: "staging-hint", textContent: "↑ クリックして防御確定" }));
  } else {
    zone.classList.add("staging-card-zone--forgive");
    zone.appendChild(el("span", { className: "staging-empty-hint", textContent: "許す" }));
  }
  zone.addEventListener("click", () => {
    if (selectedDefCards.length > 0) {
      dispatch({ type: "DEFEND", playerId: LOCAL_PLAYER, cards: [...selectedDefCards] });
    }
    dispatch({ type: "CONFIRM_DEFENSE", playerId: LOCAL_PLAYER });
    addLog(selectedDefCards.length > 0
      ? (gameState.pendingRingAttack ? "指輪カウンター防御確定" : pta ? "跳ね返し確定" : "防御確定")
      : "防御なしで確定");
  });
  wrapper.appendChild(zone);

  // Defense cards from hand (clickable grid)
  const playerMp = gameState.players[LOCAL_PLAYER]?.stats.mp ?? 0;

  if (p1.hand.some(isDefenseCard)) {
    wrapper.appendChild(el("p", { className: "action-hint", textContent: "手札の防御カードを選択:" }));
  } else {
    wrapper.appendChild(el("p", { className: "action-hint", textContent: "使える防御カードがありません" }));
  }

  const grid = el("div", { className: "defense-card-grid" });
  for (const c of p1.hand) {
    if (!isDefenseCard(c)) continue;
    let canUse: boolean;
    if (pta) {
      canUse = (c.type === "REFLECT_ALL" || c.type === "REFLECT_PHYSICAL") &&
        !(c.mpCost > 0 && playerMp < c.mpCost);
    } else {
      const isReflectCard = c.type === "REFLECT_PHYSICAL" || c.type === "REFLECT_ALL";
      const canUseElement = isReflectCard || canDefend(atkElement, c.element as Element);
      const canUseMp = !(c.mpCost > 0 && playerMp < c.mpCost);
      canUse = canUseElement && canUseMp;
    }
    const selected = selectedCards.some((s) => s.id === c.id);
    const tile = makeCardTile(c, selected, canUse ? () => handleCardClick(c) : undefined, true);
    if (!canUse) tile.classList.add("card-tile--disabled");
    grid.appendChild(tile);
  }
  if (grid.childElementCount > 0) wrapper.appendChild(grid);

  return wrapper;
}

function buildPreviewPanel(): HTMLElement {
  const panel = el("div", { className: "preview-panel" });

  // Show live defense context if active (overrides queue)
  const ctx = defenseContext;
  if (ctx) {
    appendPreviewContent(panel, {
      casterLabel: ctx.attackerLabel,
      targetLabel: ctx.defenderLabel,
      cards: ctx.attackCards,
      defCards: ctx.defenseCards,
      key: 0,
    });
    return panel;
  }

  const p = latestPreview;
  if (!p) {
    panel.appendChild(el("span", { className: "preview-empty", textContent: "—" }));
    return panel;
  }
  panel.setAttribute("data-key", String(p.key));
  appendPreviewContent(panel, {
    casterLabel: p.casterLabel,
    targetLabel: p.targetLabel,
    cards: p.cards,
    defCards: p.defCards,
    summaryText: p.summaryText,
    key: p.key,
  });
  return panel;
}

interface PreviewRenderData {
  casterLabel: string;
  targetLabel: string;
  cards: Card[];
  defCards?: Card[];
  summaryText?: string;
  key: number;
}

function appendPreviewContent(panel: HTMLElement, data: PreviewRenderData): void {
  // Header: pill → arrow → pill
  const header = el("div", { className: "preview-header" });
  const casterPill = el("div", { className: "preview-pill" });
  casterPill.appendChild(el("span", { className: "preview-dot" }));
  casterPill.appendChild(el("span", { textContent: data.casterLabel }));
  const arrow = el("div", { className: "preview-arrow", textContent: "→" });
  const targetPill = el("div", { className: "preview-pill preview-pill--target" });
  targetPill.appendChild(el("span", { className: "preview-dot" }));
  targetPill.appendChild(el("span", { textContent: data.targetLabel }));
  header.append(casterPill, arrow, targetPill);
  panel.appendChild(header);

  // Attack cards section
  if (data.cards.length > 0) {
    const atkSection = el("div", { className: "preview-cards-section" });
    for (const c of data.cards) {
      atkSection.appendChild(makeCardPanel(c));
    }
    panel.appendChild(atkSection);
  }

  // Defense cards section (shown during live defense or in result)
  if (data.defCards && data.defCards.length > 0) {
    const defSection = el("div", { className: "preview-cards-section preview-cards-section--def" });
    const defLabel = el("div", { className: "preview-section-label", textContent: "🛡 防御" });
    defSection.appendChild(defLabel);
    for (const c of data.defCards) {
      defSection.appendChild(makeCardPanel(c));
    }
    panel.appendChild(defSection);
  }else if (data.defCards !== undefined) {
    // Explicitly empty defense
    const defSection = el("div", { className: "preview-cards-section preview-cards-section--def" });
    defSection.appendChild(el("div", { className: "preview-section-label", textContent: "🛡 なし" }));
    panel.appendChild(defSection);
  }

  // Summary bar
  if (data.summaryText) {
    const summary = el("div", { className: "preview-summary", textContent: data.summaryText });
    panel.appendChild(summary);
  }
}

function buildMyCardsCol(isAttacker: boolean, phase: string): HTMLElement {
  const col = el("div", { className: "field-col" });
  let cards: Card[] = [];
  let headerText = "自分のカード";

  if (isAttacker && gameState.attackCards.length > 0) {
    cards = [...gameState.attackCards];
    headerText = "⚔ 自分の攻撃";
  } else if (!isAttacker && (phase === "DEFENSE_PHASE" || phase === "RESOLVE_PHASE")) {
    const committed = gameState.defenseCards[LOCAL_PLAYER] ?? [];
    const pending = selectedCards.filter(isDefenseCard);
    const committedIds = new Set(committed.map(c => c.id));
    const allDefCards = [...committed, ...pending.filter(c => !committedIds.has(c.id))];
    cards = allDefCards;
    headerText = "🛡 自分の防御";
  }

  col.appendChild(el("div", { className: "field-cards-header", textContent: headerText }));
  if (cards.length > 0) {
    const list = el("div", { className: "field-cards-list" });
    for (const c of cards) list.appendChild(makeCardPanel(c));
    col.appendChild(list);
    const total = cards.reduce((s, c) => s + (c.power ?? 0), 0);
    if (total > 0) {
      const box = el("div", { className: `field-power-box ${isAttacker ? "atk" : "def"}` });
      box.appendChild(el("span", { className: "field-power-label", textContent: isAttacker ? "攻" : "守" }));
      box.appendChild(el("span", { className: "field-power-value", textContent: String(total) }));
      col.appendChild(box);
    }
  } else {
    col.appendChild(el("div", { className: "field-cards-empty", textContent: "（なし）" }));
  }
  return col;
}

function buildOppCardsCol(isAttacker: boolean, phase: string): HTMLElement {
  const col = el("div", { className: "field-col" });
  let cards: Card[] = [];
  let headerText = "相手のカード";

  if (!isAttacker && gameState.attackCards.length > 0) {
    cards = [...gameState.attackCards];
    headerText = "⚔ 相手の攻撃";
  } else if (isAttacker && (phase === "DEFENSE_PHASE" || phase === "RESOLVE_PHASE")) {
    for (const id of gameState.playerOrder) {
      if (id === LOCAL_PLAYER) continue;
      cards = cards.concat(gameState.defenseCards[id] ?? []);
    }
    headerText = "🛡 相手の防御";
  }

  col.appendChild(el("div", { className: "field-cards-header", textContent: headerText }));
  if (cards.length > 0) {
    const list = el("div", { className: "field-cards-list" });
    for (const c of cards) list.appendChild(makeCardPanel(c));
    col.appendChild(list);
    const total = cards.reduce((s, c) => s + (c.power ?? 0), 0);
    if (total > 0) {
      const box = el("div", { className: `field-power-box ${isAttacker ? "def" : "atk"}` });
      box.appendChild(el("span", { className: "field-power-label", textContent: isAttacker ? "守" : "攻" }));
      box.appendChild(el("span", { className: "field-power-value", textContent: String(total) }));
      col.appendChild(box);
    }
  } else {
    col.appendChild(el("div", { className: "field-cards-empty", textContent: "（なし）" }));
  }
  return col;
}

function buildOpponentsArea(): HTMLElement {
  const area = el("div", { className: "opponents-area" });
  const activeId = getActiveId();
  const phase = gameState.phase;

  for (const id of gameState.playerOrder) {
    const p = gameState.players[id];
    if (!p) continue;

    const isSelf = id === LOCAL_PLAYER;
    const isActive = id === activeId;
    const isTarget = id === selectedTarget;
    const classes = [
      "opponent-row",
      isActive ? "is-active" : "",
      isTarget ? "is-target" : "",
      isSelf ? "is-self" : "",
    ].filter(Boolean).join(" ");
    const row = el("div", { className: classes });
    row.setAttribute("data-player-id", id);

    const avCls = isSelf ? "p1" : id === "P2" ? "p2" : "p1";
    const avatar = el("div", { className: `avatar ${avCls}`, textContent: id });
    const nameText = isSelf ? `${id} (自分)` : `Player ${id.slice(1)}`;
    const name = el("span", { className: "opp-name", textContent: nameText });

    const statsArea = el("div", { className: `opponent-stats${isSelf ? " is-self-stats" : ""}` });
    const hasFog = p.ailment === "霧";
    const statDefs: Array<["hp" | "mp" | "pay", string, number]> = [
      ["hp", "HP", p.stats.hp],
      ["mp", "MP", p.stats.mp],
      ["pay", "¥", p.stats.pay],
    ];
    for (const [cls, label, val] of statDefs) {
      const displayVal = (!isSelf && hasFog) ? "?" : String(val);
      const s = el("div", { className: "opp-stat" });
      s.appendChild(el("span", { className: `opp-stat-label ${cls}`, textContent: label }));
      if (isSelf) {
        // Show stat bars for self
        const bar = el("div", { className: "stat-bar" });
        const fill = el("div", { className: `stat-bar-fill ${cls}` });
        fill.style.width = `${(val / MAX_STAT) * 100}%`;
        bar.appendChild(fill);
        s.appendChild(bar);
      }
      s.appendChild(el("span", { className: "opp-stat-val", textContent: displayVal }));
      statsArea.appendChild(s);
    }

    const handCount = el("span", { className: "opp-hand-count", textContent: `手札 ${p.hand.length}枚` });

    row.append(avatar, name, statsArea, handCount);

    // Ailment badge
    if (p.ailment) {
      row.appendChild(el("span", { className: `ailment-badge ailment-${p.ailment}`, textContent: p.ailment }));
    }

    // Area attack hit/miss result badge (shown directly)
    if (gameState.areaHitResults) {
      const result = gameState.areaHitResults.find((r) => r.playerId === id);
      if (result) {
        const badge = el("span", {
          className: `hit-badge ${result.hit ? "hit" : "miss"}`,
          textContent: result.hit ? "💥 命中" : "外れた",
        });
        row.appendChild(badge);
      }
    }

    // Defense cards placed this phase (visible to all)
    if (phase === "DEFENSE_PHASE" || phase === "RESOLVE_PHASE") {
      const defCards = gameState.defenseCards[id] ?? [];
      if (defCards.length > 0) {
        const defRow = el("div", { className: "opp-def-cards" });
        defRow.appendChild(el("span", { className: "opp-def-label", textContent: "🛡" }));
        for (const c of defCards) {
          defRow.appendChild(makeCardTile(c, false, undefined, true));
        }
        row.appendChild(defRow);
      }
    }

    // Click to select as target
    row.addEventListener("click", () => {
      selectedTarget = selectedTarget === id ? null : id;
      render();
    });

    area.appendChild(row);
  }

  return area;
}

function buildPlayerGrid(): HTMLElement {
  const grid = el("div", { className: "player-grid" });
  const activeId = getActiveId();

  for (const pid of gameState.playerOrder) {
    const p = gameState.players[pid];
    if (!p) continue;
    const isSelf = pid === LOCAL_PLAYER;
    const isActive = pid === activeId;
    const isTargeted = pid === selectedTarget;
    const isDead = p.stats.hp <= 0;

    const btn = el("button", {
      className: [
        "player-grid-btn",
        isSelf ? "is-self" : "",
        isActive ? "is-active" : "",
        isTargeted ? "is-targeted" : "",
        isDead ? "is-dead" : "",
      ].filter(Boolean).join(" "),
    });
    btn.appendChild(el("span", { className: "player-grid-btn__name", textContent: isSelf ? `${pid}(自)` : pid }));
    const stats = el("span", { className: "player-grid-btn__stats", textContent: `HP:${p.stats.hp}` });
    btn.appendChild(stats);
    btn.addEventListener("click", () => {
      selectedTarget = selectedTarget === pid ? null : pid;
      render();
    });
    grid.appendChild(btn);
  }
  return grid;
}

function buildMiddleRow(): HTMLElement {
  const row = el("div", { className: "middle-row" });

  const battleArea = el("div", { className: "battle-area" });
  battleArea.appendChild(buildActionsPanel());
  row.appendChild(battleArea);

  // Card detail panel (right side)
  const detailPanel = el("div", { className: "card-detail-panel" });
  cardDetailContainer = detailPanel;
  renderCardDetail();
  row.appendChild(detailPanel);

  return row;
}

function buildActionsPanel(): HTMLElement {
  const panel = el("div", { className: "actions-panel" });
  const activeId = getActiveId();
  const isLocal = activeId === LOCAL_PLAYER;
  const p1 = gameState.players[LOCAL_PLAYER];
  const phase = gameState.phase;

  // ── DEFENSE_PHASE ──────────────────────────────────────────────────────────
  if (phase === "DEFENSE_PHASE") {
    // Always show attack info at the top of the side panel
    if (gameState.attackCards.length > 0 && !gameState.pendingRingAttack) {
      panel.appendChild(buildAttackInfoBlock());
    }

    // RING counter-attack defense phase: original attacker defends
    if (gameState.pendingRingAttack) {
      const alreadyConfirmed = gameState.confirmedDefenders.includes(LOCAL_PLAYER);
      if (activeId === LOCAL_PLAYER && !alreadyConfirmed) {
        // Buttons are in the defense staging view (buildFieldArea) — just show hint
        panel.appendChild(el("span", { className: "action-hint", textContent: "← 左のエリアで防御カードを選択" }));
        return panel;
      }
      if (alreadyConfirmed) {
        panel.appendChild(el("span", { className: "action-hint", textContent: "✔ 指輪カウンター防御確定済み" }));
        return panel;
      }
      panel.appendChild(el("span", { className: "action-hint", textContent: "指輪カウンター処理中..." }));
      return panel;
    }

    // Compute actual defenders (mirrors getDefenderIds logic from engine)
    const aliveNonActive = gameState.playerOrder.filter(
      (id) => id !== activeId && (gameState.players[id]?.stats.hp ?? 0) > 0
    ) as PlayerId[];
    let actualDefenders: PlayerId[];
    if (gameState.areaHitResults) {
      const hitIds = gameState.areaHitResults.filter((r) => r.hit).map((r) => r.playerId);
      actualDefenders = aliveNonActive.filter((id) => hitIds.includes(id));
    } else if (gameState.attackTarget && gameState.attackTarget !== "ALL") {
      const t = gameState.attackTarget as PlayerId;
      actualDefenders = aliveNonActive.includes(t) ? [t] : [];
    } else {
      actualDefenders = aliveNonActive;
    }

    const p1IsDefender = actualDefenders.includes(LOCAL_PLAYER);
    const alreadyConfirmed = gameState.confirmedDefenders.includes(LOCAL_PLAYER);

    if (p1IsDefender && !alreadyConfirmed && p1) {
      // Buttons are in the defense staging view (buildFieldArea) — just show hint
      panel.appendChild(el("span", { className: "action-hint", textContent: "← 左のエリアで防御カードを選択" }));
      return panel;
    }

    // Attacker during normal defense: just wait
    if (activeId === LOCAL_PLAYER && !p1IsDefender) {
      panel.appendChild(el("span", { className: "action-hint", textContent: "相手が防御中..." }));
      return panel;
    }

    // P1 is not involved (not attacker, not defender) — neutral wait
    if (!p1IsDefender) {
      panel.appendChild(el("span", { className: "action-hint", textContent: "待機中..." }));
      return panel;
    }

    // P1 already confirmed
    panel.appendChild(el("span", {
      className: "action-hint",
      textContent: "✔ 防御確定済み",
    }));
    return panel;
  }

  // BUY consent: when it's the LOCAL_PLAYER who bought, show them the revealed card
  if (gameState.pendingBuyConsent?.buyerId === LOCAL_PLAYER) {
    const { revealedCard, targetId: sellerId } = gameState.pendingBuyConsent;
    const cost = revealedCard.payCost ?? 0;
    const canAfford = p1 ? (p1.stats.pay + p1.stats.mp + p1.stats.hp) >= cost : false;

    const cardPreview = makeCardTile(revealedCard, false);
    cardPreview.style.margin = "0 auto";

    const btnRow = el("div", { className: "actions-buttons" });
    const buyBtn = el("button", {
      className: "btn-action attack",
      textContent: `✔ 購入する (¥${cost})`,
    });
    if (!canAfford) buyBtn.setAttribute("disabled", "");
    buyBtn.addEventListener("click", () => {
      addLog(`「${revealedCard.name}」を購入しました`);
      dispatch({ type: "ACCEPT_BUY", playerId: LOCAL_PLAYER });
    });
    const cancelBtn = el("button", { className: "btn-action secondary", textContent: "✕ やめる" });
    cancelBtn.addEventListener("click", () => {
      addLog("購入をやめました");
      dispatch({ type: "DECLINE_BUY", playerId: LOCAL_PLAYER });
    });
    btnRow.append(buyBtn, cancelBtn);
    panel.append(
      el("p", { className: "action-hint", textContent: `${sellerId} の手札から:` }),
      cardPreview,
      btnRow,
    );
    return panel;
  }

  // BUY consent: when LOCAL_PLAYER is the seller, just wait
  if (gameState.pendingBuyConsent?.targetId === LOCAL_PLAYER) {
    panel.appendChild(el("span", {
      className: "action-hint",
      textContent: `${gameState.pendingBuyConsent.buyerId} があなたのカードを検討中...`,
    }));
    return panel;
  }

  if (!isLocal || !p1) {
    panel.appendChild(el("span", { className: "action-hint", textContent: "相手のターン..." }));
    return panel;
  }

  // ── EXCHANGE_PHASE ─────────────────────────────────────────────────────────
  if (phase === "EXCHANGE_PHASE") {
    const allPlayers = gameState.playerOrder; // includes self
    const opponents = allPlayers.filter((id) => id !== LOCAL_PLAYER);
    const target = selectedTarget ?? (opponents.length === 1 ? opponents[0] : undefined);
    const firstOpp = opponents[0];
    const actionDone = gameState.actionUsedThisTurn;
    const total = p1.stats.hp + p1.stats.mp + p1.stats.pay;

    const attackCards = selectedCards.filter(isAttackCard);
    const healCard = selectedCards.find((c) => c.type === "HEAL_HP" || c.type === "HEAL_MP");
    const exchangeCard = selectedCards.find((c) => c.type === "EXCHANGE");
    const sellCardFromHand = selectedCards.find((c) => c.type === "SELL");
    const buyCardFromHand = p1.hand.find((c) => c.type === "BUY");
    const itemCard = selectedCards.find(
      (c) => c.type !== "SELL" && c.type !== "BUY" && c.type !== "EXCHANGE" &&
             !isAttackCard(c) && !isDefenseCard(c)
    );
    const hasAnyAttackInHand = p1.hand.some((c) => isAttackCard(c));

    // Actions moved to staging view (left panel)
    return panel;
  }

  if (phase === "RESOLVE_PHASE" || phase === "END_CHECK") {
    panel.appendChild(el("span", { className: "action-hint", textContent: "解決中..." }));
  }

  return panel;
}

function buildHandArea(): HTMLElement {
  const container = el("div", { className: "hand-area" });
  const p1 = gameState.players[LOCAL_PLAYER];
  const cards = p1?.hand ?? [];
  const phase = gameState.phase;
  const isLocal = isLocalPlayerActive();
  const activeId = getActiveId();

  // 防御カード選択可否の計算
  const aliveNonActive = gameState.playerOrder.filter(
    (id) => id !== activeId && (gameState.players[id]?.stats.hp ?? 0) > 0
  ) as PlayerId[];
  let actualDefenders: PlayerId[];
  if (gameState.areaHitResults) {
    const hitIds = gameState.areaHitResults.filter((r) => r.hit).map((r) => r.playerId);
    actualDefenders = aliveNonActive.filter((id) => hitIds.includes(id));
  } else if (gameState.attackTarget && gameState.attackTarget !== "ALL") {
    const t = gameState.attackTarget as PlayerId;
    actualDefenders = aliveNonActive.includes(t) ? [t] : [];
  } else {
    actualDefenders = aliveNonActive;
  }

  const isDefenderThisTurn = phase === "DEFENSE_PHASE" && actualDefenders.includes(LOCAL_PLAYER) && !gameState.confirmedDefenders.includes(LOCAL_PLAYER);
  const isAttackerPreDefense = phase === "DEFENSE_PHASE" && !!gameState.pendingRingAttack
    && activeId === LOCAL_PLAYER && (gameState.defenseCards[LOCAL_PLAYER] ?? []).length === 0;
  const canSelectDefense = isDefenderThisTurn || isAttackerPreDefense;
  const canSelectAttack = isLocal && phase === "EXCHANGE_PHASE";
  const atkElement: Element = (gameState.attackElementOverride ?? gameState.attackCards[0]?.element ?? "NEUTRAL") as Element;
  const hasSellCardSelected = isLocal && phase === "EXCHANGE_PHASE"
    && selectedCards.some((c) => c.type === "SELL");
  const playerMP = gameState.players[LOCAL_PLAYER]?.stats.mp ?? 0;

  // 隠しカードと表示カードを分離
  const hiddenCards = cards.filter((c) => newlyDrawnCardIds.has(c.id));
  const visibleCards = cards.filter((c) => !newlyDrawnCardIds.has(c.id));

  // ピアノキー行を構築するヘルパー
  function buildKeyRow(cardList: Card[], showHidden: boolean): HTMLElement {
    const row = el("div", { className: "piano-row" });

    // 伏せカードスロット
    if (showHidden) {
      for (let i = 0; i < hiddenCards.length; i++) {
        const slot = el("div", { className: "piano-key piano-key--hidden" });
        slot.appendChild(el("span", { className: "piano-key__back", textContent: "🎹" }));
        row.appendChild(slot);
      }
    }

    for (const card of cardList) {
      const selected = selectedCards.some((c) => c.id === card.id);
      const exchangeTypes = ["HEAL_HP", "HEAL_MP", "EXCHANGE", "BUY", "DISASTER", "SELL", "CLEANSE", "DISPEL_MIRACLE"] as const;
      const isReflectCard = card.type === "REFLECT_PHYSICAL" || card.type === "REFLECT_ALL";
      const hasElementMismatch = canSelectDefense && isDefenseCard(card) && !isReflectCard
        && !canDefend(atkElement, card.element as Element);
      const hasMpShortage = card.mpCost > 0 && playerMP < card.mpCost
        && (
          (canSelectDefense && isDefenseCard(card)) ||
          (canSelectAttack && isAttackCard(card) && !!card.isMiracle)
        );
      const isDisabled = hasElementMismatch || hasMpShortage;
      const defenseSelectable = canSelectDefense && isDefenseCard(card)
        && (isReflectCard || canDefend(atkElement, card.element as Element))
        && !(card.mpCost > 0 && playerMP < card.mpCost);
      const clickable =
        (!isDisabled && canSelectAttack && isAttackCard(card)) ||
        defenseSelectable ||
        (isLocal && phase === "EXCHANGE_PHASE" && exchangeTypes.some((t) => t === card.type)) ||
        (hasSellCardSelected && card.type !== "SELL" && !(card.isMiracle && card.wasUsed));

      const key = el("div", {
        className: [
          "piano-key",
          `el-${card.element}`,
          selected ? "piano-key--selected" : "",
          isDisabled ? "piano-key--disabled" : "",
          !clickable && !isDisabled ? "piano-key--inactive" : "",
          card.isMiracle ? "piano-key--miracle" : "",
        ].filter(Boolean).join(" "),
      });

      if (card.image) {
        const img = document.createElement("img");
        img.src = `/card-images/${card.image}`;
        img.alt = card.name;
        img.className = "piano-key__img";
        key.appendChild(img);
      } else {
        key.appendChild(el("span", { className: "piano-key__elem", textContent: ELEMENT_EMOJI[card.element] }));
      }
      key.appendChild(el("span", { className: "piano-key__name", textContent: card.name }));

      // power badge
      if (card.power > 0) {
        const typeShort = TYPE_LABEL[card.type] ?? card.type;
        key.appendChild(el("span", { className: "piano-key__power", textContent: `${typeShort}${card.power}` }));
      }

      key.addEventListener("mouseenter", () => { hoveredCard = card; renderCardDetail(); });
      if (clickable) {
        key.addEventListener("click", () => handleCardClick(card));
      }

      row.appendChild(key);
    }

    return row;
  }

  // 1行に何枚表示するか (最大14枚/行)
  const KEYS_PER_ROW = 14;

  // Row 1: 隠しカード + 最初のKEYS_PER_ROW枚
  const row1Cards = visibleCards.slice(0, KEYS_PER_ROW - hiddenCards.length);
  const row1Empty = KEYS_PER_ROW - hiddenCards.length - row1Cards.length;

  const row1 = buildKeyRow(row1Cards, true);
  for (let i = 0; i < row1Empty; i++) {
    row1.appendChild(el("div", { className: "piano-key piano-key--empty" }));
  }
  container.appendChild(row1);

  // Row 2以降: 残りカード
  if (visibleCards.length > KEYS_PER_ROW - hiddenCards.length) {
    const row2Cards = visibleCards.slice(KEYS_PER_ROW - hiddenCards.length);
    const row2 = buildKeyRow(row2Cards, false);
    const row2Empty = Math.max(0, KEYS_PER_ROW - row2Cards.length);
    for (let i = 0; i < row2Empty; i++) {
      row2.appendChild(el("div", { className: "piano-key piano-key--empty" }));
    }
    container.appendChild(row2);
  }

  return container;
}

function buildBottomBar(): HTMLElement {
  const bar = el("div", { className: "bottom-bar" });

  // Player info
  const playerArea = el("div", { className: "bottom-bar__player" });
  playerArea.appendChild(el("div", { className: "avatar p1", textContent: "P1" }));
  playerArea.appendChild(el("span", { className: "bottom-bar__player-name", textContent: "Player 1" }));
  bar.appendChild(playerArea);

  // Log preview — last message
  const lastMsg = logMessages.at(-1) ?? "— ゲームログ —";
  const msgArea = el("div", { className: "bottom-bar__msg", textContent: lastMsg });
  bar.appendChild(msgArea);

  // Center buttons
  const centerBtns = el("div", { className: "bottom-bar__center-btns" });
  const broadcastBtn = el("button", { className: "btn-bottom", textContent: "同 全体にお告げ" });
  broadcastBtn.addEventListener("click", () => {
    const p1 = gameState.players[LOCAL_PLAYER];
    if (!p1) return;
    addLog(`Player 1: 頑張るぞ！ (HP:${p1.stats.hp} MP:${p1.stats.mp})`);
    render();
  });

  const logBtn = el("button", { className: "btn-bottom", textContent: "ʺ お告げの記録" });
  logBtn.addEventListener("click", () => {
    showLog = !showLog;
    render();
  });
  centerBtns.append(broadcastBtn, logBtn);
  bar.appendChild(centerBtns);

  // Icons
  const icons = el("div", { className: "bottom-bar__icons" });
  const sendBtn = el("button", { className: "btn-icon", textContent: "📤" });
  const muteBtn = el("button", { className: "btn-icon", textContent: "🔇" });
  const volBtn = el("button", { className: "btn-icon", textContent: "🔊" });
  icons.append(sendBtn, muteBtn, volBtn);
  bar.appendChild(icons);

  return bar;
}

function buildGameOverOverlay(): HTMLElement {
  const overlay = el("div", { className: "gameover-overlay" });
  const card = el("div", { className: "gameover-card" });

  const winner = gameState.winner;
  const isDraw = gameState.isDraw === true;
  const isWin = winner === LOCAL_PLAYER;

  const title = el("h1", {
    className: `gameover-title ${isDraw ? "draw" : isWin ? "win" : "lose"}`,
    textContent: isDraw ? "🤝 引き分け！" : isWin ? "🎉 勝利！" : "💀 敗北",
  });

  const subtitle = el("p", {
    className: "gameover-subtitle",
    textContent: isDraw ? "引き分け！" : winner ? `${winner} の勝利` : "引き分け",
  });

  const restartBtn = el("button", { className: "btn-restart", textContent: "もう一度プレイ" });
  restartBtn.addEventListener("click", handleRestart);

  card.append(title, subtitle, restartBtn);
  overlay.appendChild(card);

  // Close on backdrop click
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) handleRestart();
  });

  return overlay;
}

function buildLogPanel(): HTMLElement {
  const overlay = el("div", { className: "log-panel-overlay" });
  const panel = el("div", { className: "log-panel" });

  const header = el("div", { className: "log-panel__header" });
  header.appendChild(el("span", { textContent: "ʺ お告げの記録" }));
  const closeBtn = el("button", { className: "btn-icon", textContent: "✕" });
  closeBtn.addEventListener("click", () => {
    showLog = false;
    render();
  });
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const body = el("div", { className: "log-panel__body" });
  if (logMessages.length === 0) {
    body.appendChild(el("p", { className: "log-entry", textContent: "ログなし" }));
  } else {
    for (const msg of [...logMessages].reverse()) {
      body.appendChild(el("p", { className: "log-entry", textContent: msg }));
    }
  }
  panel.appendChild(body);
  overlay.appendChild(panel);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      showLog = false;
      render();
    }
  });

  return overlay;
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

addLog("ゲーム開始！ P1 vs P2");
render();
scheduleAutoAdvance();
