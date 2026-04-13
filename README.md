# GoodFieldTS

**Godfield風カード対戦ゲーム エンジン（TypeScript実装）**

ターン制カード対戦ゲームエンジン。Godfield風の独自ルールを持ち、2〜9人のローカル対戦に対応。将来的なオンライン化も考慮した純粋関数型アーキテクチャ。

---

## 🎮 ゲーム概要

- **プレイヤー数**: 2〜9人（合言葉で参加）
- **勝利条件**: 相手のHPを0にする
- **ステータス**: HP / MP / PAY（各上限99・下限0）
- **先攻**: ランダム決定

---

## ⚡ 属性システム

| 攻撃属性 | 有効な防御属性 | 特殊効果 |
|---------|-------------|---------|
| 無属性   | 全属性       | なし |
| 🔥 火   | 💧 水        | なし |
| 💧 水   | 🔥 火        | なし |
| 🌿 木   | 🪨 土        | なし |
| 🪨 土   | 🌿 木        | なし |
| ☀️ 光   | **防御不可** | なし |
| 🌑 闇   | 全属性       | ダメージ1以上でHP=0（即死） |

**複合ルール:**
- 異なる属性のカードを同時使用 → 無属性になる
- 光属性は火/水/木/土属性の代わりになれる

---

## 🃏 カードタイプ

| タイプ | 説明 | コスト |
|-------|------|-------|
| ATTACK | 攻撃カード（基本1枚/ターン） | MP消費 |
| DEFENSE | 防御カード | なし |
| EXCHANGE | 両替カード（HP/MP/PAY再分配） | なし |
| MIRACLE_ATK | 攻撃奇跡 | MP消費 |
| MIRACLE_DEF | 防御奇跡 | MP消費（防御側） |
| SELL | 任意カードを相手に売りつける | PAY消費/獲得 |
| BUY | 相手のカードをランダムで買う | PAY消費/獲得 |

**攻撃枚数ルール:**
- 基本: 1枚/ターン
- `attackPlus` または `doubler` フラグ付きカード使用後: 追加使用可能
- 攻撃カードが手札にない場合: 「祈る」（1枚��ロー）でターン終了

---

## 🔄 ターンフェーズ

```
DRAW_PHASE
  → EXCHANGE_PHASE（攻撃・祈る・両替・売買・回復などの行動を選択）
    → DEFENSE_PHASE（防御カードを何枚でも使用可・タイムアウトor確定宣言）
      → RESOLVE_PHASE（ダメージ計算・HP適用）
        → END_CHECK（敗北判定・ターン交代）
```

---

## 🧮 ダメージ計算

```
ダメージ = max(0, 攻撃合計値 - 防御合計値)
闇属性でダメージ > 0 → 防御側HP = 0（即死）
```

---

## 📦 セットアップ

```bash
git clone https://github.com/25cm0109-OD/GoodFileldTS.git
cd GoodFileldTS
npm install
```

---

## 🚀 使い方

```bash
# CLIローカル対戦
npm run dev

# ブラウザGUI（Vite開発サーバー）
npm run gui

# テスト実行
npm test

# ビルド
npm run build
```

---

## 📁 ディレクトリ構成

```
src/
├── domain/
│   └── types.ts              # 全型定義
├── engine/
│   ├── gameEngine.ts         # 純粋関数型ステートマシン
│   ├── elementSystem.ts      # 属性カウンター・複合ルール
│   ├── cardRegistry.ts       # カードデータベース
│   └── initialState.ts       # ゲーム初期化（2〜9人対応）
├── ui/
│   ├── cli/
│   │   ├── index.ts          # CLIエントリーポイント（入出力ループ）
│   │   ├── cliActionParser.ts# CLI入力→GameAction変換
│   │   └── cliView.ts        # CLI表示（状態・手札・ヘルプ）
│   └── browser/
│       ├── index.html        # ブラウザGUIエントリーポイント
│       ├── main.ts           # ローカル対戦UI
│       ├── online.ts         # オンライン対戦UI
│       └── style.css         # ダークテーマスタイル
│
├── ui/shared/
│   ├── cardPredicates.ts     # UI共通のカード種別判定
│   └── cardUiLabels.ts       # UI共通の日本語ラベル/絵文字
├── network/
│   └── protocol.ts           # オンライン化対応型定義
└── __tests__/
    ├── engine.test.ts
    ├── element.test.ts
    └── battle.test.ts
```

---

## 🔌 将来のオンライン化

- `gameReducer` は純粋関数 → サーバー/クライアント両方で実行可能
- `GameAction` は全てシリアライズ可能な純粋オブジェクト
- `network/protocol.ts` に `NetworkAction` / `GameRoom` 型を定義済み
- Server Authoritative アーキテクチャへの移行が容易

---

## 📜 ライセンス

MIT
