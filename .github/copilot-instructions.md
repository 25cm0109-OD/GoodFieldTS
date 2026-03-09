# Copilot Instructions

## Commands

```bash
npm run dev        # CLIローカル対戦（ts-node src/ui/cli/index.ts）
npm run gui        # ブラウザGUI（Vite開発サーバー、ルート: src/ui/browser/）
npm run server     # WebSocketサーバー（ポート3001、オンライン対戦用）
npm test           # 全テスト実行
npm run build      # TypeScriptコンパイル → dist/
```

**単一テストファイルの実行:**
```bash
npx jest src/__tests__/engine.test.ts
npx jest src/__tests__/battle.test.ts
npx jest --testNamePattern="<テスト名の一部>"
```

**オンライン対戦の起動:**
```bash
# ターミナル1
npm run gui      # Vite (ポート5173) → http://localhost:5173/online.html

# ターミナル2
npm run server   # WebSocket (ポート3001)
```

## Architecture

純粋関数型ステートマシンに基づいたターン制カード対戦ゲームエンジン。

**中心となる設計:**
全てのゲームイベントは `engine/gameEngine.ts` の `gameReducer(state, action) → GameState` を通して処理される。副作用なし・ランダム性なし（ドローのランダム性は `drawRandomCard()` としてリデューサー外に分離）。これにより Server Authoritative なオンライン化が容易になっている。

**フェーズ遷移:**
```
DRAW_PHASE → EXCHANGE_PHASE → DEFENSE_PHASE → RESOLVE_PHASE → END_CHECK → GAME_OVER
```
`ATTACK_PHASE` は廃止済み。攻撃（`ATTACK` アクション）は `EXCHANGE_PHASE` 内で処理され、そのまま `DEFENSE_PHASE` へ遷移する。`CONFIRM_ATTACK` アクションは後方互換性のために残っているが no-op。

リデューサーは各アクションをフェーズでガードし、フェーズ外のアクションは現在の状態をそのまま返す。

**レイヤー構造:**
- `domain/types.ts` — 全型定義の唯一の集約場所（Card, GameState, GameAction 等）
- `engine/` — ピュアなゲームロジック（UI・ネットワーク依存なし）
- `ui/` — CLI（ts-node）とブラウザ（Vite）の2系統。どちらも `gameReducer` を呼ぶだけ
- `server/index.ts` — WebSocketサーバー（部屋管理・ゲームアクションのブロードキャスト）
- `network/protocol.ts` — オンライン化準備用の型定義のみ

## Key Conventions

**不変性:** 全ステート更新はスプレッド構文（`{...state}`）で行う。`domain/types.ts` の全プロパティは `readonly`。

**ステータス制約:** HP/MP/PAY は常に `clampStat()` で [0, 99] にクランプ。

**手札上限:** `MAX_HAND_SIZE = 20`（`initialState.ts`）。21枚目を入手した際はランダムで既存カード1枚を廃棄（奇跡カードも含む）。

**PAY消費フォールバック:** PAYが不足する場合は MP → HP の順に補填（`consumePay()` in `gameEngine.ts`）。厳密な順序: PAY全量消費 → 残りをMP → さらに残りをHP。いずれも不足で null 返却（アクション失敗）。BUY・SELL・USE_DISASTER のコストに適用（攻撃MPコストは別途チェック）。

**奇跡カード（`permanent: true`）:** 使用後に捨て札ではなく手札の末尾に戻る。`playCards()` ヘルパーが `permanent` フラグでルーティングする。

**通常攻撃とMPコスト:** `ATTACK` 型カードはMPを消費しない。`MIRACLE_ATK` のみ `mpCost` を消費する。

**全体攻撃（`areaAttackPercent`）:** カードの `areaAttackPercent: 25 | 50 | 75` は**命中確率（%）**を表す。攻撃時に非アクティブプレイヤー全員に対して各自独立で命中判定を行い、結果を `areaHitResults` として state に保存。命中したプレイヤーのみが防御フェーズに入り、フルダメージを受ける（全員外れた場合は RESOLVE_PHASE に直行）。内部的には `pendingAreaTargets` 配列で1人ずつ処理し、`processNextAreaTarget()` がターゲットをポップして DEFENSE_PHASE を起動する。暗雲アイルメントを持つプレイヤーは確率に関わらず必中。

