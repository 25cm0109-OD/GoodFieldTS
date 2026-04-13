import type { Card, GameState, Phase, PlayerId } from "../../domain/types";

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

export function printState(state: GameState): void {
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

export function printHand(state: GameState, playerId: PlayerId): void {
  const p = state.players[playerId];
  if (!p) {
    console.log("プレイヤーが見つかりません");
    return;
  }
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

export function printHelp(phase: Phase): void {
  const lines = PHASE_HELP[phase];
  if (!lines) return;
  console.log("\n使えるコマンド:");
  lines.forEach((l) => console.log("  " + l));
  console.log("  HAND [プレイヤーID]                         — 手札を確認");
  console.log("  HELP                                        — コマンド一覧");
}
