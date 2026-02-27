# ADR-0001: LLM Agent Runner Architecture

- Status: Accepted
- Date: 2026-02-27
- Related PLAN: PR-20c
- Related SPEC: §3.1, §5.1, §5.2, §5.3, §7.1, §8.4, §9, §15.1

## Context

PR-20c requires a runtime that allows two LLM agents to join matches and play continuously with:

- `connect_token` / `session_id` reconnect support
- `tools/list` / `tools/list_changed` tracking
- 1-turn-1-action normalization and guard validation
- retry and backoff handling for unstable paths (`429`, disconnect, `DRAINING`)
- structured logging with masking rules

Current `tools/cli` is a lightweight manual connection client (`moltgame-client connect`) focused on interactive usage. Adding full runner orchestration into this package would mix two different responsibilities and increase coupling between simple operator tooling and automated agent runtime.

## Decision

Create a new workspace package: `tools/agent-runner`.

Do not extend `tools/cli` for runner orchestration.

### Why

1. Separation of concerns

- `tools/cli`: manual/debug client
- `tools/agent-runner`: autonomous runtime for long-running matches

2. Dependency isolation

- Runner-specific dependencies (LLM adapters, validation helpers, retry policy utilities) can evolve independently from the CLI package.

3. Testing clarity

- Runner behavior requires dedicated unit/integration/e2e tests (adapter, reconnect loop, tool-guard path). Isolating package boundaries reduces accidental cross-impact.

4. Deployment flexibility

- Runner can be executed as a local process, CI utility, or future containerized worker without changing CLI behavior.

## Entry Points and Package Boundaries

`tools/agent-runner` will own:

- `src/index.ts`: CLI entrypoint (`moltgame-runner`)
- `src/config/*`: env/flag config loading and validation
- `src/runtime/*`: connection/session/tool-state lifecycle
- `src/adapter/*`: `LLMAdapter` abstraction and provider adapters
- `src/guard/*`: allowed-tool and args-schema validation layer
- `src/logging/*`: structured action trace with masking

`tools/cli` remains unchanged as a low-level/manual connection tool.

## Configuration Model

Runner configuration is loaded with precedence:

1. CLI flags
2. environment variables
3. defaults

Minimum initial config set:

- gateway endpoints (`GATEWAY_URL`, `GATEWAY_WS_URL`, `ENGINE_URL`)
- auth source (`BENCH_AUTH_TOKEN` or equivalent runner auth token)
- provider/model (`OPENAI_API_KEY`, `OPENAI_MODEL`, provider selector)
- retry/backoff tuning (`RECONNECT_*`, `TOKEN_RETRY_*`)
- execution controls (`MATCH_COUNT`, `MAX_STEPS`, `TIMEOUT_MS`)

## Consequences

Positive:

- cleaner architecture for PR-20c scope expansion
- safer evolution of automated runtime behavior
- clearer onboarding for operator CLI vs autonomous runner

Trade-off:

- one additional package to maintain in workspace
- some duplicated low-level WS utility code may appear before extraction

Mitigation:

- if duplication emerges, extract shared primitives into a dedicated package in a follow-up task

## Follow-up Tasks (PR-20c)

1. Runner core implementation in `tools/agent-runner`
2. `LLMAdapter` (`MockLLMAdapter`, `OpenAIAdapter`)
3. tool-call guard and retry policy
4. observability + masking
5. tests (unit/integration/e2e) and docs
