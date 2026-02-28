# Security Best Practices Report

Date: 2026-02-27  
Scope: `apps/gateway`, `apps/engine`, `apps/web`, `tools/*` (TypeScript/Node.js)

Reviewed guidance:

- `javascript-express-web-server-security.md` (Fastify backendへの準用)
- `javascript-typescript-nextjs-web-server-security.md`
- `javascript-general-web-frontend-security.md`

## Executive Summary

主要な高リスク問題を 5 件検出しました。

- Critical: 1 件
- High: 2 件
- Medium: 2 件

最も重要なのは、`CONNECT_TOKEN_SECRET` 未設定時に固定値 `dev-secret` へフォールバックする実装です。これにより接続トークン偽造が可能になります。次点で、`MOCK_AUTH=true` により本番相当環境でも認証を無効化できる点、および `connect_token` がURLクエリとしてログに残る点が重大です。

---

## Critical Findings

### [SBP-001] Predictable fallback signing secret for connect tokens

- Rule ID: `EXPRESS-SECRETS-BASELINE` (secret must be mandatory, no insecure default)
- Severity: **Critical**
- Location: `apps/gateway/src/app.ts:314-317`
- Evidence:

```ts
const service = new ConnectTokenService({
  store,
  secret: process.env.CONNECT_TOKEN_SECRET || 'dev-secret',
});
```

- Impact (one sentence): 攻撃者が固定既知鍵で `connect_token` を署名でき、任意の `uid/matchId/agentId` でセッションを乗っ取れます。
- Fix:
  - `CONNECT_TOKEN_SECRET` を必須化し、未設定時は起動失敗させる。
  - 最低長（例: 32 bytes）を強制する。
  - 環境毎に Secret Manager 等から注入し、ローテーション手順を持つ。
- Mitigation:
  - 鍵ローテーションを即時実施し、既存トークンを失効。
  - 監査ログで異常な `matchId/agentId` の接続を検知。
- False positive notes:
  - なし（コード上で固定デフォルト値が存在）。

---

## High Findings

### [SBP-002] Authentication bypass toggle (`MOCK_AUTH`) is allowed outside tests

- Rule ID: `EXPRESS-AUTH-ENV-ISOLATION`
- Severity: **High**
- Location: `apps/gateway/src/app.ts:297-301`
- Evidence:

```ts
if (process.env.NODE_ENV === 'test' || process.env.MOCK_AUTH === 'true') {
  verifier = new MockFirebaseVerifier();
}
```

- Impact: `MOCK_AUTH=true` が設定されると実トークン検証が無効化され、任意Bearer文字列で `/v1/tokens` を発行可能になります。
- Fix:
  - `MOCK_AUTH` を `NODE_ENV === 'test'` に限定する。
  - `NODE_ENV=production` かつ `MOCK_AUTH=true` の場合は起動を拒否する。
- Mitigation:
  - デプロイ時に `MOCK_AUTH` の存在をCI/起動時チェックでブロック。
- False positive notes:
  - 開発/テスト用途としては有効だが、本番ガード不在が問題。

### [SBP-003] Connect token leakage risk in request logs

- Rule ID: `EXPRESS-SECRETS-LOGGING`
- Severity: **High**
- Location:
  - `apps/gateway/src/app.ts:575-577` (`connect_token` を query で受け取る)
  - `apps/gateway/src/logger.ts:3-13` (`req.url` / query redaction 未設定)
- Evidence:

```ts
const connectToken = getQueryStringValue(query.connect_token);
```

```ts
const redactPaths = [
  'req.headers.authorization',
  // ...snip...
  'connectToken',
  '*.connectToken',
];
```

- Impact: `req.url` に含まれる `connect_token` がログに残ると、TTL内のトークン再利用によるセッション不正利用につながります。
- Fix:
  - ログで `req.url` の `connect_token` / `session_id` をマスクする serializer/redaction を追加。
  - 可能であれば query 依存を減らし、より漏えいしにくいチャネルへ移行する。
- Mitigation:
  - ログアクセス権の最小化、保存期間短縮、トークンTTL短縮。
- False positive notes:
  - 実際にFastify標準リクエストログはURLを記録するため、理論上でなく実害可能性あり。

---

## Medium Findings

### [SBP-004] `trustProxy: true` is globally enabled (IP spoof / rate-limit bypass risk)

- Rule ID: `EXPRESS-PROXY-001`
- Severity: **Medium**
- Location:
  - `apps/gateway/src/app.ts:228-231`
  - `apps/gateway/src/app.ts:251-257` (rate limit key uses `req.ip`)
- Evidence:

```ts
const app = Fastify({
  logger: loggerOptions,
  trustProxy: true,
});
```

- Impact: 直接インターネット到達可能な構成では `X-Forwarded-For` を偽装され、IPベース制限が回避される恐れがあります。
- Fix:
  - `TRUST_PROXY` を明示設定化し、CIDR/ホップ数に限定する。
  - 不明な環境ではデフォルト `false`。
- Mitigation:
  - L4/L7 で直接アクセスを遮断し、正規プロキシ経由のみ許可。
- False positive notes:
  - 入口が厳密に管理された単一リバースプロキシのみなら影響は小さい。

### [SBP-005] No explicit WebSocket payload limit handling (DoS surface)

- Rule ID: `EXPRESS-DOS-INPUT-LIMITS`
- Severity: **Medium**
- Location:
  - `apps/gateway/src/app.ts:260` (websocket plugin registration)
  - `apps/gateway/src/app.ts:384-392` (message parse path)
- Evidence:

```ts
await app.register(websocket);
// ...
payload = JSON.parse(normalizeRawDataToText(rawData));
```

- Impact: 大きなフレームや多数送信でメモリ/CPU を消費し、Gateway 応答性低下を誘発できます。
- Fix:
  - `maxPayload` 等の上限を明示設定（例: 32KB 〜 128KB）。
  - 過大ペイロードは即時 close(code 1009)。
- Mitigation:
  - WAF/edge で接続レート・帯域制限を併用。
- False positive notes:
  - ライブラリ既定値はあるが、アプリ要件に対する明示的な制約としては不十分。

---

## Notes

- フロントエンド側で直ちに悪用可能な `innerHTML` / `eval` 系シンクは今回スコープでは検出なし。
- 次アクションは `SBP-001` と `SBP-002` を優先して修正するのが妥当。
