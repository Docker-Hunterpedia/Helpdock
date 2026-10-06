#!/usr/bin/env bash
#
# The restore drill of DOMAIN-RULES §10 and PRD M9-10: back up a running
# Compose stack (Postgres dump, the object storage bucket, `.env`), restore it
# into a fresh stack, and check the restored install is the same one.
# docs/guides/restore-drill.md is the runbook.
#
#   scripts/restore-drill.sh backup  <dir>   dump the running stack into <dir>
#   scripts/restore-drill.sh restore <dir>   restore <dir> into a stack with no data
#   scripts/restore-drill.sh verify  <dir>   compare the restored stack with <dir>
#   scripts/restore-drill.sh rehearse        all three, on throwaway local stacks, timed
#
# Environment (all optional):
#   HELPDOCK_PROJECT   Compose project name                    (default: helpdock)
#   HELPDOCK_COMPOSE   colon-separated Compose files           (default: docker/docker-compose.yml)
#   HELPDOCK_PROFILES  colon-separated Compose profiles, e.g. dev for the bundled MinIO
#   API_URL            where the api answers from this host    (default: http://127.0.0.1:3000)
#   DRILL_KEEP         rehearse only: leave the stacks and files behind to inspect
#   DRILL_EMAIL, DRILL_PASSWORD, DRILL_TOTP_SECRET
#                      a staff account for the sign-in and attachment checks;
#                      without them those two checks are skipped, and say so
#
# `.env` is read from beside the first Compose file, as Compose itself reads it.
# Needs docker with Compose v2, curl and jq.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/drill-lib.sh
source "${repo_root}/scripts/drill-lib.sh"

API_URL="${API_URL:-http://127.0.0.1:3000}"
# The bucket is copied with MinIO's client, which talks to any S3 API. The image
# is the one docker-compose.yml already pins, so the drill pulls nothing new.
MC_IMAGE='cgr.dev/chainguard/minio@sha256:bd014394a80898e68c149f2311fdf8d5a2c2f3bb2c33b9327ae6d02b4b065ae1'
# Rows whose counts must survive a restore. Not every table: the ones a person
# would notice missing.
COUNTED_TABLES=(brands users departments contacts tickets ticket_messages attachments
  hc_articles settings audit_log)

configure_stack() {
  local project="${HELPDOCK_PROJECT:-helpdock}"
  local files="${HELPDOCK_COMPOSE:-${repo_root}/docker/docker-compose.yml}"
  local file profile
  compose=(docker compose --project-name "${project}")
  IFS=':' read -r -a compose_files <<< "${files}"
  for file in "${compose_files[@]}"; do
    compose+=(-f "${file}")
  done
  if [[ -n "${HELPDOCK_PROFILES:-}" ]]; then
    IFS=':' read -r -a profiles <<< "${HELPDOCK_PROFILES}"
    for profile in "${profiles[@]}"; do
      compose+=(--profile "${profile}")
    done
  fi
  env_file="$(dirname "${compose_files[0]}")/.env"
  network="${project}_default"
}

# psql as the migration owner, which owns every table and so sees every brand.
owner_psql() {
  "${compose[@]}" exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -t -A "$@"' psql "$@"
}

# mc <args…>: MinIO's client on the stack's network, with the stack's S3
# credentials as the alias `hd`, and <dir> mounted at /drill.
mc() {
  local dir="$1"
  shift
  docker run --rm --network "${network}" --env-file "${env_file}" \
    --user "$(id -u):$(id -g)" -e MC_CONFIG_DIR=/tmp/mc -v "${dir}:/drill" \
    --entrypoint sh "${MC_IMAGE}" -c \
    'mc alias set hd "$S3_ENDPOINT" "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null && '"$*"
}

count_rows() {
  local table
  for table in "${COUNTED_TABLES[@]}"; do
    printf '%s\t%s\n' "${table}" "$(owner_psql -c "SELECT count(*) FROM ${table}")"
  done
}

# The newest attachment the media pipeline finished, as brand<TAB>ticket<TAB>id<TAB>kind.
sample_attachment() {
  owner_psql -F $'\t' -c "SELECT brand_id, ticket_id, id, kind FROM attachments
    WHERE status = 'ready' ORDER BY created_at DESC LIMIT 1"
}

