output "replay_bucket_name" {
  description = "Replay archive bucket name"
  value       = google_storage_bucket.replays.name
}

output "audit_bucket_name" {
  description = "Audit log bucket name"
  value       = google_storage_bucket.audit_logs.name
}

output "redis_host" {
  description = "Memorystore host"
  value       = google_redis_instance.match_state.host
}

output "redis_port" {
  description = "Memorystore port"
  value       = google_redis_instance.match_state.port
}

output "secret_resource_names" {
  description = "Secret Manager resource names"
  value       = [for secret in google_secret_manager_secret.application : secret.name]
}
