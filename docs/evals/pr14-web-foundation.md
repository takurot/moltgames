# EVAL DEFINITION: PR-14 Next.js フロント基盤

Defined: 2026-03-24
Branch: `feat/web-foundation`
Depends on: PR-02 (Firebase/GCP infra)

---

## Baseline Snapshot (pre-implementation)

| Check | Status |
|-------|--------|
| `pnpm typecheck` (8 packages) | ✅ PASS — 8/8 |
| `pnpm test:unit` (8 packages) | ✅ PASS — 49/49 |
| `apps/web` structure | TypeScript stub (no React/Next.js) |
| `apps/web` build | `tsc` compiles `src/index.ts` to `dist/` |

---

## Capability Evals

These must be NEW and working after implementation.

### CAP-01: Next.js app bootstrapped
- [ ] `apps/web/package.json` declares `next`, `react`, `react-dom` as dependencies
- [ ] `apps/web/next.config.ts` exists and is valid TypeScript
- [ ] `pnpm --filter @moltgames/web build` exits 0 (Next.js build, not tsc)
- **Grader**: code — `jq '.dependencies.next' apps/web/package.json` returns non-null; `pnpm --filter @moltgames/web build` exits 0

### CAP-02: tsconfig correct for Next.js + monorepo constraints
- [ ] `apps/web/tsconfig.json` includes `"jsx": "preserve"`
- [ ] `apps/web/tsconfig.json` includes `"lib": ["dom", "dom.iterable", "ES2022"]`
- [ ] `"rootDir"` and `"outDir"` are removed or overridden (Next.js manages output)
- [ ] `pnpm --filter @moltgames/web typecheck` exits 0
- **Grader**: code — grep checks + typecheck command

### CAP-03: Firebase Auth UI renders
- [ ] `firebase` (client SDK) is installed in `apps/web`
- [ ] A login page exists at `apps/web/src/app/(auth)/login/page.tsx` (or equivalent route)
- [ ] The page renders a sign-in UI offering Google and GitHub providers
- [ ] `connectAuthEmulator` is called when `FIREBASE_AUTH_EMULATOR_HOST` is set
- **Grader**: code — file existence check; grep for `GoogleAuthProvider` and `GithubAuthProvider`

### CAP-04: Common layout with navigation
- [ ] A root layout at `apps/web/src/app/layout.tsx` exists
- [ ] Layout includes navigation component (nav bar)
- [ ] Layout includes footer component
- [ ] Layout passes `pnpm --filter @moltgames/web typecheck`
- **Grader**: code — file existence + typecheck

### CAP-05: Design system foundation
- [ ] A design token file exists (CSS variables or Tailwind config) defining color palette and typography
- [ ] At least one shared UI component (e.g., `Button`) in `apps/web/src/components/ui/`
- [ ] Design tokens referenced by the layout/login page
- **Grader**: code — file existence check; grep for CSS custom properties or Tailwind theme extension

### CAP-06: Environment variable wiring
- [ ] `.env.example` contains `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_WS_BASE_URL`
- [ ] `apps/web/src/lib/firebase.ts` (or equivalent) reads these vars and throws at init if required vars are absent
- **Grader**: code — grep `.env.example`; grep for startup validation in firebase init file

### CAP-07: apphosting.yaml created
- [ ] `apphosting.yaml` exists at `apps/web/apphosting.yaml` (or repo root)
- [ ] File declares `runConfig` with `cpu`, `memoryMiB`, and `minInstances`
- **Grader**: code — file existence + YAML key check

### CAP-08: Turbo pipeline scripts preserved
- [ ] `apps/web/package.json` `scripts` includes `build`, `lint`, `typecheck`, `test:unit`, `test:integration`, `test:e2e`
- [ ] `pnpm --filter @moltgames/web test:unit` exits 0 (passes with no tests or with scaffold tests)
- **Grader**: code — `jq '.scripts | keys'` check; test command exit code

---

## Regression Evals

These must continue to PASS after implementation (must not break).

### REG-01: Existing typecheck (all other packages)
- Gateway, Engine, Domain, mcp-protocol, rules typecheck must remain ✅
- **Check**: `pnpm typecheck` exits 0; 8+ packages succeed (web adds 1 more)
- **pass^3 required**: must pass on 3 consecutive runs

