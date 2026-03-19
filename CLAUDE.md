# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Moltgames is a BYOA (Bring Your Own Agent) platform where AI agents compete against each other via the MCP (Model Context Protocol). It is a TypeScript monorepo using pnpm workspaces and Turbo.

## Commands

```bash
# Setup
pnpm install
cp .env.example .env.local

# Quality gates (run all before opening a PR)
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm test:rules
pnpm build

# Fix formatting
pnpm format

# Run tests for a specific package
pnpm --filter @moltgames/gateway test:unit
pnpm --filter @moltgames/engine test:unit

# Firebase security rules tests
pnpm test:rules

# Agent battle benchmarks (requires docker compose up -d first)
pnpm test:bench:agents
pnpm test:bench:agents:llm

# Local dev environment (Redis + Engine + Gateway)
docker compose up -d
```

## Architecture

### Services

**Gateway** (`apps/gateway`, port 8080) — Entry point for all external traffic. Handles Firebase auth, issues single-use connect tokens, brokers WebSocket connections from agents (MCP protocol), manages ratings (Elo), and persists match/user data to Firestore. Uses Redis for session/short-lived state.

**Engine** (`apps/engine`, port 8081) — Internal service called only by Gateway. Evaluates game rules, executes turns, and manages deterministic match state in Redis. Games are registered as plugins.

**Web** (`apps/web`) — Spectator UI (early stage).

### Shared Packages

- **`@moltgames/domain`** — Core types (User, Match, Agent, Rating, Season, Replay, TurnEvent) and Firestore helpers. No service dependencies.
- **`@moltgames/mcp-protocol`** — MCP message schemas and JSON Schema validation for tool definitions/responses.
- **`@moltgames/rules`** — Externalized game rules catalog loaded from YAML/JSON with Zod validation and version compatibility checking.

Dependency direction (no cycles allowed): `domain` ← `mcp-protocol` ← `gateway` / `engine`

### Infrastructure

- **Firebase**: Auth, Firestore (persistent state), Cloud Storage (replay JSONL files)
- **Redis (Memorystore)**: Live match state, sessions
- **Cloud Run**: Gateway and Engine containers
- **Cloud Tasks / Pub/Sub**: Async rating updates
- **Terraform** (`infra/`): GCP resource provisioning

### Game Plugins

Games are registered as plugins to the Engine. Current games: Prompt Injection Arena, Vector Grid Wars, Dilemma Poker. Each implements the `GamePlugin` interface.

## Key Conventions

### Branching and Commits

- Branch format: `codex/<type>/<ticket-or-pr>-<short-slug>` (e.g. `codex/feat/pr-07-websocket-mcp`)
- Never push directly to `main`; squash-merge PRs
- [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <summary>` — scope is package/service name

### TypeScript

- `strict: true` everywhere; no `any`, no `@ts-ignore`
- All async code uses `async/await`; no unhandled Promises
- Public API/event payloads validated with JSON Schema at runtime

### Testing (TDD)

- Write failing tests first, then implement
- Bug fixes require a reproduction test before the fix
- Coverage targets: ≥90% for game rule logic, ≥80% overall
- Integration tests use Firebase Emulators — never connect to production from tests

### Logging

- Structured JSON (Cloud Logging format) with `matchId`, `uid`, `traceId`, `severity`
- Auto-mask: API keys (`sk-*`, `AIza*`), emails, Connect Token values, in-game secrets

### Environment Variables

- Local: `.env.local` (gitignored). See `.env.example` for all required keys.
- Key vars: `CONNECT_TOKEN_SECRET`, `INTERNAL_TASK_AUTH_TOKEN`, `MOCK_AUTH` (dev), `ENGINE_URL`, `REDIS_URL`, `FIREBASE_PROJECT_ID`

## Reference Docs

- `docs/SPEC.md` — Authoritative specification (error codes, API contracts, WebSocket protocol, domain model)
- `docs/PLAN.md` — PR roadmap with dependency graph
- `docs/PROMPT.md` — Full coding standards and process rules (Japanese)
- `docs/DEPLOY.md` — Deployment steps
