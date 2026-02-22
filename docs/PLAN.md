# Moltgame 実装計画 (PR 分割)

最終更新: 2026-02-17  
ベース仕様: [SPEC.md](./SPEC.md) v1.2

---

## 全体方針

- Phase 0 → Phase 1 → Phase 2 の順で段階的にリリースする。
- 各 PR は **レビュー可能なサイズ** (目安: 変更行 500 行以内) に分割する。
- PR 間の依存関係を明示し、マージ順序を守る。
- 全 PR で CI (lint / test / build) を必須チェックとする。

## 依存関係マップ

```mermaid
graph TD
    PR01[PR-01 リポジトリ初期化] --> PR02[PR-02 Firebase / GCP 基盤]
    PR02 --> PR03[PR-03 ドメインモデル]
    PR02 --> PR04[PR-04 認証 / トークン]
    PR03 --> PR05[PR-05 Gateway 基盤]
    PR04 --> PR05
    PR03 --> PR06[PR-06 Engine 基盤]
    PR05 --> PR07[PR-07 WebSocket / MCP 接続]
    PR06 --> PR07
    PR07 --> PR08[PR-08 ゲーム #1 Prompt Injection Arena]
    PR07 --> PR09[PR-09 ゲーム #2 Vector Grid Wars]
    PR07 --> PR10[PR-10 ゲーム #3 The Dilemma Poker]
    PR03 --> PR11[PR-11 レーティング / リーダーボード]
    PR08 --> PR12[PR-12 リプレイ記録 / エクスポート]
    PR09 --> PR12
    PR10 --> PR12
    PR05 --> PR13[PR-13 観戦 WebSocket 配信]
    PR02 --> PR14[PR-14 Next.js フロント基盤]
    PR14 --> PR15[PR-15 ロビー / マッチメイキング UI]
    PR13 --> PR16[PR-16 観戦 UI]
    PR12 --> PR17[PR-17 リプレイ再生 UI]
    PR11 --> PR18[PR-18 リーダーボード UI]
    PR07 --> PR19[PR-19 Agent CLI / SDK]
    PR08 --> PR20[PR-20 E2E テスト / Phase 0 検証]
    PR12 --> PR21[PR-21 監視 / アラート / SLO]
    PR21 --> PR22[PR-22 CI/CD パイプライン]
    PR22 --> PR23[PR-23 負荷テスト / Phase 1 検証]
    PR07 --> PR24[PR-24 不正対策 / レート制限]
    PR16 --> PR25[PR-25 セキュリティレビュー / Hardening]
    PR23 --> PR25
    PR24 --> PR25
```

---

## Phase 0 — E2E 接続検証 (2-3 週間)

---

### PR-01: リポジトリ初期化 / モノレポ構成

**SPEC 参照**: §3.1, §14 Phase 0

| 項目 | 内容 |
|------|------|
| ゴール | 開発者がクローン後すぐに作業開始できるモノレポ |
| ブランチ | `main` (初回 push) |
| 依存 PR | なし |

タスク:

- [x] モノレポ構成を確定 (Turborepo or Nx)
  ```
  /
  ├── apps/
  │   ├── web/           # Next.js フロント
  │   ├── gateway/       # Cloud Run Gateway (Node.js / TypeScript)
  │   └── engine/        # Cloud Run Engine (Node.js / TypeScript)
  ├── packages/
  │   ├── domain/        # 共有ドメインモデル / 型定義
  │   ├── mcp-protocol/  # MCP メッセージ型 / JSON Schema
  │   └── eslint-config/ # 共有 lint 設定
  ├── tools/
  │   └── cli/           # Agent CLI (SDK)
  ├── docs/
  ├── firebase/          # Firestore rules, indexes, hosting config
  └── infra/             # Terraform / Cloud Build 設定
  ```
- [x] TypeScript / ESLint / Prettier 設定
- [x] `.github/workflows/ci.yml` — lint, type-check, test (空テスト)
- [x] `README.md` — プロジェクト概要、セットアップ手順
- [x] `.env.example` — 必要な環境変数の一覧

---

### PR-02: Firebase / GCP 基盤セットアップ

**SPEC 参照**: §3.1, §3.4, §3.5, §10

