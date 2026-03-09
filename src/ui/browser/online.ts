import type { GameState, GameAction, Card, PlayerId, Phase, Element } from "../../domain/types";
import { MAX_STAT } from "../../engine/gameEngine";
import { canDefend } from "../../engine/elementSystem";

// ─── Constants ────────────────────────────────────────────────────────────────

const WS_URL = `ws://${location.hostname}:3001`;

const ELEMENT_EMOJI: Record<Element, string> = {
  FIRE: "🔥", WATER: "💧", WOOD: "🌿", EARTH: "🪨",
  LIGHT: "☀️", DARK: "🌑", NEUTRAL: "⬜",
};
const ELEMENT_LABEL: Record<Element, string> = {
  FIRE: "火", WATER: "水", WOOD: "木", EARTH: "土",
  LIGHT: "光", DARK: "闇", NEUTRAL: "無",
};
const TYPE_LABEL: Record<string, string> = {
  ATTACK: "攻", DEFENSE: "守", EXCHANGE: "両替",
  SELL: "売", BUY: "買", HEAL_HP: "HP回復", HEAL_MP: "MP回復",
  REFLECT_PHYSICAL: "跳ね返し", REFLECT_ALL: "全跳ね返し", DISASTER: "災い",
  RING: "指輪", CLEANSE: "厄払い", DISPEL_MIRACLE: "奇跡消し", HEAVEN_DISEASE_HEAL: "天国の薬",
};
const PHASE_LABEL: Record<Phase, string> = {
  DRAW_PHASE: "ドロー", EXCHANGE_PHASE: "アクション",
  DEFENSE_PHASE: "防御", RESOLVE_PHASE: "解決",
  END_CHECK: "終了確認", GAME_OVER: "ゲームオーバー",
};

// ─── State ────────────────────────────────────────────────────────────────────

type Screen = "landing" | "lobby" | "game";

let screen: Screen = "landing";
let ws: WebSocket | null = null;
let myPlayerId: PlayerId | null = null;
let myRoomCode: string | null = null;
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
/** Persisted exchange form values across re-renders */
let exchangeFormHp: number | null = null;
let exchangeFormMp: number | null = null;
/** Previous game state for event detection via state diff. */
let prevGameState: GameState | null = null;

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



// ─── Helpers ─────────────────────────────────────────────────────────────────

function isAttackCard(c: Card) { return c.type === "ATTACK"; }
function isDefenseCard(c: Card) {
  return c.type === "DEFENSE" ||
    c.type === "REFLECT_PHYSICAL" || c.type === "REFLECT_ALL" ||
    c.type === "RING";
}

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

function connect(playerName: string, mode: "create", roomCode?: undefined): void;
function connect(playerName: string, mode: "join", roomCode: string): void;
function connect(playerName: string, mode: "create" | "join", roomCode?: string): void {
  ws = new WebSocket(WS_URL);

  ws.addEventListener("open", () => {
    if (mode === "create") {
      ws!.send(JSON.stringify({ type: "CREATE_ROOM", playerName }));
    } else {
      ws!.send(JSON.stringify({ type: "JOIN_ROOM", playerName, roomCode }));
    }
  });

  ws.addEventListener("message", (ev) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg["type"]) {
      case "ROOM_CREATED":
        myPlayerId = String(msg["playerId"]) as PlayerId;
        myRoomCode = String(msg["roomCode"]);
        isHost = true;
        screen = "lobby";
        render();
        break;
      case "ROOM_JOINED":
        myPlayerId = String(msg["playerId"]) as PlayerId;
        myRoomCode = String(msg["roomCode"]);
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
              if (newP.hand.length < prevP.hand.length && newState.actionUsedThisTurn) {
                const prevTotal = prevP.stats.hp + prevP.stats.mp + prevP.stats.pay;
                const newTotal = newP.stats.hp + newP.stats.mp + newP.stats.pay;
                if (prevTotal === newTotal && (prevP.stats.hp !== newP.stats.hp || prevP.stats.mp !== newP.stats.mp)) {
                  pushPreview({ casterLabel: who, cards: [], targetLabel: `両替 HP${newP.stats.hp} MP${newP.stats.mp} ¥${newP.stats.pay}`, key: Date.now() });
                }
              }
            }
          }
        }
        prevGameState = newState;
        gameState = newState;
        screen = "game";
        render();
        schedulePhaseTimer(newState);
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