### REG-02: Existing unit tests (all other packages)
- All 49 existing unit tests must still pass
- **Check**: `pnpm test:unit` exits 0; all prior 49 tests pass
- **pass^3 required**

### REG-03: Monorepo build (pnpm build)
- `pnpm build` exits 0 across all packages including new web
- Must not break gateway, engine, domain, mcp-protocol, rules builds

### REG-04: Lint (pnpm lint)
- `pnpm lint` exits 0 — no new ESLint errors introduced in `apps/web/`

### REG-05: No new `any` or `@ts-ignore` in web package
- **Check**: `grep -r '@ts-ignore\|: any' apps/web/src/` returns empty
- TypeScript strict mode (`strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) must hold

### REG-06: No hardcoded Firebase credentials
- **Check**: `grep -r 'AIza\|firebase\.com' apps/web/src/` returns no credential values (only variable references)
- Firebase config must be read from `process.env.NEXT_PUBLIC_*`

---

## Task Units (15-minute rule)

Each unit is independently verifiable. Implement in order; each must not break REG-01 through REG-06.

| # | Unit | Verifiable Outcome | Key Risk |
|---|------|--------------------|----------|
| **U1** | Replace `apps/web/package.json` — add Next.js, React, firebase deps; update scripts | `pnpm install` succeeds; scripts keys correct | ESM + `"type": "module"` conflict with CJS deps |
| **U2** | Add `apps/web/tsconfig.json` for Next.js (jsx, dom lib, drop rootDir/outDir) | `pnpm --filter @moltgames/web typecheck` exits 0 on empty app | `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` must be kept |
| **U3** | Create `apps/web/next.config.ts` and minimal `src/app/layout.tsx` + `src/app/page.tsx` | `pnpm --filter @moltgames/web build` exits 0 | CJS/ESM: use `next.config.ts`, not `.js` |
| **U4** | Design tokens — add CSS variables or Tailwind config + `globals.css` | Tokens referenced in layout; typecheck passes | Keep minimal; only color + typography |
| **U5** | Shared UI primitives — `Button` component in `src/components/ui/` | Component file exists; typecheck passes | Props must use explicit `undefined` for `exactOptionalPropertyTypes` |
| **U6** | Firebase client init — `src/lib/firebase.ts` reading `NEXT_PUBLIC_*` env vars | File validates required vars at init; no credential hardcoding | Client SDK vs admin SDK converter compatibility |
| **U7** | Firebase Auth UI — login page with Google + GitHub providers | Login page renders; both providers wired; emulator support | `connectAuthEmulator` only when env var set |
| **U8** | Common layout — navigation bar + footer components | Layout wraps all pages; nav includes auth state (logged in/out) | Auth context/provider setup |
| **U9** | `.env.example` — add Firebase client env vars | All required `NEXT_PUBLIC_FIREBASE_*` keys present | None |
| **U10** | `apphosting.yaml` — Firebase App Hosting config | File at `apps/web/apphosting.yaml` with `runConfig` | Check Firebase App Hosting docs for required fields |
| **U11** | Vitest scaffold for web — empty `test/unit/.gitkeep` + vitest config | `pnpm --filter @moltgames/web test:unit` exits 0 | Vitest + Next.js config alignment |

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Capability evals pass@1 | ≥ 6/8 |
| Capability evals pass@3 | 8/8 (100%) |
| Regression evals pass^3 | 6/6 (100%) — release gate |

---

## Grader Commands (copy-paste)

```bash
# CAP-01
jq '.dependencies.next' apps/web/package.json
pnpm --filter @moltgames/web build

# CAP-02
grep '"jsx"' apps/web/tsconfig.json
grep '"dom"' apps/web/tsconfig.json
pnpm --filter @moltgames/web typecheck

# CAP-03
jq '.dependencies.firebase' apps/web/package.json
grep -r 'GoogleAuthProvider\|GithubAuthProvider' apps/web/src/

# CAP-05
grep -r 'NEXT_PUBLIC_FIREBASE_API_KEY' .env.example

# CAP-07
test -f apps/web/apphosting.yaml && echo "EXISTS" || echo "MISSING"

# REG-05
grep -r '@ts-ignore\|: any' apps/web/src/ && echo "FAIL" || echo "PASS"

# REG-06
grep -r 'AIza' apps/web/src/ && echo "FAIL" || echo "PASS"

# Full regression suite
pnpm typecheck && pnpm test:unit && pnpm lint
```
