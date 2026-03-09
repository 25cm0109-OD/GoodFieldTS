import * as readline from "readline";
import { createInitialState } from "../../engine/initialState";
import { gameReducer } from "../../engine/gameEngine";
import { GameState, GameAction, PlayerId, Card, Phase } from "../../domain/types";

// ── Display helpers ──────────────────────────────────────────────────────────

function cardDesc(c: Card): string {
  const cost =
    c.mpCost > 0
      ? ` MP:${c.mpCost}`
      : c.payCost !== undefined
      ? ` PAY:${c.payCost}`
      : "";
  const flags = [
    c.attackPlus && "[+攻]",
    c.doubler && "[x2]",
    c.isMiracle && "[奇跡]",
    c.areaAttackPercent && `[全体${c.areaAttackPercent}%]`,
  ]
    .filter(Boolean)
    .join(" ");
  return `[${c.id}] ${c.name} (${c.type} ${c.element} 威力:${c.power}${cost}${flags ? " " + flags : ""})`;
}

function printState(state: GameState): void {
  console.log(`\n=== フェーズ: ${state.phase} ===`);
  const activeId = state.playerOrder[state.activePlayerIndex];
  console.log(`行動中: ${activeId}`);
  for (const id of state.playerOrder) {
    const p = state.players[id];
    if (!p) continue;
    const { hp, mp, pay } = p.stats;
    const marker = id === activeId ? " ←" : "";
    console.log(
      `  ${id} | HP:${hp} MP:${mp} PAY:${pay} | 手札:${p.hand.length}枚${marker}`
    );
  }
  if (state.attackCards.length > 0) {
    console.log(`  攻撃中: ${state.attackCards.map((c) => c.name).join(", ")}`);
  }
  if (state.winner) {
    console.log(`\n🏆 勝者: ${state.winner}`);
  }
}

function printHand(state: GameState, playerId: PlayerId): void {
  const p = state.players[playerId];
  if (!p) { console.log("プレイヤーが見つかりません"); return; }
  console.log(`\n${playerId}の手札 (${p.hand.length}枚):`);
  p.hand.forEach((c, i) => {
    console.log(`  ${i + 1}. ${cardDesc(c)}`);
  });
}

const PHASE_HELP: Partial<Record<Phase, string[]>> = {
  DRAW_PHASE: [
    "DRAW                                        — カードをドロー",
  ],
  EXCHANGE_PHASE: [
    "ATTACK <カードID> [追加カードID...] [TARGET <ターゲットID>] — 攻撃 (同時に+カードも使用可)",
    "PRAY                                        — 祈る (攻撃カードなし時のみ)",
    "EXCHANGE <カードID> <HP> <MP> <PAY>         — ステータス再配分",
    "BUY <BUYカードID> <ターゲットID>            — 相手手札からランダム購入",
    "SELL <SELLカードID> <商品カードID> <ターゲット> — カードを売りつける",
    "USE_HEAL <カードID>                         — 回復アイテム使用",
    "END_EXCHANGE                                — アクション終了",
  ],
  DEFENSE_PHASE: [
    "DEFEND <プレイヤーID> <カードID...>         — 防御カードを使用",
    "CONFIRM_DEFENSE <プレイヤーID>              — 防御確定 (カードなし)",
  ],
  RESOLVE_PHASE: ["RESOLVE                                     — ダメージ計算実行"],
  END_CHECK: ["END_TURN                                    — ターン終了"],
};

function printHelp(phase: Phase): void {
  const lines = PHASE_HELP[phase];
  if (!lines) return;
  console.log("\n使えるコマンド:");
  lines.forEach((l) => console.log("  " + l));
  console.log("  HAND [プレイヤーID]                         — 手札を確認");
  console.log("  HELP                                        — コマンド一覧");
}

// ── Action parser ────────────────────────────────────────────────────────────

