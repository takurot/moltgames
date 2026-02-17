# Moltgames 実装ルール (PROMPT)

最終更新: 2026-02-17
対象: `docs/SPEC.md` と `docs/PLAN.md` に基づく全実装タスク

## 1. 基本方針

- `SPEC` と `PLAN` を唯一の仕様ソースとし、矛盾があれば実装より先にドキュメントを更新する。
- 小さく安全に進める。1 タスク = 1 ブランチ = 1 PR を原則とする。
- すべての変更は再現可能であること (コマンド、テスト、ログで確認可能) を必須とする。
- main ブランチへの直接 push を禁止する。

## 2. ブランチ作成ルール

### 2.1 命名規約

- 形式: `codex/<type>/<ticket-or-pr>-<short-slug>`
- `type` は以下から選ぶ:
  - `feat` (機能追加)
  - `fix` (不具合修正)
  - `refactor` (リファクタ)
  - `test` (テスト強化)
  - `docs` (ドキュメント)
  - `chore` (ビルド/CI/運用)

例:

- `codex/feat/pr-07-websocket-mcp`
- `codex/fix/pr-04-token-expiry-bug`

### 2.2 運用ルール

- ブランチは必ず最新 `main` から作成する。
- 1 ブランチに複数 PR 相当の変更を混在させない。
- push 前に `rebase main` または `merge main` で追従し、CI の再実行を行う。
- マージ方式は `squash merge` を基本とする。

### 2.3 コミットメッセージ規約