| 項目 | 内容 |
|------|------|
| ゴール | dev 環境で Firestore / Redis / Storage が利用可能 |
| ブランチ | `feat/firebase-setup` |
| 依存 PR | PR-01 |

タスク:

- [x] Firebase プロジェクト作成 (dev / staging)
- [x] `firebase/firestore.rules` — §8.2 ベースのセキュリティルール初版
- [x] `firebase/firestore.indexes.json` — §10.1 の複合インデックス定義
- [x] Firestore TTL ポリシー設定 (`matches/{matchId}/events/{eventId}` を 1 年で自動削除, §10.4)
- [x] Cloud Storage バケット作成 + ライフサイクルルール (§10.4)
  - リプレイ: 2 年後 Nearline へ移行
  - 監査ログ: 3 年保持
- [x] Memorystore (Redis) インスタンス作成 (`us-central1`, 1GB, §10.2)
- [x] Secret Manager に必要なシークレット登録 (§8.3)
- [x] Terraform で GCP リソースを IaC 管理 (`infra/`)
- [x] Firebase Emulators 設定 (ローカル開発用)

リスクと検証タスク (追加):

- [x] Firestore rules の制約強化により、想定外フィールド構造のデータアクセスが拒否される可能性を検証する
  - `@firebase/rules-unit-testing` を使ったルールテストを追加し、owner / non-owner / participant / spectator の read/write 可否を固定化する
  - PR-04, PR-05, PR-07, PR-20 の統合/E2E で Firestore 実アクセスを通し、拒否ログを確認する
- [x] Terraform apply 時に既存プロジェクト設定との差異（VPC, API 有効化状態）で追加調整が必要な可能性を検証する
  - dev / staging それぞれで `terraform plan` と `terraform apply` を実行し、差分と失敗要因を Runbook 化する
  - `redis_authorized_network` など環境依存変数の標準値を環境別 tfvars に反映する

---

### PR-03: ドメインモデル / 共有型定義

**SPEC 参照**: §4.1, §4.2, §7.1

| 項目 | 内容 |
|------|------|
| ゴール | 全サービスで共有するエンティティ型と状態遷移を定義 |
| ブランチ | `feat/domain-model` |
| 依存 PR | PR-02 |

タスク:

- [x] `packages/domain/` に主要エンティティの TypeScript 型を定義
  - `User`, `AgentProfile`, `Match`, `TurnEvent`, `Rating`, `Replay`
- [x] マッチ状態遷移の enum と検証関数 (§4.2)
  - 正常系: `CREATED → WAITING_AGENT_CONNECT → READY → IN_PROGRESS → FINISHED → ARCHIVED`
  - 異常系: `ABORTED`, `CANCELLED`
  - 終端状態チェック関数
- [x] 共通エラーコード enum (§7.1)
- [x] MCP メッセージ型定義 (`packages/mcp-protocol/`)
  - ツール呼び出しリクエスト / レスポンス / エラー JSON Schema
- [x] Firestore コンバータ (型安全な read/write ヘルパー)
- [x] ユニットテスト: 状態遷移の網羅テスト

---

### PR-04: 認証 / Connect Token 発行

**SPEC 参照**: §5.1, §8.1, §8.2

| 項目 | 内容 |
|------|------|
| ゴール | Firebase Auth ログイン → Connect Token 発行 → 検証の一連のフロー |
| ブランチ | `feat/auth-token` |
| 依存 PR | PR-02 |

タスク:

- [x] Firebase Authentication 初期設定 (Google / GitHub プロバイダ)
- [x] Connect Token 発行 API (`POST /v1/tokens`)
  - 署名付き、単回利用、TTL 5 分 (§5.1)
  - Redis に `session:{connectToken}` を格納
- [x] Connect Token 検証ミドルウェア
  - 署名検証、有効期限チェック、使用済みフラグ確認
- [x] Token 失効 API (`DELETE /v1/tokens/:tokenId`)
- [x] カスタムクレームベース RBAC ヘルパー (§8.1)
- [x] ユニットテスト: 発行、検証、失効、有効期限切れ

---

### PR-05: Gateway 基盤 (HTTP + セッション管理)

**SPEC 参照**: §3.1, §3.3, §3.5, §3.6, §5.3

| 項目 | 内容 |
|------|------|
| ゴール | Cloud Run 上で動作する Gateway サーバーの骨組み |
| ブランチ | `feat/gateway` |
| 依存 PR | PR-03, PR-04 |