**EXCHANGE_PHASE で使えるアクション:** `ATTACK`、`EXCHANGE`（`cardId` でEXCHANGEカードを消費してHP/MP/PAY再配分）、`BUY`、`SELL`、`USE_HEAL`、`PRAY`、`END_EXCHANGE`。

**`actionUsedThisTurn` フラグ:** `ATTACK`、`EXCHANGE`、`BUY`、`SELL`、`USE_HEAL` 使用後にセットされ、同一ターン内での再使用をブロックする。`PRAY` はこのフラグをセットしない（攻撃カードがない時の脱出手段のため）。

**PRYAフロー:** 手札に攻撃カードが1枚もない場合のみ使用可。1枚ドローして即座に次プレイヤーの `DRAW_PHASE` へ遷移（ターンスキップ）。

**BUYフロー:** `BUY` アクション実行後、state に `pendingBuyConsent` がセットされる。対象プレイヤーが `ACCEPT_BUY` または `DECLINE_BUY` を送信するまで次の操作はブロックされる。`ACCEPT_BUY` 時のみ購入者が `payCost` を支払う（`consumePay` 経由）。

**SELLフロー:** SELL カード + 売る任意カードを指定。対象プレイヤーはそのカードの `payCost` を `consumePay` 経由で支払い、売り手は同額の PAY を得る。売り手は2枚プレイ分の2枚ドロー。対象の手札に渡る際も手札上限チェックが走る。

**反射防御:** DEFENSE_PHASE 中、実際の防御対象プレイヤーのみが `DEFEND` アクションで防御カードをセット可能。攻撃者（active player）は DEFENSE_PHASE に関与しない。`REFLECT_PHYSICAL` は通常 ATTACK のみ反射（`MIRACLE_ATK` は対象外）、`REFLECT_ALL` は両方反射。反射発生時は攻撃者が攻撃力そのままのダメージを受ける（軽減不可）。反射後、攻撃者が防御する第2 DEFENSE_PHASE が発生し、反射ダメージは `pendingReflect: { damage, element }` に保存される。全体攻撃の場合、複数守備者からの反射ダメージが蓄積する。

**カード定義の編集:** `src/engine/cardRegistry.ts` の `CARD_TEMPLATES` 配列を変更する。各エントリの `frequency` フィールドが500枚プール内での出現枚数を決める。

**属性ルール（`elementSystem.ts` が唯一の実装場所）:**
- 異なる属性の同時使用 → NEUTRAL
- LIGHT防御カードは FIRE/WATER/WOOD/EARTH の**いずれか**として動的に機能する（`canDefend()` が判定）
- LIGHT攻撃は防御不可
- DARK攻撃はダメージ > 0 → 即死（HP=0強制）。ただし防御でダメージ=0に抑えると即死しない
- DARK属性の反射ダメージも同様に即死を引き起こす

**初期ステータス定数（`initialState.ts`）:** `INITIAL_HP=40`, `INITIAL_MP=10`, `INITIAL_PAY=20`, `INITIAL_HAND_SIZE=7`。テストで数値を決め打ちする前にこれらを参照する。

**`attackPlus` と `doubler`:** どちらも使用後に `attackPlusActive=true` をセットし、`EXCHANGE_PHASE` に留まる（追加攻撃可）。効果は同一。

**`lightAsElement`（ATTACKアクション）:** LIGHT属性カードを指定属性として扱う場合に `ATTACK` アクションへ `lightAsElement: Element` を渡す。`attackElementOverride` として state に保存され、RESOLVE時に適用される。

