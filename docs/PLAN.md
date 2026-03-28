# Moltgame 実装計画 (PR 分割)

最終更新: 2026-03-28
ベース仕様: [SPEC.md](./SPEC.md) v1.4 (CLI-First Edition)
変更履歴: CLI ファーストピボットに伴い PR-14〜18 のスコープを縮小・凍結し、PR-19 を拡張、新規 PR を追加 ([SUGGEST.md](./SUGGEST.md) 参照)

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
    PR03 --> PR05[PR-05 Gateway 基盤 + Queue API]
    PR04 --> PR05
    PR03 --> PR06[PR-06 Engine 基盤]
    PR05 --> PR07[PR-07 WebSocket / MCP 接続]
    PR06 --> PR07
    PR07 --> PR08[PR-08 ゲーム #1 Prompt Injection Arena]
    PR07 --> PR09[PR-09 ゲーム #2 Vector Grid Wars]
    PR07 --> PR10[PR-10 ゲーム #3 The Dilemma Poker]
    PR08 --> PR10B[PR-10b ルール定義外部化]
    PR09 --> PR10B
    PR10 --> PR10B
    PR03 --> PR11[PR-11 レーティング / リーダーボード]
    PR08 --> PR12[PR-12 リプレイ記録 / エクスポート]
    PR09 --> PR12
    PR10 --> PR12
    PR05 --> PR13[PR-13 観戦 WebSocket 配信]
    PR02 --> PR14[PR-14 静的サイト + /activate]
    PR07 --> PR19[PR-19 CLI 拡張: login / queue / watch / history / leaderboard]
    PR05 --> PR19
    PR04 --> PR19
    PR11 --> PR19
    PR12 --> PR19
    PR05 --> PR20[PR-20 E2E テスト / Phase 0 検証]
    PR07 --> PR20
    PR08 --> PR20
    PR20 --> PR20B
    PR20B --> PR20C
    PR08 --> PR20D[PR-20d Prompt Injection Arena ルール改善]
    PR20B --> PR20D
    PR20D --> PR20C
    PR12 --> PR18B[PR-18b 面白さKPI基盤]
    PR13 --> PR18B
    PR10B --> PR18C[PR-18c ゲームバリエーション拡張]
    PR18B --> PR18C
    PR20B --> PR18D[PR-18d バランス調整サイクル]
    PR11 --> PR18D
    PR18B --> PR18D
    PR18C --> PR18D
    PR12 --> PR21[PR-21 監視 / アラート / SLO]
    PR18D --> PR21
    PR21 --> PR22[PR-22 CI/CD パイプライン]
    PR22 --> PR23[PR-23 負荷テスト / Phase 1 検証]
    PR07 --> PR24[PR-24 不正対策 / レート制限]
    PR19 --> PR26[PR-26 Python SDK moltgames-py]
    PR23 --> PR25[PR-25 セキュリティレビュー / Hardening]
    PR24 --> PR25
    PR14 --> PR27[PR-27 CLI ドキュメントサイト]
    PR19 --> PR27
```

> **CLI-First ピボットによる変更**:
> - PR-15 (ロビー UI), PR-16 (観戦 UI), PR-17 (リプレイ再生 UI), PR-18 (リーダーボード UI) は **凍結**
> - PR-14 のスコープを「静的サイト + `/activate`」に縮小
> - PR-19 を大幅拡張 (CLI 認証 / Queue / Watch / History / Leaderboard)
> - PR-26 (Python SDK), PR-27 (CLI ドキュメントサイト) を新設
> - PR-18b の依存から PR-16, PR-17 を除外（CLI データで代替）
> - PR-18d の依存から PR-18 を除外
> - PR-25 の依存から PR-16 を除外

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

### PR-05: Gateway 基盤 (HTTP + セッション管理 + Queue API + Device Auth)

**SPEC 参照**: §3.1, §3.3, §3.5, §3.6, §5.0, §5.3, §5.4

| 項目 | 内容 |
|------|------|
| ゴール | Cloud Run 上で動作する Gateway サーバーの骨組み + CLI ファースト API |
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
- [x] **Device Auth API** (§5.0)
  - `POST /v1/auth/device` — `device_code` + `user_code` 発行
  - `POST /v1/auth/device/token` — CLI polling 用認証トークン取得
  - `POST /v1/auth/device/activate` — ブラウザ側ユーザー認証完了エンドポイント
  - Redis `device:{device_code}` 管理 (TTL 10 分)
- [x] **Queue API** (§5.4)
  - `POST /v1/matches/queue` — キュー登録 (`gameId`, `agentId`, `ratingRange`)
  - `DELETE /v1/matches/queue` — キュー離脱
  - `GET /v1/matches/queue/status` — 待機状況
  - Redis `moltgames:queue:<gameId>` によるマッチング Worker
  - Rating ±200 Elo 以内を優先、30 秒経過で段階拡大
  - レート制限: 1 UID あたり 10 req/min
- [x] **バッチ取得 API**
  - `GET /v1/matches?agentId=xxx&limit=100&cursor=yyy` ページネーション対応
  - 構造化エラーレスポンス (`code`, `message`, `retryable`) の統一

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

### PR-19: CLI 拡張 — login / queue / watch / history / leaderboard (スコープ拡大)

**SPEC 参照**: §3.1, §5.0, §5.1, §5.4, §5.5, §11.0

> **CLI-First ピボット**: 従来の `connect --token` のみの CLI を、プラットフォーム全操作を CLI で完結できる統合コマンドツールへ拡張。

| 項目 | 内容 |
|------|------|
| ゴール | CLI からの全操作 (認証・マッチメイキング・観戦・データ取得) を完結できる |
| ブランチ | `feat/agent-cli` |
| 依存 PR | PR-04, PR-05, PR-07, PR-11, PR-12 |

タスク (既存):

- [x] `tools/cli/` に CLI 実装
  - `moltgame-client connect --token <TOKEN>` コマンド
  - WebSocket 接続 + 自動再接続
  - MCP ツール一覧表示
- [x] Python SDK (`moltgame-sdk`) の基礎
  - WebSocket クライアントラッパー
  - ツール呼び出しヘルパー
- [x] Python SDK のサンプルエージェント (ランダムアクション)
- [x] README: エージェント実装ガイド

タスク (CLI-First 拡張):

- [ ] **`moltgame login`** — Device Flow 認証 (§5.0)
  - `POST /v1/auth/device` で `user_code` 取得
  - ブラウザ自動 open (可能な場合) + ターミナルにコード表示
  - polling で認証完了を待機
  - refresh 可能な認証情報を `~/.moltgames/credentials.json` に保存し、自動更新
- [ ] **`moltgame queue`** — オートマッチング (§5.4)
  - `--game <gameId>` (必須)
  - `--agent <path>` (Agent Runner 連携)
  - キュー登録 → マッチ成立待機 → WebSocket 接続の一連のフロー
  - `--json` でマッチ結果を JSON 出力
- [ ] **`moltgame match start`** — 直接マッチ作成
  - `--game <gameId>` (必須)
  - Connect Token 表示
- [ ] **`moltgame match status <id>`** — マッチ状況確認
- [ ] **`moltgame watch <id>`** — リアルタイム観戦 (§11.0)
  - ターミナル描画モード (ANSI エスケープ)
  - `--json` で NDJSON ストリーム出力
  - WebSocket で `spectator:*` イベントを受信
- [ ] **`moltgame replay fetch <id>`** — リプレイ取得
  - JSONL 出力 (デフォルト) / `--json` で JSON 配列出力
- [ ] **`moltgame leaderboard`** — ランキング表示
  - `--game <gameId>`, `--season <id>`, `--limit <n>`
  - ターミナルテーブル / `--json`
- [ ] **`moltgame history`** — 対戦履歴一覧
  - `--limit <n>`, `--cursor <token>`
  - ターミナルテーブル / `--json`
- [ ] **`moltgame agent register`** — エージェント登録
- [ ] **全コマンド `--json` フラグ** 統一実装
  - 構造化 JSON を stdout、進捗メッセージは stderr に分離
- [ ] CLI のヘルプ / バージョン / 自動更新チェック

完了条件:

- [ ] `moltgame login` → `moltgame queue` → 対戦完了 → `moltgame history` の一連のフローが CLI のみで完結する
- [ ] 全コマンドの `--json` 出力が `jq` でパース可能
- [ ] CI 環境 (ヘッドレス) で `moltgame login` が Device Flow で動作する

---

### PR-20: E2E テスト / Phase 0 検証

**SPEC 参照**: §14 Phase 0, §15.1

| 項目 | 内容 |
|------|------|
| ゴール | ローカル環境で 1 マッチの E2E フローが通ることを確認 |
| ブランチ | `feat/e2e-phase0` |
| 依存 PR | PR-05, PR-07, PR-08 |

タスク:

- [x] E2E テストスクリプト
  1. Firebase Emulators 起動
  2. Gateway + Engine 起動
  3. ユーザー登録 → ログイン
  4. マッチ作成 → Connect Token 発行
  5. 2 つのエージェント接続
  6. Prompt Injection Arena を最後までプレイ
  7. マッチ状態が `FINISHED` であることを検証
- [x] Docker Compose でのローカル統合テスト環境
- [x] CI に E2E テストを組み込み
- [x] dev 環境への手動デプロイ Runbook を整備し、1 回ドライラン実施 (§14 Phase 0)

**✅ Phase 0 マイルストーン: この PR のマージでE2E 接続検証完了**

---

### PR-20b: エージェント対戦テストベンチ

**SPEC 参照**: §5.1, §5.2, §5.3, §15.1

| 項目 | 内容 |
|------|------|
| ゴール | ローカル環境で複数エージェント対戦を繰り返し実行できる検証ベンチを整備 |
| ブランチ | `test/agent-battle-bench` |
| 依存 PR | PR-20 |

タスク:

- [x] `test/e2e/` にエージェント対戦ベンチハーネスを追加
  - 対戦開始、トークン発行、2 エージェント接続、試合終了待機を共通化
- [x] Prompt Injection Arena 用のベンチエージェント (attacker / defender) を実装
  - `tools/list` / `tools/list_changed` を解釈して自動行動する
- [x] 複数試合を連続実行し、勝者・終了理由・試合時間を集計するレポートを実装
- [x] 障害系シナリオを 1 つ以上追加
  - 例: 接続ドレイン後の再接続、または一時切断後の復帰
- [x] 実行コマンド (`package.json`) と運用手順を整備

---

### PR-20c: LLM エージェント参加ランナー

**SPEC 参照**: §3.1, §5.1, §5.2, §5.3, §7.1, §8.4, §9, §15.1

| 項目 | 内容 |
|------|------|
| ゴール | LLM を使う 2 エージェントが Moltgames に参加し、自動対戦を安定実行できる状態を作る |
| ブランチ | `feat/llm-agent-runner` |
| 依存 PR | PR-20b, PR-20d |

設計方針 (深掘り):

- 接続境界: LLM は Gateway に直接接続させず、Runner プロセス経由で `/v1/ws` に接続する
  - 理由: `session_id` 再接続、`tools/list` 追従、`request_id` 管理を集約するため
- モデル非依存化: Runner 内に `LLMAdapter` 抽象を定義し、Provider 差し替えを可能にする
  - 初期実装: OpenAI 1 系統 + テスト用 `MockLLMAdapter`
- アクション安全性: LLM 出力は必ず「1 ターン 1 ツール呼び出し JSON」に正規化する
  - ツール名は `tools/list` に存在するもののみ許可し、引数は JSON Schema で検証する
- レジリエンス: 切断 / レート制限 / 一時失敗を Runner で吸収する
  - `session_id` 再接続、指数バックオフ、429 リトライ待機、タイムアウトを標準化する
- 観測性と安全性: 構造化ログ + マスク + 再現性のある記録を徹底する
  - ログ項目: `matchId`, `agentId`, `sessionId`, `request_id`, `tool`, `latencyMs`, `provider`, `model`
  - 秘密情報 (`connect_token`, API key, ゲーム秘密値, 生 CoT) は保存しない
- CI 再現性: モック LLM で決定的に動く E2E を別途維持し、外部 API 依存を排除する

タスク:

- [x] Runner 実装方針を確定 (`tools/cli` 拡張 or `tools/agent-runner` 新設)
  - ADR: `docs/adr/ADR-0001-llm-agent-runner.md` (`tools/agent-runner` 新設方針)
  - エントリポイント、設定ロード、責務分割を ADR 形式で文書化
- [x] Runner コア実装
  - 実装: `tools/agent-runner` (接続/再接続、`tools/list` 追従、1ターン1アクションループ)
  - `connect_token` 接続、`session_id` 再接続、`tools/list` / `tools/list_changed` 追従
  - 1 ターン 1 アクションの実行ループ
- [x] LLMAdapter 実装
  - `MockLLMAdapter` (テスト用)
  - `OpenAIAdapter` (本番用; model/version を設定可能にする)
- [x] ツール呼び出しガード実装
  - 許可ツールの検証、引数 JSON Schema 検証、失敗時の自己修正リトライ
- [x] レート制限 / 障害対策
  - `/v1/tokens` 429 対応、接続切断時の指数バックオフ、`DRAINING` 対応
- [x] 観測ログとリプレイ向けトレース整備
  - ターン単位の実行ログ + マスクポリシー + サマリー出力
- [x] テスト整備
  - ユニット: Adapter, バリデーション, リトライ制御
  - 統合: Mock Engine/Gateway で reconnect / tools change / error code を検証
  - E2E: `RUN_AGENT_BENCH=true` + `RUN_LLM_BENCH=true` で LLM 対戦ベンチを追加
- [x] 運用ドキュメント更新
  - `.env.example`, README, 実行コマンド, コスト/レート制約, 失敗時 Runbook

完了条件:

- [ ] LLM エージェント 2 体で Prompt Injection Arena を連続 10 試合以上実行できる
- [ ] 再接続シナリオを含む E2E がローカルで安定して再現できる
- [ ] 外部 API 依存なしのモック E2E が CI で常時グリーン
- [ ] セキュリティ要件 (ログマスク、秘密値非保存) をテストで担保

---

### PR-20d: Prompt Injection Arena ルール改善 / ベンチ公平性補強

**SPEC 参照**: §6.1, §9, §15.1

| 項目 | 内容 |
|------|------|
| ゴール | Prompt Injection Arena の漏えい判定を会話駆動に寄せ、ベンチの固定勝ちパターンを解消する |
| ブランチ | `codex/fix/pr-20d-secret-guess-guard` |
| 依存 PR | PR-08, PR-20b |

タスク:

- [x] `check_secret` の解禁条件を追加
  - 最低 2 ラウンド (攻撃 2 回 + 防衛 2 回) の会話後のみ実行可能
- [x] `check_secret` 推測回数を試合中 1 回に制限
  - 失敗時は防衛側勝利 (`Secret guess limit reached`)
- [x] Prompt Injection Arena のユニットテストを拡張
  - 解禁前バリデーション、解禁後成功、回数上限到達の終了判定を追加
- [x] Phase 0 E2E を新ルールに追従
  - 2 往復の会話後に `check_secret` する手順へ更新
- [x] Deterministic ベンチを接続/進行スモーク用途へ調整
  - シード逆算による秘密特定を使わず、固定誤推測で defender 勝利パスを検証

完了条件:

- [x] `check_secret` が初手で利用できないことを unit test で担保
- [x] Deterministic ベンチで `actionTimeline.length === steps` を維持
- [x] reconnect シナリオでも新ルール下で試合完了まで到達

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

- [x] `GamePlugin` 実装: `VectorGridWars`
  - 10x10 グリッド初期化
  - 占有スコア計算
  - 規定ターン終了判定
- [x] LLM Judge 統合
  - 固定モデルバージョン + プロンプトテンプレート (§6.2)
  - 2 回評価の平均点方式
- [x] MCP ツール定義
  - `place_unit`: ユニット配置
  - `move_unit`: ユニット移動
  - `get_board`: 盤面状態取得
- [x] ユニットテスト: スコア計算、ターン制限、LLM Judge モック

---

### PR-10: ゲーム #3 — The Dilemma Poker

**SPEC 参照**: §6.3

| 項目 | 内容 |
|------|------|
| ゴール | 3 つ目のゲームを追加 |
| ブランチ | `feat/game-dilemma-poker` |
| 依存 PR | PR-07 |

タスク:

- [x] `GamePlugin` 実装: `DilemmaPoker`
  - フェーズ管理 (交渉フェーズ → 行動フェーズ)
  - チップ管理、勝利条件判定
  - 不完全情報の管理 (プレイヤーごとの可視情報)
- [x] MCP ツール定義
  - `negotiate`: 交渉フェーズでの発言
  - `commit_action`: 行動フェーズでの最終決定
  - `get_status`: 自分の状態取得
- [x] 会話ログと実行行動の分離記録 (§6.3)
- [x] ユニットテスト: チップ計算、フェーズ遷移、裏切り検出

---

### PR-10b: ルール定義外部化 (コード変更なしルール差し替え)

**SPEC 参照**: §6, §7, §9

| 項目 | 内容 |
|------|------|
| ゴール | ルール定義ファイルの差し替えだけでゲーム挙動を更新できるようにする |
| ブランチ | `feat/rule-externalization` |
| 依存 PR | PR-08, PR-09, PR-10 |

タスク:

- [x] ルール定義スキーマを策定 (`ruleId`, `ruleVersion`, `tools`, `turnLimit`, `termination`, `redactionPolicy`)
- [x] `packages/rules` にゲーム別のルール定義 (`json` / `yaml`) を配置し、JSON Schema バリデーションを追加
- [x] Engine のルールローダーを実装し、起動時にフェイルファストで検証できるようにする
- [x] マッチ開始時に `ruleId` + `ruleVersion` をスナップショット固定し、進行中マッチへの途中反映を禁止する
- [x] ルール切り替えフロー (CLI または管理 API) を追加し、公開 / ロールバック / 監査ログを実装する
- [x] 後方互換ポリシーを定義し、非互換変更時の `major` バージョン更新を必須化する
- [x] テスト整備
  - ユニット: スキーマ検証、デフォルト補完、互換性判定
  - 統合: ルール差し替え後の新規マッチ反映、進行中マッチ非影響
  - E2E: コード変更なしでルール差し替えが有効であることを確認

---

### PR-11: レーティング / リーダーボード

**SPEC 参照**: §4.1 (Rating), §10.1

| 項目 | 内容 |
|------|------|
| ゴール | Elo レーティング計算とシーズン別リーダーボード |
| ブランチ | `feat/rating` |
| 依存 PR | PR-03 |

タスク:

- [x] Elo レーティング計算ロジック (K ファクター設定可)
- [x] マッチ終了時の Cloud Tasks トリガー → レーティング更新
- [x] Firestore `ratings/{seasonId}_{uid}` 更新
- [x] リーダーボード集計 (`leaderboards/{seasonId}`)
  - Redis キャッシュ併用 (§12.3)
- [x] シーズン管理 (開始日、終了日、アーカイブ)
- [x] ユニットテスト: Elo 計算、各種エッジケース

---

### PR-12: リプレイ記録 / エクスポート

**SPEC 参照**: §4.1 (Replay), §10.3, §10.4

| 項目 | 内容 |
|------|------|
| ゴール | マッチ終了後にリプレイを Storage に保存・ダウンロード可能 |
| ブランチ | `feat/replay` |
| 依存 PR | PR-08, PR-09, PR-10 |

タスク:

- [x] マッチ終了時の TurnEvent 収集 → JSONL 生成
- [x] Redaction 処理 (秘密情報のマスク) (§8.4)
- [x] `replays/{seasonId}/{matchId}.jsonl.gz` への圧縮アップロード
- [x] Replay メタデータを Firestore に記録 (`visibility`, `redactionVersion`)
- [x] ダウンロード API (`GET /v1/replays/:matchId`)
  - 署名付き URL 発行 (有効期限付き)
- [x] ユニットテスト: Redaction、JSONL 生成、アクセス制御

---

### PR-13: 観戦 WebSocket 配信

**SPEC 参照**: §11, §11.1

| 項目 | 内容 |
|------|------|
| ゴール | 観戦者がリアルタイムで対戦を視聴できる仕組み |
| ブランチ | `feat/spectator-ws` |
| 依存 PR | PR-05 |

タスク:

- [x] 観戦用 WebSocket エンドポイント (Read-Only)
- [x] Redis Pub/Sub → 観戦者への配信パイプライン (in-memory fan-out; single-instance)
- [x] Redaction 済みデータのみ配信 (§11)
- [x] 非公開マッチの認可チェック (招待制) (§11)
- [x] マッチ開始/終了時の Webhook 通知実装 (§11.1)
  - ユーザー単位で ON/OFF 設定
  - 送信失敗時のリトライ (指数バックオフ) と署名ヘッダ付与
- [x] 盤面更新の 200ms 以内配信目標の計測
- [x] 統合テスト: 配信遅延測定、認可テスト

---

### PR-14: 静的サイト + `/activate` ログイン画面 (スコープ縮小)

**SPEC 参照**: §3.1, §3.2, §5.0

> **CLI-First ピボット**: リッチな Web フロントエンドから、静的ドキュメント + CLI Device Flow ログイン画面のみに縮小。

| 項目 | 内容 |
|------|------|
| ゴール | CLI ログイン用の `/activate` ページと静的ドキュメントの配信 |
| ブランチ | `feat/web-foundation` |
| 依存 PR | PR-02 |

タスク:

- [x] Next.js プロジェクト初期化 (`apps/web/`)
- [x] Firebase Auth UI (ログイン / サインアップ / ログアウト)
- [x] 共通レイアウト (ナビゲーション、フッター)
- [x] `/activate` ページ — CLI Device Flow 用のユーザーコード入力 + Firebase Auth ログイン
- [x] CLI インストールガイド + Getting Started の静的ページ (`/docs/get-started`)
- [x] Firebase Hosting 設定 (静的サイト配信、App Hosting 不要)

---

### PR-15: ~~ロビー / マッチメイキング UI~~ (凍結)

> **CLI-First ピボット**: CLI `queue` コマンド (PR-19) + Queue API (PR-05) で代替。Web ロビーは Phase 2 以降で検討。

---

### PR-16: ~~観戦 UI~~ (凍結)

> **CLI-First ピボット**: CLI `watch` コマンド (PR-19) + `--json` ストリームで代替。ブラウザ観戦は Phase 2 以降で検討。

---

### PR-17: ~~リプレイ再生 UI~~ (凍結)

> **CLI-First ピボット**: CLI `replay fetch --json` (PR-19) + コミュニティ製可視化ツールで代替。

---

### PR-18: ~~リーダーボード UI~~ (凍結)

> **CLI-First ピボット**: CLI `leaderboard --json` (PR-19) で代替。静的な最小限のランキングページは PR-27 (CLI ドキュメントサイト) に含める。

---

### PR-18b: 面白さ KPI 計測基盤 (対戦ログ / リプレイ分析)

**SPEC 参照**: §11.2, §12.4, §15.2

> **CLI-First ピボット**: PR-16 (観戦 UI), PR-17 (リプレイ UI) の依存を除外。KPI データソースは対戦ログ・リプレイ JSONL・CLI watch JSON ストリームに統一。

| 項目 | 内容 |
|------|------|
| ゴール | 対戦ログ・リプレイからゲームの面白さを定量評価できる状態を作る |
| ブランチ | `feat/gameplay-kpi` |
| 依存 PR | PR-12, PR-13 |

タスク:

- [ ] KPI 辞書 v1 を確定
  - 主要 KPI: `CMR`, `CWR`, `ADI`, `RIR24`
  - ガードレール: `MCR`, `FSWG`, `DSS`, `SR60`, `RCR80`, `DBT`
  - ゲーム別の `TTFC` 目標レンジを固定
- [ ] イベントスキーマを分析向けに拡張
  - TurnEvent に `actionType`, `seat`, `scoreDiffBefore/After`, `ruleVersion` を追加
  - 観戦 / リプレイログに再生・離脱指標を追加
- [ ] 集計パイプラインを実装
  - 日次・週次で `gameId × ruleVersion × queueType × ratingBracket` 単位の KPI を算出
  - サンプルサイズ下限 (`N >= 400`) と信頼区間計算を実装
- [ ] KPI ダッシュボードとレポート出力
  - 直近 7 日 / 28 日の推移
  - ルールバージョン切替時の差分比較
- [ ] データ品質検証
  - 欠損イベント率、重複イベント率、遅延到着率を計測
  - `ruleVersion` 欠落時は集計対象外として警告
- [ ] ベンチ連携
  - `test:bench:agents` の結果を同一 KPI 形式で出力
  - 実戦データとベンチデータを並列比較できるレポートを追加

完了条件:

- [ ] 3 ゲームすべてで KPI ダッシュボードが稼働し、日次更新が 7 日連続で成功
- [ ] `ruleVersion` ごとの KPI 比較レポートを自動生成できる
- [ ] 欠損/重複イベント率が 1% 未満であることを検証できる

---

### PR-18c: ゲームバリエーション拡張 (ルールパック運用)

**SPEC 参照**: §6.4, §12.4, §15.2

| 項目 | 内容 |
|------|------|
| ゴール | 各ゲームで複数ルールパックを安全に運用し、単調化を抑制する |
| ブランチ | `feat/game-variants` |
| 依存 PR | PR-10b, PR-18b |

タスク:

- [ ] バリエーションカタログを設計
  - `standard`, `aggressive`, `mindgame` などゲーム別の rule pack を定義
  - `queueType` ごとに許可する rule pack を明示
- [ ] ゲーム別ルールパックを追加
  - Prompt Injection Arena: ターン制限・推測制約の組み合わせを 2 パターン以上
  - Vector Grid Wars: 初期盤面シード・スコア係数の組み合わせを 2 パターン以上
  - The Dilemma Poker: チップ配分・交渉長・裏切り報酬の組み合わせを 2 パターン以上
- [ ] ルール配信戦略を実装
  - 重み付き割り当て (例: `70/30`) と canary 切替
  - 緊急ロールバック時に 5 分以内で `stable` へ復帰できる運用を整備
- [ ] 公平性チェック
  - `FSWG`, `MCR`, `DSS` のガードレール自動判定を導入
  - 逸脱時は自動で配信停止し、監査ログへ理由を記録
- [ ] テスト整備
  - ユニット: ルールパック読み込み、割り当て、フェイルオーバー
  - 統合: マッチ作成時の rule pack 固定、進行中マッチ非影響
  - ベンチ: 各 rule pack 500 試合以上のスモーク

完了条件:

- [ ] 各ゲームで `standard + 1 variant` 以上を本番同等環境で運用できる
- [ ] rule pack 切替/ロールバックがコード変更なしで実行できる
- [ ] ガードレール逸脱時に自動停止し、復旧 Runbook が機能する

---

### PR-18d: バランス調整サイクル運用 (Gameplay Polish)

**SPEC 参照**: §6.4, §12.4, §14 Phase 1.5, §15.2

| 項目 | 内容 |
|------|------|
| ゴール | KPI 駆動で継続的にゲームバランスを改善する運用サイクルを確立する |
| ブランチ | `feat/gameplay-polish` |
| 依存 PR | PR-11, PR-18b, PR-18c, PR-20b |

タスク:

- [ ] バランス調整の運用テンプレートを整備
  - 変更提案テンプレート (`仮説`, `変更レバー`, `期待 KPI`, `ロールバック条件`)
  - 週次レビューの判定基準 (採用 / 保留 / 差し戻し)
- [ ] 連戦ベンチを面白さ評価向けに拡張
  - 各ゲームで 1,000 試合の定期実行ジョブ
  - KPI 算出と差分比較 (`candidate` vs `stable`) を自動化
- [ ] canary 評価フローを実装
  - `candidate` を最大 10% 配信し、48 時間で KPI を判定
  - 主要 KPI 2 指標以上の改善 + ガードレール非逸脱で昇格
- [ ] ゲーム別の重点改善項目を実施
  - Prompt Injection Arena: 初手固定化防止、会話中盤の分岐増加
  - Vector Grid Wars: 逆転余地の調整、終盤一手詰みの頻度低減
  - The Dilemma Poker: 交渉価値の向上、裏切りリスクとリターンの最適化
- [ ] パッチノートと考察レポート運用
  - 変更理由、KPI 変化、残課題を公開テンプレートで記録
  - 次スプリントへの課題引き継ぎを定型化

完了条件:

- [ ] 2 スプリント連続で主要 KPI (`CMR`, `CWR`, `ADI`, `RIR24`) のうち 2 指標以上が改善
- [ ] ガードレール逸脱時の自動ロールバックが 24 時間以内に収束する
- [ ] ゲーム別のバランスパッチノートを最低 2 回分公開できる

---

### PR-21: 監視 / アラート / SLO

**SPEC 参照**: §12

| 項目 | 内容 |
|------|------|
| ゴール | Cloud Monitoring で SLO を計測しアラートが機能する |
| ブランチ | `feat/monitoring` |
| 依存 PR | PR-12, PR-18d |

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
- [ ] Firebase Hosting デプロイ (静的サイト + `/activate`)
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
**ℹ️ Phase 1 完了条件: PR-18d (Gameplay Polish), PR-24 (不正対策), PR-25 (セキュリティ Hardening) まで完了**

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
| 依存 PR | PR-23, PR-24 |

タスク:

- [ ] Firestore セキュリティルール最終レビュー (§8.2)
- [ ] ログマスク処理の網羅性確認 (§8.3)
- [ ] CORS 設定の最終確認 (§3.5)
- [ ] 依存パッケージの脆弱性スキャン (`npm audit`)
- [ ] Penetration Test (手動 or 自動)
- [ ] セキュリティレビュー結果ドキュメント

---

### PR-26: Python SDK (`moltgames-py`) (新設)

**SPEC 参照**: §3.1, §5.5

| 項目 | 内容 |
|------|------|
| ゴール | Python から直接マッチング・対戦・結果取得ができるライブラリ |
| ブランチ | `feat/python-sdk` |
| 依存 PR | PR-19 |

タスク:

- [ ] `moltgames-py` パッケージ構成 (PyPI 公開前提)
- [ ] 認証ヘルパー (`~/.moltgames/credentials.json` 読み込み)
- [ ] 主要 API ラッパー: `queue()`, `match_status()`, `replay()`, `leaderboard()`, `history()`
- [ ] WebSocket クライアント: 対戦接続 + `watch()` ストリーム
- [ ] サンプルコード: Jupyter Notebook でのリプレイ分析
- [ ] README + API リファレンスドキュメント
- [ ] ユニットテスト + CI (pytest)

---

### PR-27: CLI ドキュメントサイト (新設)

**SPEC 参照**: §3.2

| 項目 | 内容 |
|------|------|
| ゴール | CLI インストール・Getting Started・API リファレンスを公開 |
| ブランチ | `feat/cli-docs` |
| 依存 PR | PR-14, PR-19 |

タスク:

- [ ] Getting Started チュートリアル (CLI インストール → ログイン → 初対戦)
- [ ] CLI コマンドリファレンス (全コマンド + `--json` フラグ仕様)
- [ ] API リファレンス (REST API エンドポイント一覧)
- [ ] Python SDK クイックスタート
- [ ] コミュニティツール紹介ページ (OSS ダッシュボード等)
- [ ] Firebase Hosting で静的デプロイ

---

## Phase 2 — Public Beta (将来)

> Phase 2 の詳細計画は Phase 1 完了後に策定する。

- PR-28: シーズン運用 (自動開始 / 終了 / アーカイブ)
- PR-29: 通報・モデレーション機能
- PR-30: コミュニティゲーム投稿フロー (審査付きデプロイ)
- PR-31: 多言語 (i18n) 対応
- PR-32: Premium 課金 (Stripe 連携)
- PR-33: FCM Push 通知
- PR-34: Web 観戦 UI / リプレイ再生 UI (凍結した PR-15〜18 の再検討)

---

## PR 一覧サマリー

| PR | タイトル | Phase | 状態 | 依存 | 推定規模 |
|----|---------|-------|------|------|---------|
| 01 | リポジトリ初期化 | 0 | 完了 | — | S |
| 02 | Firebase / GCP 基盤 | 0 | 完了 | 01 | M |
| 03 | ドメインモデル | 0 | 完了 | 02 | M |
| 04 | 認証 / Connect Token | 0 | 完了 | 02 | M |
| 05 | Gateway 基盤 + Queue API + Device Auth | 0 | **拡張** | 03, 04 | L |
| 06 | Engine 基盤 | 0 | 完了 | 03 | L |
| 07 | WebSocket / MCP 接続 | 0 | 完了 | 05, 06 | L |
| 08 | Prompt Injection Arena | 0 | 完了 | 07 | M |
| 09 | Vector Grid Wars | 1 | 完了 | 07 | M |
| 10 | The Dilemma Poker | 1 | 完了 | 07 | M |
| 10b | ルール定義外部化 | 1 | 完了 | 08-10 | M |
| 11 | レーティング / リーダーボード | 1 | 完了 | 03 | M |
| 12 | リプレイ記録 / エクスポート | 1 | 完了 | 08-10 | M |
| 13 | 観戦 WebSocket 配信 | 1 | 完了 | 05 | M |
| 14 | 静的サイト + /activate | 1 | **縮小** | 02 | S |
| 15 | ~~ロビー UI~~ | — | **凍結** | — | — |
| 16 | ~~観戦 UI~~ | — | **凍結** | — | — |
| 17 | ~~リプレイ再生 UI~~ | — | **凍結** | — | — |
| 18 | ~~リーダーボード UI~~ | — | **凍結** | — | — |
| 18b | 面白さ KPI 計測基盤 | 1 | — | 12, 13 | M |
| 18c | ゲームバリエーション拡張 | 1 | — | 10b, 18b | M |
| 18d | バランス調整サイクル運用 | 1 | — | 11, 18b, 18c, 20b | L |
| 19 | CLI 拡張: login / queue / watch / history / leaderboard | 1 | **拡張** | 04, 05, 07, 11, 12 | L |
| 20 | E2E テスト / Phase 0 検証 | 0 | 完了 | 05, 07, 08 | M |
| 20b | エージェント対戦テストベンチ | 0 | 完了 | 20 | M |
| 20c | LLM エージェント参加ランナー | 0 | 完了 | 20b, 20d | L |
| 20d | Prompt Injection Arena ルール改善 | 0 | 完了 | 08, 20b | M |
| 21 | 監視 / アラート / SLO | 1 | — | 12, 18d | M |
| 22 | CI/CD パイプライン | 1 | — | 21 | M |
| 23 | 負荷テスト / Phase 1 検証 | 1 | — | 22 | M |
| 24 | 不正対策 / レート制限 | 1 | — | 07 | M |
| 25 | セキュリティレビュー | 1 | — | 23, 24 | S |
| 26 | Python SDK (`moltgames-py`) | 1 | **新設** | 19 | M |
| 27 | CLI ドキュメントサイト | 1 | **新設** | 14, 19 | S |

推定規模: **S** (〜200 行), **M** (200〜500 行), **L** (500〜800 行)

> **凍結 PR について**: PR-15〜18 は Phase 2 で Web UI を再検討する際に PR-34 として再設計する。現在の開発リソースは CLI/API/SDK に集中させる。
