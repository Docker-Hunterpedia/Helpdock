#!/usr/bin/env bash
#
# The Compose stack the ZAP baseline scan runs against (M9-05, ARCHITECTURE §15),
# from an image that is already in the local daemon.
#
#   HELPDOCK_VERSION=ci ./scripts/zap-stack.sh up     # stack on 127.0.0.1:3000
#   ./scripts/zap-stack.sh down
#
# `up` finishes the first-run wizard with one brand, so the scan sees what a
# stranger reaches on a real install — the sign-in page and the api's public
# answers — rather than a wizard nobody leaves open.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_dir="${repo_root}/docker"
env_file="${compose_dir}/.env"
api_url='http://127.0.0.1:3000'

export HELPDOCK_VERSION="${HELPDOCK_VERSION:-ci}"
compose=(
  docker compose
  --project-name helpdock-zap
  -f "${compose_dir}/docker-compose.yml"
  -f "${compose_dir}/docker-compose.dev.yml"
)

down() {
  "${compose[@]}" logs --no-color --tail 80 api worker || true
  "${compose[@]}" --profile dev down --volumes --remove-orphans || true
  rm -f "${env_file}"
}

up() {
  if [[ -e "${env_file}" ]]; then
    echo "Refusing to overwrite ${env_file}; move it aside first." >&2
    exit 1
  fi

  # shellcheck source=scripts/compose-env.sh
  source "${repo_root}/scripts/compose-env.sh"
  write_compose_env "${env_file}" "zap-$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"

  "${compose[@]}" --profile dev up -d postgres redis minio minio-bucket api worker

  echo 'Waiting for the api to report healthy...'
  for _ in $(seq 1 60); do
    [[ "$("${compose[@]}" ps --format '{{.Health}}' api | head -n1)" == 'healthy' ]] && break
    sleep 5
  done
  [[ "$("${compose[@]}" ps --format '{{.Health}}' api | head -n1)" == 'healthy' ]] \
    || { echo 'api never became healthy' >&2; exit 1; }

  local same_site=(-H 'content-type: application/json' -H 'sec-fetch-site: same-origin')
  local setup_token
  setup_token="$(curl -sS "${same_site[@]}" \
    -d '{"name":"ZAP","email":"zap@helpdock.test","password":"a very long zap passphrase","locale":"en"}' \
    "${api_url}/api/install/setup/admin" | jq -r '.setupToken')"
  [[ -n "${setup_token}" && "${setup_token}" != 'null' ]] \
    || { echo 'the first-run wizard would not create an admin' >&2; exit 1; }

  curl -sSf -o /dev/null "${same_site[@]}" -H "x-helpdock-setup: ${setup_token}" \
    -d '{"name":"ZAP Support","prefix":"ZAP","defaultLocale":"en","timezone":"UTC"}' \
    "${api_url}/api/install/setup/brand"
  curl -sSf -o /dev/null "${same_site[@]}" -H "x-helpdock-setup: ${setup_token}" \
    -d '{"skip":true}' "${api_url}/api/install/setup/smtp"
  curl -sSf -o /dev/null -H 'sec-fetch-site: same-origin' -H "x-helpdock-setup: ${setup_token}" \
    -X POST "${api_url}/api/install/setup/complete"
  echo "The stack is up at ${api_url}, past the first-run wizard."
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *)
    echo "usage: $0 up|down" >&2
    exit 64
    ;;
esac
