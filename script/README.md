# script/

タスク自動実行スクリプト群。AI エージェントを使ってリサーチ→TDD実装→検証→PR作成→CIまでを自動化します。

## ファイル構成

| ファイル | 役割 |
|---------|------|
| `dev_claude.sh` | Claude エージェントで実行するエントリーポイント |
| `dev_codex.sh` | Codex エージェントで実行するエントリーポイント |
| `dev-workflow.sh` | ワークフロー本体（両エントリーポイントから呼ばれる） |
| `review-prompt.sh` | コードレビュープロンプト生成ヘルパー |

## 使い方

```bash
# Claude で実装（実装: claude / レビュー: codex）
bash script/dev_claude.sh <PLAN.md> "<タスク名>"

# Codex で実装（実装: codex / レビュー: codex）
bash script/dev_codex.sh <PLAN.md> "<タスク名>"
```

### 例

```bash
bash script/dev_claude.sh temp/PLAN.md "feat(gateway): add rate limiting to /v1/match"
bash script/dev_codex.sh temp/PLAN.md "fix(engine): correct bluff dice resolution"
```

## ワークフロー（12ステップ）

```
[0/12] リサーチ          — 既存実装・パターン調査（コードは書かない）
[1/12] Eval 定義         — 受け入れ条件・回帰条件・タスク分解
[2/12] TDD 実装          — テスト先行（RED→GREEN→REFACTOR）
[3/12] クリーンアップ    — テストスロップ除去・console.log 削除
[4/12] 多段検証          — build / typecheck / lint / test を全通し
[5/12] E2E テスト        — クリティカルフロー確認（Playwright 未設定時はスキップ）
[6/12] セキュリティ      — OWASP Top10 / シークレット漏洩チェック
[7/12] Eval 検証         — Step 1 で定義した eval を再実行・pass@k 確認
[8/12] コミット → PR     — conventional commit + gh pr create
[9/12] CI 監視①         — PR 作成後にオールグリーンまで自動修正
[10/12] コードレビュー   — Codex によるレビュー（review-prompt.sh を使用）
[11/12] レビュー投稿     — gh pr comment でレビュー結果を PR に投稿
[12/12] 指摘対応         — CRITICAL/HIGH 指摘があれば自動修正 + CI 監視②
[post]  学習記録         — continuous-learning-v2 でインスティンクト記録
```

## チェックポイント機能

レートリミットや途中エラーで停止しても、**再実行すると続きから再開**されます。

```bash
# 通常実行（0から開始 or チェックポイントから再開）
bash script/dev_claude.sh temp/PLAN.md "..."

# 特定ステップから強制再開（例: ステップ4から）
echo "3" > .dev-task-checkpoint
bash script/dev_claude.sh temp/PLAN.md "..."

# チェックポイントをリセット（最初から実行）
rm -f .dev-task-checkpoint
bash script/dev_claude.sh temp/PLAN.md "..."
```

チェックポイントファイル `.dev-task-checkpoint` はワークツリーのルートに作成されます。正常完了時は自動削除されます。

## 環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `DEV_AGENT_FAMILY` | `claude` / `codex` | 実装エージェント |
| `DEV_REVIEW_AGENT_FAMILY` | `codex` | レビューエージェント |
| `MODEL_PLAN` | `sonnet` / `gpt-5.4` | プランニング・セキュリティ用モデル |
| `MODEL_IMPL` | `sonnet` / `gpt-5.4` | 実装・検証用モデル |
| `MODEL_CLEANUP` | `haiku` / `gpt-5.4` | クリーンアップ用モデル |
| `DEV_DRY_RUN` | `0` | `1` にするとエージェント呼び出しをスキップ |
| `CI_MAX_ATTEMPTS` | `10` | CI 修正の最大リトライ回数 |
| `CI_POLL_INTERVAL` | `30` | CI ポーリング間隔（秒） |
| `DEV_SKILL_DIR` | `~/.claude/skills` など | スキルファイルディレクトリ |

## PLAN ファイルの最小構成

```markdown
# PLAN: <タイトル>

## Source Issue
GitHub Issue #XX

## Problem Statement
（問題の説明）

## Goal / Non-goals
（目標と対象外）

## Likely Touched Areas
（変更対象ファイル・パッケージ）

## Acceptance Criteria
- [ ] ...

## Tests / Verification
（検証方法）

## Risks / Edge Cases
（リスクとエッジケース）
```

## 並列実行（複数 Issue を同時処理）

git worktree を使って複数 Issue を並列実行できます。

```bash
# worktree 作成
git worktree add ../myrepo-issue-99 -b codex/fix/issue-99-description

# PLAN を作成
cat > ../myrepo-issue-99/temp/PLAN-issue-99.md << 'EOF'
# PLAN: ...
EOF

# バックグラウンドで起動
cd ../myrepo-issue-99 && bash script/dev_claude.sh temp/PLAN-issue-99.md "Issue #99: ..." >> /tmp/dev-99.log 2>&1 &
```