[Conventional Commits](https://www.conventionalcommits.org/) に従う。

```
<type>(<scope>): <summary>

<body>

<footer>
```

- `type`: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`
- `scope`: 変更対象パッケージまたはサービス名 (`gateway`, `engine`, `web`, `domain`, `mcp-protocol`, `cli`)
- `summary`: 英語、命令形、小文字開始、末尾にピリオド不要
- `body`: 変更理由と背景 (任意)
- `footer`: `BREAKING CHANGE:` や `Refs: PR-XX` (任意)

例:

```
feat(engine): add turn timeout enforcement

Implement 30-second default turn timeout with per-game override.
Refs: PR-06, SPEC §5.3
```

## 3. モノレポ運用ルール

### 3.1 パッケージ間依存

- 内部パッケージの参照には `workspace:*` プロトコルを使用する。
- 循環依存を禁止する。依存方向は `domain` ← `mcp-protocol` ← `gateway` / `engine` を基本とする。
- `packages/` 配下の共有パッケージを変更した場合、依存先のテストも CI で実行する。

### 3.2 新規パッケージ追加時

- `packages/` または `apps/` に追加し、`pnpm-workspace.yaml` を更新する。
- `tsconfig.json` の `references` を更新する。
- CI ワークフローに対象パッケージを追加する。

### 3.3 外部依存の管理

- 新規パッケージ追加時は PR 本文に**追加理由**と**ライセンス**を明記する。
- `pnpm audit` で High/Critical が 0 であることを確認してからマージする。
- `pnpm-lock.yaml` の変更が意図的であることを PR でレビューする。
- pinned version (`=x.y.z`) は原則使わず、`^x.y.z` で管理する。

## 4. 実装プロセス (TDD 必須)

全タスクで TDD を適用する。

1. Red: 先に失敗するテストを書く。
2. Green: テストを通す最小限の実装を行う。
3. Refactor: 重複除去、命名改善、責務分離を行い、テストを再実行する。

補足ルール:

- バグ修正は「再現テスト」を先に追加してから修正する。
- 仕様変更時はテストを仕様に合わせて更新し、理由を PR に記載する。

### 4.1 TDD 適用外

以下のタスクは TDD を必須としないが、変更後の動作確認は必須とする。

- インフラ/IaC (Terraform, `cloudbuild.yaml`)
- CI/CD ワークフロー (`.github/workflows/`)
- ドキュメント変更
- 設定ファイルのみの変更 (`firebase.json`, `apphosting.yaml`)

## 5. コーディング/シンタックス標準

### 5.1 TypeScript/Node 標準

- TypeScript は `strict: true` を必須。
- `any` の新規導入を禁止。やむを得ない場合は理由コメントと期限付き TODO を残す。
- `@ts-ignore` を禁止。必要なら `@ts-expect-error` と理由を明記する。
- 非同期処理は `async/await` を標準とし、未処理 Promise を禁止。
- 公開 API/イベント payload は JSON Schema で明示し、ランタイムバリデーションを行う。

### 5.2 命名と設計

- 変数・関数は意図が分かる名前を使う。
- 1 関数 1 責務を徹底し、長大関数を避ける。
- ドメインロジックは I/O から分離し、ユニットテスト可能にする。

### 5.3 エラーハンドリング

- 例外は握りつぶさない。必ずハンドリングまたは再送出する。
- API/WS のエラーは `SPEC §7.1` で定義したエラーコードに正規化する。
- ログには `matchId`, `uid`, `traceId`, `severity` を含める。

### 5.4 ログとマスク

- ログ出力は構造化 JSON 形式 (Cloud Logging 準拠) とする。
- 以下のパターンは出力前に自動マスクする:
  - API キー (`sk-*`, `AIza*` など)
  - メールアドレス、電話番号
  - Connect Token の値
  - ゲーム内秘密情報 (Prompt Injection Arena の秘密文字列など)
- 生の Chain-of-Thought は保存しない。もし要約が必要な場合は許可フィールドのみを抽出する。

## 6. テストルール

### 6.1 ユニットテスト

- すべてのビジネスロジック変更にユニットテストを必須化する。
- 特にゲームルール判定、状態遷移、トークン検証、レーティング計算は重点的に網羅する。
- カバレッジ目標:
  - ゲームルール判定ロジック 90% 以上
  - 全体 80% 以上

### 6.2 統合テスト

- サービス境界 (Gateway-Engine, Firestore, Redis, Storage) の接続箇所に統合テストを用意する。
- 契約テストとして API schema / MCP tool schema の互換性を検証する。
- 統合テストは **Firebase Emulators** (Firestore / Auth / Storage) を使用する。ローカル環境から本番サービスへの接続を禁止する。

### 6.3 E2E テスト

- 各 Phase の完了前に E2E を実施する。
- 最低限の E2E シナリオ:
  - ログイン → マッチ作成 → Agent 接続 → 対戦完了 → リプレイ取得
- 主要障害シナリオ (切断、再接続、タイムアウト、再試行) を必ず含める。

### 6.4 MCP ツール契約テスト

- `packages/mcp-protocol/` で定義した JSON Schema に対し、全ゲームのツール定義が適合することをテストする。
- ツール定義の変更時は、Agent CLI / SDK 側の互換性テストを連動して実行する。

## 7. 品質ゲート (ローカル + CI)

PR 作成前と CI の両方で以下を必須とする。

1. Lint チェック
2. Format チェック
3. Type check
4. Unit test
5. Integration test
6. E2E test (対象 PR)
7. Build

推奨スクリプト名:

- `pnpm lint`
- `pnpm format:check`
- `pnpm typecheck`
- `pnpm test:unit`
- `pnpm test:integration`
- `pnpm test:e2e`
- `pnpm build`

いずれか 1 つでも失敗している状態でのマージを禁止する。

## 8. 環境変数と秘密情報

### 8.1 ローカル開発

- `.env.local` をルートに配置し、ローカル設定を管理する。`.env.local` は `.gitignore` に含める。
- `.env.example` にすべての必須環境変数のキーとダミー値を記載し、コミットする。
- 新しい環境変数を追加した場合、`.env.example` と `README.md` を同時に更新する。

### 8.2 本番 / ステージング

- 秘密情報は Secret Manager で管理し、Cloud Run の環境変数として注入する (SPEC §8.3)。
- Terraform の `variables.tf` に変数定義を追加し、`terraform.tfvars` は `.gitignore` に含める。
- API キー、トークン、秘密情報をリポジトリへコミットしない。

## 9. Firestore スキーマ変更ルール

### 9.1 セキュリティルール

- `firebase/firestore.rules` の変更は専用のレビューチェックリストを使用する:
  - 意図しない read/write の許可がないか
  - カスタムクレームの検証が正しいか
  - サブコレクション (`matches/{matchId}/events/`) のアクセス制御が親と整合するか
- 変更時は Firebase Emulators 上で `@firebase/rules-unit-testing` を実行する。

### 9.2 インデックス変更

- `firebase/firestore.indexes.json` を手動編集し、PR でレビューを受ける。
- インデックス追加は既存クエリのパフォーマンスに影響しないことを確認する。
- デプロイは CI/CD で `firebase deploy --only firestore:indexes` を実行する。

## 10. セキュリティ/運用ルール

- ログ/リプレイ公開前に必ず redaction を適用する。
- 依存パッケージ脆弱性スキャンを定期実行し、High/Critical を放置しない。
- データ保持期間/TTL は `SPEC §10.4` に準拠する。

## 11. PR ルール

### 11.1 PR サイズと構成

- 1 PR あたりの差分目安は 500 行以内。
- PR 本文に以下を必須記載:
  - 目的
  - 変更内容
  - テスト結果 (実行コマンド + 要約)
  - リスクとロールバック方針
  - `SPEC` / `PLAN` の参照セクション

### 11.2 レビュー基準

- 正しさ、セキュリティ、性能、保守性、テスト十分性を優先してレビューする。
- 指摘対応後は関連テストを再実行して結果を更新する。

## 12. Definition of Done

以下をすべて満たしたときのみ「完了」とする。

- `SPEC`/`PLAN` と実装が整合している。
- 必須テストが通過し、カバレッジ基準を満たす。
- Lint/Format/Typecheck/Build がすべて成功。
- 運用上必要なログ・監視項目が実装されている。
- 仕様変更がある場合、関連ドキュメント (`SPEC`, `PLAN`, 本ファイル) を更新済み。

## 13. 例外運用

- 緊急対応で本ルールを一時的に満たせない場合、PR に以下を明記する。
  - 例外理由
  - 影響範囲
  - 期限付きフォローアップタスク
- 例外は恒久化しない。次スプリント内で通常ルールへ復帰する。
