#!/usr/bin/env bash
#
# Starts the Compose stack from an image that is already in the local daemon and
# checks the four things M0-09 claims: the api becomes healthy, it serves the
# admin build at `/`, it refuses a certificate for an unverified domain, and a
# route that needs a session still answers 401.
#
# M1-10 adds a fifth: an image goes all the way through the media pipeline —
# presign, PUT straight to MinIO, confirm, `media.process` on the worker — and
# comes back out as a WebP with the headers the pipeline promises. That half
# exercises the parts no unit test can: the real Compose network, the real
# worker process, and the `mc` sidecar that makes the bucket.
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
  # `--profile dev` on the way down too: without it Compose leaves the profiled
  # services — MinIO and its `mc` sidecar — running after the stack is gone.
  "${compose[@]}" --profile dev down --volumes --remove-orphans || true
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

# Caddy is left out: it would try to get certificates for hosts that do not
# resolve. The dev override publishes the api on 127.0.0.1:3000 instead.
#
# MinIO and its `mc` sidecar are in the `dev` profile, which is how a production
# install points `S3_*` at real object storage instead. The sidecar creates the
# bucket and exits; the api and the worker both need it to exist before an
# upload can be confirmed.
"${compose[@]}" --profile dev up -d postgres redis minio minio-bucket api worker

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

# The M0 exit criterion: a clean machine reaches the first-run wizard. The
# database this stack came up with is empty, so the api has to say `fresh`.
grep -q 'name="helpdock:install-state" content="fresh"' <<< "${body}" \
  || { echo 'FAIL a brand-new install did not offer the first-run wizard' >&2; exit 1; }
echo 'ok   a brand-new install reports itself as fresh'

setup_status="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H 'content-type: application/json' -H 'sec-fetch-site: cross-site' \
  -d '{"name":"Nope","email":"nope@example.test","password":"a very long passphrase","locale":"en"}' \
  http://127.0.0.1:3000/api/install/setup/admin)"
[[ "${setup_status}" == '403' ]] \
  || { echo "FAIL setup accepted a cross-site request (${setup_status})" >&2; exit 1; }
echo 'ok   setup refuses a browser that came from another site'

# The worker only starts once the api is healthy, so it is still booting when
# the checks above run.
for _ in $(seq 1 20); do
  "${compose[@]}" logs --no-color worker | grep -q 'Worker ready' && break
  sleep 3
done
"${compose[@]}" logs --no-color worker | grep -q 'Worker ready' \
  || { echo 'FAIL the worker did not start the relay' >&2; exit 1; }
echo 'ok   the worker started the outbox relay'

# ---------------------------------------------------------------------------
# M1-10: an image all the way through the media pipeline.
# ---------------------------------------------------------------------------

api_url='http://127.0.0.1:3000'
# Every setup call has to look like it came from this origin; the wizard refuses
# a cross-site one, which the check above already proved.
same_site=(-H 'content-type: application/json' -H 'sec-fetch-site: same-origin')

admin_email='smoke@helpdock.test'
admin_password='a very long smoke passphrase'

setup_token="$(curl -sS "${same_site[@]}" \
  -d "{\"name\":\"Smoke\",\"email\":\"${admin_email}\",\"password\":\"${admin_password}\",\"locale\":\"en\"}" \
  "${api_url}/api/install/setup/admin" | jq -r '.setupToken')"
[[ -n "${setup_token}" && "${setup_token}" != 'null' ]] \
  || { echo 'FAIL the first-run wizard would not create an admin' >&2; exit 1; }

brand_id="$(curl -sS "${same_site[@]}" -H "x-helpdock-setup: ${setup_token}" \
  -d '{"name":"Smoke Support","prefix":"SMK","defaultLocale":"en","timezone":"UTC"}' \
  "${api_url}/api/install/setup/brand" | jq -r '.brand.id')"
[[ -n "${brand_id}" && "${brand_id}" != 'null' ]] \
  || { echo 'FAIL the first-run wizard would not create a brand' >&2; exit 1; }
echo 'ok   the first-run wizard created an admin and a brand'

token="$(curl -sS -H 'content-type: application/json' \
  -d "{\"email\":\"${admin_email}\",\"password\":\"${admin_password}\"}" \
  "${api_url}/api/auth/sign-in" | jq -r '.accessToken')"
[[ -n "${token}" && "${token}" != 'null' ]] \
  || { echo 'FAIL the new admin could not sign in' >&2; exit 1; }

# Two forms on purpose: Fastify refuses a request that declares
# `content-type: application/json` and sends no body, so a bodyless call must
# not carry the header.
bearer=(-H "authorization: Bearer ${token}")
auth=("${bearer[@]}" -H 'content-type: application/json')

