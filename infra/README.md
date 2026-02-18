# Infrastructure (Terraform)

`infra/` は SPEC §10 のデータ保持要件を Terraform で管理します。

## 作成対象リソース

- Firestore events コレクショングループ TTL (`expiresAt`)
- Cloud Storage バケット
  - Replay: 2 年後 Nearline へ移行
  - Audit logs: 3 年で削除
- Memorystore (Redis, 1GB, `maxmemory-policy=volatile-ttl`)
- Secret Manager シークレット (初期セット)

## 前提

- Terraform 1.8+
- GCP プロジェクト作成済み
- Application Default Credentials が設定済み

## 使い方

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan
terraform apply
```

## 補足

- Firestore TTL は `events` コレクショングループ内の `expiresAt` フィールドを参照します。
- アプリケーション側で `matches/{matchId}/events/{eventId}` へ書き込む際、`expiresAt` に作成時刻 + 365 日を設定してください。
