variable "project_id" {
  description = "GCP project id"
  type        = string
}

variable "environment" {
  description = "Deployment environment name (dev, staging, prod)"
  type        = string
  default     = "dev"
}

variable "region" {
  description = "Primary region"
  type        = string
  default     = "us-central1"
}

variable "storage_location" {
  description = "GCS location for buckets"
  type        = string
  default     = "US-CENTRAL1"
}

variable "match_event_ttl_field" {
  description = "Firestore timestamp field used by events collection-group TTL"
  type        = string
  default     = "expiresAt"
}

variable "replay_nearline_transition_days" {
  description = "Days to transition replay objects to Nearline"
  type        = number
  default     = 730
}

variable "audit_log_retention_days" {
  description = "Days to retain audit logs before deleting"
  type        = number
  default     = 1095
}

variable "redis_authorized_network" {
  description = "Optional VPC network self-link for Memorystore (null = default VPC)"
  type        = string
  default     = null
}

variable "secret_ids" {
  description = "Secret Manager secret ids to provision"
  type        = set(string)
  default = [
    "moltgame-connect-token-signing-key",
    "moltgame-engine-internal-auth",
    "moltgame-webhook-signing-key"
  ]
}

variable "labels" {
  description = "Additional labels applied to all resources"
  type        = map(string)
  default     = {}
}