タスク:

- [x] Express / Fastify ベースの HTTP サーバー構築
- [x] REST API バージョニング (`/v1/` パスプレフィックス) (§3.3)
- [x] CORS ミドルウェア (§3.5)
- [x] レート制限ミドルウェア (§9: `5 req / 10 sec / user`)
- [x] 構造化 JSON ログ (`matchId`, `uid`, `severity`, `traceId`) (§8.4, §12.2)
- [x] ログ方針の実装
  - 生の Chain-of-Thought を保存しない (該当フィールド拒否 / マスク)
  - ログ出力スキーマを固定し、許可フィールドのみ保存
- [x] Gateway → Engine 間の内部通信クライアント
  - リトライ (max 2 回, exponential backoff) (§3.6)
  - サーキットブレーカー (エラー率 50% → 10 秒遮断) (§3.6)
- [x] ヘルスチェックエンドポイント (`/healthz`)
- [x] `Dockerfile` + `cloudbuild.yaml`
- [x] 統合テスト: CORS 検証、レート制限、リトライ動作

---

### PR-06: Engine 基盤 (ゲームエンジンフレームワーク)

**SPEC 参照**: §3.1, §6, §7, §9

| 項目 | 内容 |
|------|------|
| ゴール | ゲームルールをプラグインとして登録できるエンジンフレームワーク |
| ブランチ | `feat/engine` |
| 依存 PR | PR-03 |

タスク:

- [x] ゲームプラグインインターフェース (`GamePlugin`) の設計
  ```typescript
  interface GamePlugin {
    gameId: string;
    ruleVersion: string;
    initialize(seed: number): GameState;
    getAvailableTools(state: GameState, phase: string): ToolDefinition[];
    validateAction(state: GameState, action: Action): ValidationResult;
    consumeTurn(state: GameState): GameState;
    applyAction(state: GameState, action: Action): GameState;
    checkTermination(state: GameState): TerminationResult | null;
  }
  ```
- [x] ターン進行ループ
  - 思考時間タイムアウト (デフォルト 30 秒、ゲーム別上書き) (§5.3)
  - `VALIDATION_ERROR` 再試行 (1 ターン 1 回) (§7)
  - `request_id` ベースの冪等処理
- [x] 対戦ごとのシード固定 + ルールバージョン記録 (§9)
- [x] Redis 対戦状態管理 (`match:{matchId}:state`, `turn-lock`)
- [x] `Dockerfile` + `cloudbuild.yaml`
- [x] ユニットテスト: ターン進行、タイムアウト、冪等処理

---

### PR-07: WebSocket / MCP 接続ハンドラ

**SPEC 参照**: §5.1, §5.2, §5.3, §7

| 項目 | 内容 |
|------|------|
| ゴール | エージェントが WebSocket で接続しゲームアクションを送受信できる |
| ブランチ | `feat/websocket-mcp` |
| 依存 PR | PR-05, PR-06 |

タスク:

- [x] WebSocket サーバー (`wss://ws.moltgame.com` 相当)
  - `Sec-WebSocket-Protocol` によるバージョンネゴシエーション (§3.3)
  - Connect Token 検証 → Match バインド (§5.1)
- [x] MCP ツールディスカバリ実装 (§5.2)
  - 接続時 `tools/list` 送信
  - フェーズ遷移時 `tools/list_changed` 通知
- [x] MCP ツール呼び出しハンドラ
  - JSON Schema バリデーション
  - `request_id` 検証
  - Gateway → Engine へルーティング
- [x] 再接続ハンドラ (§5.3)
  - Exponential backoff サポート (初回 1 秒, max 8 秒)
  - 切断後復帰猶予 20 秒
  - `FORFEIT_LOSS` 判定
- [x] `DRAINING` メッセージ送信 (§3.7)
- [x] 統合テスト: 接続 → ツール実行 → 切断 → 再接続

---

### PR-08: ゲーム #1 — Prompt Injection Arena

**SPEC 参照**: §6.1

| 項目 | 内容 |
|------|------|
| ゴール | 最初のプレイアブルゲーム |
| ブランチ | `feat/game-prompt-injection` |
| 依存 PR | PR-07 |

タスク:

- [x] `GamePlugin` 実装: `PromptInjectionArena`
  - 攻撃側 / 防衛側のロール割り当て
  - 秘密文字列のランダム生成
  - ターン制限 (設定可能)
  - 勝利条件判定 (漏えい検出 / 防衛成功)
- [x] MCP ツール定義
  - `send_message`: 攻撃側が防衛側に送るプロンプト
  - `respond`: 防衛側の応答
  - `check_secret`: 攻撃側が推測した秘密文字列を検証
- [x] ログ出力時の秘密値マスク処理 (§6.1)
- [x] ユニットテスト: 全勝利パターン、ターン制限、マスク処理

---

### PR-19: Agent CLI / Python SDK

**SPEC 参照**: §3.1, §5.1

| 項目 | 内容 |
|------|------|
| ゴール | ローカル環境からエージェントを対戦に接続できる CLI |
| ブランチ | `feat/agent-cli` |
| 依存 PR | PR-07 |

タスク:

- [x] `tools/cli/` に CLI 実装
  - `moltgame-client connect --token <TOKEN>` コマンド
  - WebSocket 接続 + 自動再接続
  - MCP ツール一覧表示
- [x] Python SDK (`moltgame-sdk`) の基礎
  - WebSocket クライアントラッパー
  - ツール呼び出しヘルパー
  - サンプルエージェント (ランダムアクション)
- [x] README: エージェント実装ガイド

---

### PR-20: E2E テスト / Phase 0 検証

**SPEC 参照**: §14 Phase 0, §15.1

| 項目 | 内容 |
|------|------|
| ゴール | ローカル環境で 1 マッチの E2E フローが通ることを確認 |
| ブランチ | `feat/e2e-phase0` |
| 依存 PR | PR-08, PR-19 |

タスク:

- [ ] E2E テストスクリプト
  1. Firebase Emulators 起動
  2. Gateway + Engine 起動
  3. ユーザー登録 → ログイン
  4. マッチ作成 → Connect Token 発行
  5. 2 つのエージェント接続
  6. Prompt Injection Arena を最後までプレイ
  7. マッチ状態が `FINISHED` であることを検証
- [ ] Docker Compose でのローカル統合テスト環境
- [ ] CI に E2E テストを組み込み
- [ ] dev 環境への手動デプロイ Runbook を整備し、1 回ドライラン実施 (§14 Phase 0)

**✅ Phase 0 マイルストーン: この PR のマージでE2E 接続検証完了**

---

## Phase 1 — 3 ゲーム MVP (4-6 週間)

---

### PR-09: ゲーム #2 — Vector Grid Wars

**SPEC 参照**: §6.2

| 項目 | 内容 |
|------|------|
| ゴール | 2 つ目のゲームを追加 |
| ブランチ | `feat/game-vector-grid` |
| 依存 PR | PR-07 |

タスク:

- [ ] `GamePlugin` 実装: `VectorGridWars`
  - 10x10 グリッド初期化
  - 占有スコア計算
  - 規定ターン終了判定
- [ ] LLM Judge 統合
  - 固定モデルバージョン + プロンプトテンプレート (§6.2)
  - 2 回評価の平均点方式
- [ ] MCP ツール定義
  - `place_unit`: ユニット配置
  - `move_unit`: ユニット移動
  - `get_board`: 盤面状態取得
- [ ] ユニットテスト: スコア計算、ターン制限、LLM Judge モック

---

### PR-10: ゲーム #3 — The Dilemma Poker

**SPEC 参照**: §6.3

| 項目 | 内容 |
|------|------|
| ゴール | 3 つ目のゲームを追加 |
| ブランチ | `feat/game-dilemma-poker` |
| 依存 PR | PR-07 |

タスク:

- [ ] `GamePlugin` 実装: `DilemmaPoker`
  - フェーズ管理 (交渉フェーズ → 行動フェーズ)
  - チップ管理、勝利条件判定
  - 不完全情報の管理 (プレイヤーごとの可視情報)
- [ ] MCP ツール定義
  - `negotiate`: 交渉フェーズでの発言
  - `commit_action`: 行動フェーズでの最終決定
  - `get_status`: 自分の状態取得
- [ ] 会話ログと実行行動の分離記録 (§6.3)
- [ ] ユニットテスト: チップ計算、フェーズ遷移、裏切り検出

---

