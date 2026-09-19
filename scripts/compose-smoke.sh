#!/usr/bin/env bash
#
# Starts the Compose stack from an image that is already in the local daemon and
# checks the four things M0-09 claims: the api becomes healthy, it serves the
# admin build at `/`, it refuses a certificate for an unverified domain, and a
# route that needs a session still answers 401.
#
# It is the browser-less end-to-end test for the deliverable, and it runs in CI
# as a step of the `ci` job.
#
#   HELPDOCK_VERSION=ci ./scripts/compose-smoke.sh
#
# The image tag is `ghcr.io/docker-hunterpedia/helpdock:${HELPDOCK_VERSION}`.
# Compose builds it only if the daemon does not already have it.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_dir="${repo_root}/docker"
env_file="${compose_dir}/.env"

export HELPDOCK_VERSION="${HELPDOCK_VERSION:-ci}"
# A project name of its own. `down --volumes` below must never reach the volumes
# of a stack an operator is actually running from the same files.
compose=(
  docker compose
  --project-name helpdock-smoke
  -f "${compose_dir}/docker-compose.yml"
  -f "${compose_dir}/docker-compose.dev.yml"
)

# Checked before the trap is installed: the cleanup removes this file, and a
# `.env` that was already there belongs to whoever put it there.
if [[ -e "${env_file}" ]]; then
  echo "Refusing to overwrite ${env_file}; move it aside first." >&2
  exit 1
fi

cleanup() {
  "${compose[@]}" logs --no-color --tail 80 api worker || true
  "${compose[@]}" down --volumes --remove-orphans || true
  rm -f "${env_file}"
}
trap cleanup EXIT

password='smoke-password'
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
OUTBOUND_ALLOW_CIDRS=

ADMIN_HOST=admin.smoke.test
API_HOST=api.smoke.test
ACME_EMAIL=
POSTGRES_USER=helpdock_owner
POSTGRES_PASSWORD=${password}
POSTGRES_DB=helpdock
HELPDOCK_APP_PASSWORD=${password}
EOF

# Caddy is left out: it would try to get certificates for hosts that do not
# resolve. The dev override publishes the api on 127.0.0.1:3000 instead.
"${compose[@]}" up -d postgres redis api worker

echo 'Waiting for the api to report healthy...'
for _ in $(seq 1 60); do
  state="$("${compose[@]}" ps --format '{{.Health}}' api | head -n1)"
  [[ "${state}" == 'healthy' ]] && break
  [[ "${state}" == 'unhealthy' ]] && { echo 'api went unhealthy' >&2; exit 1; }
  sleep 5
done
[[ "$("${compose[@]}" ps --format '{{.Health}}' api | head -n1)" == 'healthy' ]] \
  || { echo 'api never became healthy' >&2; exit 1; }

check() {
  local description="$1" expected="$2" path="$3"
  local actual
  actual="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:3000${path}")"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "FAIL ${description}: GET ${path} answered ${actual}, expected ${expected}" >&2
    exit 1
  fi
  echo "ok   ${description} (${expected})"
}

check 'liveness' 200 /health
check 'readiness: database, Redis and settings all answered' 200 /ready
check 'the admin SPA is served at the root' 200 /
check 'no certificate for an unverified domain' 403 '/internal/domain-check?domain=nope.example'
check 'a session is still required for the API' 401 /api/me

body="$(curl -sS http://127.0.0.1:3000/)"
grep -q 'helpdock:primary-domain' <<< "${body}" \
  || { echo 'FAIL the root did not return the admin index.html' >&2; exit 1; }
echo 'ok   the root carries the install meta tags'

# The worker only starts once the api is healthy, so it is still booting when
# the checks above run.
for _ in $(seq 1 20); do
  "${compose[@]}" logs --no-color worker | grep -q 'Worker ready' && break
  sleep 3
done
"${compose[@]}" logs --no-color worker | grep -q 'Worker ready' \
  || { echo 'FAIL the worker did not start the relay' >&2; exit 1; }
echo 'ok   the worker started the outbox relay'

echo 'Compose smoke test passed.'