# The wizard seeds one department per brand, and there is no endpoint that lists
# them until M1-01, so the smoke test reads it the way an operator would.
department_id="$("${compose[@]}" exec -T -e PGPASSWORD="${password}" postgres \
  psql -U helpdock_owner -d helpdock -t -A \
  -c "SELECT id FROM departments WHERE brand_id = '${brand_id}' LIMIT 1" | tr -d '[:space:]')"
[[ -n "${department_id}" ]] \
  || { echo 'FAIL the new brand has no department' >&2; exit 1; }

ticket_id="$(curl -sS "${auth[@]}" \
  -d "{\"subject\":\"Smoke\",\"bodyHtml\":\"<p>Smoke</p>\",\"departmentId\":\"${department_id}\"}" \
  "${api_url}/api/brands/${brand_id}/tickets" | jq -r '.ticket.id')"
[[ -n "${ticket_id}" && "${ticket_id}" != 'null' ]] \
  || { echo 'FAIL could not create a ticket to attach to' >&2; exit 1; }

# A 1×1 PNG, small enough to inline and real enough for sharp to decode.
png_file="$(mktemp)"
base64 -d > "${png_file}" <<'PNG'
iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==
PNG
png_size="$(wc -c < "${png_file}" | tr -d '[:space:]')"

attachments_url="${api_url}/api/brands/${brand_id}/tickets/${ticket_id}/attachments"
presign="$(curl -sS "${auth[@]}" \
  -d "{\"kind\":\"image\",\"mime\":\"image/png\",\"size\":${png_size},\"fileName\":\"smoke.png\"}" \
  "${attachments_url}/presign")"
attachment_id="$(jq -r '.attachmentId' <<< "${presign}")"
upload_url="$(jq -r '.url' <<< "${presign}")"
[[ -n "${attachment_id}" && "${attachment_id}" != 'null' ]] \
  || { echo "FAIL presign refused the upload: ${presign}" >&2; exit 1; }
echo 'ok   the api presigned an upload'

# `--resolve` rather than rewriting the host: the signature covers the `Host`
# header, and `minio:9000` is the hostname the api signed for. The port is
# published on the loopback address by docker-compose.dev.yml.
put_status="$(curl -sS -o /dev/null -w '%{http_code}' \
  --resolve 'minio:9000:127.0.0.1' \
  -X PUT -H 'content-type: image/png' --data-binary "@${png_file}" "${upload_url}")"
rm -f "${png_file}"
[[ "${put_status}" == '200' ]] \
  || { echo "FAIL the presigned PUT answered ${put_status}" >&2; exit 1; }
echo 'ok   the object went straight to MinIO on a presigned URL'

confirm_status="$(curl -sS "${bearer[@]}" -X POST "${attachments_url}/${attachment_id}/confirm" \
  | jq -r '.status')"
[[ "${confirm_status}" == 'processing' ]] \
  || { echo "FAIL confirm left the attachment ${confirm_status}" >&2; exit 1; }
echo 'ok   confirm enqueued media.process through the outbox'

# The relay polls every 500 ms and the worker has an image to re-encode, so this
# is seconds rather than instant.
download=''
for _ in $(seq 1 40); do
  download="$(curl -sS "${bearer[@]}" "${attachments_url}/${attachment_id}?variant=webp")"
  [[ "$(jq -r '.attachment.status // empty' <<< "${download}")" == 'ready' ]] && break
  sleep 2
done
[[ "$(jq -r '.attachment.status // empty' <<< "${download}")" == 'ready' ]] \
  || { echo "FAIL the worker never made the attachment ready: ${download}" >&2; exit 1; }
echo 'ok   the worker processed the upload and marked it ready'

variants="$(jq -r '.attachment.variants | keys | join(",")' <<< "${download}")"
[[ "${variants}" == 'thumb320,thumb960,webp' ]] \
  || { echo "FAIL the variants were ${variants}" >&2; exit 1; }
echo 'ok   the image has a WebP and both thumbnails'

headers="$(curl -sS -D - -o /dev/null --resolve 'minio:9000:127.0.0.1' \
  "$(jq -r '.url' <<< "${download}")")"
grep -qi '^content-type: image/webp' <<< "${headers}" \
  || { echo 'FAIL the WebP variant was not served as image/webp' >&2; exit 1; }
grep -qi '^content-disposition: inline' <<< "${headers}" \
  || { echo 'FAIL the WebP variant was not served inline' >&2; exit 1; }
echo 'ok   the WebP variant is served inline with the right content type'

echo 'Compose smoke test passed.'