# attachment_sha256 <brand> <ticket> <id> <kind>: the SHA-256 of the bytes the
# api hands a signed-in agent. The presigned URL names the bucket host as the
# api sees it, so the api container fetches it.
attachment_sha256() {
  local variant='' url
  [[ "$4" == 'image' ]] && variant='?variant=webp'
  url="$(api GET "/api/brands/$1/tickets/$2/attachments/$3${variant}" | jq -r '.url // empty')"
  [[ -n "${url}" ]] || fail "the api would not issue a download URL for attachment $3"
  "${compose[@]}" exec -T api node -e '
    fetch(process.argv[1]).then(async (r) => {
      if (!r.ok) { console.error(`download answered ${r.status}`); process.exit(1); }
      const bytes = Buffer.from(await r.arrayBuffer());
      console.log(require("node:crypto").createHash("sha256").update(bytes).digest("hex"));
    });' "${url}"
}

have_drill_account() { [[ -n "${DRILL_EMAIL:-}" && -n "${DRILL_PASSWORD:-}" ]]; }

drill_sign_in() {
  TOTP_SECRET="${DRILL_TOTP_SECRET:-}"
  sign_in "${DRILL_EMAIL}" "${DRILL_PASSWORD}"
}

backup() {
  local dir="$1" started
  mkdir -p "${dir}"
  dir="$(cd "${dir}" && pwd)"
  [[ -f "${env_file}" ]] || fail "no .env at ${env_file}"
  started="$(now)"

  "${compose[@]}" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' \
    > "${dir}/helpdock.dump"
  install -m 600 "${env_file}" "${dir}/env"
  mkdir -p "${dir}/bucket"
  mc "${dir}" 'mc mirror --quiet --overwrite "hd/$S3_BUCKET" /drill/bucket' > /dev/null

  count_rows > "${dir}/counts.tsv"
  (cd "${dir}/bucket" && find . -type f -print0 | sort -z | xargs -0 -r sha256sum) > "${dir}/bucket.sha256"

  local sample
  sample="$(sample_attachment)"
  if [[ -n "${sample}" ]] && have_drill_account; then
    drill_sign_in
    IFS=$'\t' read -r brand ticket id kind <<< "${sample}"
    printf '%s\t%s\t%s\t%s\t%s\n' "${brand}" "${ticket}" "${id}" "${kind}" \
      "$(attachment_sha256 "${brand}" "${ticket}" "${id}" "${kind}")" > "${dir}/attachment.tsv"
  fi

  echo "backup    $(elapsed "${started}") s  $(du -sh "${dir}" | cut -f1) in ${dir}"
}

