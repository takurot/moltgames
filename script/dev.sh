#!/bin/bash
# dev.sh - タスク自動実行スクリプト (everything-claude-code Skills 活用版)
#
# 使い方:
#   ./temp/dev.sh <PLAN.md のパス> "Phase 2.1: Dockerfile multi-stage build"
#   ./temp/dev.sh temp/PLAN.md    "Phase 3.4.2: Rust L1 サービス実装"
#
# フロー:
#   リサーチ → Eval定義 → TDD実装 → クリーンアップ → 検証 → E2Eテスト → セキュリティレビュー
#   → Eval検証 → コミット → プッシュ → PR作成
#   → [CI監視ループ①] オールグリーンまで修正
#   → コードレビュー(Codex) → レビューをPRコメントに投稿
#   → 指摘対応 → [CI監視ループ②] オールグリーンまで修正
#   → 学習記録
#
# スキルファイルを直接読み込んで claude -p に注入する。
# コードレビューのみ Codex を使用し、それ以外は Claude Code を使用する。

set -e

# CI 監視の設定
CI_MAX_ATTEMPTS=${CI_MAX_ATTEMPTS:-10}   # 最大リトライ回数（デフォルト10回）
CI_POLL_INTERVAL=${CI_POLL_INTERVAL:-30} # CI ポーリング間隔（秒）

# モデルルーティング設定 (autonomous-loops パターン)
# Opus: 深い推論が必要なプランニング・レビュー
# Sonnet: 実装・検証のデフォルト
# Haiku: 軽量なクリーンアップ・単純タスク
MODEL_PLAN="${MODEL_PLAN:-sonnet}"
MODEL_IMPL="${MODEL_IMPL:-sonnet}"
MODEL_CLEANUP="${MODEL_CLEANUP:-haiku}"

PLAN="${1:-}"
TASK="${2:-}"

# スキルファイルのパス
SKILL_DIR="$HOME/.claude/skills"
SKILL_TDD="$SKILL_DIR/tdd-workflow/SKILL.md"
SKILL_VERIFY="$SKILL_DIR/verification-loop/SKILL.md"
SKILL_EVAL="$SKILL_DIR/eval-harness/SKILL.md"
SKILL_LEARNING="$SKILL_DIR/continuous-learning-v2/SKILL.md"
SKILL_SECURITY="$SKILL_DIR/security-review/SKILL.md"
SKILL_E2E="$SKILL_DIR/e2e-testing/SKILL.md"

# クロスステップ共有メモ (continuous-agent-loop パターン)
# 各ステップが知見を書き込み、後続ステップが参照する
NOTES_FILE=".dev-task-notes.md"

if [ -z "$PLAN" ] || [ -z "$TASK" ]; then
  echo "Usage: ./temp/dev.sh <PLAN.md のパス> 'Phase X.Y: タスク説明'"
  echo "Example: ./temp/dev.sh temp/PLAN.md 'Phase 2.1: Dockerfile multi-stage build'"
  exit 1
fi

if [ ! -f "$PLAN" ]; then
  echo "ERROR: PLAN ファイルが見つかりません: $PLAN"
  exit 1
fi

# 共有ノートを初期化
cat > "$NOTES_FILE" <<EOF
# Dev Task Notes: $TASK
Started: $(date '+%Y-%m-%d %H:%M:%S')

## Research Findings
(populated in Step 0)

## Known Patterns / Constraints
(populated by steps as discovered)

## CI Fix History
(populated by CI loop when failures occur)
EOF

