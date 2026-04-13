import type { GameState, GameAction, Card, PlayerId, Element } from "../../domain/types";
import { MAX_STAT } from "../../engine/gameEngine";
import { canDefend } from "../../engine/elementSystem";
// ローカルUI(main.ts)と共通の表示定数/判定を shared から参照する。
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

const WS_URL = `ws://${location.hostname}:3001`;


// ─── State ────────────────────────────────────────────────────────────────────
// グローバルな UI 状態変数。render() はこれらを参照して毎回フル再描画する。
//
// screen         : 現在表示中の画面 ("landing" | "lobby" | "game")
// ws             : WebSocket 接続インスタンス
// myPlayerId     : このクライアントのプレイヤーID (サーバーから払い出し)
// myRoomPassphrase : 参加中の部屋合言葉
// isHost         : 自分がホストかどうか
// lobbyPlayers   : ロビー参加者一覧 (名前・ID・ホストフラグ)
// gameState      : 最新のゲーム状態 (サーバーから受信した GameState)
// selectedCards  : 手札で選択中のカード配列
// selectedTarget : 攻撃・スキル対象として選択中のプレイヤーID
// hoveredCard    : カード詳細パネルに表示するホバー中カード
// logMessages    : ゲームログ文字列配列 (最大100件)
// showLog        : ログモーダルパネルの表示フラグ
// uiLocked       : 全体攻撃アニメーション中 → 操作ブロック
// missBannerVisible : 全体攻撃全外れバナーの表示フラグ
// exchangeFormHp/Mp : 両替フォームの入力値 (再レンダー間で保持)
// prevGameState  : 状態差分検出用の一世代前のゲーム状態
// newlyDrawnCardIds : 直前のドローで増えたカードID (伏せ表示用)
// revealTimer    : 伏せカードをプレビュー終了後に開示する待機タイマー
// turnCount      : 現在のターン数 (表示用カウンター)
// ascendingPlayers  : 昇天演出用 — 直前に HP=0 になったプレイヤー名
// showMiraclePanel  : 「起こした奇跡」パネルの表示フラグ

type Screen = "landing" | "lobby" | "game";

let screen: Screen = "landing";
let ws: WebSocket | null = null;
let myPlayerId: PlayerId | null = null;
let myRoomPassphrase: string | null = null;
let isHost = false;
let lobbyPlayers: { id: string; name: string; isHost: boolean }[] = [];
let gameState: GameState | null = null;
let selectedCards: Card[] = [];
let selectedTarget: PlayerId | null = null;
let hoveredCard: Card | null = null;
let logMessages: string[] = [];
let showLog = false;

let phaseTimerTimeout: ReturnType<typeof setTimeout> | null = null;
let phaseTimerStartTime: number | null = null;
let phaseTimerInterval: ReturnType<typeof setInterval> | null = null;
let phaseTimerKey: string | null = null;
const PHASE_TIMER_MS = 25000;
/** True while a global-attack animation is running; blocks UI input and phase timer. */
let uiLocked = false;
/** True while the full-area-miss banner should be visible */
let missBannerVisible = false;
/** Persisted exchange form values across re-renders */
let exchangeFormHp: number | null = null;
let exchangeFormMp: number | null = null;
/** Previous game state for event detection via state diff. */
let prevGameState: GameState | null = null;
let newlyDrawnCardIds: Set<string> = new Set();
let revealTimer: ReturnType<typeof setTimeout> | null = null;
let turnCount = 1;
let ascendingPlayers: string[] = [];
let ascensionDisplayTimer: ReturnType<typeof setTimeout> | null = null;
let showMiraclePanel = false;

interface PreviewEvent {
  casterLabel: string;
  targetLabel: string;
  cards: Card[];
  defCards?: Card[];
  summaryText?: string;
  key: number;
}
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
let previewLastSignature: string | null = null;
const PREVIEW_DURATION = 600;
const REVEAL_POLL_MS = 50;
const WATCHER_ANIM_STEP_MS = 180;
const WATCHER_ANIM_MAX_STEP = 3;
let watcherPreviewStep = WATCHER_ANIM_MAX_STEP;
let watcherPreviewTimer: ReturnType<typeof setTimeout> | null = null;
let watcherPreviewSig: string | null = null;

function previewSignature(evt: PreviewEvent): string {
  const cardIds = evt.cards.map((c) => c.id).join(",");
  const defCardIds = (evt.defCards ?? []).map((c) => c.id).join(",");
  return `${evt.casterLabel}|${evt.targetLabel}|${evt.summaryText ?? ""}|${cardIds}|${defCardIds}`;
}

function isPreviewTransitionActive(): boolean {
  return previewAdvanceTimer !== null || previewQueue.length > 0 || watcherPreviewTimer !== null || watcherPreviewStep < WATCHER_ANIM_MAX_STEP;
}

function clearWatcherPreviewAnimation(): void {
  watcherPreviewStep = WATCHER_ANIM_MAX_STEP;
  watcherPreviewSig = null;
  if (watcherPreviewTimer !== null) {
    clearTimeout(watcherPreviewTimer);
    watcherPreviewTimer = null;
  }
}

function startWatcherPreviewAnimation(evt: PreviewEvent): void {
  clearWatcherPreviewAnimation();
  watcherPreviewSig = previewSignature(evt);
  watcherPreviewStep = 0;
  render();
  const advance = () => {
    if (!latestPreview || previewSignature(latestPreview) !== watcherPreviewSig) {
      clearWatcherPreviewAnimation();
      render();
      return;
    }
    if (watcherPreviewStep >= WATCHER_ANIM_MAX_STEP) {
      watcherPreviewTimer = null;
      render();
      return;
    }
    watcherPreviewStep += 1;
    render();
    if (watcherPreviewStep < WATCHER_ANIM_MAX_STEP) {
      watcherPreviewTimer = setTimeout(advance, WATCHER_ANIM_STEP_MS);
    } else {
      watcherPreviewTimer = null;
    }
  };
  watcherPreviewTimer = setTimeout(advance, WATCHER_ANIM_STEP_MS);
}

function pushPreview(evt: PreviewEvent): void {
  const sig = previewSignature(evt);
  const currentSig = latestPreview ? previewSignature(latestPreview) : null;
  const queuedHasSame = previewQueue.some((q) => previewSignature(q) === sig);
  if (sig === currentSig || sig === previewLastSignature || queuedHasSame) return;

  // プレビューは1件だけキュー保持し、連続チラつきを抑える。
  previewQueue = [evt];
  if (previewAdvanceTimer === null) showNextPreview();
}
function showNextPreview(): void {
  if (previewAdvanceTimer !== null) {
    clearTimeout(previewAdvanceTimer);
    previewAdvanceTimer = null;
  }
  if (previewQueue.length === 0) return;
  latestPreview = previewQueue.shift()!;
  previewLastSignature = previewSignature(latestPreview);
  startWatcherPreviewAnimation(latestPreview);
  previewAdvanceTimer = setTimeout(() => {
    previewAdvanceTimer = null;
    previewLastSignature = null;
    if (previewQueue.length > 0) showNextPreview();
  }, PREVIEW_DURATION);
}

function clearPreviewState(): void {
  defenseContext = null;
  latestPreview = null;
  previewQueue = [];
  previewLastSignature = null;
  clearWatcherPreviewAnimation();
  if (previewAdvanceTimer !== null) {
    clearTimeout(previewAdvanceTimer);
    previewAdvanceTimer = null;
  }
}

function clearNewlyDrawnCards(): void {
  if (newlyDrawnCardIds.size === 0) return;
  newlyDrawnCardIds = new Set();
  render();
}

function scheduleRevealAfterWatcherPreview(): void {
  if (revealTimer) {
    clearTimeout(revealTimer);
    revealTimer = null;
  }
  const tryReveal = () => {
    // buildWatcherCardsCol で使っているプレビュー表示が終わるまで待つ
    if (isPreviewTransitionActive()) {
      revealTimer = setTimeout(tryReveal, REVEAL_POLL_MS);
      return;
    }
    revealTimer = null;
    clearNewlyDrawnCards();
  };
  revealTimer = setTimeout(tryReveal, REVEAL_POLL_MS);
}



// ─── Helpers ─────────────────────────────────────────────────────────────────
// ゲームロジック補助関数。カード種別判定・ログ追記・WebSocket dispatch など。

function addLog(msg: string) {
  const now = new Date();
  const ts = `${now.getHours().toString().padStart(2,"0")}:${now.getMinutes().toString().padStart(2,"0")}`;
  logMessages.push(`[${ts}] ${msg}`);
  if (logMessages.length > 100) logMessages.shift();
}

function dispatch(action: GameAction) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "ACTION", action }));
  selectedTarget = null;
}

function clearPhaseTimer(): void {
  if (phaseTimerTimeout !== null) { clearTimeout(phaseTimerTimeout); phaseTimerTimeout = null; }
  if (phaseTimerInterval !== null) { clearInterval(phaseTimerInterval); phaseTimerInterval = null; }
  phaseTimerStartTime = null;
}

function executeExchangeAction(): void {
  if (!gameState || !myPlayerId) return;
  const opponents = gameState.playerOrder.filter((id) => id !== myPlayerId) as PlayerId[];
  const attackCards = selectedCards.filter(isAttackCard);
  const healCard = selectedCards.find((c) => c.type === "HEAL_HP" || c.type === "HEAL_MP");
  const disasterCard = selectedCards.find((c) => c.type === "DISASTER");
  const cleanseCard = selectedCards.find((c) => c.type === "CLEANSE");
  const dispelCard = selectedCards.find((c) => c.type === "DISPEL_MIRACLE");
  const buyCard = selectedCards.find((c) => c.type === "BUY");
  const sellCard = selectedCards.find((c) => c.type === "SELL");
  const itemCard = selectedCards.find(
    (c) => c.type !== "SELL" && c.type !== "BUY" && c.type !== "EXCHANGE" &&
      c.type !== "DISASTER" && c.type !== "CLEANSE" && c.type !== "DISPEL_MIRACLE" &&
      !isAttackCard(c) && !isDefenseCard(c)
  );
  const target = selectedTarget ?? (opponents.length === 1 ? opponents[0] : undefined);
  selectedCards = [];
  if (attackCards.length > 0 && target) {
    dispatch({ type: "ATTACK", cards: [...attackCards], target });
  } else if (healCard) {
    dispatch({ type: "USE_HEAL", cardId: healCard.id, targetId: selectedTarget ?? myPlayerId });
  } else if (disasterCard && target) {
    dispatch({ type: "USE_DISASTER", playerId: myPlayerId, cardId: disasterCard.id, targetId: target });
  } else if (cleanseCard && target) {
    dispatch({ type: "USE_CLEANSE", cardId: cleanseCard.id, targetId: target });
  } else if (dispelCard && target) {
    dispatch({ type: "USE_DISPEL_MIRACLE", cardId: dispelCard.id, targetId: target });
  } else if (sellCard && itemCard && target) {
    dispatch({ type: "SELL", sellCardId: sellCard.id, itemCardId: itemCard.id, targetId: target });
  } else if (buyCard && target) {
    dispatch({ type: "BUY", buyCardId: buyCard.id, targetId: target });
  } else {
    dispatch({ type: "END_EXCHANGE" });
  }
}

function executeDefenseAction(): void {
  if (!myPlayerId || !gameState) return;
  const defCards = selectedCards.filter(isDefenseCard);
  selectedCards = [];
  if (defCards.length > 0) {
    dispatch({ type: "DEFEND", playerId: myPlayerId, cards: [...defCards] });
  }
  dispatch({ type: "CONFIRM_DEFENSE", playerId: myPlayerId });
}

