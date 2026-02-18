terraform {
  required_version = ">= 1.8.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.20"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  common_labels = merge(
    {
      managed_by  = "terraform"
      environment = var.environment
      service     = "moltgames"
    },
    var.labels
  )

  replay_bucket_name = "${var.project_id}-${var.environment}-replays"
  audit_bucket_name  = "${var.project_id}-${var.environment}-audit"
}

resource "google_project_service" "required" {
  for_each = toset([
    "firestore.googleapis.com",
    "redis.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com"
  ])

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_storage_bucket" "replays" {
  name                        = local.replay_bucket_name
  location                    = var.storage_location
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  force_destroy               = false
  labels                      = local.common_labels

  lifecycle_rule {
    action {
      type          = "SetStorageClass"
      storage_class = "NEARLINE"
    }

    condition {
      age = var.replay_nearline_transition_days
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_storage_bucket" "audit_logs" {
  name                        = local.audit_bucket_name
  location                    = var.storage_location
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  force_destroy               = false
  labels                      = local.common_labels

  lifecycle_rule {
    action {
      type = "Delete"
    }

    condition {
      age = var.audit_log_retention_days
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_firestore_field" "match_events_ttl" {
  project    = var.project_id
  database   = "(default)"
  collection = "events"
  field      = var.match_event_ttl_field

  ttl_config {}

  depends_on = [google_project_service.required]
}

resource "google_redis_instance" "match_state" {
  name           = "${var.environment}-moltgame-state"
  display_name   = "Moltgames ${upper(var.environment)} Match State"
  region         = var.region
  tier           = "BASIC"
  memory_size_gb = 1
  redis_version  = var.redis_version
  connect_mode   = "DIRECT_PEERING"
  labels         = local.common_labels

  redis_configs = {
    "maxmemory-policy" = "volatile-ttl"
  }

  authorized_network = var.redis_authorized_network

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret" "application" {
  for_each = var.secret_ids

  secret_id = each.value
  labels    = local.common_labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
}
