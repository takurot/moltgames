# Benchmark Runbook

This document describes how to run the local agent battle benchmark.

## 1. Prerequisites

- Node.js 22+
- pnpm 10+
- Docker / Docker Compose
- Dependencies installed (`pnpm install`)

## 2. Quick Local Benchmark (Recommended)

Use this path for deterministic local verification without real Firebase ID tokens.

1. Start services:

```bash
docker compose up --build -d
```

2. Restart only `gateway` in development mode (required for local mock auth flow):

```bash
docker compose stop gateway
docker compose run -d -p 8080:8080 -e NODE_ENV=development gateway
```

3. Run benchmark:

```bash
pnpm test:bench:agents
```

4. Clean up:

```bash
docker compose down --remove-orphans
```

## 3. Real Auth Mode (Optional)

If you want to run with real Firebase ID token verification:

1. Start services:

```bash
docker compose up --build -d
```

2. Run benchmark with a valid Firebase ID token:

```bash
BENCH_AUTH_TOKEN="<firebase-id-token>" pnpm test:bench:agents
```

3. Clean up:

```bash
docker compose down
```

## 4. OpenAI Benchmark Mode (Optional)

```bash
export OPENAI_API_KEY="<your-api-key>"
pnpm test:bench:agents:openai
```

Useful options:

- `OPENAI_MODEL` (default: `gpt-4.1-mini`)
- `OPENAI_BENCH_MATCH_COUNT` (default: `1`)
- `OPENAI_MAX_OUTPUT_TOKENS` (default: `220`)

## 5. Troubleshooting

### 5.1 `HTTP 401 ... Invalid Firebase ID token`

Cause:

- Gateway is not running in development mode for mock auth, and benchmark uses default `BENCH_AUTH_TOKEN=valid-token`.

Fix:

- Use the "Quick Local Benchmark" flow above (restart gateway with `NODE_ENV=development`), or provide a real `BENCH_AUTH_TOKEN`.

### 5.2 `ECONNREFUSED 127.0.0.1:8080`

Cause:

- Gateway container is not exposing host port `8080`.

Fix:

- Start gateway with explicit port publish:

```bash
docker compose run -d -p 8080:8080 -e NODE_ENV=development gateway
```