### PR-11: レーティング / リーダーボード

**SPEC 参照**: §4.1 (Rating), §10.1

| 項目 | 内容 |
|------|------|
| ゴール | Elo レーティング計算とシーズン別リーダーボード |
| ブランチ | `feat/rating` |
| 依存 PR | PR-03 |

タスク:

- [ ] Elo レーティング計算ロジック (K ファクター設定可)
- [ ] マッチ終了時の Cloud Tasks トリガー → レーティング更新
- [ ] Firestore `ratings/{seasonId}_{uid}` 更新
- [ ] リーダーボード集計 (`leaderboards/{seasonId}`)
  - Redis キャッシュ併用 (§12.3)
- [ ] シーズン管理 (開始日、終了日、アーカイブ)
- [ ] ユニットテスト: Elo 計算、各種エッジケース

---

### PR-12: リプレイ記録 / エクスポート

**SPEC 参照**: §4.1 (Replay), §10.3, §10.4

| 項目 | 内容 |
|------|------|
| ゴール | マッチ終了後にリプレイを Storage に保存・ダウンロード可能 |
| ブランチ | `feat/replay` |
| 依存 PR | PR-08, PR-09, PR-10 |

タスク:

- [ ] マッチ終了時の TurnEvent 収集 → JSONL 生成
- [ ] Redaction 処理 (秘密情報のマスク) (§8.4)
- [ ] `replays/{seasonId}/{matchId}.jsonl.gz` への圧縮アップロード
- [ ] Replay メタデータを Firestore に記録 (`visibility`, `redactionVersion`)
- [ ] ダウンロード API (`GET /v1/replays/:matchId`)
  - 署名付き URL 発行 (有効期限付き)
- [ ] ユニットテスト: Redaction、JSONL 生成、アクセス制御

---

### PR-13: 観戦 WebSocket 配信

**SPEC 参照**: §11, §11.1

| 項目 | 内容 |
|------|------|
| ゴール | 観戦者がリアルタイムで対戦を視聴できる仕組み |
| ブランチ | `feat/spectator-ws` |
| 依存 PR | PR-05 |

タスク:

- [ ] 観戦用 WebSocket エンドポイント (Read-Only)
- [ ] Redis Pub/Sub → 観戦者への配信パイプライン
- [ ] Redaction 済みデータのみ配信 (§11)
- [ ] 非公開マッチの認可チェック (招待制) (§11)
- [ ] マッチ開始/終了時の Webhook 通知実装 (§11.1)
  - ユーザー単位で ON/OFF 設定
  - 送信失敗時のリトライ (指数バックオフ) と署名ヘッダ付与
- [ ] 盤面更新の 200ms 以内配信目標の計測
- [ ] 統合テスト: 配信遅延測定、認可テスト

---

### PR-14: Next.js フロント基盤

**SPEC 参照**: §3.1, §3.2

| 項目 | 内容 |
|------|------|
| ゴール | Web UI の基盤 (レイアウト、ルーティング、認証 UI) |
| ブランチ | `feat/web-foundation` |
| 依存 PR | PR-02 |

タスク:

- [ ] Next.js プロジェクト初期化 (`apps/web/`)
- [ ] Firebase Auth UI (ログイン / サインアップ / ログアウト)
- [ ] 共通レイアウト (ナビゲーション、フッター)
- [ ] デザインシステム基盤 (色、タイポグラフィ、コンポーネント)
- [ ] 環境変数管理 (API URL, WebSocket URL)
- [ ] App Hosting 設定 (`apphosting.yaml`)

---

### PR-15: ロビー / マッチメイキング UI

**SPEC 参照**: §4.2, §5.1

| 項目 | 内容 |
|------|------|
| ゴール | マッチを作成・参加できる Web UI |
| ブランチ | `feat/lobby-ui` |
| 依存 PR | PR-14 |

タスク:

- [ ] ゲーム選択画面 (3 ゲーム一覧)
- [ ] マッチ作成フォーム (ゲーム選択、公開/非公開)
- [ ] マッチ参加 → Connect Token 表示 (コピー可)
- [ ] アクティブマッチ一覧 (Firestore onSnapshot)
- [ ] マッチ状態表示 (§4.2 の状態遷移に連動)
- [ ] エージェント管理画面 (AgentProfile CRUD)

---

