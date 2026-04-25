#!/bin/bash

set -euo pipefail

DEV_AGENT_FAMILY="${DEV_AGENT_FAMILY:-claude}"
DEV_REVIEW_AGENT_FAMILY="${DEV_REVIEW_AGENT_FAMILY:-codex}"
DEV_SCRIPT_NAME="${DEV_SCRIPT_NAME:-script/dev.sh}"
DEV_DRY_RUN="${DEV_DRY_RUN:-0}"

default_skill_dir() {
  local agent_family="$1"

  case "$agent_family" in
    claude)
      printf '%s/.claude/skills' "$HOME"
      ;;
    codex)
      printf '%s/.codex/skills' "$HOME"
      ;;
    *)
      echo "ERROR: unsupported agent family: $agent_family" >&2
      exit 1
      ;;
  esac
}

default_model() {
  local agent_family="$1"

  case "$agent_family" in
    claude)
      printf 'sonnet'
      ;;
    codex)
      printf 'gpt-5.4'
      ;;
    *)
      echo "ERROR: unsupported agent family: $agent_family" >&2
      exit 1
      ;;
  esac
}

default_cleanup_model() {
  local agent_family="$1"

  case "$agent_family" in
    claude)
      printf 'haiku'
      ;;
    codex)
      printf 'gpt-5.4'
      ;;
    *)
      echo "ERROR: unsupported agent family: $agent_family" >&2
      exit 1
      ;;
  esac
}

PRIMARY_SKILL_DIR="${DEV_SKILL_DIR:-$(default_skill_dir "$DEV_AGENT_FAMILY")}"
MODEL_PLAN="${MODEL_PLAN:-$(default_model "$DEV_AGENT_FAMILY")}"
MODEL_IMPL="${MODEL_IMPL:-$(default_model "$DEV_AGENT_FAMILY")}"
MODEL_CLEANUP="${MODEL_CLEANUP:-$(default_cleanup_model "$DEV_AGENT_FAMILY")}"
REVIEW_MODEL="${REVIEW_MODEL:-$(default_model "$DEV_REVIEW_AGENT_FAMILY")}"

PLAN="${1:-}"
TASK="${2:-}"

SKILL_TDD="$PRIMARY_SKILL_DIR/tdd-workflow/SKILL.md"
SKILL_VERIFY="$PRIMARY_SKILL_DIR/verification-loop/SKILL.md"
SKILL_EVAL="$PRIMARY_SKILL_DIR/eval-harness/SKILL.md"
SKILL_LEARNING="$PRIMARY_SKILL_DIR/continuous-learning-v2/SKILL.md"
SKILL_SECURITY="$PRIMARY_SKILL_DIR/security-review/SKILL.md"
SKILL_E2E="$PRIMARY_SKILL_DIR/e2e-testing/SKILL.md"

NOTES_FILE=".dev-task-notes.md"
CHECKPOINT_FILE=".dev-task-checkpoint"
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REVIEW_FILE=""
PR_NUMBER=""
PR_URL=""
VERDICT=""

# チェックポイントから再開位置を決定
RESUME_FROM=0
if [ -f "$CHECKPOINT_FILE" ]; then
  _completed=$(cat "$CHECKPOINT_FILE" 2>/dev/null || echo "-1")
  if [ "$_completed" -ge 0 ] 2>/dev/null; then
    RESUME_FROM=$(( _completed + 1 ))
    echo "チェックポイント検出: ステップ $_completed 完了済み → ステップ $RESUME_FROM から再開"
  fi
fi

# shellcheck source=script/review-prompt.sh
. "$SCRIPT_DIR/review-prompt.sh"

is_dry_run() {
  [ "$DEV_DRY_RUN" = "1" ]
}

usage() {
  echo "Usage: $DEV_SCRIPT_NAME <PLAN.md path> <task>"
  echo "Example: $DEV_SCRIPT_NAME temp/PLAN.md 'Phase 2.1: Dockerfile multi-stage build'"
}

require_command() {
  local command_name="$1"

  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $command_name" >&2
    exit 1
  fi
}

require_file() {
  local file_path="$1"

  if [ ! -f "$file_path" ]; then
    echo "ERROR: required file not found: $file_path" >&2
    exit 1
  fi
}

