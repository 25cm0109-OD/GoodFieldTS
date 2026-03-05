import * as readline from "readline";
import { createInitialState } from "../../engine/initialState";
import { gameReducer } from "../../engine/gameEngine";
import { GameState, GameAction, PlayerId } from "../../domain/types";

function printState(state: GameState): void {
  console.log(`\n=== Phase: ${state.phase} ===`);
  const activeId = state.playerOrder[state.activePlayerIndex];
  console.log(`Active player: ${activeId}`);
  for (const id of state.playerOrder) {
    const p = state.players[id];
    if (!p) continue;
    const { hp, mp, pay } = p.stats;
    console.log(
      `  ${id} | HP:${hp} MP:${mp} PAY:${pay} | Hand:${p.hand.length} Deck:${p.deck.length} Discard:${p.discard.length}`
    );
  }
  if (state.winner) {
    console.log(`\n🏆 Winner: ${state.winner}`);
  }
}

function parseAction(input: string): GameAction | null {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toUpperCase();

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
      if (!playerId) return null;
      return { type: "CONFIRM_DEFENSE", playerId };
    }
    default:
      return null;
  }
}

async function main(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  console.log("=== GoodFieldTS CLI ===");
  const numStr = await question("Number of players (2-9): ");
  const numPlayers = parseInt(numStr, 10);
  if (isNaN(numPlayers) || numPlayers < 2 || numPlayers > 9) {
    console.error("Invalid number of players.");
    rl.close();
    return;
  }

  const playerIds = Array.from(
    { length: numPlayers },
    (_, i) => `P${i + 1}` as PlayerId
  );

  let state = createInitialState(playerIds);
  printState(state);

  console.log(
    "\nCommands: DRAW, END_EXCHANGE, PRAY, CONFIRM_ATTACK, CONFIRM_DEFENSE <PID>, RESOLVE, END_TURN"
  );

  while (state.phase !== "GAME_OVER") {
    const input = await question("> ");
    const action = parseAction(input);
    if (!action) {
      console.log("Unknown command.");
      continue;
    }
    state = gameReducer(state, action);
    printState(state);
  }

  rl.close();
}

main().catch(console.error);