function schedulePhaseTimer(gs: GameState): void {
  if (isAnimPlaying()) return; // animation pipeline controls timing
  if (!myPlayerId) return;
  const activeId = gs.playerOrder[gs.activePlayerIndex];
  const { phase } = gs;

  // Auto-end turn immediately when action is done (but not while awaiting BUY consent or PTA defense)
  if (phase === "EXCHANGE_PHASE" && activeId === myPlayerId && gs.actionUsedThisTurn && !gs.pendingBuyConsent && !gs.pendingTargetedAction) {
    clearPhaseTimer();
    phaseTimerKey = null;
    dispatch({ type: "END_EXCHANGE" });
    return;
  }

  let timerKey: string | null = null;

  if (phase === "EXCHANGE_PHASE" && activeId === myPlayerId) {
    timerKey = `exchange-${gs.activePlayerIndex}`;
  } else if (phase === "DEFENSE_PHASE") {
    if (gs.pendingTargetedAction) {
      const pta = gs.pendingTargetedAction;
      if (pta.currentTargetId === myPlayerId && !gs.confirmedDefenders.includes(myPlayerId)) {
        timerKey = `defense-pta-${gs.activePlayerIndex}-${pta.casterId}-${pta.originalTargetId}`;
      }
    } else if ((gs.pendingRingAttack || gs.pendingReflect) && activeId === myPlayerId && !gs.confirmedDefenders.includes(myPlayerId)) {
      timerKey = `defense-ring-reflect-${gs.activePlayerIndex}`;
    } else if (!gs.pendingRingAttack && !gs.pendingReflect) {
      const aliveNonActive = gs.playerOrder.filter(
        (id) => id !== activeId && (gs.players[id]?.stats.hp ?? 0) > 0
      ) as PlayerId[];
      let defenders: PlayerId[];
      if (gs.areaHitResults) {
        const hitIds = gs.areaHitResults.filter((r) => r.hit).map((r) => r.playerId);
        defenders = aliveNonActive.filter((id) => hitIds.includes(id));
      } else if (gs.attackTarget && gs.attackTarget !== "ALL") {
        const t = gs.attackTarget as PlayerId;
        defenders = aliveNonActive.includes(t) ? [t] : [];
      } else {
        defenders = aliveNonActive;
      }
      if (defenders.includes(myPlayerId) && !gs.confirmedDefenders.includes(myPlayerId)) {
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
    if (isExchange) executeExchangeAction();
    else executeDefenseAction();
  }, PHASE_TIMER_MS);
}

function myName(): string {
  const p = lobbyPlayers.find((p) => p.id === myPlayerId);
  return p?.name ?? myPlayerId ?? "?";
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
// サーバー (port 3001) との接続管理。
// connect() でルーム作成/参加し、メッセージハンドラで状態を更新して render() を呼ぶ。
// 受信メッセージ種別:
//   ROOM_CREATED  → myPlayerId・myRoomPassphrase をセット → lobby 画面へ
//   ROOM_JOINED   → 同上 (参加者側)
//   LOBBY_STATE   → lobbyPlayers 更新 → lobby 画面再描画
//   GAME_STATE    → gameState 更新 + 状態差分イベント検出 (攻撃/防御/昇天/ミス) → game 画面へ
//   ERROR         → エラートースト表示

function connect(playerName: string, mode: "create", passphrase: string): void;
function connect(playerName: string, mode: "join", passphrase: string): void;
function connect(playerName: string, mode: "create" | "join", passphrase: string): void {
  ws = new WebSocket(WS_URL);

  ws.addEventListener("open", () => {
    if (mode === "create") {
      ws!.send(JSON.stringify({ type: "CREATE_ROOM", playerName, passphrase }));
    } else {
      // 旧サーバー互換: roomCode も同時送信する
      ws!.send(JSON.stringify({ type: "JOIN_ROOM", playerName, passphrase, roomCode: passphrase }));
    }
  });

  ws.addEventListener("message", (ev) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg["type"]) {
      case "ROOM_CREATED":
        myPlayerId = String(msg["playerId"]) as PlayerId;
        {
          const rawPassphrase = msg["passphrase"] ?? msg["roomCode"];
          const resolvedPassphrase = typeof rawPassphrase === "string" ? rawPassphrase.trim() : "";
          if (!resolvedPassphrase) {
            showError("合言葉情報を受信できませんでした。サーバーを再起動してください。");
            break;
          }
          myRoomPassphrase = resolvedPassphrase;
        }
        isHost = true;
        screen = "lobby";
        render();
        break;
      case "ROOM_JOINED":
        myPlayerId = String(msg["playerId"]) as PlayerId;
        {
          const rawPassphrase = msg["passphrase"] ?? msg["roomCode"];
          const resolvedPassphrase = typeof rawPassphrase === "string" ? rawPassphrase.trim() : "";
          if (!resolvedPassphrase) {
            showError("合言葉情報を受信できませんでした。サーバーを再起動してください。");
            break;
          }
          myRoomPassphrase = resolvedPassphrase;
        }
        screen = "lobby";
        render();
        break;
      case "LOBBY_STATE":
        lobbyPlayers = msg["players"] as typeof lobbyPlayers;
        isHost = lobbyPlayers.find((p) => p.id === myPlayerId)?.isHost ?? false;
        render();
        break;
      case "GAME_STATE": {
        const newState = msg["state"] as GameState;
        // Event detection from state diff
        if (prevGameState) {
          const prev = prevGameState;
          const nameOf = (id: string) => {
            if (id === myPlayerId) return "自分";
            return lobbyPlayers.find((p) => p.id === id)?.name ?? id;
          };

          // ATTACK: EXCHANGE_PHASE → DEFENSE_PHASE — set up live defenseContext
          if (prev.phase === "EXCHANGE_PHASE" && newState.phase === "DEFENSE_PHASE" && newState.attackCards.length > 0 && !newState.pendingTargetedAction) {
            const attackerId = newState.playerOrder[newState.activePlayerIndex];
            const target = newState.attackTarget;
            const tLabel = (!target || target === "ALL") ? "全体" : nameOf(target as string);
            const tId = (!target || target === "ALL") ? "" : target as string;
            defenseContext = {
              attackerLabel: nameOf(attackerId),
              defenderLabel: tLabel,
              targetId: tId,
              attackCards: [...newState.attackCards],
              defenseCards: [],
            };
          }

          // Area miss: new areaHitResults entries with hit=false
          const prevHits = prev.areaHitResults ?? [];
          const newHits = newState.areaHitResults ?? [];
          if (newHits.length > prevHits.length) {
            const atkId = newState.playerOrder[newState.activePlayerIndex];
            const atkCard = newState.attackCards[0] ?? prev.attackCards[0];
            for (const r of newHits.slice(prevHits.length)) {
              if (!r.hit) {
                pushPreview({ casterLabel: nameOf(atkId), cards: atkCard ? [atkCard] : [], targetLabel: `${nameOf(r.playerId as string)}に外れ！`, key: Date.now() + Math.random() });
              }
            }
          }
          // All-miss detection: when areaHitResults first appears and ALL results are misses
          if (!prev.areaHitResults && newState.areaHitResults && newState.areaHitResults.length > 0) {
            const allMiss = newState.areaHitResults.every((r) => !r.hit);
            if (allMiss) {
              addLog("全体攻撃：誰にも当たらなかった！");
              triggerScreenShake(150);
              missBannerVisible = true;
              setTimeout(() => { missBannerVisible = false; render(); }, 2200);
            }
          }

          // ── Area attack cinematic animation ─────────────────────────────
          // Fires once when areaHitResults first appears (first GAME_STATE
          // broadcast after the ATTACK action is processed by the server).
          if (!prev.areaHitResults && newState.areaHitResults && newState.areaHitResults.length > 0) {
            const atkCard = newState.attackCards[0];
            if (atkCard?.areaAttackPercent) {
              uiLocked = true;
              const hitResults = newState.areaHitResults.map(r => ({
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
                  if (gameState) schedulePhaseTimer(gameState);
                },
              });
            }
          }

          // Death screen shake — fires when any player's HP drops to 0
          for (const id of newState.playerOrder) {
            const prevHp = prev.players[id as PlayerId]?.stats.hp ?? 0;
            const newHp = newState.players[id as PlayerId]?.stats.hp ?? 0;
            if (prevHp > 0 && newHp <= 0) {
              triggerScreenShake(200);
              break;
            }
          }

          // DEFENSE_PHASE → non-DEFENSE: push result if attackCards were present
          if (prev.phase === "DEFENSE_PHASE" && newState.phase !== "DEFENSE_PHASE" && prev.attackCards.length > 0 && !prev.pendingTargetedAction) {
            const attackerId = prev.playerOrder[prev.activePlayerIndex];
            let primaryTarget: string | undefined;
            if (prev.attackTarget && prev.attackTarget !== "ALL") {
              primaryTarget = prev.attackTarget as string;
            } else {
              const hit = prev.areaHitResults?.find((r: {hit: boolean; playerId: unknown}) => r.hit);
              primaryTarget = hit?.playerId as string | undefined;
            }
            const atkPower = prev.attackCards.reduce((s: number, c: {power?: number}) => s + (c.power ?? 0), 0);
            const defCards = primaryTarget ? (prev.defenseCards[primaryTarget as import("../../domain/types").PlayerId] ?? []) : [];
            const defPower = defCards.reduce((s: number, c: {power?: number}) => s + (c.power ?? 0), 0);
            let summaryText = `⚔${atkPower}  🛡${defPower}`;
            if (primaryTarget) {
              const hpBefore = prev.players[primaryTarget as import("../../domain/types").PlayerId]?.stats.hp ?? 0;
              const hpAfter = newState.players[primaryTarget as import("../../domain/types").PlayerId]?.stats.hp ?? 0;
              const dmg = Math.max(0, hpBefore - hpAfter);
              summaryText += `  💥${dmg}`;
            }
            pushPreview({
              casterLabel: nameOf(attackerId),
              targetLabel: nameOf(primaryTarget ?? "?"),
              cards: [...(prev.attackCards as Card[])],
              defCards: [...(defCards as Card[])],
              summaryText,
              key: Date.now(),
            });
            defenseContext = null;
          }

          // DEFEND: update defenseContext with all current defense cards for this defender
          for (const id of newState.playerOrder) {
            const newDef = newState.defenseCards[id as import("../../domain/types").PlayerId] ?? [];
            const prevDef = prev.defenseCards[id as import("../../domain/types").PlayerId] ?? [];
            if (newDef.length > prevDef.length && defenseContext && id === defenseContext.targetId) {
              defenseContext = { ...defenseContext, defenseCards: [...newDef] };
            }
          }

          // PTA staged
          if (!prev.pendingTargetedAction && newState.pendingTargetedAction) {
            const pta = newState.pendingTargetedAction;
            const caster = nameOf(pta.casterId);
            const curTarget = nameOf(pta.currentTargetId);
            const ptaCard = pta.itemCard;
            pushPreview({ casterLabel: caster, cards: ptaCard ? [ptaCard] : [], targetLabel: curTarget, key: Date.now() });
          }

          // PTA reflect
          if (prev.pendingTargetedAction && newState.pendingTargetedAction &&
              prev.pendingTargetedAction.currentTargetId !== newState.pendingTargetedAction.currentTargetId) {
            const pta = newState.pendingTargetedAction;
            pushPreview({ casterLabel: "🔄 跳ね返し", cards: [], targetLabel: nameOf(pta.currentTargetId), key: Date.now() });
          }

          // EXCHANGE_PHASE events: PRAY, EXCHANGE
          if (prev.phase === "EXCHANGE_PHASE" && newState.phase === "EXCHANGE_PHASE") {
            for (const id of newState.playerOrder) {
              const prevP = prev.players[id as import("../../domain/types").PlayerId];
              const newP = newState.players[id as import("../../domain/types").PlayerId];
              if (!prevP || !newP) continue;
              const who = nameOf(id);
              if (newP.hand.length > prevP.hand.length && !newState.actionUsedThisTurn && !prev.actionUsedThisTurn) {
                pushPreview({ casterLabel: who, cards: [], targetLabel: "祈る🙏", key: Date.now() });
              }
            }
            // 両替は「手札枚数が増減しない」ケースがあるため、行動者のステータス配分変化で検出する。
            const actorId = newState.playerOrder[newState.activePlayerIndex];
            const prevActor = prev.players[actorId as import("../../domain/types").PlayerId];
            const newActor = newState.players[actorId as import("../../domain/types").PlayerId];
            if (prevActor && newActor && !prev.actionUsedThisTurn && newState.actionUsedThisTurn && !newState.pendingBuyConsent && !newState.pendingTargetedAction) {
              const hpGain = Math.max(0, newActor.stats.hp - prevActor.stats.hp);
              const mpGain = Math.max(0, newActor.stats.mp - prevActor.stats.mp);
              if (hpGain > 0 || mpGain > 0) {
                const gainText = [hpGain > 0 ? `HP+${hpGain}` : "", mpGain > 0 ? `MP+${mpGain}` : ""]
                  .filter(Boolean)
                  .join(" ");
                pushPreview({
                  casterLabel: nameOf(actorId),
                  cards: [],
                  targetLabel: `回復 ${gainText}`,
                  key: Date.now(),
                });
              }

              const prevTotal = prevActor.stats.hp + prevActor.stats.mp + prevActor.stats.pay;
              const newTotal = newActor.stats.hp + newActor.stats.mp + newActor.stats.pay;
              const redistributed = prevTotal === newTotal
                && (prevActor.stats.hp !== newActor.stats.hp || prevActor.stats.mp !== newActor.stats.mp || prevActor.stats.pay !== newActor.stats.pay);
              if (redistributed) {
                const hpDelta = newActor.stats.hp - prevActor.stats.hp;
                const mpDelta = newActor.stats.mp - prevActor.stats.mp;
                const payDelta = newActor.stats.pay - prevActor.stats.pay;
                const deltaText = [
                  `HP${hpDelta >= 0 ? "+" : ""}${hpDelta}`,
                  `MP${mpDelta >= 0 ? "+" : ""}${mpDelta}`,
                  `¥${payDelta >= 0 ? "+" : ""}${payDelta}`,
                ].join(" ");
                pushPreview({
                  casterLabel: nameOf(actorId),
                  cards: [],
                  targetLabel: `両替 ${deltaText} → HP${newActor.stats.hp} MP${newActor.stats.mp} ¥${newActor.stats.pay}`,
                  key: Date.now(),
                });
              }
            }
          }

          // Increment turn counter on player change
          if (prev.activePlayerIndex !== newState.activePlayerIndex) {
            // ターン交代時に即クリアすると直前行動のプレビューが見えないため、
            // 表示中プレビューは維持しつつ次キューだけ破棄する。
            defenseContext = null;
            previewQueue = [];
            previewLastSignature = null;
            turnCount++;
          }

          // Death detection: RESOLVE_PHASE → other phase
          if (prev.phase === "RESOLVE_PHASE" && newState.phase !== "RESOLVE_PHASE") {
            const newlyDead: string[] = [];
            for (const pid of prev.playerOrder) {
              const prevHp = prev.players[pid as import("../../domain/types").PlayerId]?.stats.hp ?? 0;
              const newHp = newState.players[pid as import("../../domain/types").PlayerId]?.stats.hp ?? 0;
              if (prevHp > 0 && newHp <= 0) {
                const pInfo = lobbyPlayers.find((p) => p.id === pid);
                newlyDead.push(pid === myPlayerId ? "自分" : (pInfo?.name ?? pid));
              }
            }
            if (newlyDead.length > 0) {
              ascendingPlayers = newlyDead;
              if (ascensionDisplayTimer) clearTimeout(ascensionDisplayTimer);
              ascensionDisplayTimer = setTimeout(() => {
                ascendingPlayers = [];
                ascensionDisplayTimer = null;
                render();
              }, 2500);
            }
          }
        }
        // Detect newly drawn cards for the local player
        if (myPlayerId && prevGameState) {
          const prevHand = prevGameState.players[myPlayerId]?.hand ?? [];
          const newHand = newState.players[myPlayerId]?.hand ?? [];
          let hasNewDraw = false;
          if (newHand.length > prevHand.length) {
            const prevIds = new Set(prevHand.map((c) => c.id));
            for (const c of newHand) {
              if (!prevIds.has(c.id)) {
                newlyDrawnCardIds.add(c.id);
                hasNewDraw = true;
              }
            }
          }
          if (hasNewDraw) scheduleRevealAfterWatcherPreview();
        }

        prevGameState = newState;
        gameState = newState;
        screen = "game";
        render();
        if (!isAnimPlaying()) schedulePhaseTimer(newState);
        break;
      }
      case "ERROR":
        showError(String(msg["message"] ?? "エラーが発生しました"));
        break;
    }
  });

  ws.addEventListener("close", () => {
    if (screen === "game") addLog("接続が切断されました");
    render();
  });

  ws.addEventListener("error", () => {
    showError("サーバーに接続できません。npm run server が起動しているか確認してください。");
  });
}