prepare_prompt_for_agent() {
  local agent_family="$1"
  local allowed_tools="$2"
  local prompt_text="$3"

  if [ "$agent_family" = "codex" ] && [ -n "$allowed_tools" ]; then
    printf 'Tool guardrails: Prefer restricting yourself to these tool categories when they are relevant: %s\n\n%s' \
      "$allowed_tools" \
      "$prompt_text"
    return 0
  fi

  printf '%s' "$prompt_text"
}

describe_exec_command() {
  local agent_family="$1"
  local model_name="$2"
  local allowed_tools="$3"

  case "$agent_family" in
    claude)
      if [ -n "$allowed_tools" ]; then
        printf 'claude -p --model "%s" --allowedTools "%s" -- "<prompt>"' "$model_name" "$allowed_tools"
      else
        printf 'claude -p --model "%s" -- "<prompt>"' "$model_name"
      fi
      ;;
    codex)
      printf 'codex exec -m "%s" --sandbox workspace-write -' "$model_name"
      ;;
  esac
}

describe_review_command() {
  local agent_family="$1"
  local model_name="$2"

  case "$agent_family" in
    claude)
      printf 'claude -p --model "%s" -- "<review prompt>"' "$model_name"
      ;;
    codex)
      printf 'codex review -c model="%s" -' "$model_name"
      ;;
  esac
}

run_agent_exec() {
  local agent_family="$1"
  local model_name="$2"
  local allowed_tools="$3"
  local prompt_text
  local prepared_prompt

  prompt_text=$(cat)
  prepared_prompt=$(prepare_prompt_for_agent "$agent_family" "$allowed_tools" "$prompt_text")

  if is_dry_run; then
    echo "DRY RUN EXEC [$agent_family]: $(describe_exec_command "$agent_family" "$model_name" "$allowed_tools")"
    return 0
  fi

  case "$agent_family" in
    claude)
      if [ -n "$allowed_tools" ]; then
        claude -p --model "$model_name" --allowedTools "$allowed_tools" -- "$prepared_prompt"
      else
        claude -p --model "$model_name" -- "$prepared_prompt"
      fi
      ;;
    codex)
      printf '%s' "$prepared_prompt" | codex exec -m "$model_name" --sandbox workspace-write -
      ;;
  esac
}

run_agent_review() {
  local agent_family="$1"
  local model_name="$2"
  local prompt_text

  prompt_text=$(cat)

  if is_dry_run; then
    echo "DRY RUN REVIEW [$agent_family]: $(describe_review_command "$agent_family" "$model_name")"
    return 0
  fi

  case "$agent_family" in
    claude)
      claude -p --model "$model_name" -- "$prompt_text"
      ;;
    codex)
      printf '%s' "$prompt_text" | codex review -c "model=\"$model_name\"" -
      ;;
  esac
}

print_runtime_summary() {
  echo "Agent family: $DEV_AGENT_FAMILY"
  echo "Review agent: $DEV_REVIEW_AGENT_FAMILY"
  echo "Skill directory: $PRIMARY_SKILL_DIR"
  echo "Model (plan): $MODEL_PLAN"
  echo "Model (impl): $MODEL_IMPL"
  echo "Model (cleanup): $MODEL_CLEANUP"

  if is_dry_run; then
    echo "Dry run: enabled"
  fi
}

initialize_notes_file() {
  cat >"$NOTES_FILE" <<EOF
# Dev Task Notes: $TASK
Started: $(date '+%Y-%m-%d %H:%M:%S')

## Research Findings
(populated in Step 0)

## Known Patterns / Constraints
(populated by steps as discovered)

## CI Fix History
(populated by CI loop when failures occur)
EOF
}

checkpoint() {
  echo "$1" > "$CHECKPOINT_FILE"
}

cleanup_files() {
  rm -f "$NOTES_FILE"
}

trap cleanup_files EXIT

if [ -z "$PLAN" ] || [ -z "$TASK" ]; then
  usage
  exit 1
fi

require_file "$PLAN"

require_file "$SCRIPT_DIR/review-prompt.sh"
require_file "$SKILL_TDD"
require_file "$SKILL_VERIFY"
require_file "$SKILL_EVAL"
require_file "$SKILL_LEARNING"
require_file "$SKILL_E2E"

