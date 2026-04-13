import * as readline from "readline";
import { createInitialState } from "../../engine/initialState";
import { gameReducer } from "../../engine/gameEngine";
import type { PlayerId } from "../../domain/types";
import { parseAction } from "./cliActionParser";
import { printHand, printHelp, printState } from "./cliView";

// CLI層の責務:
// - このファイル: 入力待ちとゲームループ進行
// - cliActionParser.ts: 文字列コマンドの解釈
// - cliView.ts: 状態表示

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