restore() {
  local dir started
  dir="$(cd "$1" && pwd)"
  [[ -f "${dir}/helpdock.dump" && -f "${dir}/env" ]] || fail "${dir} is not a drill backup"
  if [[ -f "${env_file}" ]] && ! cmp -s "${dir}/env" "${env_file}"; then
    fail "${env_file} differs from the backup's env; move it aside first"
  fi
  install -m 600 "${dir}/env" "${env_file}"
  started="$(now)"

  # Postgres and Redis first, without the api: it would migrate an empty
  # database the dump then collides with. Profiled services (the bundled MinIO
  # and its bucket step) come up with them.
  local infra=(postgres redis)
  [[ ":${HELPDOCK_PROFILES:-}:" == *':dev:'* ]] && infra+=(minio minio-bucket)
  "${compose[@]}" up -d "${infra[@]}" > /dev/null 2>&1
  wait_healthy postgres

  [[ "$(owner_psql -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")" == '0' ]] \
    || fail 'the target database is not empty; restore into a fresh stack'
  "${compose[@]}" exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --exit-on-error' \
    < "${dir}/helpdock.dump"
  local restored_db
  restored_db="$(elapsed "${started}")"

  [[ " ${infra[*]} " == *' minio '* ]] && wait_healthy minio
  mc "${dir}" 'mc mb --ignore-existing "hd/$S3_BUCKET" >/dev/null && mc mirror --quiet --overwrite /drill/bucket "hd/$S3_BUCKET"' > /dev/null
  local restored_bucket
  restored_bucket="$(elapsed "${started}")"

  "${compose[@]}" up -d > /dev/null 2>&1
  wait_healthy api
  wait_worker

  echo "restore   $(elapsed "${started}") s  (database ${restored_db} s, bucket ${restored_bucket} s, then the stack)"
}

verify() {
  local dir started
  dir="$(cd "$1" && pwd)"
  started="$(now)"

  diff <(count_rows) "${dir}/counts.tsv" > /dev/null \
    || fail "row counts differ: $(diff <(count_rows) "${dir}/counts.tsv" | tr '\n' ' ')"
  echo "ok   row counts match ($(paste -sd' ' < <(cut -f2 "${dir}/counts.tsv")))"

  local scratch
  scratch="$(mktemp -d)"
  mkdir -p "${scratch}/bucket"
  mc "${scratch}" 'mc mirror --quiet "hd/$S3_BUCKET" /drill/bucket' > /dev/null
  (cd "${scratch}/bucket" && find . -type f -print0 | sort -z | xargs -0 -r sha256sum) \
    | diff - "${dir}/bucket.sha256" > /dev/null || fail 'the bucket differs from the backup'
  echo "ok   the bucket matches, object for object ($(wc -l < "${dir}/bucket.sha256") objects)"
  rm -rf "${scratch}"

  if have_drill_account; then
    drill_sign_in
    echo "ok   ${DRILL_EMAIL} signed in, second factor included"
    if [[ -f "${dir}/attachment.tsv" ]]; then
      local brand ticket id kind expected
      IFS=$'\t' read -r brand ticket id kind expected < "${dir}/attachment.tsv"
      [[ "$(attachment_sha256 "${brand}" "${ticket}" "${id}" "${kind}")" == "${expected}" ]] \
        || fail "attachment ${id} downloads different bytes"
      echo "ok   attachment ${id} downloads the same bytes"
    fi
  else
    echo 'skip sign-in and attachment download: set DRILL_EMAIL and DRILL_PASSWORD'
  fi

  echo "verify    $(elapsed "${started}") s"
}

# A local rehearsal: a source stack with a brand, a ticket and an image, backed
# up, destroyed, and restored into a second stack under another project name.
rehearse() {
  export HELPDOCK_VERSION="${HELPDOCK_VERSION:-local}"
  export HELPDOCK_COMPOSE="${repo_root}/docker/docker-compose.yml:${repo_root}/docker/docker-compose.dev.yml"
  export HELPDOCK_PROFILES=dev
  export DRILL_EMAIL='drill@helpdock.test' DRILL_PASSWORD='a long drill passphrase for the rehearsal'
  # Global, not local: the EXIT trap runs after this function has returned.
  drill_dir="$(mktemp -d)"
  env_path="${repo_root}/docker/.env"
  local dir="${drill_dir}"
  [[ -e "${env_path}" ]] && fail "Refusing to overwrite ${env_path}; move it aside first."

  cleanup() {
    if [[ -n "${DRILL_KEEP:-}" ]]; then
      echo "DRILL_KEEP is set: the stacks, ${env_path} and ${drill_dir} are left for you"
      return
    fi
    for project in helpdock-drill-source helpdock-drill-target; do
      HELPDOCK_PROJECT="${project}" configure_stack
      "${compose[@]}" down --volumes --remove-orphans > /dev/null 2>&1 || true
    done
    rm -f "${env_path}"
    rm -rf "${drill_dir}"
  }
  trap cleanup EXIT

  # shellcheck source=scripts/compose-env.sh
  source "${repo_root}/scripts/compose-env.sh"
  write_compose_env "${env_path}" 'drill-password'

  HELPDOCK_PROJECT=helpdock-drill-source configure_stack
  "${compose[@]}" up -d postgres redis minio minio-bucket api worker > /dev/null 2>&1
  wait_healthy api
  wait_worker
  run_wizard "${DRILL_EMAIL}" "${DRILL_PASSWORD}" 'Drill Support' DRL
  sign_in "${DRILL_EMAIL}" "${DRILL_PASSWORD}"
  export DRILL_TOTP_SECRET="${TOTP_SECRET}"
  seed_ticket_with_image
  echo "source    brand ${BRAND_ID}, ticket ${TICKET_ID}, attachment ${ATTACHMENT_ID}"

  backup "${dir}"
  "${compose[@]}" down --volumes > /dev/null 2>&1
  # The api answered on the same port; the target must not reach the old one.
  rm -f "${env_path}"

  HELPDOCK_PROJECT=helpdock-drill-target configure_stack
  restore "${dir}"
  verify "${dir}"
  rotate_master_key
  echo 'Restore drill rehearsal passed.'
}

# set_env <key> <value>: replaces or appends one line of ${env_file}.
set_env() {
  local rest
  rest="$(grep -v "^$1=" "${env_file}")"
  printf '%s\n%s=%s\n' "${rest}" "$1" "$2" > "${env_file}"
}

# The master key rotation of docs/guides/operations.md, on the restored stack:
# both keys set, `keys rotate`, sign in, then the previous key removed and the
# install checked to need nothing from it.
rotate_master_key() {
  local started old
  started="$(now)"
  old="$(grep '^APP_MASTER_KEY=' "${env_file}" | cut -d= -f2-)"
  set_env APP_MASTER_KEY_PREVIOUS "${old}"
  set_env APP_MASTER_KEY "$(head -c 32 /dev/urandom | base64)"
  "${compose[@]}" up -d api worker > /dev/null 2>&1
  wait_healthy api
  "${compose[@]}" exec -T api node dist/cli.js keys rotate
  # The password hash is still under the previous key's pepper; this sign-in
  # verifies it with that one and replaces it.
  drill_sign_in

  set_env APP_MASTER_KEY_PREVIOUS ''
  "${compose[@]}" up -d api worker > /dev/null 2>&1
  wait_healthy api
  "${compose[@]}" exec -T api node dist/cli.js keys rotate | tail -n 1
  drill_sign_in
  echo "ok   rotated the master key; ${DRILL_EMAIL} signs in under the new key alone"
  echo "rotate    $(elapsed "${started}") s"
}

seed_ticket_with_image() {
  local department png size presign upload_url
  department="$(api GET "/api/brands/${BRAND_ID}/departments" | jq -r '.departments[0].id')"
  TICKET_ID="$(api POST "/api/brands/${BRAND_ID}/tickets" \
    "$(jq -nc --arg d "${department}" '{subject:"Restore drill",bodyHtml:"<p>Before the backup</p>",departmentId:$d}')" \
    | jq -r '.ticket.id')"
  [[ -n "${TICKET_ID}" && "${TICKET_ID}" != 'null' ]] || fail 'could not create a ticket'

  png="$(mktemp)"
  base64 -d > "${png}" <<'PNG'
iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==
PNG
  size="$(wc -c < "${png}" | tr -d '[:space:]')"
  presign="$(api POST "/api/brands/${BRAND_ID}/tickets/${TICKET_ID}/attachments/presign" \
    "{\"kind\":\"image\",\"mime\":\"image/png\",\"size\":${size},\"fileName\":\"drill.png\"}")"
  ATTACHMENT_ID="$(jq -r '.attachmentId' <<< "${presign}")"
  upload_url="$(jq -r '.url' <<< "${presign}")"
  curl -sS -o /dev/null --fail --resolve 'minio:9000:127.0.0.1' -X PUT \
    -H 'content-type: image/png' --data-binary "@${png}" "${upload_url}" || fail 'upload refused'
  rm -f "${png}"
  api POST "/api/brands/${BRAND_ID}/tickets/${TICKET_ID}/attachments/${ATTACHMENT_ID}/confirm" > /dev/null
  for _ in $(seq 1 40); do
    [[ "$(api GET "/api/brands/${BRAND_ID}/tickets/${TICKET_ID}/attachments/${ATTACHMENT_ID}?variant=webp" \
      | jq -r '.attachment.status // empty')" == 'ready' ]] && return 0
    sleep 1
  done
  fail 'the worker never made the attachment ready'
}

command="${1:-}"
case "${command}" in
  backup | restore | verify)
    [[ $# -eq 2 ]] || fail "usage: $0 ${command} <dir>"
    configure_stack
    "${command}" "$2"
    ;;
  rehearse) rehearse ;;
  *)
    sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