if ! is_dry_run; then
  require_command gh
  require_command "$DEV_AGENT_FAMILY"

  if [ "$DEV_REVIEW_AGENT_FAMILY" != "$DEV_AGENT_FAMILY" ]; then
    require_command "$DEV_REVIEW_AGENT_FAMILY"
  fi
fi

if [ "$RESUME_FROM" -eq 0 ]; then
  initialize_notes_file
fi

wait_for_ci_green() {
  local label="${1:-CI}"
  local attempt=0

  if is_dry_run; then
    echo "DRY RUN CI WAIT: $label"
    return 0
  fi

  echo ""
  echo "--- CI 監視開始: $label ---"

  while [ $attempt -lt "${CI_MAX_ATTEMPTS:-10}" ]; do
    attempt=$((attempt + 1))
    echo ""
    echo "  CI チェック (試行 $attempt/${CI_MAX_ATTEMPTS:-10})"
    echo "  CI 完了を待機中..."
    gh pr checks "$PR_NUMBER" --watch 2>/dev/null || true

    CI_STATUS=$(gh pr checks "$PR_NUMBER" --json name,state \
      --jq '[.[] | select(.state != "SUCCESS" and .state != "SKIPPED")] | length' 2>/dev/null || echo "error")

    if [ "$CI_STATUS" = "0" ]; then
      echo "  CI オールグリーン ✓ ($label)"
      return 0
    fi

    echo "  CI 失敗あり ($CI_STATUS 件)。ログを取得して修正します..."

    CI_FAILURES=$(gh pr checks "$PR_NUMBER" --json name,state,link \
      --jq '.[] | select(.state != "SUCCESS" and .state != "SKIPPED") | "- \(.name): \(.state) \(.link)"' \
      2>/dev/null || echo "")

    {
      echo ""
      echo "### CI Fix Attempt $attempt ($label) — $(date '+%H:%M:%S')"
      echo "$CI_FAILURES"
    } >>"$NOTES_FILE"

    run_agent_exec "$DEV_REVIEW_AGENT_FAMILY" "$REVIEW_MODEL" "" <<EOF
$(cat "$SKILL_VERIFY")

---
CI checks are failing on PR #$PR_NUMBER ($label, attempt $attempt).

Failing checks:
$CI_FAILURES

Prior fix history (avoid repeating same approach):
$(grep -A5 "CI Fix Attempt" "$NOTES_FILE" 2>/dev/null | tail -20 || echo "none")

Steps:
1. Fetch failure logs:
   gh run list --branch \$(git branch --show-current) --json databaseId,name,conclusion \
     --jq '.[] | select(.conclusion == "failure") | .databaseId' \
     | head -5 | xargs -I{} gh run view {} --log-failed 2>/dev/null | head -300
2. Analyze the root cause of each failure
3. Fix the issues — do not add new features, fix failures only
4. Run the verification loop locally to confirm fixes pass
5. Stage and commit:
   git add -A && git commit -m 'fix(ci): fix CI failures [$label attempt $attempt]'
6. Push: git push

Focus strictly on CI failures. Do not change unrelated code.
EOF

    echo "  修正をプッシュしました。CI の再実行を待ちます (${CI_POLL_INTERVAL:-30}s)..."
    sleep "${CI_POLL_INTERVAL:-30}"
  done

  echo ""
  echo "ERROR: ${CI_MAX_ATTEMPTS:-10} 回試行しましたが CI がグリーンになりませんでした ($label)。"
  echo "手動での確認が必要です: $PR_URL"
  exit 1
}

echo ""
echo "======================================================"
echo " Task: $TASK"
echo "======================================================"
print_runtime_summary

if [ 0 -ge "$RESUME_FROM" ]; then
echo ""
echo "==> [0/12] リサーチ — 既存実装・パターン調査"
run_agent_exec "$DEV_AGENT_FAMILY" "$MODEL_IMPL" "Read,Grep,Glob,Bash" <<EOF
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
EOF
checkpoint 0
else
  echo ""
  echo "==> [0/12] リサーチ — スキップ (チェックポイント済み)"
fi

if [ 1 -ge "$RESUME_FROM" ]; then
echo ""
echo "==> [1/12] Eval 定義 + タスク分解"
run_agent_exec "$DEV_AGENT_FAMILY" "$MODEL_PLAN" "" <<EOF
$(cat "$SKILL_EVAL")

---
Task: $TASK
Read $PLAN for context.
Read research findings in $NOTES_FILE for codebase patterns.

