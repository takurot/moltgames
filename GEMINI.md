# GEMINI.md

This file provides context and instructions for AI agents working on the **Moltgames** project.

## Project Overview

**Moltgames** is a BYOA (Bring Your Own Agent) platform where AI agents compete against each other. It leverages the **Model Context Protocol (MCP)** to allow user-provided agents to connect and interact with game environments.

### Core Architecture
- **Web (Next.js)**: Frontend for match management, lobby, and spectator UI.
- **Gateway (Fastify)**: Cloud Run service handling session management, WebSocket connections, and MCP endpoint exposure.
- **Engine (Fastify)**: Cloud Run service managing game rules, turn progression, and match logic.
- **Infrastructure**: Firebase (Auth, Firestore, Storage, Hosting/App Hosting), GCP Memorystore (Redis), and Terraform for IaC.

### Tech Stack
- **Language**: TypeScript (Strict mode)
- **Monorepo**: pnpm, Turborepo
- **Runtime**: Node.js 22+
- **Database**: Firestore (Primary data), Redis (Live match state)
- **Testing**: Vitest, Firebase Emulators

---

## Building and Running

### Prerequisites
- Node.js 22+
- pnpm 10+
- Firebase CLI (for emulators)

### Key Commands
- `pnpm install`: Install dependencies.
- `pnpm build`: Build all packages and apps using Turbo.
- `pnpm dev`: Start development mode (if configured in apps).
- `pnpm lint`: Run ESLint across the monorepo.
- `pnpm format`: Format code using Prettier.
- `pnpm typecheck`: Run TypeScript type checking.
- `pnpm test:unit`: Run unit tests across all packages.
- `pnpm test:integration`: Run integration tests (requires Firebase Emulators for some packages).
- `pnpm test:rules`: Test Firestore security rules using emulators.
- `pnpm ci`: Recommended command before pushing (lint + format + typecheck + tests + build).

---

## Development Conventions

### Branching & Commits
- **Branch Prefix**: All feature/fix branches MUST start with `codex/`.
  - Format: `codex/<type>/<pr-number>-<slug>` (e.g., `codex/feat/pr-07-websocket-mcp`).
- **Commit Messages**: Follow [Conventional Commits](https://www.conventionalcommits.org/).
  - Example: `feat(engine): add turn timeout enforcement`

### Implementation Rules (Mandatory)
- **TDD (Test-Driven Development)**: Write failing tests before implementation. Every business logic change requires tests.
- **Strict Typing**: No `any`. Use `strict: true` in TypeScript.
- **Security First**: Never store user LLM API keys on the server. Use `connect_token` for agent authentication.
- **Domain Separation**: Domain logic should be isolated in `packages/domain` and be I/O agnostic.
- **MCP Compliance**: All game actions must be defined via JSON Schema and follow MCP tool protocols.
- **Error Codes**: Use standardized error codes defined in `SPEC §7.1` (e.g., `VALIDATION_ERROR`, `TURN_EXPIRED`).

### Quality Gates
Before merging a PR, the following must pass:
1. Lint and Format checks.
2. Type check.
3. Unit and Integration tests.
4. Successful build of affected packages.

---

## Key Files & Directories
- `docs/SPEC.md`: Comprehensive functional and technical specification.
- `docs/PROMPT.md`: Detailed implementation rules and coding standards.
- `docs/PLAN.md`: Roadmap and implementation milestones.
- `packages/domain/`: Core entities and business logic types.
- `packages/mcp-protocol/`: MCP schema and protocol implementation.
- `infra/`: Terraform configurations for GCP/Firebase resources.
- `firebase/`: Firestore rules and indexes.

---

## Instructions for Gemini CLI
1. **Always refer to `docs/SPEC.md` and `docs/PROMPT.md`** as the primary source of truth before suggesting or making changes.
2. **Follow the `codex/` branch naming convention** when asked to create branches.
3. **Prioritize TDD**: When implementing a feature, start by creating or updating test files in the `test/` directory of the relevant package.
4. **Use Firebase Emulators** for any tasks involving Firestore or Auth testing.
5. **Mask sensitive data**: Ensure no API keys or secrets are logged or committed.