// ─── DOM Helpers ──────────────────────────────────────────────────────────────
// el() : タグ名・属性・子要素を受け取って HTMLElement を生成するユーティリティ。
//        className / textContent / data-* / boolean属性 をまとめて設定できる。
// showError() : 4秒後に自動消去されるエラートースト (画面上部中央に固定表示)。

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
    else if (typeof v === "boolean") { if (v) e.setAttribute(k, ""); }
    else (e as unknown as Record<string, string>)[k] = v;
  }
  for (const child of children) {
    if (child === null) continue;
    if (typeof child === "string") e.appendChild(document.createTextNode(child));
    else e.appendChild(child);
  }
  return e;
}

/**
 * Shows an error toast message that automatically dismisses after 3 seconds.
 * Replaces inline style toast with CSS-based implementation.
 */
function showError(msg: string) {
  const existing = document.getElementById("err-toast");
  existing?.remove();
  const toast = el("div", { id: "err-toast", className: "error-toast", textContent: msg });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ─── Screens ──────────────────────────────────────────────────────────────────
// render() が唯一のエントリポイント。#app を毎回クリアしてフル再構築する。
// screen の値に応じて buildLanding() / buildLobby() / buildGame() を呼び分ける。

function render() {
  const app = document.getElementById("app");
  if (!app) return;
  app.innerHTML = "";
  if (uiLocked) app.classList.add("ui-locked");
  else app.classList.remove("ui-locked");
  if (screen === "landing") app.appendChild(buildLanding());
  else if (screen === "lobby") app.appendChild(buildLobby());
  else app.appendChild(buildGame());
}

// ── Landing ──────────────────────────────────────────────────────────────────
// 【画面: ランディング (初期画面)】
// URL: /online.html を開いたときに最初に表示される画面。
// ┌────────────────────────┐
// │  ⚔ GoodField           │
// │  プレイヤー名入力        │
// │  [部屋を作成]           │
// │  ──────────────────    │
// │  合言葉入力              │
// │  [+ 部屋に参加]         │
// └────────────────────────┘
// 部屋作成 → CREATE_ROOM をサーバーに送信 → ROOM_CREATED 受信でロビーへ
// 部屋参加 → JOIN_ROOM をサーバーに送信 → ROOM_JOINED 受信でロビーへ

function buildLanding(): HTMLElement {
  const box = el("div", { className: "lobby-container" });
  box.appendChild(el("h1", { textContent: "⚔ GoodField" }));
  box.appendChild(el("p", { className: "action-hint", textContent: "localhost オンライン対戦" }));

  // Player name input with label
  const nameLabel = el("label", { textContent: "プレイヤー名" });
  nameLabel.style.cssText = "font-size: 12px; color: var(--text-dim); margin-bottom: 4px; display: block;";
  
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "プレイヤー名を入力";
  nameInput.className = "lobby-input";
  nameInput.maxLength = 12;
  nameInput.setAttribute("aria-label", "プレイヤー名");
  
  box.appendChild(nameLabel);
  box.appendChild(nameInput);

  // Passphrase input
  const passphraseLabel = el("label", { textContent: "部屋の合言葉" });
  passphraseLabel.style.cssText = "font-size: 12px; color: var(--text-dim); margin-bottom: 4px; display: block;";

  const passphraseInput = document.createElement("input");
  passphraseInput.type = "text";
  passphraseInput.placeholder = "合言葉を入力（日本語可）";
  passphraseInput.className = "lobby-input";
  passphraseInput.maxLength = 32;
  passphraseInput.setAttribute("aria-label", "部屋の合言葉");
  box.appendChild(passphraseLabel);
  box.appendChild(passphraseInput);

  // Create room button
  const createBtn = el("button", { className: "btn-action attack", textContent: "部屋を作成" });
  createBtn.setAttribute("aria-label", "合言葉で新しい部屋を作成");
  createBtn.addEventListener("click", () => {
    const name = nameInput.value.trim() || "Player";
    const passphrase = passphraseInput.value.trim();
    if (!passphrase) {
      showError("合言葉を入力してください");
      return;
    }
    connect(name, "create", passphrase);
  });

  const joinBtn = el("button", { className: "btn-action exchange", textContent: "+ 部屋に参加" });
  joinBtn.setAttribute("aria-label", "合言葉で部屋に参加");
  joinBtn.addEventListener("click", () => {
    const name = nameInput.value.trim() || "Player";
    const passphrase = passphraseInput.value.trim();
    if (!passphrase) {
      showError("合言葉を入力してください");
      return;
    }
    connect(name, "join", passphrase);
  });

  // Handle Enter key for form submission
  const handleEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      const name = nameInput.value.trim() || "Player";
      const passphrase = passphraseInput.value.trim();
      if (!passphrase) {
        showError("合言葉を入力してください");
        return;
      }
      connect(name, "join", passphrase);
    }
  };
  nameInput.addEventListener("keydown", handleEnter);
  passphraseInput.addEventListener("keydown", handleEnter);

  const row = el("div", { className: "btn-row" });
  row.appendChild(createBtn);
  box.appendChild(row);
  
  box.appendChild(el("hr", { className: "lobby-separator" }));
  box.appendChild(el("p", { className: "action-hint", textContent: "参加する場合も同じ合言葉を入力" }));
  
  const joinRow = el("div", { className: "btn-row" });
  joinRow.appendChild(joinBtn);
  box.appendChild(joinRow);

  return box;
}

// ── Lobby ────────────────────────────────────────────────────────────────────
// 【画面: ロビー】
// ゲーム開始を待機する画面。LOBBY_STATE を受信するたびに更新される。
// ┌──────────────────────────────────────┐
// │  合言葉: ******  [👑 あなたはホスト]   │
// │  参加者一覧                            │
// │  ・Player1 (👑)                       │
// │  ・Player2                            │
// │  [▶ ゲームスタート]  (ホストのみ表示)   │
// └──────────────────────────────────────┘
// ホストが「ゲームスタート」→ START_GAME 送信 → サーバーが GAME_STATE をブロードキャスト

function buildLobby(): HTMLElement {
  const box = el("div", { className: "lobby-container" });
  box.appendChild(el("h1", { textContent: "⚔ GoodField" }));

  if (myRoomPassphrase) {
    box.appendChild(el("p", { className: "action-hint", textContent: "合言葉" }));
    box.appendChild(el("div", { className: "room-code-display", textContent: myRoomPassphrase }));
    box.appendChild(el("p", { className: "action-hint", textContent: "この合言葉を友達に伝えてください" }));
  }

  box.appendChild(el("h3", { textContent: `プレイヤー (${lobbyPlayers.length}/9)` }));
  const list = el("ul", { className: "lobby-player-list" });
  
  for (const p of lobbyPlayers) {
    const li = el("li", { className: "lobby-player-item" });
    
    // Avatar
    const avatar = el("div", { className: "lobby-avatar", textContent: p.id });
    avatar.setAttribute("data-player", p.id);
    li.appendChild(avatar);
    
    // Player name
    const nameSpan = el("span", { className: "lobby-player-name", textContent: p.name });
    li.appendChild(nameSpan);
    
    // Badges
    if (p.id === myPlayerId) {
      const badge = el("span", { className: "lobby-player-badge", textContent: "あなた" });
      li.appendChild(badge);
    }
    if (p.isHost) {
      const badge = el("span", { className: "lobby-player-badge host", textContent: "ホスト" });
      li.appendChild(badge);
    }
    list.appendChild(li);
  }
  box.appendChild(list);

  if (isHost) {
    const startBtn = el("button", { className: "btn-action attack", textContent: "▶ バトル開始" });
    if (lobbyPlayers.length < 2) startBtn.setAttribute("disabled", "");
    startBtn.addEventListener("click", () => {
      ws?.send(JSON.stringify({ type: "START_GAME" }));
    });
    box.appendChild(startBtn);
    if (lobbyPlayers.length < 2) {
      box.appendChild(el("p", { className: "action-hint", textContent: "2人以上で開始できます" }));
    }
  } else {
    box.appendChild(el("p", { className: "action-hint", textContent: "ホストの開始を待っています..." }));
  }

  return box;
}

// ── Event Strip / WatcherCardsCol ─────────────────────────────────────────────
// 【UI: イベントストリップ (トップバー下の帯)】
// 現在は空コンテナ。将来的なイベント通知テキスト用プレースホルダー。

function buildEventStrip(): HTMLElement {
  const strip = el("div", { className: "event-strip" });
  return strip;
}

