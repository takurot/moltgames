# Repository Guidelines

## Project Structure & Module Organization
This repo is a `pnpm` + Turborepo monorepo for the moltgames platform. Core apps live in `apps/`: `web` (Next.js UI), `gateway` (Fastify API/WebSocket), and `engine` (game execution). Shared code lives in `packages/`, especially `domain`, `mcp-protocol`, `rules`, and `eslint-config`. Developer tools live in `tools/` (`cli`, `agent-runner`). Infrastructure and policy files are under `firebase/` and `infra/`. Specs and implementation notes belong in `docs/`. Cross-workspace tests such as `test/unit/review-prompt.test.mjs` stay in the root `test/` directory.

## Build, Test, and Development Commands
- `pnpm install`: install workspace dependencies. Use Node `>=22` and `pnpm@10`.
- `pnpm --filter @moltgames/web dev`: run the web app locally.
- `pnpm lint`, `pnpm format:check`, `pnpm typecheck`: run monorepo quality checks.
- `pnpm test:unit`, `pnpm test:integration`, `pnpm test:e2e`: run the standard test layers across workspaces.
- `pnpm test:rules`: run Firestore rules tests with the Firebase Emulator (Java 21 required).
- `pnpm build`: build all packages and apps.
- `pnpm ci`: run the same full quality gate expected in GitHub Actions.

## Coding Style & Naming Conventions
TypeScript is the default language. Prettier enforces 2-space indentation, semicolons, single quotes, trailing commas, and `printWidth: 100`. Run `pnpm format` before large refactors. ESLint rejects `any` and unused variables unless the name starts with `_`. Use descriptive names and keep business logic separate from I/O. Follow existing file naming: kebab-case source files such as `queue-service.ts`, and colocated exports from `src/index.ts`.

## Testing Guidelines
Vitest is the primary test runner. Place tests inside each workspace under `test/unit`, `test/integration`, or `test/e2e`. Use names such as `*.test.ts`, `*.unit.test.ts`, `*.integration.test.ts`, and `*.rules.test.ts`. Coverage targets in `docs/PROMPT.md` are 90% for game-rule logic and 80% overall. Every business-logic change should add unit tests; service boundaries should add integration tests.

## Commit & Pull Request Guidelines
Recent history follows Conventional Commits with scope, for example `feat(cli): ...`, `fix(web): ...`, and `style(cli): ...`. Keep commits focused and reviewable. Open PRs from `codex/<type>/...` branches, not directly from `main`. PRs should summarize impacted apps/packages, link the issue or plan item, list commands you ran (for example `pnpm ci`), and include screenshots for visible `apps/web` changes.

## Security & Configuration Tips
Never commit secrets. Keep local settings in `.env.local`, and treat `CONNECT_TOKEN_SECRET`, `INTERNAL_TASK_AUTH_TOKEN`, and OpenAI keys as required runtime secrets. Use Firebase Emulators for integration work instead of production services.