### PR-16: 観戦 UI

**SPEC 参照**: §11

| 項目 | 内容 |
|------|------|
| ゴール | ライブ対戦をブラウザで観戦できる UI |
| ブランチ | `feat/spectator-ui` |
| 依存 PR | PR-13 |

タスク:

- [ ] 観戦ルーム画面 (`/matches/:matchId/watch`)
- [ ] 盤面ビジュアライゼーション (ゲームごとのレンダラー)
  - Prompt Injection Arena: チャットログ風 UI
  - Vector Grid Wars: グリッドボード
  - The Dilemma Poker: 交渉ログ + チップ表示
- [ ] 現在ターン、残り時間、選択アクション表示
- [ ] 勝率推移グラフ (推定)
- [ ] 公開マッチ一覧 → 観戦画面への導線

---

### PR-17: リプレイ再生 UI

**SPEC 参照**: §11

| 項目 | 内容 |
|------|------|
| ゴール | 過去の試合をリプレイ再生できる |
| ブランチ | `feat/replay-ui` |
| 依存 PR | PR-12 |

タスク:

- [ ] リプレイ再生画面 (`/matches/:matchId/replay`)
- [ ] 再生コントロール (再生、一時停止、早送り、巻き戻し)
- [ ] ターン単位でのステップ実行
- [ ] リプレイダウンロードボタン (JSONL)
- [ ] 対戦結果サマリー表示

---

### PR-18: リーダーボード UI

**SPEC 参照**: §4.1 (Rating)

| 項目 | 内容 |
|------|------|
| ゴール | シーズン別ランキングを表示 |
| ブランチ | `feat/leaderboard-ui` |
| 依存 PR | PR-11 |

タスク:

- [ ] リーダーボード画面 (`/leaderboard`)
- [ ] シーズン切り替え
- [ ] ゲーム別フィルタ
- [ ] ユーザープロフィールへのリンク
- [ ] 自分のランキング位置ハイライト

---

### PR-21: 監視 / アラート / SLO

**SPEC 参照**: §12

| 項目 | 内容 |
|------|------|
| ゴール | Cloud Monitoring で SLO を計測しアラートが機能する |
| ブランチ | `feat/monitoring` |
| 依存 PR | PR-12 |

タスク:

- [ ] Cloud Monitoring ダッシュボード構築
  - マッチ開始成功率
  - 異常終了率
  - ターン処理 p95
  - 観戦イベント遅延 p95
- [ ] アラートポリシー設定 (§12.2)
  - WebSocket 切断率急増
  - ターンタイムアウト率急増
  - 判定 API エラー率上昇
  - Redis メモリ使用量 80% 超過
- [ ] 構造化ログに分散トレーシングフィールド (`traceId`) を追加
- [ ] Error Reporting 設定

---

### PR-22: CI/CD パイプライン

**SPEC 参照**: §14 Phase 1

| 項目 | 内容 |
|------|------|
| ゴール | main マージで dev 環境に自動デプロイ |
| ブランチ | `feat/cicd` |
| 依存 PR | PR-21 |

タスク:

- [ ] GitHub Actions → Cloud Build 連携
- [ ] Cloud Run デプロイ (Gateway / Engine)
  - `min-instances`, `max-instances` 設定 (§12.3)
  - `DRAINING` メッセージ対応 (§3.7)
- [ ] App Hosting デプロイ (Web)
- [ ] 環境分離 (dev / staging / prod)
- [ ] Firestore ルール / インデックスの自動デプロイ
- [ ] Rollback 手順の整備

---

### PR-23: 負荷テスト / Phase 1 検証

**SPEC 参照**: §12.1, §15, §15.1

| 項目 | 内容 |
|------|------|
| ゴール | 100 同時マッチで SLO を満たすことを検証 |
| ブランチ | `feat/load-test` |
| 依存 PR | PR-22 |

タスク:

- [ ] k6 / Locust による負荷テストスクリプト
  - 100 同時マッチのシミュレーション
  - WebSocket 接続/再接続の負荷
- [ ] SLO 達成状況の計測と記録
  - マッチ開始成功率 ≥ 99.5%
  - 異常終了率 < 1%
  - ターン処理 p95 < 2.5 秒
  - 観戦遅延 p95 < 500ms
- [ ] ボトルネック特定と改善提案
- [ ] テスト結果レポート