# ==================================================
# CI 監視ループ関数
# 引数: $1 = ラベル (例: "PR作成後" / "レビュー対応後")
# ==================================================
wait_for_ci_green() {
  local label="${1:-CI}"
  local attempt=0

  echo ""
  echo "--- CI 監視開始: $label ---"

  while [ $attempt -lt $CI_MAX_ATTEMPTS ]; do
    attempt=$((attempt + 1))
    echo ""
    echo "  CI チェック (試行 $attempt/$CI_MAX_ATTEMPTS)"

    # CI の完了を待つ
    echo "  CI 完了を待機中..."
    gh pr checks "$PR_NUMBER" --watch 2>/dev/null || true

    # 失敗しているチェック数を取得
    CI_STATUS=$(gh pr checks "$PR_NUMBER" --json name,state \
      --jq '[.[] | select(.state != "SUCCESS" and .state != "SKIPPED")] | length' 2>/dev/null || echo "error")

    if [ "$CI_STATUS" = "0" ]; then
      echo "  CI オールグリーン ✓ ($label)"
      return 0
    fi

    echo "  CI 失敗あり ($CI_STATUS 件)。ログを取得して修正します..."

    # 失敗した CI チェック一覧
    CI_FAILURES=$(gh pr checks "$PR_NUMBER" --json name,state,link \
      --jq '.[] | select(.state != "SUCCESS" and .state != "SKIPPED") | "- \(.name): \(.state) \(.link)"' \
      2>/dev/null || echo "")

    # 共有ノートに CI 失敗履歴を記録 (continuous-agent-loop パターン)
    echo "" >> "$NOTES_FILE"
    echo "### CI Fix Attempt $attempt ($label) — $(date '+%H:%M:%S')" >> "$NOTES_FILE"
    echo "$CI_FAILURES" >> "$NOTES_FILE"

    claude -p --model "$MODEL_IMPL" -- "$(cat "$SKILL_VERIFY")

---
CI checks are failing on PR #$PR_NUMBER ($label, attempt $attempt).

Failing checks:
$CI_FAILURES

Prior fix history (avoid repeating same approach):
$(grep -A5 "CI Fix Attempt" "$NOTES_FILE" 2>/dev/null | tail -20 || echo "none")

Steps:
1. Fetch failure logs:
   gh run list --branch \$(git branch --show-current) --json databaseId,name,conclusion \
     --jq '.[] | select(.conclusion == \"failure\") | .databaseId' \
     | head -5 | xargs -I{} gh run view {} --log-failed 2>/dev/null | head -300
2. Analyze the root cause of each failure
3. Fix the issues — do not add new features, fix failures only
4. Run the verification loop locally to confirm fixes pass
5. Stage and commit:
   git add -A && git commit -m 'fix(ci): fix CI failures [$label attempt $attempt]'
6. Push: git push

Focus strictly on CI failures. Do not change unrelated code.
"

    echo "  修正をプッシュしました。CI の再実行を待ちます (${CI_POLL_INTERVAL}s)..."
    sleep "$CI_POLL_INTERVAL"
  done

  echo ""
  echo "ERROR: $CI_MAX_ATTEMPTS 回試行しましたが CI がグリーンになりませんでした ($label)。"
  echo "手動での確認が必要です: $PR_URL"
  exit 1
}

# ==================================================
echo ""
echo "======================================================"
echo " Task: $TASK"
echo "======================================================"

# --------------------------------------------------
# STEP 0: リサーチ — 既存実装・パターンの調査
# (search-first パターン: 実装前に車輪の再発明を防ぐ)
# --------------------------------------------------
echo ""
echo "==> [0/11] リサーチ — 既存実装・パターン調査"
claude -p --model "$MODEL_IMPL" --allowedTools "Read,Grep,Glob,Bash" -- "
Task: $TASK
Read $PLAN for context.

Research phase — do NOT write any code yet.

1. Search the codebase for existing similar implementations:
   - rg through relevant modules for patterns related to this task
   - Identify reusable utilities, helpers, or abstractions already present

2. Identify applicable patterns from the plan:
   - Which design patterns are already in use in this codebase?
   - Are there skeleton implementations or templates to follow?

3. Flag potential AI regression risks (sandbox/production path parity,
   SELECT clause completeness, optimistic update rollbacks) if relevant.

