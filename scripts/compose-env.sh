#!/usr/bin/env bash
#
# The `.env` a throwaway Compose stack runs with: the dev override's ports, MinIO
# for object storage, no Caddy, and a fresh master key. Sourced by
# `compose-smoke.sh` and `zap-stack.sh`, so the smoke test and the ZAP baseline
# scan run the same stack.
#
#   write_compose_env <file> <password>

write_compose_env() {
  local env_file="$1" password="$2"
  cat > "${env_file}" <<EOF
APP_URL=http://localhost:3000
APP_ROLE=api
APP_MASTER_KEY=$(head -c 32 /dev/urandom | base64)
NODE_ENV=production
PORT=3000
TRUST_PROXY=false
DATABASE_URL=postgres://helpdock_app:${password}@postgres:5432/helpdock
DATABASE_MIGRATION_URL=postgres://helpdock_owner:${password}@postgres:5432/helpdock
REDIS_URL=redis://redis:6379
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_BUCKET=helpdock
S3_ACCESS_KEY_ID=helpdock
S3_SECRET_ACCESS_KEY=${password}
# MinIO addresses a bucket as a path; virtual-host style would need DNS for
# `helpdock.minio`, which nothing in this stack provides.
S3_FORCE_PATH_STYLE=true
OUTBOUND_ALLOW_CIDRS=

ADMIN_HOST=admin.smoke.test
API_HOST=api.smoke.test
ACME_EMAIL=
POSTGRES_USER=helpdock_owner
POSTGRES_PASSWORD=${password}
POSTGRES_DB=helpdock
HELPDOCK_APP_PASSWORD=${password}
EOF
}
