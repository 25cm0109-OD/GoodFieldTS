import type { Card } from "../../domain/types";

/**
 * UI側で共通利用するカード種別判定。
 * ゲームルール自体は engine 側にあり、ここは表示・入力制御のための補助のみを置く。
 */
export function isAttackCard(card: Card): boolean {
  return card.type === "ATTACK";
}

export function isDefenseCard(card: Card): boolean {
  return (
    card.type === "DEFENSE" ||
    card.type === "REFLECT_PHYSICAL" ||
    card.type === "REFLECT_ALL" ||
    card.type === "RING"
  );
}