Output a brief research summary (5-10 bullet points) covering:
- Relevant existing code to reuse or extend
- Patterns to follow for consistency
- Potential pitfalls specific to this task

Append the summary to $NOTES_FILE under '## Research Findings'.
"

# --------------------------------------------------
# STEP 1: Eval 定義 + タスク分解
# --------------------------------------------------
echo ""
echo "==> [1/11] Eval 定義 + タスク分解"
claude -p --model "$MODEL_PLAN" -- "$(cat "$SKILL_EVAL")

---
Task: $TASK
Read $PLAN for context.
Read research findings in $NOTES_FILE for codebase patterns.

1. Define capability evals (what must work after implementation)
2. Define regression evals (what must NOT break)
3. Break the task into independently verifiable units (15-minute rule)
4. Run baseline: capture current test/build status

Output the eval definitions and task units. Do not implement yet.
"

# --------------------------------------------------
# STEP 2: TDD 実装
# --------------------------------------------------
echo ""
echo "==> [2/11] TDD 実装"
claude -p --model "$MODEL_IMPL" -- "$(cat "$SKILL_TDD")

---
Task: $TASK
Read $PLAN for context.
Read $NOTES_FILE for research findings and patterns to follow.

Follow the TDD cycle strictly:
1. Define interfaces/types first
2. Write failing tests (RED) — unit + integration + edge cases
   - Include sandbox/production path parity tests if applicable (ai-regression-testing)
   - Test API response shapes explicitly for any new endpoints
3. Run tests and confirm they FAIL
4. Implement minimal code to pass (GREEN)
5. Run tests and confirm they PASS
6. Refactor while keeping tests green (REFACTOR)
7. Verify ≥80% coverage (100% for security/financial logic)

Do NOT create documentation files.
Do NOT write implementation before tests.
"

# --------------------------------------------------
# STEP 3: クリーンアップ (de-sloppify)
# --------------------------------------------------
echo ""
echo "==> [3/11] クリーンアップ"
claude -p --model "$MODEL_CLEANUP" -- "
Review all files changed since the last commit (git diff HEAD).
Remove test slop:
- Tests verifying language/framework behavior (not business logic)
- Overly defensive runtime checks for impossible states
- Redundant type assertions the type system already enforces
- console.log / debug print statements
- Commented-out code

Keep all business logic tests and edge case coverage.
Run the test suite after cleanup and confirm it still passes.
"

# --------------------------------------------------
# STEP 4: 多段検証
# --------------------------------------------------
echo ""
echo "==> [4/11] 多段検証"
claude -p --model "$MODEL_IMPL" -- "$(cat "$SKILL_VERIFY")

---
Run all verification phases and fix any failures.
Do not add new features. Fix failures only.
Output a VERIFICATION REPORT with PASS/FAIL per phase.
"

# --------------------------------------------------
# STEP 5: E2E テスト (e2e-testing パターン)
# クリティカルユーザーフローを Playwright で検証する。
# --------------------------------------------------
echo ""
echo "==> [5/12] E2E テスト"
claude -p --model "$MODEL_IMPL" -- "$(cat "$SKILL_E2E")

---
Task: $TASK
Read $PLAN for context.

1. Identify the critical user flows affected by this task
   (auth, key feature flows, payment/financial flows if applicable)

2. Check if E2E tests already exist for these flows (tests/e2e/):
   - If yes: run them and fix any failures before adding new tests
   - If no: create minimal Page Object Model tests for the affected flows

3. Run the E2E suite:
   npx playwright test --reporter=list 2>&1 | tail -40

4. If any tests fail:
   - Capture screenshots/traces for failures
   - Fix the underlying issue (app code or test code)
   - Re-run to confirm green

5. If Playwright is not installed in this project, skip this step and output:
   'E2E SKIPPED — Playwright not configured in this project.'

Output a brief E2E REPORT:
- Flows tested
- Pass / Fail count
- Any flaky tests quarantined with test.fixme()
"