**`HEAL_HP` / `HEAL_MP` カード:** EXCHANGE_PHASE に `USE_HEAL` アクション（`{ type: "USE_HEAL", cardId, targetId? }`）で使用。`targetId` を省略すると自分を回復。カードの `power` 分だけ HP または MP を回復する。

**`deck` フィールド:** 各プレイヤーの `deck` は常に空配列。個別デッキは存在せず、ドローは全て共有プールの `drawRandomCard()` 経由。型互換のためフィールドのみ保持。

**`DRAW` アクション:** ドロー処理を行わず、`DRAW_PHASE → EXCHANGE_PHASE` への遷移のみを担う。カードは各カード使用後のドロー（1枚プレイ → 1枚ドロー）で補充される。

**カードID形式:** `card-{連番}` (例: `"card-1"`, `"card-42"`)。グローバルカウンター `_cardIdCounter` でインクリメント。

**プレイヤー離脱（3人以上）:** RESOLVE_PHASE 後に HP=0 のプレイヤーは `playerOrder` から即時除外。残り1人以下になれば `GAME_OVER`。攻撃者も反射ダメージでHP=0になる場合がある。複数人が同時に除外されてから生存者チェックを行う。

**テストヘルパー（ファイル別）:**
- `engine.test.ts`: `testCard(type, overrides?)` / `stateAtPhase(phase, playerOrder?)`
- `battle.test.ts`: `makeCard(overrides?)` / `battleState(attackCards, defCards, atkHp=30, defHp=30)` — P1攻撃・P2防御の `RESOLVE_PHASE` 状態を返す

EXCHANGEアクションに `cardId` が必要な場合は、テスト内でEXCHANGEカードを手札に注入してから呼ぶ。

**テスト分離:** `makeCard()` / `makeCardFromTemplate()` はグローバルカウンターでIDを付与するため、テスト間でID衝突が起きる場合は `resetCardIdCounter()`（`cardRegistry.ts`）と `resetPool()`（`initialState.ts`）を `beforeEach` で呼ぶ。両ヘルパー（`testCard` / `makeCard`）も独自のローカルカウンターを持つため、ID依存のアサーションがあれば同様にリセットが必要。

**テスト配置:** `src/__tests__/` 以下に `*.test.ts`。Jest の `testMatch` は `**/__tests__/**/*.test.ts` にマッチする。

## Ailment System

**病気チェーン（progression）:** 風邪 → 熱病 → 地獄病 → 天国病 → 即死

**ターン開始時効果（DRAW_PHASE）:**
- 風邪: -1 HP/ターン
- 熱病: -2 HP/ターン
- 地獄病: -5 HP/ターン
- 天国病: +5 HP/ターン
- 各ターン5%の確率で自然悪化（天国病の次は即死）

**その他アイルメント（悪化しない）:**
- 霧（kiri）: 攻撃対象がランダムになる
- 閃光（senkou）: 防御カードを1枚しか使えない
- 夢（yume）: カード表示が変化（見た目のみ）
- 暗雲（an'un）: 全体攻撃が必中になる

**`USE_DISASTER` アクション:** `{ type: "USE_DISASTER", cardId, targetId }` で使用。`payCost` を `consumePay` 経由で支払い、1枚ドロー。対象プレイヤーへのアイルメント付与。対象が既に同じ病気系アイルメントを持つ場合は悪化チェーンが進む。自分への使用も可能。

**病気系アイルメント一覧:** `["風邪", "熱病", "地獄病", "天国病"]`（これらのみ悪化チェーンに参加。他は上書き）。

## Server Patterns

**部屋コード形式:** 4文字英数字（母音 O/I と数字 0/1 を除外してコード読み違いを防止）。

**ホスト再割り当て:** ホストが退出した場合、残った最初のプレイヤーが新ホストになる。

**`autoAdvance()` の自動フェーズ進行:** サーバー側で `DRAW_PHASE → EXCHANGE_PHASE`、`RESOLVE_PHASE → END_CHECK → DRAW_PHASE` を自動的に繋ぐ。`GAME_OVER` 検知も `autoAdvance()` 内で行われ、ブロードキャストされる。
