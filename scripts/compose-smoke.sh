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
# On the way there it does what a new operator does (M9-02): runs the first-run
# wizard, signs in as the administrator it made, and enrols the authenticator
# that account must have before it gets a session.
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
# shellcheck source=scripts/compose-env.sh
source "${repo_root}/scripts/compose-env.sh"
write_compose_env "${env_file}" "${password}"

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

# A code from an authenticator secret, as RFC 6238 computes it with the
# parameters the api uses (SHA-1, six digits, thirty-second steps). coreutils
# and openssl only: the runner that builds the image has no Node of its own.
totp_code() {
  local secret="$1"
  local padded="${secret}"
  while (( ${#padded} % 8 != 0 )); do padded+='='; done
  local key
  key="$(printf '%s' "${padded}" | base32 -d | od -An -tx1 -v | tr -d ' \n')"
  local step
  step="$(( $(date +%s) / 30 ))"
  local digest
  digest="$(printf "$(printf '%016x' "${step}" | sed 's/../\\x&/g')" \
    | openssl dgst -sha1 -mac HMAC -macopt "hexkey:${key}" | sed 's/^.* //')"
  local offset=$(( 16#${digest:39:1} ))
  local truncated=$(( 16#${digest:$((offset * 2)):8} & 0x7fffffff ))
  printf '%06d' "$(( truncated % 1000000 ))"
}

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

# The install administrator must have a second factor (DOMAIN-RULES §12, ASVS
# 4.3.1), so the first sign-in of the account the wizard made answers with an
# enrolment challenge rather than a session. The smoke test enrols the way the
# admin app does: start, read the secret back, confirm it with a live code —
# which also proves the authenticator maths against a real clock.
sign_in="$(curl -sS -H 'content-type: application/json' \
  -d "{\"email\":\"${admin_email}\",\"password\":\"${admin_password}\"}" \
  "${api_url}/api/auth/sign-in")"
[[ "$(jq -r '.kind // empty' <<< "${sign_in}")" == 'totp-enrolment-required' ]] \
  || { echo "FAIL the new admin was not sent to enrol an authenticator: ${sign_in}" >&2; exit 1; }
echo 'ok   the first sign-in of the install admin asks for an authenticator'

challenge_id="$(jq -r '.challengeId' <<< "${sign_in}")"
totp_secret="$(curl -sS -H 'content-type: application/json' \
  -d "{\"challengeId\":\"${challenge_id}\"}" \
  "${api_url}/api/auth/enrolment/start" | jq -r '.secret // empty')"
[[ -n "${totp_secret}" ]] \
  || { echo 'FAIL enrolment did not hand back an authenticator secret' >&2; exit 1; }

enrolled="$(curl -sS -H 'content-type: application/json' \
  -d "{\"challengeId\":\"${challenge_id}\",\"code\":\"$(totp_code "${totp_secret}")\"}" \
  "${api_url}/api/auth/enrolment/confirm")"
token="$(jq -r '.accessToken // empty' <<< "${enrolled}")"
[[ -n "${token}" ]] \
  || { echo "FAIL the new admin could not sign in: ${enrolled}" >&2; exit 1; }
[[ "$(jq -r '.recoveryCodes | length' <<< "${enrolled}")" == '10' ]] \
  || { echo 'FAIL enrolment did not hand back ten recovery codes' >&2; exit 1; }
echo 'ok   the new admin enrolled an authenticator and got a session'

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