1. Define capability evals (what must work after implementation)
2. Define regression evals (what must NOT break)
3. Break the task into independently verifiable units (15-minute rule)
4. Run baseline: capture current test/build status

Output the eval definitions and task units. Do not implement yet.
EOF
checkpoint 1
else
  echo ""
  echo "==> [1/12] Eval 定義 — スキップ (チェックポイント済み)"
fi

if [ 2 -ge "$RESUME_FROM" ]; then
echo ""
echo "==> [2/12] TDD 実装"
run_agent_exec "$DEV_AGENT_FAMILY" "$MODEL_IMPL" "" <<EOF
$(cat "$SKILL_TDD")

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
EOF
checkpoint 2
else
  echo ""
  echo "==> [2/12] TDD 実装 — スキップ (チェックポイント済み)"
fi

if [ 3 -ge "$RESUME_FROM" ]; then
echo ""
echo "==> [3/12] クリーンアップ"
run_agent_exec "$DEV_AGENT_FAMILY" "$MODEL_CLEANUP" "" <<EOF
Review all files changed since the last commit (git diff HEAD).
Remove test slop:
- Tests verifying language/framework behavior (not business logic)
- Overly defensive runtime checks for impossible states
- Redundant type assertions the type system already enforces
- console.log / debug print statements
- Commented-out code

Keep all business logic tests and edge case coverage.
Run the test suite after cleanup and confirm it still passes.
EOF
checkpoint 3
else
  echo ""
  echo "==> [3/12] クリーンアップ — スキップ (チェックポイント済み)"
fi

if [ 4 -ge "$RESUME_FROM" ]; then
echo ""
echo "==> [4/12] 多段検証"
run_agent_exec "$DEV_AGENT_FAMILY" "$MODEL_IMPL" "" <<EOF
$(cat "$SKILL_VERIFY")

---
Run all verification phases and fix any failures.
Do not add new features. Fix failures only.
Output a VERIFICATION REPORT with PASS/FAIL per phase.
EOF
checkpoint 4
else
  echo ""
  echo "==> [4/12] 多段検証 — スキップ (チェックポイント済み)"
fi

if [ 5 -ge "$RESUME_FROM" ]; then
echo ""
echo "==> [5/12] E2E テスト"
run_agent_exec "$DEV_AGENT_FAMILY" "$MODEL_IMPL" "" <<EOF
$(cat "$SKILL_E2E")

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
EOF
checkpoint 5
else
  echo ""
  echo "==> [5/12] E2E テスト — スキップ (チェックポイント済み)"
fi

if [ 6 -ge "$RESUME_FROM" ]; then
echo ""
echo "==> [6/12] セキュリティレビュー"
SECURITY_PROMPT=""
if [ -f "$SKILL_SECURITY" ]; then
  SECURITY_PROMPT="$(cat "$SKILL_SECURITY")

---"
fi

run_agent_exec "$DEV_AGENT_FAMILY" "$MODEL_PLAN" "Read,Grep,Glob,Bash,Edit,Write" <<EOF
$SECURITY_PROMPT
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
EOF
checkpoint 6
else
  echo ""
  echo "==> [6/12] セキュリティレビュー — スキップ (チェックポイント済み)"
fi

if [ 7 -ge "$RESUME_FROM" ]; then
echo ""
echo "==> [7/12] Eval 検証"
run_agent_exec "$DEV_AGENT_FAMILY" "$MODEL_PLAN" "Read,Grep,Glob,Bash" <<EOF
$(cat "$SKILL_EVAL")

---
Task: $TASK

Re-run the capability and regression evals defined in Step 1.
Report pass@k delta vs baseline.
If any eval fails: output what needs fixing and exit with code 1.
EOF
checkpoint 7
else
  echo ""
  echo "==> [7/12] Eval 検証 — スキップ (チェックポイント済み)"
fi

if [ 8 -ge "$RESUME_FROM" ]; then
echo ""
echo "==> [8/12] コミット → プッシュ → PR 作成"
run_agent_exec "$DEV_AGENT_FAMILY" "$MODEL_IMPL" "" <<EOF
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
EOF
checkpoint 8
else
  echo ""
  echo "==> [8/12] コミット → PR — スキップ (チェックポイント済み)"
fi