function showError(msg: string) {
  const existing = document.getElementById("err-toast");
  existing?.remove();
  const toast = el("div", { id: "err-toast", className: "err-msg" });
  toast.style.cssText = "position:fixed;top:1rem;left:50%;transform:translateX(-50%);background:#400;color:#f88;padding:.6rem 1.4rem;border-radius:8px;z-index:9999;font-size:.95rem;";
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ─── Screens ──────────────────────────────────────────────────────────────────

function render() {
  const app = document.getElementById("app");
  if (!app) return;
  app.innerHTML = "";
  if (screen === "landing") app.appendChild(buildLanding());
  else if (screen === "lobby") app.appendChild(buildLobby());
  else app.appendChild(buildGame());
}

// ── Landing ──────────────────────────────────────────────────────────────────

function buildLanding(): HTMLElement {
  const box = el("div", { className: "lobby-box" });
  box.appendChild(el("h1", { textContent: "⚔ GoodField" }));
  box.appendChild(el("p", { className: "action-hint", textContent: "localhost オンライン対戦" }));

  const nameInput = document.createElement("input");
  nameInput.type = "text"; nameInput.placeholder = "プレイヤー名"; nameInput.className = "exchange-input";
  nameInput.style.width = "100%";
  nameInput.maxLength = 12;
  box.appendChild(nameInput);

  // Create room
  const createBtn = el("button", { className: "btn-action attack", textContent: "部屋を作成" });
  createBtn.addEventListener("click", () => {
    const name = nameInput.value.trim() || "Player";
    connect(name, "create");
  });

  // Join room
  const codeInput = document.createElement("input");
  codeInput.type = "text"; codeInput.placeholder = "ルームコード (4文字)";
  codeInput.className = "exchange-input"; codeInput.maxLength = 4;
  codeInput.style.cssText = "width:100%;text-transform:uppercase;letter-spacing:.3rem;";

  const joinBtn = el("button", { className: "btn-action exchange", textContent: "+ 部屋に参加" });
  joinBtn.addEventListener("click", () => {
    const name = nameInput.value.trim() || "Player";
    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== 4) { showError("ルームコードは4文字です"); return; }
    connect(name, "join", code);
  });

  const row = el("div", { className: "btn-row" });
  row.appendChild(createBtn);

  box.appendChild(row);
  box.appendChild(el("hr", { style: "border-color:#333;margin:1rem 0;" }));
  box.appendChild(el("p", { className: "action-hint", textContent: "参加する場合は部屋コードを入力" }));
  box.appendChild(codeInput);
  const joinRow = el("div", { className: "btn-row" });
  joinRow.appendChild(joinBtn);
  box.appendChild(joinRow);

  return box;
}

// ── Lobby ────────────────────────────────────────────────────────────────────