// 【UI: 観戦ビューのカード列 (フィールドエリア内)】
// buildFieldArea() の watching ビューで2列表示される。
//   isAttacker=true  → ⚔ 攻撃: gs.attackCards を表示
//   isAttacker=false → 🛡 防御: gs.defenseCards (対象プレイヤー分) を表示
// 各カードは makeCardPanel() で描画。合計値を「攻/守 N」ボックスで表示。
function buildWatcherCardsCol(isAttacker: boolean, gs: GameState): HTMLElement {
  const col = el("div", { className: "field-col" });
  let cards: Card[] = [];
  let headerText = "カード";
  let powerBoxKind: "atk" | "def" | null = null;
  let powerLabel: "攻" | "守" | null = null;
  let actionText: string | null = null;

  if (isAttacker && gs.attackCards.length > 0) {
    cards = [...gs.attackCards];
    headerText = "⚔ 攻撃";
    powerBoxKind = "atk";
    powerLabel = "攻";
  } else if (!isAttacker && (gs.phase === "DEFENSE_PHASE" || gs.phase === "RESOLVE_PHASE")) {
    if (gs.attackTarget && gs.attackTarget !== "ALL") {
      cards = [...(gs.defenseCards[gs.attackTarget as PlayerId] ?? [])];
    } else {
      for (const id of gs.playerOrder) {
        if (id === gs.playerOrder[gs.activePlayerIndex]) continue;
        cards = cards.concat(gs.defenseCards[id] ?? []);
      }
    }
    headerText = "🛡 防御";
    powerBoxKind = "def";
    powerLabel = "守";
  }

  // 観戦列で攻防カードが無い時は、相手の非攻撃アクション(売買/回復/両替/反射など)を表示する。
  if (!isAttacker && cards.length === 0 && latestPreview) {
    const evt = latestPreview;
    const isOpponentAction = evt.casterLabel !== "自分";
    if (isOpponentAction) {
      const step = watcherPreviewStep;
      headerText = step === 0 ? "🎬 行動予告" : "🎬 相手の行動";
      if (step <= 0) {
        actionText = `${evt.casterLabel} が行動中…`;
      } else if (step === 1) {
        actionText = `${evt.casterLabel} の行動`;
      } else if (step === 2) {
        actionText = `${evt.casterLabel} → ${evt.targetLabel}`;
      } else {
        cards = [...evt.cards];
        actionText = `${evt.casterLabel} → ${evt.targetLabel}${evt.summaryText ? `  ${evt.summaryText}` : ""}`;
      }
      powerBoxKind = null;
      powerLabel = null;
    }
  }

  col.appendChild(el("div", { className: "field-cards-header", textContent: headerText }));
  if (cards.length > 0) {
    const list = el("div", { className: "field-cards-list" });
    for (const c of cards) list.appendChild(makeCardPanel(c));
    col.appendChild(list);
    const total = cards.reduce((s, c) => s + (c.power ?? 0), 0);
    if (powerBoxKind && powerLabel && total > 0) {
      const box = el("div", { className: `field-power-box ${powerBoxKind}` });
      box.appendChild(el("span", { className: "field-power-label", textContent: powerLabel }));
      box.appendChild(el("span", { className: "field-power-value", textContent: String(total) }));
      col.appendChild(box);
    }
    if (actionText) {
      col.appendChild(el("div", { className: "field-cards-empty", textContent: actionText }));
    }
  } else {
    col.appendChild(el("div", { className: "field-cards-empty", textContent: actionText ?? "（なし）" }));
  }
  return col;
}

// ── Game ─────────────────────────────────────────────────────────────────────
// 【画面: ゲーム本体】
// buildGame() が画面全体を組み立てるルートビルダー。
// 各サブビルダーを呼び出し、オーバーレイ系を最後に重ねる。
//
// 構造:
//   #game-root
//   ├── buildTopBar()          ← 画面最上部: ← 戻る / ターン数 / フェーズバッジ / ボタン群
//   ├── buildMainArea()        ← メインコンテンツ (左右2カラム + フィールド)
//   ├── buildEventStrip()      ← イベント帯 (現在は空)
//   ├── buildHandArea()        ← 画面下部: 手札ピアノキー
//   ├── buildBottomBar()       ← 最下部: アクションボタン群
//   └── [オーバーレイ系]
//       ├── buildGameOverOverlay()   ← GAME_OVER フェーズ
//       ├── buildAscensionOverlay()  ← HP=0 昇天演出 (2.5s表示後消える)
//       ├── buildMiraclePanel()      ← 「起こした奇跡」モーダル
//       ├── buildLogPanel()          ← ログ一覧モーダル
//       └── buildMissBanner()        ← 全体攻撃全外れ演出

let cardDetailContainer: HTMLElement | null = null;
let _lastDetailCardId: string | null | undefined = undefined;

function buildGame(): HTMLElement {
  const gs = gameState!;
  const frag = el("div", { id: "game-root" });

  _lastDetailCardId = undefined; // force detail redraw after full render
  frag.appendChild(buildTopBar(gs));
  frag.appendChild(buildMainArea(gs));
  frag.appendChild(buildEventStrip());
  frag.appendChild(buildHandArea(gs));
  frag.appendChild(buildBottomBar(gs));

  if (gs.phase === "GAME_OVER") frag.appendChild(buildGameOverOverlay(gs));
  if (ascendingPlayers.length > 0) frag.appendChild(buildAscensionOverlay());
  if (showMiraclePanel) frag.appendChild(buildMiraclePanel());
  if (showLog) frag.appendChild(buildLogPanel());
  if (missBannerVisible) frag.appendChild(buildMissBanner());

  return frag;
}

// ── TopBar ────────────────────────────────────────────────────────────────────
// 【UI: トップバー (画面最上部の帯)】
// 左: ← 戻る ボタン + "ステージ 1" ラベル
// 中: ターン数表示 "G.F. N / 99" + フェーズバッジ (自分のターンは緑, 相手は青+点滅)
// 右: ✨ 起こした奇跡 / 🎒 / 📖 教典 ボタン
// ← 戻る → confirm ダイアログ後 landing 画面に戻り ws.close()
function buildTopBar(gs: GameState): HTMLElement {
  const bar = el("div", { className: "top-bar" });

  // Left
  const left = el("div", { className: "top-bar__left" });
  const backBtn = el("button", { className: "btn-icon", textContent: "← 戻る" });
  backBtn.addEventListener("click", () => {
    if (confirm("ゲームを終了しますか？")) {
      cancelAnim();
      uiLocked = false;
      screen = "landing";
      ws?.close();
      ws = null;
      myRoomPassphrase = null;
      gameState = null;
      lobbyPlayers = [];
      selectedCards = [];
      logMessages = [];
      render();
    }
  });
  const stageLabel = el("span", { className: "top-bar__stage", textContent: "ステージ 1" });
  left.append(backBtn, stageLabel);

  // Center
  const center = el("div", { className: "top-bar__center" });
  const gfLabel = el("span", { className: "top-bar__gf", textContent: `G.F.  ${turnCount} / 99` });
  const activeId = gs.playerOrder[gs.activePlayerIndex];
  const phaseName = PHASE_LABEL[gs.phase] ?? gs.phase;
  const isOthersTurn = activeId !== myPlayerId && gs.phase !== "GAME_OVER";
  const phaseClass = `phase-badge${isOthersTurn ? " ai" : " active"}`;
  const phaseBadge = el("span", { className: phaseClass, textContent: phaseName });
  if (isOthersTurn) {
    phaseBadge.appendChild(el("span", { className: "thinking-dot" }));
  }
  center.append(gfLabel, phaseBadge);

  // Right
  const right = el("div", { className: "top-bar__right" });
  const miracleBtn = el("button", { className: "btn-icon", textContent: "✨ 起こした奇跡" });
  miracleBtn.addEventListener("click", () => { showMiraclePanel = !showMiraclePanel; render(); });
  const bagBtn = el("button", { className: "btn-icon", textContent: "🎒" });
  const codexBtn = el("button", { className: "btn-icon", textContent: "📖 教典" });
  right.append(miracleBtn, bagBtn, codexBtn);

  bar.append(left, center, right);
  return bar;
}

// ── MainArea ──────────────────────────────────────────────────────────────────
// 【UI: メインエリア (画面中央)】
// main-area は CSS Grid/Flex で2つの子を横に並べる:
//   [フィールドエリア] [右カラム]
//
// フィールドエリア (左〜中) : buildFieldArea()
//   EXCHANGE_PHASE → buildStagingView() (行動選択ゾーン)
//   DEFENSE_PHASE  → buildDefenseStagingView() (自分が防御者の場合)
//   その他         → 観戦ビュー (攻撃カード列 / 防御カード列)
//
// 右カラム:
//   buildOpponentsArea()  ← 対戦相手のステータスカード一覧
//   buildPlayerGrid()     ← 対象選択用プレイヤーボタングリッド
//   buildMiddleRow()      ← アクションパネル (攻撃/防御/交換 ボタン)
function buildMainArea(gs: GameState): HTMLElement {
  const main = el("div", { className: "main-area" });
  main.appendChild(buildFieldArea(gs));
  const right = el("div", { className: "right-column" });
  right.appendChild(buildOpponentsArea(gs));
  right.appendChild(buildPlayerGrid(gs));
  right.appendChild(buildMiddleRow(gs));
  main.appendChild(right);
  return main;
}

// ── PlayerGrid ────────────────────────────────────────────────────────────────
// 【UI: プレイヤー選択グリッド (右カラム中段)】
// 攻撃・スキル対象を素早く選択するためのボタン群。
// 各ボタンに HP を表示。自分は "(自)" サフィックス付き。
// クリックで selectedTarget をトグル (同じボタンを再クリックで解除)。
// CSS クラス: is-self / is-active (今ターンのプレイヤー) / is-targeted (選択中) / is-dead
function buildPlayerGrid(gs: GameState): HTMLElement {
  const grid = el("div", { className: "player-grid" });
  const activeId = gs.playerOrder[gs.activePlayerIndex];

  for (const pid of gs.playerOrder) {
    const p = gs.players[pid];
    if (!p) continue;
    const isSelf = pid === myPlayerId;
    const isActive = pid === activeId;
    const isTargeted = pid === selectedTarget;
    const isDead = p.stats.hp <= 0;
    const playerInfo = lobbyPlayers.find((lp) => lp.id === pid);
    const playerName = playerInfo?.name ?? pid;

    const btn = el("button", {
      className: [
        "player-grid-btn",
        isSelf ? "is-self" : "",
        isActive ? "is-active" : "",
        isTargeted ? "is-targeted" : "",
        isDead ? "is-dead" : "",
      ].filter(Boolean).join(" "),
    });
    btn.appendChild(el("span", { className: "player-grid-btn__name", textContent: isSelf ? `${playerName}(自)` : playerName }));
    btn.appendChild(el("span", { className: "player-grid-btn__stats", textContent: `HP:${p.stats.hp}` }));
    btn.addEventListener("click", () => {
      selectedTarget = selectedTarget === pid ? null : pid;
      render();
    });
    grid.appendChild(btn);
  }
  return grid;
}

// ── InlineLog (未使用) ────────────────────────────────────────────────────────
// buildInlineLog() は右カラムへのインラインログパネルを構築する関数。
// 現在は buildMainArea() から呼ばれていない (ユーザー要件で削除済み)。
// ログ参照は buildBottomBar() の "お告げの記録" ボタン → buildLogPanel() モーダルを使う。
function buildInlineLog(): HTMLElement {
  const panel = el("div", { className: "log-inline" });
  const header = el("div", { className: "log-inline__header" });
  header.appendChild(el("span", { textContent: "ʺ お告げの記録" }));
  panel.appendChild(header);
  const body = el("div", { className: "log-inline__body" });
  const msgs = logMessages.length > 0 ? [...logMessages].reverse().slice(0, 20) : ["— ログなし —"];
  for (const msg of msgs) {
    body.appendChild(el("p", { className: "log-entry", textContent: msg }));
  }
  panel.appendChild(body);
  return panel;
}

