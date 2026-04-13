# UI参照関係マップ

このファイルは、**どのUIがどのロジックを参照しているか**を素早く把握するための図です。

## エントリーポイント

- `npm run dev` → `src/ui/cli/index.ts`（CLI UI）
- `npm run gui` → `src/ui/browser/main.ts` / `src/ui/browser/online.ts`（ブラウザ UI）
- `npm run server` → `src/server/index.ts`（オンライン対戦サーバー）

## 参照関係図（Mermaid）

```mermaid
flowchart LR
  subgraph UI["UI層"]
    CLI["src/ui/cli/index.ts\n(入力ループ)"]
    CLIP["src/ui/cli/cliActionParser.ts\n(入力→GameAction)"]
    CLIV["src/ui/cli/cliView.ts\n(表示)"]
    BMAIN["src/ui/browser/main.ts\n(ローカル対戦UI)"]
    BONLINE["src/ui/browser/online.ts\n(オンライン対戦UI)"]
    BANI["src/ui/browser/battleAnimController.ts\n(演出制御)"]
    USHARED1["src/ui/shared/cardPredicates.ts\n(UI共通カード判定)"]
    USHARED2["src/ui/shared/cardUiLabels.ts\n(UI共通ラベル)"]
  end

  subgraph ENGINE["ロジック層"]
    INIT["src/engine/initialState.ts\n(初期状態生成)"]
    REDUCER["src/engine/gameEngine.ts\n(gameReducer)"]
    ELEM["src/engine/elementSystem.ts\n(canDefend)"]
  end

  DOMAIN["src/domain/types.ts\n(型定義)"]
  SERVER["src/server/index.ts\n(WebSocketサーバー)"]
  PROTO["src/network/protocol.ts\n(通信型)"]

  CLI --> CLIP
  CLI --> CLIV
  CLI --> INIT
  CLI --> REDUCER
  CLI --> DOMAIN

  CLIP --> DOMAIN
  CLIV --> DOMAIN

  BMAIN --> INIT
  BMAIN --> REDUCER
  BMAIN --> ELEM
  BMAIN --> BANI
  BMAIN --> USHARED1
  BMAIN --> USHARED2
  BMAIN --> DOMAIN

  BONLINE --> ELEM
  BONLINE --> BANI
  BONLINE --> USHARED1
  BONLINE --> USHARED2
  BONLINE --> DOMAIN
  BONLINE --> SERVER

  SERVER --> REDUCER
  SERVER --> INIT
  SERVER --> PROTO
  SERVER --> DOMAIN
```

## 役割の見分け方（短縮）

- **`engine/*`**: ルール本体（UI非依存）
- **`ui/*`**: 表示・入力・演出（UI依存）
- **`ui/shared/*`**: UI同士の共通部品
- **`domain/types.ts`**: UI/Engine/Serverの共通契約（型）