function buildLobby(): HTMLElement {
  const box = el("div", { className: "lobby-box" });
  box.appendChild(el("h1", { textContent: "⚔ GoodField" }));

  if (myRoomCode) {
    box.appendChild(el("p", { className: "action-hint", textContent: "ルームコード" }));
    box.appendChild(el("div", { className: "room-code", textContent: myRoomCode }));
    box.appendChild(el("p", { className: "action-hint", textContent: "このコードを友達に伝えてください" }));
  }

  box.appendChild(el("h3", { textContent: `プレイヤー (${lobbyPlayers.length}/9)` }));
  const list = el("ul", { className: "player-list" });
  for (const p of lobbyPlayers) {
    const li = el("li");
    li.textContent = `${p.name} (${p.id})`;
    if (p.id === myPlayerId) {
      const badge = el("span", { className: "badge", textContent: "あなた" });
      li.appendChild(badge);
    }
    if (p.isHost) {
      const badge = el("span", { className: "badge", textContent: "ホスト" });
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

// ── Combat Banner / Event Strip / Miracle Panel ───────────────────────────────

function buildCombatBanner(gs: GameState): HTMLElement | null {
  const phase = gs.phase;
  if (
    (phase !== "DEFENSE_PHASE" && phase !== "RESOLVE_PHASE" && phase !== "END_CHECK") ||
    gs.attackCards.length === 0
  ) return null;

  const activeId = gs.playerOrder[gs.activePlayerIndex];
  const atkPlayer = lobbyPlayers.find((p) => p.id === activeId);
  const atkName = activeId === myPlayerId ? "自分" : (atkPlayer?.name ?? activeId);
  const tgt = gs.attackTarget;
  const tgtPlayer = typeof tgt === "string" && tgt !== "ALL" ? lobbyPlayers.find((p) => p.id === tgt) : null;
  const tgtName = !tgt || tgt === "ALL" ? "全体" : tgt === myPlayerId ? "自分" : (tgtPlayer?.name ?? tgt);

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
  const strip = el("div", { className: "event-strip" });
  return strip;
}

function buildPreviewPanel(): HTMLElement {
  const panel = el("div", { className: "preview-panel" });
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

  if (data.cards.length > 0) {
    const atkSection = el("div", { className: "preview-cards-section" });
    for (const card of data.cards) {
      atkSection.appendChild(makeCardTile(card, false, undefined, true));
    }
    panel.appendChild(atkSection);
  }

  if (data.defCards && data.defCards.length > 0) {
    const defSection = el("div", { className: "preview-cards-section preview-cards-section--def" });
    defSection.appendChild(el("div", { className: "preview-section-label", textContent: "🛡 防御" }));
    for (const card of data.defCards) {
      defSection.appendChild(makeCardTile(card, false, undefined, true));
    }
    panel.appendChild(defSection);
  } else if (data.defCards !== undefined) {
    const defSection = el("div", { className: "preview-cards-section preview-cards-section--def" });
    defSection.appendChild(el("div", { className: "preview-section-label", textContent: "🛡 なし" }));
    panel.appendChild(defSection);
  }

  if (data.summaryText) {
    panel.appendChild(el("div", { className: "preview-summary", textContent: data.summaryText }));
  }
}

// ── Game ─────────────────────────────────────────────────────────────────────

let cardDetailContainer: HTMLElement | null = null;
let _lastDetailCardId: string | null | undefined = undefined;

function buildGame(): HTMLElement {
  const gs = gameState!;
  const frag = el("div", { id: "game-root" });

  _lastDetailCardId = undefined; // force detail redraw after full render
  frag.appendChild(buildTopBar(gs));
  const banner = buildCombatBanner(gs);
  if (banner) frag.appendChild(banner);
  frag.appendChild(buildMainArea(gs));
  frag.appendChild(buildEventStrip());
  frag.appendChild(buildHandArea(gs));
  frag.appendChild(buildBottomBar(gs));

  if (gs.phase === "GAME_OVER") frag.appendChild(buildGameOverOverlay(gs));
  if (showLog) frag.appendChild(buildLogPanel());

  return frag;
}

function buildTopBar(gs: GameState): HTMLElement {
  const bar = el("div", { className: "top-bar" });

  const left = el("div", { className: "top-bar__left" });
  left.appendChild(el("span", { className: "top-bar__stage", textContent: `部屋 ${myRoomCode ?? ""}` }));
  left.appendChild(el("span", { className: "top-bar__stage", textContent: `あなた: ${myName()} (${myPlayerId})` }));
  bar.appendChild(left);

  const center = el("div", { className: "top-bar__center" });
  center.appendChild(el("span", { className: "top-bar__gf", textContent: "G.F." }));
  const activeId = gs.playerOrder[gs.activePlayerIndex];
  const isMyTurn = activeId === myPlayerId;
  const phaseClass = `phase-badge${isMyTurn ? " active" : " ai"}`;
  const phaseName = PHASE_LABEL[gs.phase] ?? gs.phase;
  const badge = el("span", { className: phaseClass, textContent: `${activeId} — ${phaseName}` });
  if (!isMyTurn) badge.appendChild(el("span", { className: "thinking-dot" }));
  center.appendChild(badge);
  bar.appendChild(center);

  const right = el("div", { className: "top-bar__right" });
  const logBtn = el("button", { className: "btn-icon", textContent: "📋 ログ" });
  logBtn.addEventListener("click", () => { showLog = !showLog; render(); });
  right.appendChild(logBtn);
  bar.appendChild(right);

  return bar;
}

function buildMainArea(gs: GameState): HTMLElement {
  const main = el("div", { className: "main-area" });
  main.appendChild(buildFieldArea(gs));
  main.appendChild(buildPreviewPanel());
  const right = el("div", { className: "right-column" });
  right.appendChild(buildOpponentsArea(gs));
  right.appendChild(buildMiddleRow(gs));
  main.appendChild(right);
  return main;
}

function buildFieldArea(gs: GameState): HTMLElement {
  const area = el("div", { className: "field-area" });
  const activeId = gs.playerOrder[gs.activePlayerIndex];
  const isAttacker = activeId === myPlayerId;
  const phase = gs.phase;

  if (phase === "EXCHANGE_PHASE") {
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
      if (isDefenderNow) {
        area.appendChild(buildDefenseStagingView(gs));
        return area;
      }
    }
  }

  // Combat header: attacker → target
  const header = el("div", { className: "field-combat-header" });
  if (phase === "DEFENSE_PHASE" || phase === "RESOLVE_PHASE") {
    if (gs.pendingRingAttack) {
      // Show RING counter context: original attacker is now defending
      header.appendChild(el("span", { className: "combat-badge target", textContent: "💍 指輪カウンター" }));
      header.appendChild(el("span", { className: "combat-arrow", textContent: "→" }));
      const atkPlayer = lobbyPlayers.find((p) => p.id === activeId);
      const atkName = isAttacker ? "自分" : (atkPlayer?.name ?? activeId);
      header.appendChild(el("span", { className: "combat-badge attacker", textContent: atkName }));
    } else {
      // Original header logic (attacker → target)
      const atkPlayer = lobbyPlayers.find((p) => p.id === activeId);
      const atkName = isAttacker ? "自分" : (atkPlayer?.name ?? activeId);
      const tgt = gs.attackTarget;
      const tgtPlayer = typeof tgt === "string" && tgt !== "ALL" ? lobbyPlayers.find((p) => p.id === tgt) : null;
      const tgtName = !tgt || tgt === "ALL" ? "全体" : tgt === myPlayerId ? "自分" : (tgtPlayer?.name ?? tgt);
      header.appendChild(el("span", { className: "combat-badge attacker", textContent: atkName }));
      header.appendChild(el("span", { className: "combat-arrow", textContent: "→" }));
      header.appendChild(el("span", { className: "combat-badge target", textContent: tgtName }));
    }
  }
  area.appendChild(header);

  const cols = el("div", { className: "field-columns" });
  // My cards column
  const myCol = el("div", { className: "field-col" });
  let myCards: Card[] = [];
  let myHeader = "自分のカード";
  if (isAttacker && gs.attackCards.length > 0) {
    myCards = [...gs.attackCards]; myHeader = "⚔ 自分の攻撃";
  } else if (!isAttacker && (phase === "DEFENSE_PHASE" || phase === "RESOLVE_PHASE") && myPlayerId) {
    const committed = gs.defenseCards[myPlayerId] ?? [];
    const pending = selectedCards.filter(isDefenseCard);
    const committedIds = new Set(committed.map(c => c.id));
    const allDefCards = [...committed, ...pending.filter(c => !committedIds.has(c.id))];
    myCards = allDefCards;
    myHeader = "🛡 自分の防御";
  }
  myCol.appendChild(el("div", { className: "field-cards-header", textContent: myHeader }));
  if (myCards.length > 0) {
    const list = el("div", { className: "field-cards-list" });
    for (const c of myCards) list.appendChild(makeCardTile(c, false));
    myCol.appendChild(list);
    const total = myCards.reduce((s, c) => s + (c.power ?? 0), 0);
    if (total > 0) myCol.appendChild(el("div", { className: "field-total", textContent: `${isAttacker ? "攻" : "守"}${total}` }));
  } else {
    myCol.appendChild(el("div", { className: "field-cards-empty", textContent: "（なし）" }));
  }
  cols.appendChild(myCol);

  // Opponent's cards column
  const oppCol = el("div", { className: "field-col" });
  let oppCards: Card[] = [];
  let oppHeader = "相手のカード";
  if (!isAttacker && gs.attackCards.length > 0) {
    oppCards = [...gs.attackCards]; oppHeader = "⚔ 相手の攻撃";
  } else if (isAttacker && (phase === "DEFENSE_PHASE" || phase === "RESOLVE_PHASE")) {
    for (const id of gs.playerOrder) {
      if (id === myPlayerId) continue;
      oppCards = oppCards.concat(gs.defenseCards[id] ?? []);
    }
    oppHeader = "🛡 相手の防御";
  }
  oppCol.appendChild(el("div", { className: "field-cards-header", textContent: oppHeader }));
  if (oppCards.length > 0) {
    const list = el("div", { className: "field-cards-list" });
    for (const c of oppCards) list.appendChild(makeCardTile(c, false));
    oppCol.appendChild(list);
    const total = oppCards.reduce((s, c) => s + (c.power ?? 0), 0);
    if (total > 0) oppCol.appendChild(el("div", { className: "field-total", textContent: `${isAttacker ? "守" : "攻"}${total}` }));
  } else {
    oppCol.appendChild(el("div", { className: "field-cards-empty", textContent: "（なし）" }));
  }
  cols.appendChild(oppCol);

  area.appendChild(cols);
  return area;
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

  // Staged defense cards zone — clicking confirms defense or allows damage
  const selectedDefCards = selectedCards.filter(isDefenseCard);
  const zone = el("div", { className: "staging-card-zone is-clickable" });
  if (selectedDefCards.length > 0) {
    for (const c of selectedDefCards) zone.appendChild(makeCardTile(c, true));
    zone.appendChild(el("div", { className: "staging-hint", textContent: "↑ クリックして防御確定" }));
  } else {
    zone.appendChild(el("span", { className: "staging-empty-hint", textContent: "（カードなし）クリックして許す" }));
  }
  zone.addEventListener("click", () => {
    if (selectedDefCards.length > 0) {
      dispatch({ type: "DEFEND", playerId: myPlayerId!, cards: [...selectedDefCards] });
    }
    dispatch({ type: "CONFIRM_DEFENSE", playerId: myPlayerId! });
    selectedCards = [];
    addLog(selectedDefCards.length > 0
      ? (gs.pendingRingAttack ? "指輪カウンター防御確定" : pta ? "跳ね返し確定" : "防御確定")
      : "許す");
  });
  wrapper.appendChild(zone);

  // Defense card selection grid
  if (me?.hand && me.hand.some(isDefenseCard)) {
    wrapper.appendChild(el("p", { className: "action-hint", textContent: "手札の防御カードを選択:" }));
    const grid = el("div", { className: "defense-card-grid" });
    for (const c of me.hand) {
      if (!isDefenseCard(c)) continue;
      let canUse: boolean;
      if (pta) {
        canUse = (c.type === "REFLECT_ALL" || c.type === "REFLECT_PHYSICAL") &&
          !(c.mpCost && playerMp < c.mpCost);
      } else {
        const isReflectCard = c.type === "REFLECT_PHYSICAL" || c.type === "REFLECT_ALL";
        const canUseElement = isReflectCard || canDefend(atkElement, c.element as Element);
        const canUseMp = !(c.mpCost && playerMp < c.mpCost);
        canUse = canUseElement && canUseMp;
      }
      const selected = selectedCards.some((s) => s.id === c.id);
      const tile = makeCardTile(c, selected);
      if (!canUse) {
        tile.classList.add("card-tile--disabled");
      } else {
        tile.addEventListener("click", () => {
          if (selected) {
            selectedCards = selectedCards.filter((s) => s.id !== c.id);
          } else {
            selectedCards = [...selectedCards, c];
          }
          render();
        });
      }
      grid.appendChild(tile);
    }
    wrapper.appendChild(grid);
  } else if (usableDefCards.length === 0) {
    wrapper.appendChild(el("p", { className: "action-hint", textContent: "使える防御カードがありません" }));
  }

  return wrapper;
}

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
      zone.appendChild(makeCardTile(sellCardFromHand, true));
      zone.appendChild(makeCardTile(itemCard, true));
    } else if (sellCardFromHand && !itemCard) {
      hintText = "売りつけるカードを手札から選んでください";
      zone.appendChild(makeCardTile(sellCardFromHand, true));
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
      for (const c of selectedCards) zone.appendChild(makeCardTile(c, true));
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
      for (const c of selectedCards) zone.appendChild(makeCardTile(c, true));
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
      for (const c of selectedCards) zone.appendChild(makeCardTile(c, true));
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
      for (const c of selectedCards) zone.appendChild(makeCardTile(c, true));
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
      for (const c of selectedCards) zone.appendChild(makeCardTile(c, true));
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
      zone.appendChild(makeCardTile(buyCard, true));
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
          className: `area-hit-badge ${result.hit ? "hit" : "miss"}`,
          textContent: result.hit ? "💥 命中" : "⬜ 外れ",
        });
        row.appendChild(badge);
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