// ── MissBanner ────────────────────────────────────────────────────────────────
// 【UI: 外れバナー (全体攻撃オーバーレイ)】
// 全体攻撃が誰にも命中しなかった時に画面上に重ねて表示。
// "MISS / 誰にも当たらなかった" を赤文字 + shake アニメーションで演出。
// missBannerVisible フラグが true の間表示。WebSocket ハンドラで 2.5s 後に自動消去。
function buildMissBanner(): HTMLElement {
  const banner = el("div", { className: "miss-banner" });
  banner.appendChild(el("span", { className: "miss-banner__title", textContent: "MISS" }));
  banner.appendChild(el("span", { className: "miss-banner__sub", textContent: "誰にも当たらなかった" }));
  return banner;
}

// ── AscensionOverlay ──────────────────────────────────────────────────────────
// 【UI: 昇天演出オーバーレイ】
// HP が 0 になったプレイヤーをゲームから除外する際に表示されるシネマティックバナー。
// ascendingPlayers 配列に名前が入っていれば表示。2.5s 後に自動消去。
// "昇天 + プレイヤー名" を中央に大きく表示。
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

// ── MiraclePanel ──────────────────────────────────────────────────────────────
// 【UI: 起こした奇跡パネル (モーダルオーバーレイ)】
// トップバー右の "✨ 起こした奇跡" ボタンで表示/非表示をトグル。
// 全プレイヤーの手札から isMiracle && wasUsed なカードを抽出して一覧表示。
// 背景クリック or ✕ ボタンで閉じる。
function buildMiraclePanel(): HTMLElement {
  const gs = gameState!;
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
  for (const pid of gs.playerOrder) {
    const p = gs.players[pid as import("../../domain/types").PlayerId];
    if (!p) continue;
    const usedMiracles = p.hand.filter((c) => c.isMiracle && c.wasUsed);
    if (usedMiracles.length === 0) continue;
    hasAny = true;
    const pInfo = lobbyPlayers.find((lp) => lp.id === pid);
    const playerLabel = pid === myPlayerId
      ? `${pInfo?.name ?? pid} (自分)`
      : (pInfo?.name ?? pid);
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

// ── FieldArea ─────────────────────────────────────────────────────────────────
// 【UI: フィールドエリア (メインエリア左〜中)】
// 現在フェーズに応じて3種のビューを切り替える:
//
// EXCHANGE_PHASE (自分のターン)
//   → buildStagingView(): 攻撃/交換/購入/売却 などのアクション選択UI
//     ※ 直前プレビューの段階表示中は観戦ビューを優先し、終了後に表示
//
// DEFENSE_PHASE (自分が防御者かつ未確認)
//   → buildDefenseStagingView(): 防御カード選択UI
//     ※ 直前プレビューの段階表示中は観戦ビューを優先し、終了後に表示
//
// それ以外 (観戦・相手のターン・RESOLVE_PHASE・相手EXCHANGE)
//   → 観戦ビュー: field-combat-header (攻撃者 → 対象) + field-columns (攻撃/防御カード列)
//     指輪カウンター時は「💍 指輪カウンター → 攻撃者」表示に切り替わる
function buildFieldArea(gs: GameState): HTMLElement {
  const area = el("div", { className: "field-area" });
  const activeId = gs.playerOrder[gs.activePlayerIndex];
  const isAttacker = activeId === myPlayerId;
  const phase = gs.phase;

  // EXCHANGE は「自分のターン」のときだけステージングUIを表示する。
  // 相手ターン中は観戦ビューにして buildWatcherCardsCol のプレビューを見えるようにする。
  if (phase === "EXCHANGE_PHASE" && isAttacker && !isPreviewTransitionActive()) {
    area.appendChild(buildStagingView(gs));
    return area;
  }

  // DEFENSE_PHASE: show defense staging view when local player is an unconfirmed defender
  if (phase === "DEFENSE_PHASE" && myPlayerId) {
    const alreadyConfirmed = gs.confirmedDefenders.includes(myPlayerId);
    if (!alreadyConfirmed) {
      let isDefenderNow = false;
      if (gs.pendingTargetedAction) {
        // PTA phase: the currentTargetId is the defender
        isDefenderNow = gs.pendingTargetedAction.currentTargetId === myPlayerId;
      } else if (gs.pendingRingAttack || gs.pendingReflect) {
        // Ring counter / reflect: the original attacker (activeId) defends
        isDefenderNow = isAttacker;
      } else {
        const aliveNonActive = gs.playerOrder.filter(
          (id) => id !== activeId && (gs.players[id]?.stats.hp ?? 0) > 0
        );
        if (gs.areaHitResults) {
          const hitIds = gs.areaHitResults.filter((r) => r.hit).map((r) => r.playerId as string);
          isDefenderNow = aliveNonActive.filter((id) => hitIds.includes(id)).includes(myPlayerId);
        } else if (gs.attackTarget && gs.attackTarget !== "ALL") {
          isDefenderNow = gs.attackTarget === myPlayerId;
        } else {
          isDefenderNow = aliveNonActive.includes(myPlayerId);
        }
      }
      if (isDefenderNow && !isPreviewTransitionActive()) {
        area.appendChild(buildDefenseStagingView(gs));
        return area;
      }
    }
  }

  // Watching phase (DEFENSE/RESOLVE/END_CHECK, not our turn to act):
  // show combat header + card columns
  const header = el("div", { className: "field-combat-header" });
  if (gs.phase === "DEFENSE_PHASE" || gs.phase === "RESOLVE_PHASE") {
    const activeId2 = gs.playerOrder[gs.activePlayerIndex];
    if (gs.pendingRingAttack) {
      header.appendChild(el("span", { className: "combat-badge target", textContent: "💍 指輪カウンター" }));
      header.appendChild(el("span", { className: "combat-arrow", textContent: "→" }));
      const atkName = isAttacker ? "自分" : (lobbyPlayers.find((p) => p.id === activeId2)?.name ?? activeId2);
      header.appendChild(el("span", { className: "combat-badge attacker", textContent: atkName }));
    } else {
      const atkName = isAttacker ? "自分" : (lobbyPlayers.find((p) => p.id === activeId2)?.name ?? activeId2);
      const tgt = gs.attackTarget;
      const tgtName = !tgt || tgt === "ALL" ? "全体" : tgt === myPlayerId ? "自分" : (lobbyPlayers.find((p) => p.id === tgt)?.name ?? tgt);
      header.appendChild(el("span", { className: "combat-badge attacker", textContent: atkName }));
      header.appendChild(el("span", { className: "combat-arrow", textContent: "→" }));
      header.appendChild(el("span", { className: "combat-badge target", textContent: tgtName }));
    }
  }
  area.appendChild(header);

  const cols = el("div", { className: "field-columns" });
  cols.appendChild(buildWatcherCardsCol(true, gs));
  cols.appendChild(buildWatcherCardsCol(false, gs));
  area.appendChild(cols);

  return area;
}

// ── PhaseTimerBar ─────────────────────────────────────────────────────────────
// 【UI: フェーズタイマーバー (スタービュー内上部)】
// 各フェーズの制限時間 (25秒) を残り秒数 + プログレスバーで表示。
// 残り 10秒以下 → warning (黄), 5秒以下 → urgent (赤) にスタイル変化。
// タイムアップ時は schedulePhaseTimer() が自動でアクションを dispatch する。
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

// ── DefenseStagingView ────────────────────────────────────────────────────────
// 【UI: 防御ステージングビュー (DEFENSE_PHASE 中・自分が防御者のとき)】
// 自分が防御すべきターゲットのときに buildFieldArea() から呼ばれる。
// 上部: プレイヤーバッジ + フェーズタイマーバー
// 中部: 受信アクション説明
//   - PendingTargetedAction (呪い/回復/売りつけ等) → 内容説明 + 跳ね返し注意
//   - pendingRingAttack → 指輪カウンターのダメージ情報
//   - pendingReflect  → 反射ダメージ情報
//   - 通常攻撃       → buildAttackInfoBlock() で攻撃力・属性を表示
// 下部: 選択中の防御カード + 「防御完了」ボタン
function buildDefenseStagingView(gs: GameState): HTMLElement {
  const wrapper = el("div", { className: "staging-wrapper" });
  const me = myPlayerId ? gs.players[myPlayerId] : null;
  const activeId = gs.playerOrder[gs.activePlayerIndex];
  const myName2 = myName();
  const pta = gs.pendingTargetedAction;

  // Player badge
  const badge = el("div", { className: "staging-badge" });
  badge.appendChild(el("div", { className: "avatar p1", textContent: myPlayerId ?? "?" }));
  badge.appendChild(el("span", { className: "staging-badge-name", textContent: `${myName2} (自分)` }));
  wrapper.appendChild(badge);

  const timerBar = buildPhaseTimerBar();
  if (timerBar) wrapper.appendChild(timerBar);

  // Incoming action info
  if (pta) {
    // PendingTargetedAction: show what action is coming
    const casterName = pta.casterId === myPlayerId ? "自分"
      : (lobbyPlayers.find((p) => p.id === pta.casterId)?.name ?? pta.casterId);
    let desc = "";
    switch (pta.kind) {
      case "HEAL_HP": desc = `HP+${pta.healAmount}（回復）`; break;
      case "HEAL_MP": desc = `MP+${pta.healAmount}（回復）`; break;
      case "SELL": desc = `売りつけ「${pta.itemCard?.name ?? "?"}」¥${pta.price ?? 0}`; break;
      case "ACCEPT_BUY": desc = `買付け「${pta.itemCard?.name ?? "?"}」¥${pta.price ?? 0}`; break;
      case "USE_DISASTER": desc = `呪い（${pta.ailment}）`; break;
      case "USE_CLEANSE": desc = "厄払い（状態異常除去）"; break;
      case "USE_DISPEL_MIRACLE": desc = "奇跡消し"; break;
    }
    wrapper.appendChild(el("p", {
      className: "action-hint ring-incoming",
      textContent: `${casterName} → あなた: ${desc}`,
    }));
    wrapper.appendChild(el("p", {
      className: "action-hint",
      textContent: "🔄 跳ね返しカードのみ有効です",
    }));
  } else if (gs.pendingRingAttack) {
    const ring = gs.pendingRingAttack;
    wrapper.appendChild(el("p", {
      className: "action-hint ring-incoming",
      textContent: `💍 指輪カウンター！反射ダメージ: ${ring.damage} ${ELEMENT_EMOJI[ring.element as Element]}${ELEMENT_LABEL[ring.element as Element]}`,
    }));
  } else if (gs.pendingReflect) {
    const ref = gs.pendingReflect;
    wrapper.appendChild(el("p", {
      className: "action-hint ring-incoming",
      textContent: `🔄 反射！跳ね返しダメージ: ${ref.damage} ${ELEMENT_EMOJI[ref.element as Element]}${ELEMENT_LABEL[ref.element as Element]}`,
    }));
  } else if (gs.attackCards.length > 0) {
    const atkElement: Element = (gs.attackElementOverride ?? gs.attackCards[0]?.element ?? "NEUTRAL") as Element;
    const totalPower = gs.attackCards.reduce((s, c) => s + (c.power ?? 0), 0);
    const atkPlayer = lobbyPlayers.find((p) => p.id === activeId);
    const atkName = activeId === myPlayerId ? "自分" : (atkPlayer?.name ?? activeId);
    const infoBlock = el("div", { className: "attack-info-block" });
    const hdr = el("div", { className: "attack-info-header" });
    hdr.appendChild(el("span", { className: "attack-info-attacker", textContent: `${atkName} ⚔` }));
    hdr.appendChild(el("span", { className: "attack-info-element", textContent: ` ${ELEMENT_EMOJI[atkElement]}${ELEMENT_LABEL[atkElement]}` }));
    hdr.appendChild(el("span", { className: "attack-info-power", textContent: ` 攻撃力 ${totalPower}` }));
    infoBlock.appendChild(hdr);
    const cardRow = el("div", { className: "attack-info-cards" });
    for (const c of gs.attackCards) cardRow.appendChild(makeCardTile(c, false));
    infoBlock.appendChild(cardRow);
    wrapper.appendChild(infoBlock);
  }

  // Determine attack element for defense filtering (not used for PTA)
  const atkElement: Element = gs.pendingRingAttack
    ? (gs.pendingRingAttack.element as Element)
    : gs.pendingReflect
    ? (gs.pendingReflect.element as Element)
    : (gs.attackElementOverride ?? gs.attackCards[0]?.element ?? "NEUTRAL") as Element;

  // Build list of usable defense cards
  const playerMp = me?.stats.mp ?? 0;
  const usableDefCards = (me?.hand ?? []).filter((c) => {
    if (!isDefenseCard(c)) return false;
    if (pta) {
      // PTA: only REFLECT cards are valid
      return c.type === "REFLECT_ALL" || c.type === "REFLECT_PHYSICAL";
    }
    const isReflectCard = c.type === "REFLECT_PHYSICAL" || c.type === "REFLECT_ALL";
    const canUseElement = isReflectCard || canDefend(atkElement, c.element as Element);
    const canUseMp = !(c.mpCost && playerMp < c.mpCost);
    return canUseElement && canUseMp;
  });

  // 防御側も攻撃フェーズと同じ見た目に寄せる:
  // - ステージングゾーンは表示専用
  // - 実行操作は下のボタン列で確定する
  const selectedDefCards = selectedCards.filter(isDefenseCard);
  const zone = el("div", { className: "staging-card-zone" });
  if (selectedDefCards.length > 0) {
    for (const c of selectedDefCards) zone.appendChild(makeCardTile(c, true, undefined, true));
    zone.appendChild(el("div", { className: "staging-hint", textContent: "選択カードを下のボタンで確定" }));
  } else {
    zone.appendChild(el("div", { className: "staging-placeholder" }));
    zone.appendChild(el("span", { className: "staging-empty-hint", textContent: "防御カードを手札から選択してください" }));
  }
  wrapper.appendChild(zone);

  const confirmDefense = () => {
    if (selectedDefCards.length > 0) {
      dispatch({ type: "DEFEND", playerId: myPlayerId!, cards: [...selectedDefCards] });
    }
    dispatch({ type: "CONFIRM_DEFENSE", playerId: myPlayerId! });
    selectedCards = [];
    addLog(selectedDefCards.length > 0
      ? (gs.pendingRingAttack ? "指輪カウンター防御確定" : pta ? "跳ね返し確定" : "防御確定")
      : "許す");
  };

  const btnRow = el("div", { className: "staging-action-btns" });
  const defendBtn = el("button", { className: "btn-action defend", textContent: "🛡 防御確定" });
  if (selectedDefCards.length === 0) defendBtn.setAttribute("disabled", "");
  defendBtn.addEventListener("click", confirmDefense);
  btnRow.appendChild(defendBtn);

  const forgiveBtn = el("button", { className: "btn-action secondary", textContent: "✋ 許す" });
  forgiveBtn.addEventListener("click", confirmDefense);
  btnRow.appendChild(forgiveBtn);
  wrapper.appendChild(btnRow);

  if (usableDefCards.length === 0) {
    wrapper.appendChild(el("p", { className: "action-hint", textContent: "使える防御カードがありません（許すで進行）" }));
  }

  return wrapper;
}

// ── StagingView ───────────────────────────────────────────────────────────────
// 【UI: ステージングビュー (EXCHANGE_PHASE — 自分のターン時のフィールドエリア)】
// 手札から選択したカードをここにステージして実行する操作UIの中核。
//
// 上部: プレイヤーバッジ + フェーズタイマーバー
// 中部: カードステージングゾーン
//   - 選択カードと実行ボタンを動的に生成
//   - 攻撃カード → ATTACK dispatch + 対象選択セレクト
//   - EXCHANGE カード → HP/MP/PAY 再分配フォーム
//   - BUY / SELL / HEAL / 呪い / 祈り 等も同様
//   - actionUsedThisTurn=true なら攻撃系ボタンはグレーアウト
// 下部: ヒントテキスト
function buildStagingView(gs: GameState): HTMLElement {
  const wrapper = el("div", { className: "staging-wrapper" });
  const me = myPlayerId ? gs.players[myPlayerId] : null;
  const activeId = gs.playerOrder[gs.activePlayerIndex];
  const isMyTurn = activeId === myPlayerId;
  const actionDone = gs.actionUsedThisTurn;
  const opponents = gs.playerOrder.filter((id) => id !== myPlayerId) as PlayerId[];
  const myName2 = myName();

  // Player badge
  const badge = el("div", { className: "staging-badge" });
  badge.appendChild(el("div", { className: "avatar p1", textContent: myPlayerId ?? "?" }));
  badge.appendChild(el("span", { className: "staging-badge-name", textContent: `${myName2} (自分)` }));
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
  const buyCard = selectedCards.find((c) => c.type === "BUY");
  const sellCardFromHand = selectedCards.find((c) => c.type === "SELL");
  const itemCard = selectedCards.find(
    (c) => c.type !== "SELL" && !(c.isMiracle && c.wasUsed)
  );
  const target = selectedTarget ?? (opponents.length === 1 ? opponents[0] : undefined);
  const total = (me?.stats.hp ?? 0) + (me?.stats.mp ?? 0) + (me?.stats.pay ?? 0);
  const hasAnyAttackInHand = me?.hand.some((c) => isAttackCard(c)) ?? false;
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
      const atkTargetLabel = atkTarget === myPlayerId
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
    } else if (healCard && myPlayerId) {
      const healTarget = selectedTarget ?? myPlayerId;
      const healTargetLabel = healTarget === myPlayerId ? "自分" : healTarget;
      execLabel = `💊 ${healCard.name} → ${healTargetLabel}`;
      execEnabled = true;
      execHandler = () => {
        addLog(`「${healCard.name}」使用`);
        dispatch({ type: "USE_HEAL", cardId: healCard.id, targetId: healTarget });
        selectedCards = [];
      };
      hintText = `対象: ${healTargetLabel} (プレイヤー行をクリックで変更)`;
      for (const c of selectedCards) zone.appendChild(makeCardTile(c, true, undefined, true));
    } else if (disasterCard && myPlayerId) {
      const disasterTarget = selectedTarget ?? (opponents.length === 1 ? opponents[0] : undefined);
      const disasterTargetLabel = disasterTarget === myPlayerId ? "自分" : disasterTarget ?? "未選択";
      execLabel = `💀 ${disasterCard.name} → ${disasterTargetLabel}`;
      execEnabled = !!disasterTarget;
      execHandler = disasterTarget ? () => {
        addLog(`「${disasterCard.name}」で${disasterTargetLabel}に災いを与えた！`);
        dispatch({ type: "USE_DISASTER", playerId: myPlayerId!, cardId: disasterCard.id, targetId: disasterTarget });
        selectedCards = [];
      } : null;
      hintText = `対象: ${disasterTargetLabel} (プレイヤー行をクリックで変更)`;
      for (const c of selectedCards) zone.appendChild(makeCardTile(c, true, undefined, true));
    } else if (cleanseCard && myPlayerId) {
      const cleanseTarget = selectedTarget ?? (opponents.length === 1 ? opponents[0] : undefined);
      const cleanseTargetLabel = cleanseTarget === myPlayerId ? "自分" : cleanseTarget ?? "未選択";
      execLabel = `🌿 ${cleanseCard.name} → ${cleanseTargetLabel}`;
      execEnabled = !!cleanseTarget;
      execHandler = cleanseTarget ? () => {
        addLog(`「${cleanseCard.name}」で${cleanseTargetLabel}の状態異常を解除！`);
        dispatch({ type: "USE_CLEANSE", cardId: cleanseCard.id, targetId: cleanseTarget });
        selectedCards = [];
      } : null;
      hintText = `対象: ${cleanseTargetLabel} (プレイヤー行をクリックで変更)`;
      for (const c of selectedCards) zone.appendChild(makeCardTile(c, true, undefined, true));
    } else if (dispelCard && myPlayerId) {
      const dispelTarget = selectedTarget ?? (opponents.length === 1 ? opponents[0] : undefined);
      const dispelTargetLabel = dispelTarget === myPlayerId ? "自分" : dispelTarget ?? "未選択";
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
    } else if (buyCard) {
      const buyTarget = target ?? (opponents.length === 1 ? opponents[0] : undefined);
      execLabel = `🛒 買い付け${buyTarget ? ` → ${buyTarget}` : ""}`;
      execEnabled = !!buyTarget;
      execHandler = buyTarget ? () => {
        addLog(`${buyTarget}から購入`);
        dispatch({ type: "BUY", buyCardId: buyCard.id, targetId: buyTarget });
        selectedCards = [];
      } : null;
      hintText = buyTarget ? `${buyTarget}からランダムで公開して購入判断` : "対象を選択してください";
      zone.appendChild(makeCardTile(buyCard, true, undefined, true));
      zone.appendChild(el("div", { className: "staging-hint", textContent: `→ ${buyTarget ?? "?"} から買い付け` }));
    } else {
      zone.appendChild(el("div", { className: "staging-placeholder" }));
    }
  } else if (actionDone) {
    hintText = "✔ アクション済み";
    zone.appendChild(el("div", { className: "staging-hint", textContent: "✔ アクション済み — ターン終了を待っています" }));
  } else {
    zone.appendChild(el("div", { className: "staging-placeholder" }));
  }

  if (execHandler) {
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
  prayBtn.addEventListener("click", () => {
    addLog("祈りを捧げました");
    dispatch({ type: "PRAY" });
  });
  btnRow.appendChild(prayBtn);
  wrapper.appendChild(btnRow);

  // 🔄 両替 inline form (moved from buildActionsPanel)
  if (exchangeCard && !actionDone && isMyTurn && me) {
    // Initialize persisted form values when exchange card is first selected
    if (exchangeFormHp === null) exchangeFormHp = me.stats.hp;
    if (exchangeFormMp === null) exchangeFormMp = me.stats.mp;

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
        showError("無効な値です"); return;
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

// ── OpponentsArea ─────────────────────────────────────────────────────────────
// 【UI: 対戦相手ステータスエリア (右カラム上段)】
// 全プレイヤー (自分含む) のステータスを縦リストで表示する。
// 各行 (opponent-row):
//   アバター | 名前 | HP/MP/¥ ステータス | 手札枚数
//   - 自分: stat-bar (HP バー) 表示、他プレイヤーは数値のみ
//   - 霧アイルメント: 相手ステータスは「?」表示
//   - アイルメントバッジ (ailment-{name}) を名前横に表示
//   - 全体攻撃中: 命中/外れ バッジ (hit-badge) を表示
//   - DEFENSE_PHASE: 対象プレイヤーの防御カードをミニカードで表示
// 行クリック → selectedTarget をトグル
function buildOpponentsArea(gs: GameState): HTMLElement {
  const area = el("div", { className: "opponents-area" });
  const activeId = gs.playerOrder[gs.activePlayerIndex];

  for (const id of gs.playerOrder) {
    const isSelf = id === myPlayerId;
    const p = gs.players[id];
    if (!p) continue;

    const classes = [
      "opponent-row",
      id === activeId ? "is-active" : "",
      id === selectedTarget ? "is-target" : "",
      isSelf ? "is-self" : "",
    ].filter(Boolean).join(" ");
    const row = el("div", { className: classes });
    row.setAttribute("data-player-id", id);

    const playerInfo = lobbyPlayers.find((lp) => lp.id === id);
    const playerName = playerInfo?.name ?? `Player ${id.slice(1)}`;
    const nameText = isSelf ? `${id} (自分)` : playerName;

    row.appendChild(el("div", { className: "avatar p2", textContent: id }));
    row.appendChild(el("span", { className: "opp-name", textContent: nameText }));

    const stats = el("div", { className: `opponent-stats${isSelf ? " is-self-stats" : ""}` });
    const hasFog = p.ailment === "霧";
    for (const [cls, label, val] of [
      ["hp", "HP", p.stats.hp], ["mp", "MP", p.stats.mp], ["pay", "¥", p.stats.pay],
    ] as const) {
      const displayVal = (!isSelf && hasFog) ? "?" : String(val);
      const s = el("div", { className: "opp-stat" });
      s.appendChild(el("span", { className: `opp-stat-label ${cls}`, textContent: label }));
      if (isSelf) {
        const bar = el("div", { className: "stat-bar" });
        const fill = el("div", { className: `stat-bar-fill ${cls}` });
        fill.style.width = `${(val / MAX_STAT) * 100}%`;
        bar.appendChild(fill);
        s.appendChild(bar);
      }
      s.appendChild(el("span", { className: "opp-stat-val", textContent: displayVal }));
      stats.appendChild(s);
    }
    row.append(stats, el("span", { className: "opp-hand-count", textContent: `手札 ${p.hand.length}枚` }));

    // Ailment badge
    if (p.ailment) {
      row.appendChild(el("span", { className: `ailment-badge ailment-${p.ailment}`, textContent: p.ailment }));
    }

    // Show area attack hit/miss badge
    if (gs.areaHitResults) {
      const result = gs.areaHitResults.find((r) => r.playerId === id);
      if (result) {
        const badge = el("span", {
          className: `hit-badge ${result.hit ? "hit" : "miss"}`,
          textContent: result.hit ? "💥 命中" : "外れた",
        });
        row.appendChild(badge);
      }
    }

    // Defense cards placed this phase (visible to all)
    if (gs.phase === "DEFENSE_PHASE" || gs.phase === "RESOLVE_PHASE") {
      const defCards = gs.defenseCards[id as import("../../domain/types").PlayerId] ?? [];
      if (defCards.length > 0) {
        const defRow = el("div", { className: "opp-def-cards" });
        defRow.appendChild(el("span", { className: "opp-def-label", textContent: "🛡" }));
        for (const c of defCards) {
          defRow.appendChild(makeCardTile(c, false, undefined, true));
        }
        row.appendChild(defRow);
      }
    }

    // Click to select as target (including self)
    row.addEventListener("click", () => {
      selectedTarget = selectedTarget === id ? null : id;
      render();
    });

    area.appendChild(row);
  }
  return area;
}

// ── MiddleRow / AttackInfoBlock / ActionsPanel ────────────────────────────────
// 【UI: ミドルロー (右カラム下段)】
// buildMiddleRow() = buildActionsPanel() (左) + カード詳細パネル (右) の横並び。
//
// 【UI: アタックインフォブロック (DEFENSE_PHASE 中の right-column 上部)】
// buildAttackInfoBlock(): 攻撃者名・属性・合計攻撃力・攻撃カード一覧を表示。
// DEFENSE_PHASE で buildActionsPanel() の先頭に追加される。
//
// 【UI: アクションパネル】
// buildActionsPanel(): フェーズや状況に応じてボタンを切り替えるパネル。
//   DEFENSE_PHASE  → "← 左で防御" / "相手が防御中" / "防御確定済み" を表示
//   BUY_CONSENT    → 売りつけられたカードの購入確認ダイアログを表示
//   EXCHANGE_PHASE (自分のターン) → 「ターンを終える」ボタン等
//   その他         → "相手のターン..." / "解決中..." を表示
//
// 【UI: カード詳細パネル】
// cardDetailContainer = card-detail-panel。手札やフィールドのカードに
// マウスホバーで renderCardDetail() が呼ばれ属性・タイプ・コスト等を表示。
function buildMiddleRow(gs: GameState): HTMLElement {
  const row = el("div", { className: "middle-row" });
  const battleArea = el("div", { className: "battle-area" });

  battleArea.appendChild(buildActionsPanel(gs));
  row.appendChild(battleArea);

  const detailPanel = el("div", { className: "card-detail-panel" });
  cardDetailContainer = detailPanel;
  renderCardDetail();
  row.appendChild(detailPanel);

  return row;
}

function buildAttackInfoBlock(gs: GameState): HTMLElement {
  const block = el("div", { className: "attack-info-block" });
  const activeId = gs.playerOrder[gs.activePlayerIndex];
  const atkPlayer = lobbyPlayers.find((p) => p.id === activeId);
  const atkName = activeId === myPlayerId ? "自分" : (atkPlayer?.name ?? activeId);
  const atkCards = gs.attackCards;
  const atkElement: Element = (gs.attackElementOverride ?? atkCards[0]?.element ?? "NEUTRAL") as Element;
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

function buildActionsPanel(gs: GameState): HTMLElement {
  const panel = el("div", { className: "actions-panel" });
  const activeId = gs.playerOrder[gs.activePlayerIndex];
  const isMyTurn = activeId === myPlayerId;
  const me = myPlayerId ? gs.players[myPlayerId] : null;
  const phase = gs.phase;

  // ── DEFENSE_PHASE ──
  if (phase === "DEFENSE_PHASE" && me && myPlayerId) {
    // Always show attack info at top of side panel
    if (gs.attackCards.length > 0 && !gs.pendingRingAttack) {
      panel.appendChild(buildAttackInfoBlock(gs));
    }
    const alreadyConfirmed = gs.confirmedDefenders.includes(myPlayerId);
    if (alreadyConfirmed) {
      panel.appendChild(el("span", { className: "action-hint", textContent: "✔ 防御確定済み — 待機中" }));
      return panel;
    }
    // Determine if local player is a defender
    let isDefenderNow = false;
    if (gs.pendingRingAttack || gs.pendingReflect) {
      isDefenderNow = isMyTurn; // original attacker defends
    } else {
      const aliveNonActive = gs.playerOrder.filter(
        (id) => id !== activeId && (gs.players[id]?.stats.hp ?? 0) > 0
      );
      if (gs.areaHitResults) {
        const hitIds = gs.areaHitResults.filter((r) => r.hit).map((r) => r.playerId as string);
        isDefenderNow = aliveNonActive.filter((id) => hitIds.includes(id)).includes(myPlayerId);
      } else if (gs.attackTarget && gs.attackTarget !== "ALL") {
        isDefenderNow = gs.attackTarget === myPlayerId;
      } else {
        isDefenderNow = aliveNonActive.includes(myPlayerId);
      }
    }
    if (isDefenderNow) {
      // Defense buttons are in the staging view (left panel)
      panel.appendChild(el("span", { className: "action-hint", textContent: "← 左のエリアで防御カードを選択" }));
    } else {
      panel.appendChild(el("span", { className: "action-hint", textContent: "相手が防御中..." }));
    }
    return panel;
  }

  // ── BUY CONSENT: show revealed card to buyer ──────────────────────────────
  if (gs.pendingBuyConsent?.buyerId === myPlayerId && me && myPlayerId) {
    const { revealedCard, targetId: sellerId } = gs.pendingBuyConsent;
    const cost = revealedCard.payCost ?? 0;
    const canAfford = (me.stats.pay + me.stats.mp + me.stats.hp) >= cost;

    const cardPreview = makeCardTile(revealedCard, false);
    cardPreview.style.margin = "0 auto";
    const btnRow = el("div", { className: "actions-buttons" });
    const buyBtn = el("button", { className: "btn-action attack", textContent: `✔ 購入する (¥${cost})` });
    if (!canAfford) buyBtn.setAttribute("disabled", "");
    buyBtn.addEventListener("click", () => {
      addLog(`「${revealedCard.name}」を購入`);
      dispatch({ type: "ACCEPT_BUY", playerId: myPlayerId! });
    });
    const cancelBtn = el("button", { className: "btn-action secondary", textContent: "✕ やめる" });
    cancelBtn.addEventListener("click", () => {
      addLog("購入をやめました");
      dispatch({ type: "DECLINE_BUY", playerId: myPlayerId! });
    });
    btnRow.append(buyBtn, cancelBtn);
    panel.append(
      el("p", { className: "action-hint", textContent: `${sellerId} の手札から:` }),
      cardPreview,
      btnRow,
    );
    return panel;
  }

  if (gs.pendingBuyConsent?.targetId === myPlayerId) {
    panel.appendChild(el("span", {
      className: "action-hint",
      textContent: `${gs.pendingBuyConsent.buyerId} があなたのカードを検討中...`,
    }));
    return panel;
  }

  if (!isMyTurn || !me || !myPlayerId) {
    panel.appendChild(el("span", { className: "action-hint", textContent: "相手のターン..." }));
    return panel;
  }

  if (phase !== "EXCHANGE_PHASE") {
    panel.appendChild(el("span", { className: "action-hint", textContent: "解決中..." }));
    return panel;
  }

  // ── EXCHANGE_PHASE ──────────────────────────────────────────────────────────
  const actionDone = gs.actionUsedThisTurn;
  const total = me.stats.hp + me.stats.mp + me.stats.pay;
  const allPlayers = gs.playerOrder;
  const opponents = allPlayers.filter((id) => id !== myPlayerId);
  const target = selectedTarget ?? (opponents.length === 1 ? opponents[0] : undefined);
  const firstOpp = opponents[0];

  const attackCards = selectedCards.filter(isAttackCard);
  const healCard = selectedCards.find((c) => c.type === "HEAL_HP" || c.type === "HEAL_MP");
  const exchangeCard = selectedCards.find((c) => c.type === "EXCHANGE");
  const buyCardFromHand = me.hand.find((c) => c.type === "BUY");
  const sellCardFromHand = selectedCards.find((c) => c.type === "SELL");
  const itemCard = selectedCards.find(
    (c) => c.type !== "SELL" && c.type !== "BUY" && c.type !== "EXCHANGE" &&
           !isAttackCard(c) && !isDefenseCard(c)
  );
  const hasAnyAttackInHand = me.hand.some((c) => isAttackCard(c));

  // Actions moved to staging view (left panel) — no buttons needed here
  return panel;
}

// ── HandArea ──────────────────────────────────────────────────────────────────
// 【UI: 手札エリア (画面下部のピアノキー)】
// 自分の手札を横スクロール可能な「ピアノキー」形式で表示する。
//
// カード行は2列に分かれる:
//   piano-row 1: 表向きカード (通常操作可能)
//   piano-row 2: 伏せカード (🎹 back) — 直近ドローで増えたカード
//     → buildWatcherCardsCol のプレビュー終了後に表向きへ戻る (revealTimer)
//
// 各カード (piano-key) のクリック可否判定:
//   EXCHANGE_PHASE (自分のターン) → 攻撃・各種アクションカードが選択可
//   DEFENSE_PHASE (自分が防御者)  → 防御・反射カードが選択可
//     属性ミスマッチの防御カードは piano-key--disabled でグレーアウト
//
// CSS クラス: piano-key--selected / piano-key--disabled /
//             piano-key--inactive / piano-key--miracle / piano-key--hidden
function buildHandArea(gs: GameState): HTMLElement {
  const container = el("div", { className: "hand-area" });
  const me = myPlayerId ? gs.players[myPlayerId] : null;
  const cards = me?.hand ?? [];
  const activeId = gs.playerOrder[gs.activePlayerIndex];
  const isMyTurn = activeId === myPlayerId;
  const phase = gs.phase;

  // Determine actual defenders (same logic as elsewhere)
  let actualDefenders: string[] = [];
  if (phase === "DEFENSE_PHASE" && myPlayerId) {
    const aliveNonActive = gs.playerOrder.filter(
      (id) => id !== activeId && (gs.players[id]?.stats.hp ?? 0) > 0
    );
    if (gs.areaHitResults) {
      const hitIds = gs.areaHitResults.filter((r) => r.hit).map((r) => r.playerId as string);
      actualDefenders = aliveNonActive.filter((id) => hitIds.includes(id));
    } else if (gs.attackTarget && gs.attackTarget !== "ALL") {
      const t = gs.attackTarget;
      actualDefenders = aliveNonActive.includes(t) ? [t] : [];
    } else {
      actualDefenders = aliveNonActive;
    }
  }
  const isDefenderThisTurn = phase === "DEFENSE_PHASE" && !!myPlayerId
    && actualDefenders.includes(myPlayerId) && !gs.confirmedDefenders.includes(myPlayerId);
  const isAttackerPreDefense = phase === "DEFENSE_PHASE"
    && (!!gs.pendingRingAttack || !!gs.pendingReflect)
    && activeId === myPlayerId && !gs.confirmedDefenders.includes(myPlayerId);
  const canSelectDefense = isDefenderThisTurn || isAttackerPreDefense;
  const canSelectAttack = isMyTurn && phase === "EXCHANGE_PHASE";
  const atkElement: Element = (gs.attackElementOverride ?? gs.attackCards[0]?.element ?? "NEUTRAL") as Element;
  const hasSellCardSelected = isMyTurn && phase === "EXCHANGE_PHASE"
    && selectedCards.some((c) => c.type === "SELL");
  const exchangeTypes = ["HEAL_HP", "HEAL_MP", "EXCHANGE", "BUY", "DISASTER", "SELL", "CLEANSE", "DISPEL_MIRACLE"] as const;

  // Split into hidden (newly drawn) and visible cards
  const hiddenCards = cards.filter((c) => newlyDrawnCardIds.has(c.id));
  const visibleCards = cards.filter((c) => !newlyDrawnCardIds.has(c.id));

  function buildKeyRow(cardList: Card[], showHidden: boolean): HTMLElement {
    const row = el("div", { className: "piano-row" });

    // Hidden card back slots
    if (showHidden) {
      for (let i = 0; i < hiddenCards.length; i++) {
        const slot = el("div", { className: "piano-key piano-key--hidden" });
        slot.appendChild(el("span", { className: "piano-key__back", textContent: "🎹" }));
        row.appendChild(slot);
      }
    }

    for (const card of cardList) {
      const selected = selectedCards.some((c) => c.id === card.id);
      const isReflectCard = card.type === "REFLECT_PHYSICAL" || card.type === "REFLECT_ALL";
      const hasElementMismatch = canSelectDefense && isDefenseCard(card) && !isReflectCard
        && !canDefend(atkElement, card.element as Element);
      const isDisabled = hasElementMismatch;
      const defenseSelectable = canSelectDefense && isDefenseCard(card)
        && (isReflectCard || canDefend(atkElement, card.element as Element));
      const clickable =
        (!isDisabled && canSelectAttack && isAttackCard(card)) ||
        defenseSelectable ||
        (isMyTurn && phase === "EXCHANGE_PHASE" && exchangeTypes.some((t) => t === card.type)) ||
        (hasSellCardSelected && card.type !== "SELL" && !(card.isMiracle && card.wasUsed));

      const key = el("div", {
        className: [
          "piano-key",
          `el-${card.element}`,
          selected ? "piano-key--selected" : "",
          isDisabled ? "piano-key--disabled" : "",
          !clickable && !isDisabled ? "piano-key--inactive" : "",
          card.isMiracle ? "piano-key--miracle" : "",
          card.wasUsed ? "card-tile--used" : "",
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
      if (card.power > 0) {
        const typeShort = TYPE_LABEL[card.type] ?? card.type;
        key.appendChild(el("span", { className: "piano-key__power", textContent: `${typeShort}${card.power}` }));
      }

      key.addEventListener("mouseenter", () => { hoveredCard = card; renderCardDetail(); });
      if (clickable) {
        key.addEventListener("click", () => {
          const idx = selectedCards.findIndex((c) => c.id === card.id);
          if (idx !== -1) selectedCards = selectedCards.filter((_, i) => i !== idx);
          else selectedCards = [...selectedCards, card];
          render();
        });
      }
      row.appendChild(key);
    }
    return row;
  }

  const KEYS_PER_ROW = 14;
  const row1Cards = visibleCards.slice(0, KEYS_PER_ROW - hiddenCards.length);
  const row1Empty = KEYS_PER_ROW - hiddenCards.length - row1Cards.length;
  const row1 = buildKeyRow(row1Cards, true);
  for (let i = 0; i < row1Empty; i++) {
    row1.appendChild(el("div", { className: "piano-key piano-key--empty" }));
  }
  container.appendChild(row1);

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

// ── BottomBar ─────────────────────────────────────────────────────────────────
// 【UI: ボトムバー (画面最下部の固定バー)】
// 左: プレイヤーアバター + 名前
// 中左: 最新ログメッセージ 1件のプレビュー
// 中: 「全体にお告げ」ボタン (HP/MP をログ出力) + 「お告げの記録」ボタン (ログモーダル開閉)
// 右: 📤 / 🔇 / 🔊 アイコンボタン (現在は機能なし・将来用)
function buildBottomBar(gs: GameState): HTMLElement {
  const bar = el("div", { className: "bottom-bar" });

  // Player info
  const playerArea = el("div", { className: "bottom-bar__player" });
  playerArea.appendChild(el("div", { className: "avatar p1", textContent: myPlayerId ?? "?" }));
  playerArea.appendChild(el("span", { className: "bottom-bar__player-name", textContent: myName() }));
  bar.appendChild(playerArea);

  // Log preview — last message
  const lastMsg = logMessages.at(-1) ?? "— ゲームログ —";
  bar.appendChild(el("div", { className: "bottom-bar__msg", textContent: lastMsg }));

  // Center buttons
  const centerBtns = el("div", { className: "bottom-bar__center-btns" });
  const broadcastBtn = el("button", { className: "btn-bottom", textContent: "同 全体にお告げ" });
  broadcastBtn.addEventListener("click", () => {
    if (!gameState || !myPlayerId) return;
    const me = gameState.players[myPlayerId];
    if (!me) return;
    addLog(`${myName()}: 頑張るぞ！ (HP:${me.stats.hp} MP:${me.stats.mp})`);
    render();
  });
  const logBtn = el("button", { className: "btn-bottom", textContent: "ʺ お告げの記録" });
  logBtn.addEventListener("click", () => { showLog = !showLog; render(); });
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

// ── GameOverOverlay ───────────────────────────────────────────────────────────
// 【UI: ゲームオーバーオーバーレイ (GAME_OVER フェーズ)】
// 画面全体を半透明で覆い、中央カードに勝敗結果を表示する。
// 勝利: "🎉 勝利！" (win クラス = 緑)
// 敗北: "💀 敗北" (lose クラス = 赤)
// 引き分け: "🤝 引き分け！" (draw クラス)
// 「もう一度プレイ」ボタン: ws.close() → 全状態リセット → landing 画面へ
// 背景クリックでも同様にリセット
function buildGameOverOverlay(gs: GameState): HTMLElement {
  const overlay = el("div", { className: "gameover-overlay" });
  const card = el("div", { className: "gameover-card" });
  const winner = gs.winner;
  const isDraw = gs.isDraw === true;
  const isWin = winner === myPlayerId;
  card.appendChild(el("h1", {
    className: `gameover-title ${isDraw ? "draw" : isWin ? "win" : "lose"}`,
    textContent: isDraw ? "🤝 引き分け！" : isWin ? "🎉 勝利！" : "💀 敗北",
  }));
  card.appendChild(el("p", {
    className: "gameover-subtitle",
    textContent: isDraw ? "引き分け！" : winner
      ? `${lobbyPlayers.find((p) => p.id === winner)?.name ?? winner} の勝利`
      : "引き分け",
  }));
  const lobbyBtn = el("button", { className: "btn-restart", textContent: "もう一度プレイ" });
  lobbyBtn.addEventListener("click", () => {
    cancelAnim();
    uiLocked = false;
    screen = "landing";
    ws?.close();
    ws = null;
    myRoomPassphrase = null;
    gameState = null;
    lobbyPlayers = [];
    selectedCards = [];
    logMessages = [];
    render();
  });
  card.appendChild(lobbyBtn);
  overlay.appendChild(card);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) lobbyBtn.click();
  });
  return overlay;
}

// ── LogPanel ──────────────────────────────────────────────────────────────────
// 【UI: ログパネル (モーダルオーバーレイ)】
// ボトムバーの「お告げの記録」ボタンで表示/非表示をトグル。
// logMessages 配列を新しい順で最大全件表示。背景クリックまたは ✕ で閉じる。
function buildLogPanel(): HTMLElement {
  const overlay = el("div", { className: "log-panel-overlay" });
  const panel = el("div", { className: "log-panel" });
  const header = el("div", { className: "log-panel__header" });
  header.appendChild(el("span", { textContent: "ʺ お告げの記録" }));
  const closeBtn = el("button", { className: "btn-icon", textContent: "✕" });
  closeBtn.addEventListener("click", () => { showLog = false; render(); });
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const body = el("div", { className: "log-panel__body" });
  if (logMessages.length === 0) body.appendChild(el("p", { className: "log-entry", textContent: "ログなし" }));
  else for (const msg of [...logMessages].reverse()) body.appendChild(el("p", { className: "log-entry", textContent: msg }));
  panel.appendChild(body);
  overlay.appendChild(panel);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) { showLog = false; render(); } });
  return overlay;
}

// ─── Card Tile ────────────────────────────────────────────────────────────────
// 【ヘルパー: カード表示コンポーネント】
//
// makeCardTile(card, selected, onClick?, small?):
//   ピアノキーと共通デザインの「タイル型」カード表示。手札・防御カード一覧で使用。
//   small=true → card-tile-sm (コンパクトサイズ、相手の防御カード一覧など)
//
// makeCardPanel(card):
//   「パネル型」カード表示。フィールド観戦ビュー・プレビューパネルで使用。
//   アイコン (画像 or 属性絵文字) + カード名 + タイプ/威力 + コストを横並びで表示。
//
// renderCardDetail():
//   右カラムの card-detail-panel を更新。mouseenter イベントで hoveredCard をセットし
//   この関数を呼ぶことで属性・タイプ・威力・コスト等の詳細を表示する。
//   同一カードへの再ホバーは _lastDetailCardId でスキップして不要な再描画を防ぐ。

function makeCardTile(card: Card, selected: boolean, onClick?: () => void, small = false): HTMLElement {
  const cls = small ? "card-tile-sm" : "card-tile";
  const tile = el("div", { className: `${cls} el-${card.element}${selected ? " selected" : ""}${card.isMiracle ? " card-tile--miracle" : ""}${card.wasUsed ? " card-tile--used" : ""}` });

  // Image or emoji
  if (card.image) {
    const img = document.createElement("img");
    img.src = `/card-images/${card.image}`;
    img.alt = card.name;
    img.className = `${cls}__img`;
    tile.appendChild(img);
  } else {
    tile.appendChild(el("span", { className: `${cls}__element`, textContent: ELEMENT_EMOJI[card.element] }));
  }

  tile.appendChild(el("span", { className: `${cls}__name`, textContent: card.name }));
  const baseLabel = TYPE_LABEL[card.type] ?? card.type;
  const miraclePrefix = card.isMiracle ? (card.wasUsed ? "✨(使用済)" : "✨") : "";
  const typeLabel = `${miraclePrefix}${baseLabel}`;
  const powerText = card.power > 0 ? `${typeLabel}${card.power}` : typeLabel;
  tile.appendChild(el("span", { className: `${cls}__power`, textContent: powerText }));
  if (!small) {
    // Bottom info: area%, MP, PAY
    const infoParts: string[] = [];
    if (card.areaAttackPercent) infoParts.push(`${card.areaAttackPercent}%全`);
    if (card.mpCost > 0) infoParts.push(`MP:${card.mpCost}`);
    if (card.payCost !== undefined && card.payCost > 0) infoParts.push(`¥${card.payCost}`);
    tile.appendChild(el("span", { className: "card-tile__type", textContent: infoParts.join(" ") || "—" }));
  }

  tile.addEventListener("mouseenter", () => { hoveredCard = card; renderCardDetail(); });
  if (onClick) tile.addEventListener("click", onClick);
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

function renderCardDetail() {
  if (!cardDetailContainer) return;
  const cardId = hoveredCard?.id ?? null;
  if (cardId === _lastDetailCardId) return;
  _lastDetailCardId = cardId;

  cardDetailContainer.innerHTML = "";
  cardDetailContainer.appendChild(el("h3", { textContent: "カード詳細" }));
  if (!hoveredCard) {
    cardDetailContainer.appendChild(el("p", { className: "card-detail-empty", textContent: "カードにホバーで詳細表示" }));
    return;
  }
  const c = hoveredCard;
  const thumb = el("div", { className: `card-detail__thumb el-${c.element}` });
  thumb.appendChild(el("span", { textContent: ELEMENT_EMOJI[c.element] }));
  thumb.appendChild(el("span", { textContent: c.name, className: "card-detail__name" }));
  cardDetailContainer.appendChild(thumb);
  const detailRows: [string, string][] = [
    ["属性", `${ELEMENT_EMOJI[c.element]} ${ELEMENT_LABEL[c.element]}`],
    ["タイプ", TYPE_LABEL[c.type] ?? c.type],
    ["威力", c.power > 0 ? String(c.power) : "—"],
    ...(c.mpCost > 0 ? [["MPコスト", String(c.mpCost)] as [string, string]] : []),
    ...(c.payCost !== undefined ? [["PAYコスト", `¥${c.payCost}`] as [string, string]] : []),
    ...(c.areaAttackPercent ? [["全体攻撃", `${c.areaAttackPercent}%`] as [string, string]] : []),
    ...(c.attackPlus ? [["追加攻撃", "あり (+同時使用可)"] as [string, string]] : []),
    ...(c.isMiracle ? [["奇跡", "✨ MP消費・手札に戻る"] as [string, string]] : []),
  ];
  for (const [label, val] of detailRows) {
    const row = el("div", { className: "card-detail__row" });
    row.appendChild(el("span", { textContent: label }));
    row.appendChild(el("span", { className: "card-detail__val", textContent: val }));
    cardDetailContainer.appendChild(row);
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
// アプリケーション起動。DOMContentLoaded 後に render() を呼び出して初期画面を描画する。

render();
