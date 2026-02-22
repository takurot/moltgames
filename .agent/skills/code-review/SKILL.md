---
name: code-review
description: Perform risk-first reviews for pull requests and code diffs. Use when asked to review a PR, audit code quality, check architecture impact, or find bugs/regressions. Prioritize correctness, security, performance, and missing tests; return severity-ranked findings with file/line evidence and concrete fixes.
---

# Code Review Skill

## Review Contract

- Start with findings, ordered by severity.
- Focus on high-value risk: correctness, regressions, security, performance, API compatibility, and test gaps.
- Treat style/formatting as non-blocking unless it hides defects.
- Do not claim issues without evidence. If uncertain, raise an explicit question.

## Workflow: Explore -> Analyze -> Verify -> Report

### 1) Explore Scope

1. Identify review target:
   - PR number (`gh pr view`, `gh pr diff`) when available.
   - Otherwise local diff (`git diff`, `git diff --name-status`, `git diff --stat`).
2. Gather context:
   - Goal, acceptance criteria, linked issues/spec docs.
   - CI status and failing checks.
3. Triage review size:
   - If >400 changed lines or >15 files, call out review risk and suggest split.
4. Optional fast sizing:
   - `git diff <base>...<head> | python .agent/skills/code-review/scripts/pr-analyzer.py --stats`

### 2) Analyze Risk-First

Review changed files in this order:

1. Security-sensitive paths (`auth`, `token`, `secret`, input parsing, DB queries).
2. Core domain logic and state transitions.
3. Concurrency/async paths and error handling.
4. Data migrations/config/runtime wiring.
5. Tests and docs alignment.

For each file, evaluate:

- Logic correctness and edge cases.
- Security vulnerabilities and trust boundaries.
- Performance regressions and complexity growth.
- Backward compatibility and failure behavior.
- Test adequacy (happy path + edge/error cases).

### 3) Verify Claims

- Run targeted checks whenever possible:
  - Unit/integration tests relevant to changed code.
  - Lint/typecheck/build if risk suggests broader impact.
- Prefer minimal, high-signal verification over full-suite by default.
- If you cannot run a check, explicitly state: what was not run and residual risk.

### 4) Report with Fixed Structure

Use this output structure exactly:

```markdown
Findings

- [blocking] <title> — <path:line>
  - Risk: <what can break>
  - Evidence: <why this is true>
  - Fix: <specific change>
- [important] ...

Open Questions

- <question with context>

Summary

- <1-3 bullets: overall risk, test posture, merge readiness>

Validation

- Ran: `<commands>`
- Not run: `<commands and reason>`
```

## Severity Taxonomy

- `[blocking]`: Must fix before merge (correctness/security/data-loss/breaking behavior).
- `[important]`: High-value fix; can merge only with explicit acceptance of risk.
- `[nit]`: Non-blocking improvement with low risk.
- `[suggestion]`: Alternative approach, not required.
- `[learning]`: Educational note, no action required.
- `[praise]`: Explicitly call out strong implementation choices.

## Prompt and Feedback Best Practices

Apply these rules to keep review prompts and feedback effective:

1. Make scope explicit:
   - Bad: "review this"
   - Better: "review `git diff main...HEAD` for regressions, security issues, and missing tests."
2. Provide verification criteria:
   - Include commands or expected behavior that can prove/disprove findings.
3. Break complex reviews into passes:
   - Pass 1: architecture/risk map
   - Pass 2: line-level defects
   - Pass 3: tests/verification
4. Keep comments specific and actionable:
   - Include path/line, concrete failure mode, and concrete fix.
5. Avoid pure negative phrasing:
   - Prefer "Change X to Y so Z is guaranteed" over "don't do X."

## Progressive Reference Loading

Load only the references needed for the languages/frameworks present in the diff:

| Language/Framework | Reference                    |
| ------------------ | ---------------------------- |
| React              | `reference/react.md`         |
| Vue 3              | `reference/vue.md`           |
| TypeScript         | `reference/typescript.md`    |
| Rust               | `reference/rust.md`          |
| Python             | `reference/python.md`        |
| Java               | `reference/java.md`          |
| Go                 | `reference/go.md`            |
| C                  | `reference/c.md`             |
| C++                | `reference/cpp.md`           |
| CSS/Less/Sass      | `reference/css-less-sass.md` |
| Qt                 | `reference/qt.md`            |

Cross-cutting references:

- Architecture: `reference/architecture-review-guide.md`
- Performance: `reference/performance-review-guide.md`
- Security: `reference/security-review-guide.md`
- Common bugs: `reference/common-bugs-checklist.md`
- General review patterns: `reference/code-review-best-practices.md`

Optional output helpers:

- Full review template: `assets/pr-review-template.md`
- Quick checklist: `assets/review-checklist.md`