function buildActionsPanel(gs: GameState): HTMLElement {
  const panel = el("div", { className: "actions-panel" });
  const activeId = gs.playerOrder[gs.activePlayerIndex];
  const isMyTurn = activeId === myPlayerId;
  const me = myPlayerId ? gs.players[myPlayerId] : null;
  const phase = gs.phase;

  // ── DEFENSE_PHASE ──
  if (phase === "DEFENSE_PHASE" && me && myPlayerId) {
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

function buildHandArea(gs: GameState): HTMLElement {
  const hand = el("div", { className: "hand-area" });
  hand.appendChild(el("span", { className: "hand-label", textContent: "手札" }));

  const cardRow = el("div", { className: "hand-cards" });
  const me = myPlayerId ? gs.players[myPlayerId] : null;
  const cards = me?.hand ?? [];
  const activeId = gs.playerOrder[gs.activePlayerIndex];
  const isMyTurn = activeId === myPlayerId;
  const phase = gs.phase;

  const canSelectAttack = isMyTurn && phase === "EXCHANGE_PHASE";

  // Determine actual defenders (same logic as buildActionsPanel)
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

  // Determine attack element for filtering incompatible defense cards
  const atkElement: Element = (gs.attackElementOverride ?? gs.attackCards[0]?.element ?? "NEUTRAL") as Element;

  // SELL card must be explicitly selected first, then select the item to sell
  const hasSellCardSelected = isMyTurn && phase === "EXCHANGE_PHASE"
    && selectedCards.some((c) => c.type === "SELL");
  const exchangeTypes = ["HEAL_HP", "HEAL_MP", "EXCHANGE", "BUY", "DISASTER", "SELL", "CLEANSE", "DISPEL_MIRACLE"] as const;

  for (const card of cards) {
    const selected = selectedCards.some((c) => c.id === card.id);
    // For defense phase: REFLECT cards always usable; other defense cards only if element matches
    const isReflectCard = card.type === "REFLECT_PHYSICAL" || card.type === "REFLECT_ALL";
    const defenseSelectable = canSelectDefense && isDefenseCard(card)
      && (isReflectCard || canDefend(atkElement, card.element as Element));
    const clickable =
      (canSelectAttack && isAttackCard(card)) ||
      defenseSelectable ||
      (isMyTurn && phase === "EXCHANGE_PHASE" && exchangeTypes.some((t) => t === card.type)) ||
      (hasSellCardSelected && card.type !== "SELL" && !(card.isMiracle && card.wasUsed));
    const tile = makeCardTile(card, selected, clickable ? () => {
      const idx = selectedCards.findIndex((c) => c.id === card.id);
      if (idx !== -1) selectedCards = selectedCards.filter((_, i) => i !== idx);
      else selectedCards = [...selectedCards, card];
      render();
    } : undefined);
    if (!clickable) tile.style.opacity = "0.55";
    cardRow.appendChild(tile);
  }

  for (let i = cards.length; i < Math.max(8, cards.length); i++) {
    cardRow.appendChild(el("div", { className: "card-tile empty-slot" }));
  }

  hand.appendChild(cardRow);
  return hand;
}

function buildBottomBar(gs: GameState): HTMLElement {
  const bar = el("div", { className: "bottom-bar" });

  const playerArea = el("div", { className: "bottom-bar__player" });
  playerArea.appendChild(el("div", { className: "avatar p1", textContent: myPlayerId ?? "?" }));
  playerArea.appendChild(el("span", { className: "bottom-bar__player-name", textContent: myName() }));
  bar.appendChild(playerArea);

  const lastMsg = logMessages.at(-1) ?? "— ゲームログ —";
  bar.appendChild(el("div", { className: "bottom-bar__msg", textContent: lastMsg }));

  const centerBtns = el("div", { className: "bottom-bar__center-btns" });
  const logBtn = el("button", { className: "btn-bottom", textContent: "ʺ お告げの記録" });
  logBtn.addEventListener("click", () => { showLog = !showLog; render(); });
  centerBtns.appendChild(logBtn);
  bar.appendChild(centerBtns);

  if (gs.phase === "GAME_OVER") {
    // Disconnected from room — show return button
    const retBtn = el("button", { className: "btn-icon", textContent: "← ロビーへ" });
    retBtn.addEventListener("click", () => {
      screen = "landing";
      ws?.close();
      ws = null;
      gameState = null;
      lobbyPlayers = [];
      selectedCards = [];
      logMessages = [];
      render();
    });
    bar.appendChild(retBtn);
  }

  return bar;
}

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
  overlay.appendChild(card);
  return overlay;
}

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

render();