# --------------------------------------------------
# STEP 6: セキュリティレビュー (security-review パターン)
# コミット前に必ず実施。CRITICAL/HIGH 指摘があれば修正して続行。
# --------------------------------------------------
echo ""
echo "==> [6/12] セキュリティレビュー"
SECURITY_SKILL_AVAILABLE=false
if [ -f "$SKILL_SECURITY" ]; then
  SECURITY_SKILL_AVAILABLE=true
fi

if [ "$SECURITY_SKILL_AVAILABLE" = "true" ]; then
  SECURITY_PROMPT="$(cat "$SKILL_SECURITY")

---"
else
  SECURITY_PROMPT=""
fi

claude -p --model "$MODEL_PLAN" --allowedTools "Read,Grep,Glob,Bash,Edit,Write" -- "${SECURITY_PROMPT}
Task: $TASK — Security review before commit.

Review all changes since the last commit (git diff HEAD):

MANDATORY CHECKS:
- [ ] No hardcoded secrets, API keys, or tokens
- [ ] All user inputs validated at system boundaries
- [ ] SQL injection prevention (parameterized queries only)
- [ ] XSS prevention (sanitized HTML output)
- [ ] Authentication / authorization checks in place
- [ ] No sensitive data in logs or error messages
- [ ] No command injection via string interpolation

If any CRITICAL or HIGH issue is found:
1. Fix it immediately before proceeding
2. Run the test suite to confirm the fix doesn't break anything
3. Note the finding in $NOTES_FILE under '## Security Fixes'

If clean, output: 'Security review PASSED — no critical/high issues found.'
"

# --------------------------------------------------
# STEP 7: Eval 検証
# --------------------------------------------------
echo ""
echo "==> [7/12] Eval 検証"
claude -p --model "$MODEL_PLAN" --allowedTools "Read,Grep,Glob,Bash" -- "$(cat "$SKILL_EVAL")

---
Task: $TASK

Re-run the capability and regression evals defined in Step 1.
Report pass@k delta vs baseline.
If any eval fails: output what needs fixing and exit with code 1.
"

# --------------------------------------------------
# STEP 8: コミット → プッシュ → PR 作成
# --------------------------------------------------
echo ""
echo "==> [8/12] コミット → プッシュ → PR 作成"
claude -p --model "$MODEL_IMPL" -- "
1. Stage all changed files: git add -A
2. Create a conventional commit:
   - Format: type(scope): description
   - Types: feat / fix / test / refactor / chore / ci
   - Task for reference: $TASK
3. Push to remote: git push -u origin HEAD
4. Create a pull request using gh:
   gh pr create --title '...' --body '...'
   - Title: concise (under 70 chars), derived from the task
   - Body must include:
     ## Summary
     - What was implemented and why
     ## Changes
     - Key files changed
     ## Test plan
     - How to verify the changes

Output the PR URL at the end.
"

# PR 情報を取得
PR_URL=$(gh pr view --json url -q .url 2>/dev/null || echo "")
PR_NUMBER=$(gh pr view --json number -q .number 2>/dev/null || echo "")

if [ -z "$PR_NUMBER" ]; then
  echo "ERROR: PR が見つかりません。PR 作成を確認してください。"
  exit 1
fi

echo "PR: $PR_URL"

# --------------------------------------------------
# STEP 8: CI 監視ループ① — PR作成後
# --------------------------------------------------
echo ""
echo "==> [9/12] CI 監視ループ① (PR作成後)"
wait_for_ci_green "PR作成後"

# --------------------------------------------------
# STEP 9: コードレビュー (Codex)
# --------------------------------------------------
echo ""
echo "==> [10/12] コードレビュー (Codex)"

REVIEW_FILE="review-${PR_NUMBER}.md"

codex "
Review the pull request diff.
Run: gh pr diff $PR_NUMBER

Review checklist:

[SECURITY - CRITICAL]
- Hardcoded secrets or API keys
- SQL/command injection vulnerabilities
- Authentication/authorization bypass
- Unvalidated user input
- Sensitive data in logs

[CODE QUALITY - HIGH]
- Functions >50 lines or files >800 lines
- Missing error handling
- N+1 query patterns
- Missing tests for new code paths
- Dead code or unused imports

[CORRECTNESS - HIGH]
- Logic errors or off-by-one bugs
- Race conditions or concurrency issues
- Missing edge case handling

[STYLE - LOW]
- Naming inconsistencies
- Magic numbers without constants

Output format (Markdown):
## Code Review

### Summary
<1-2 sentence overall assessment>

### Findings

#### CRITICAL
- file:line — description and suggested fix

#### HIGH
- file:line — description and suggested fix

#### MEDIUM
- file:line — description and suggested fix

#### LOW
- file:line — description and suggested fix

### Verdict
APPROVE / REQUEST_CHANGES / BLOCK

Save the full review output to: $REVIEW_FILE
" | tee "$REVIEW_FILE"

# --------------------------------------------------
# STEP 10: レビュー内容を PR コメントに投稿
# --------------------------------------------------
echo ""
echo "==> [11/12] レビューを PR に投稿"
claude -p -- "
Read the review file at $REVIEW_FILE.

Post the review as a PR comment:
  gh pr comment $PR_NUMBER --body-file $REVIEW_FILE

Then check the Verdict line:
- If APPROVE: output 'Review passed.'
- If REQUEST_CHANGES or BLOCK: output 'Review requires changes.' and list CRITICAL and HIGH findings only.
"

# Verdict を確認
VERDICT=$(grep -i "^### Verdict" -A1 "$REVIEW_FILE" | tail -1 | tr -d ' \n' 2>/dev/null || echo "UNKNOWN")

if echo "$VERDICT" | grep -qiE "BLOCK|REQUEST_CHANGES"; then
  echo ""
  echo "==> [12/12] レビュー指摘対応 + CI 監視ループ②"

  # ----------------------------------------------
  # 指摘対応 → コミット → プッシュ
  # ----------------------------------------------
  claude -p --model "$MODEL_IMPL" "$(cat "$SKILL_VERIFY")

---
Read the code review findings at $REVIEW_FILE.

Address ALL CRITICAL and HIGH findings:
1. For each finding: read the file, understand the issue, apply the fix
2. After all fixes: run the verification loop (build, types, lint, tests)
3. Stage fixed files: git add -A
4. Create a follow-up commit:
   fix(review): address code review findings from PR #$PR_NUMBER
5. Push: git push

Then post a follow-up comment summarizing what was fixed:
  gh pr comment $PR_NUMBER --body '## Review Fixes

  Addressed the following findings:
  - [finding 1 and how it was fixed]
  - [finding 2 and how it was fixed]
  ...'
"

  # ----------------------------------------------
  # CI 監視ループ② — レビュー対応後
  # ----------------------------------------------
  wait_for_ci_green "レビュー対応後"

  echo ""
  echo "指摘対応 + CI グリーン確認完了。PR をマージしてください: $PR_URL"
else
  echo ""
  echo "レビュー承認 + CI グリーン確認済み。PR をマージしてください: $PR_URL"
fi

# 共有ノートを削除 (一時ファイル)
rm -f "$NOTES_FILE"

# --------------------------------------------------
# セッション学習記録 (continuous-learning-v2)
# --------------------------------------------------
echo ""
echo "==> 学習記録 (continuous-learning-v2)"
claude -p --model "$MODEL_IMPL" -- "$(cat "$SKILL_LEARNING")

---
Task completed: $TASK

Extract 1-2 instincts learned from this session:
- What pattern worked well and should be remembered?
- Any project-specific convention discovered?
Save each as an instinct with: trigger, action, confidence, domain, scope.
"

echo ""
echo "======================================================"
echo " Completed: $TASK"
echo " PR: $PR_URL"
echo "======================================================"
