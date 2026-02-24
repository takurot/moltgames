# Deployment Runbook

This document describes the manual deployment process for development and staging environments.

## 1. Prerequisites

- GCP Project with Cloud Run, Secret Manager, and Memorystore enabled.
- Firebase project with Auth and Firestore enabled.
- Terraform installed.
- gcloud CLI authenticated.

## 2. Infrastructure Setup (Terraform)

```bash
cd infra
terraform init
terraform apply -var-file=terraform.tfvars
```

## 3. Secret Configuration

Ensure the following secrets are in Secret Manager:

- `connect-token-secret`

## 4. Manual Deployment to Cloud Run

### 4.1. Deploy Engine

```bash
cd apps/engine
gcloud builds submit --config cloudbuild.yaml .
```

### 4.2. Deploy Gateway

```bash
cd apps/gateway
gcloud builds submit --config cloudbuild.yaml .
```

## 5. Local E2E Verification

```bash
# Start Redis
docker run -d -p 6379:6379 redis:7-alpine

# Start Engine (Terminal 1)
cd apps/engine
pnpm dev

# Start Gateway (Terminal 2)
cd apps/gateway
pnpm dev

# Run E2E tests (Terminal 3)
pnpm test:e2e:local
```