function parseAction(input: string, state: GameState): GameAction | null {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toUpperCase();
  const activeId = state.playerOrder[state.activePlayerIndex];

  switch (cmd) {
    case "DRAW":
      return { type: "DRAW" };
    case "END_EXCHANGE":
      return { type: "END_EXCHANGE" };
    case "PRAY":
      return { type: "PRAY" };
    case "RESOLVE":
      return { type: "RESOLVE" };
    case "END_TURN":
      return { type: "END_TURN" };
    case "CONFIRM_ATTACK":
      return { type: "CONFIRM_ATTACK" };

    case "CONFIRM_DEFENSE": {
      const playerId = parts[1] as PlayerId | undefined;
      if (!playerId) { console.log("使い方: CONFIRM_DEFENSE <プレイヤーID>"); return null; }
      return { type: "CONFIRM_DEFENSE", playerId };
    }

    case "ATTACK": {
      // ATTACK <cardId> [<cardId2> ...] [TARGET <targetId>]
      const cardIds: string[] = [];
      let target: PlayerId | undefined;
      for (let i = 1; i < parts.length; i++) {
        if (parts[i]?.toUpperCase() === "TARGET") {
          target = parts[i + 1] as PlayerId | undefined;
          break;
        }
        cardIds.push(parts[i]!);
      }
      if (cardIds.length === 0) {
        console.log("使い方: ATTACK <カードID> [TARGET <プレイヤーID>]");
        return null;
      }
      const hand = state.players[activeId]?.hand ?? [];
      const cards = cardIds.map((id) => hand.find((c) => c.id === id)).filter(Boolean) as Card[];
      if (cards.length !== cardIds.length) {
        console.log("指定されたカードが手札に見つかりません");
        return null;
      }
      return { type: "ATTACK", cards, target };
    }

    case "DEFEND": {
      // DEFEND <playerId> [<cardId> ...]
      const playerId = parts[1] as PlayerId | undefined;
      if (!playerId) { console.log("使い方: DEFEND <プレイヤーID> [カードID...]"); return null; }
      const cardIds = parts.slice(2);
      const hand = state.players[playerId]?.hand ?? [];
      const cards = cardIds.map((id) => hand.find((c) => c.id === id)).filter(Boolean) as Card[];
      if (cards.length !== cardIds.length) {
        console.log("指定されたカードが手札に見つかりません");
        return null;
      }
      return { type: "DEFEND", playerId, cards };
    }

    case "EXCHANGE": {
      // EXCHANGE <cardId> <hp> <mp> <pay>
      const cardId = parts[1];
      const hp  = parseInt(parts[2] ?? "", 10);
      const mp  = parseInt(parts[3] ?? "", 10);
      const pay = parseInt(parts[4] ?? "", 10);
      if (!cardId || isNaN(hp) || isNaN(mp) || isNaN(pay)) {
        console.log("使い方: EXCHANGE <カードID> <HP> <MP> <PAY>");
        const p = state.players[activeId];
        if (p) {
          const { hp: h, mp: m, pay: pa } = p.stats;
          console.log(`  現在: HP:${h} MP:${m} PAY:${pa}  合計:${h + m + pa}`);
        }
        return null;
      }
      return { type: "EXCHANGE", cardId, allocations: { hp, mp, pay } };
    }

    case "BUY": {
      // BUY <buyCardId> <targetId>
      const buyCardId = parts[1];
      const targetId  = parts[2] as PlayerId | undefined;
      if (!buyCardId || !targetId) {
        console.log("使い方: BUY <BUYカードID> <ターゲットID>");
        return null;
      }
      return { type: "BUY", buyCardId, targetId };
    }

    case "SELL": {
      // SELL <sellCardId> <itemCardId> <targetId>
      const sellCardId = parts[1];
      const itemCardId = parts[2];
      const targetId   = parts[3] as PlayerId | undefined;
      if (!sellCardId || !itemCardId || !targetId) {
        console.log("使い方: SELL <SELLカードID> <商品カードID> <ターゲットID>");
        return null;
      }
      return { type: "SELL", sellCardId, itemCardId, targetId };
    }

    case "USE_HEAL": {
      const cardId = parts[1];
      if (!cardId) { console.log("使い方: USE_HEAL <カードID>"); return null; }
      return { type: "USE_HEAL", cardId };
    }

    default:
      return null;
  }
}

// ── Main loop ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  console.log("=== GoodFieldTS CLI ===");
  const numStr = await question("プレイヤー数 (2-9): ");
  const numPlayers = parseInt(numStr, 10);
  if (isNaN(numPlayers) || numPlayers < 2 || numPlayers > 9) {
    console.error("無効なプレイヤー数です。");
    rl.close();
    return;
  }

  const playerIds = Array.from(
    { length: numPlayers },
    (_, i) => `P${i + 1}` as PlayerId
  );

  let state = createInitialState(playerIds);
  printState(state);
  // Show all players' starting hands
  for (const id of playerIds) printHand(state, id);
  printHelp(state.phase);

  while (state.phase !== "GAME_OVER") {
    const activeId = state.playerOrder[state.activePlayerIndex];
    const input = await question(`\n${activeId} > `);
    const trimmed = input.trim();

    if (!trimmed) continue;

    const upper = trimmed.toUpperCase();

    // HAND [playerId] — meta command, does not advance game state
    if (upper.startsWith("HAND")) {
      const pid = (trimmed.split(/\s+/)[1] ?? activeId) as PlayerId;
      printHand(state, pid);
      continue;
    }

    if (upper === "HELP") {
      printHelp(state.phase);
      continue;
    }

    const action = parseAction(trimmed, state);
    if (!action) {
      console.log("不明なコマンドです。HELP で一覧を確認できます。");
      continue;
    }

    const prev = state;
    state = gameReducer(state, action);
    if (state === prev) {
      console.log("(コマンドが無効でした — フェーズやカードIDを確認してください)");
    } else {
      printState(state);
      if (state.phase !== "GAME_OVER") printHelp(state.phase);
    }
  }

  rl.close();
}

main().catch(console.error);