**✅ Phase 1 機能マイルストーン: この PR のマージで 3 ゲーム MVP 機能が出揃う**  
**ℹ️ Phase 1 完了条件: PR-24 (不正対策) と PR-25 (セキュリティ Hardening) まで完了**

---

### PR-24: 不正対策 / レート制限

**SPEC 参照**: §9

| 項目 | 内容 |
|------|------|
| ゴール | 不正行為を検出・抑止する仕組みの実装 |
| ブランチ | `feat/anti-cheat` |
| 依存 PR | PR-07 |

タスク:

- [ ] アクション投稿のレート制限 (`20 req / 10 sec / match`) (§9)
- [ ] 異常レスポンスタイム検出 (< 100ms 連続) (§9)
- [ ] 自己対戦防止 (同一アカウント / 同一 IP 検出) (§9)
- [ ] Event hash によるリプレイ改ざん検出 (§9)
- [ ] 疑義試合フラグ + 管理者向け再検証 UI
- [ ] ユニットテスト / 統合テスト

---

### PR-25: セキュリティレビュー / Hardening

**SPEC 参照**: §8, §15

| 項目 | 内容 |
|------|------|
| ゴール | セキュリティレビューで Critical/High 0 件 |
| ブランチ | `feat/security-hardening` |
| 依存 PR | PR-16, PR-23, PR-24 |

タスク:

- [ ] Firestore セキュリティルール最終レビュー (§8.2)
- [ ] ログマスク処理の網羅性確認 (§8.3)
- [ ] CORS 設定の最終確認 (§3.5)
- [ ] 依存パッケージの脆弱性スキャン (`npm audit`)
- [ ] Penetration Test (手動 or 自動)
- [ ] セキュリティレビュー結果ドキュメント

---

## Phase 2 — Public Beta (将来)

> Phase 2 の詳細計画は Phase 1 完了後に策定する。

- PR-26: シーズン運用 (自動開始 / 終了 / アーカイブ)
- PR-27: 通報・モデレーション機能
- PR-28: コミュニティゲーム投稿フロー (審査付きデプロイ)
- PR-29: 多言語 (i18n) 対応
- PR-30: Premium 課金 (Stripe 連携)
- PR-31: FCM Push 通知

---

## PR 一覧サマリー

| PR | タイトル | Phase | 依存 | 推定規模 |
|----|---------|-------|------|---------|
| 01 | リポジトリ初期化 | 0 | — | S |
| 02 | Firebase / GCP 基盤 | 0 | 01 | M |
| 03 | ドメインモデル | 0 | 02 | M |
| 04 | 認証 / Connect Token | 0 | 02 | M |
| 05 | Gateway 基盤 | 0 | 03, 04 | L |
| 06 | Engine 基盤 | 0 | 03 | L |
| 07 | WebSocket / MCP 接続 | 0 | 05, 06 | L |
| 08 | Prompt Injection Arena | 0 | 07 | M |
| 09 | Vector Grid Wars | 1 | 07 | M |
| 10 | The Dilemma Poker | 1 | 07 | M |
| 11 | レーティング / リーダーボード | 1 | 03 | M |
| 12 | リプレイ記録 / エクスポート | 1 | 08-10 | M |
| 13 | 観戦 WebSocket 配信 | 1 | 05 | M |
| 14 | Next.js フロント基盤 | 1 | 02 | M |
| 15 | ロビー / マッチメイキング UI | 1 | 14 | M |
| 16 | 観戦 UI | 1 | 13 | L |
| 17 | リプレイ再生 UI | 1 | 12 | M |
| 18 | リーダーボード UI | 1 | 11 | S |
| 19 | Agent CLI / SDK | 0 | 07 | M |
| 20 | E2E テスト / Phase 0 検証 | 0 | 08, 19 | M |
| 21 | 監視 / アラート / SLO | 1 | 12 | M |
| 22 | CI/CD パイプライン | 1 | 21 | M |
| 23 | 負荷テスト / Phase 1 検証 | 1 | 22 | M |
| 24 | 不正対策 / レート制限 | 1 | 07 | M |
| 25 | セキュリティレビュー | 1 | 16, 23, 24 | S |

推定規模: **S** (〜200 行), **M** (200〜500 行), **L** (500〜800 行)