# ステップ8完了またはスキップ後にPR情報を取得
if is_dry_run; then
  PR_URL="https://example.invalid/dry-run-pr"
  PR_NUMBER="0"
else
  PR_URL=$(gh pr view --json url -q .url 2>/dev/null || echo "")
  PR_NUMBER=$(gh pr view --json number -q .number 2>/dev/null || echo "")

  if [ -z "$PR_NUMBER" ]; then
    echo "ERROR: PR が見つかりません。PR 作成を確認してください。"
    exit 1
  fi
fi

echo "PR: $PR_URL"

if [ 9 -ge "$RESUME_FROM" ]; then
echo ""
echo "==> [9/12] CI 監視ループ① (PR作成後)"
wait_for_ci_green "PR作成後"
checkpoint 9
else
  echo ""
  echo "==> [9/12] CI 監視ループ① — スキップ (チェックポイント済み)"
fi

REVIEW_FILE="review-${PR_NUMBER}.md"

if [ 10 -ge "$RESUME_FROM" ]; then
echo ""
echo "==> [10/12] コードレビュー"
if is_dry_run; then
  echo "DRY RUN REVIEW [$DEV_REVIEW_AGENT_FAMILY]: $(describe_review_command "$DEV_REVIEW_AGENT_FAMILY" "$REVIEW_MODEL")"
  cat >"$REVIEW_FILE" <<EOF
## Code Review

### Summary
Dry run placeholder review.

### Findings

#### CRITICAL
- none

#### HIGH
- none

#### MEDIUM
- none

#### LOW
- none

### Verdict
APPROVE
EOF
else
  run_agent_review "$DEV_REVIEW_AGENT_FAMILY" "$REVIEW_MODEL" <<EOF | tee "$REVIEW_FILE"
$(build_codex_review_prompt "$PR_NUMBER" "$TASK" "$NOTES_FILE" "$PLAN")
EOF
fi
checkpoint 10
else
  echo ""
  echo "==> [10/12] コードレビュー — スキップ (チェックポイント済み)"
fi

if [ 11 -ge "$RESUME_FROM" ]; then
echo ""
echo "==> [11/12] レビューを PR に投稿"
run_agent_exec "$DEV_AGENT_FAMILY" "$MODEL_IMPL" "" <<EOF
Read the review file at $REVIEW_FILE.

Post the review as a PR comment:
  gh pr comment $PR_NUMBER --body-file $REVIEW_FILE

Then check the Verdict line:
- If APPROVE: output 'Review passed.'
- If REQUEST_CHANGES or BLOCK: output 'Review requires changes.' and list CRITICAL and HIGH findings only.
EOF
checkpoint 11
else
  echo ""
  echo "==> [11/12] レビュー投稿 — スキップ (チェックポイント済み)"
fi

# VERDICTをファイルから取得（スキップ時も含む）
if [ -f "$REVIEW_FILE" ]; then
  VERDICT=$(grep -i "^### Verdict" -A1 "$REVIEW_FILE" | tail -1 | tr -d ' \n' 2>/dev/null || echo "UNKNOWN")
fi

if echo "$VERDICT" | grep -qiE "BLOCK|REQUEST_CHANGES"; then
  echo ""
  echo "==> [12/12] レビュー指摘対応 + CI 監視ループ②"

  run_agent_exec "$DEV_AGENT_FAMILY" "$MODEL_IMPL" "" <<EOF
$(cat "$SKILL_VERIFY")

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
EOF

  wait_for_ci_green "レビュー対応後"
  echo ""
  echo "指摘対応 + CI グリーン確認完了。PR をマージしてください: $PR_URL"
else
  echo ""
  echo "レビュー承認 + CI グリーン確認済み。PR をマージしてください: $PR_URL"
fi

echo ""
echo "==> [post] 学習記録 (continuous-learning-v2)"
run_agent_exec "$DEV_AGENT_FAMILY" "$MODEL_IMPL" "" <<EOF
$(cat "$SKILL_LEARNING")

---
Task completed: $TASK

Extract 1-2 instincts learned from this session:
- What pattern worked well and should be remembered?
- Any project-specific convention discovered?
Save each as an instinct with: trigger, action, confidence, domain, scope.
EOF

rm -f "$CHECKPOINT_FILE"

echo ""
echo "======================================================"
echo " Completed: $TASK"
echo " PR: $PR_URL"
echo "======================================================"
