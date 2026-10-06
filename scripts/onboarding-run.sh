#!/usr/bin/env bash
#
# The machine half of the M9-07 onboarding test. REQUIREMENTS §7: from
# `docker compose up`, finish the wizard, embed the widget on two sites under
# two brands and receive a ticket, in under 30 minutes. It times each step an
# operator takes, on a throwaway local stack, through the same HTTP calls the
# admin, the widget and the web form make:
#
#   1. docker compose up, until the api is healthy and the worker ready
#   2. the first-run wizard: admin account, first brand, finish
#   3. the admin's first sign-in, enrolling the required second factor
#   4. a second brand
#   5. each brand's widget allowed on its own site, and a visitor on each site
#      starting a conversation (with that site's Origin, as a browser sends it)
#   6. Channels › Web form switched on, and a customer sending the form
#   7. the agent finds a ticket in the list and replies
#
# A Telegram ticket, the last part of §7, needs a bot made with BotFather and a
# host Telegram can reach, so it is left to the clean-VM run. So is everything
# a person does: reading the guide, filling in `.env`, DNS, finding their way
# round the admin (docs/completed/onboarding-test.md).
#
#   HELPDOCK_VERSION=local scripts/onboarding-run.sh
#
# The image is `ghcr.io/docker-hunterpedia/helpdock:${HELPDOCK_VERSION}`; set
# HELPDOCK_VERSION to a published release to time a pull as well.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/drill-lib.sh
source "${repo_root}/scripts/drill-lib.sh"
# shellcheck source=scripts/compose-env.sh
source "${repo_root}/scripts/compose-env.sh"

export HELPDOCK_VERSION="${HELPDOCK_VERSION:-local}"
API_URL='http://127.0.0.1:3000'
env_path="${repo_root}/docker/.env"
compose=(docker compose --project-name helpdock-onboarding
  -f "${repo_root}/docker/docker-compose.yml" -f "${repo_root}/docker/docker-compose.dev.yml"
  --profile dev)

[[ -e "${env_path}" ]] && fail "Refusing to overwrite ${env_path}; move it aside first."
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans > /dev/null 2>&1 || true
  rm -f "${env_path}"
}
trap cleanup EXIT
write_compose_env "${env_path}" 'onboarding-password'

timings=()
step_started=''
begin() { step_started="$(now)"; }
finish() { timings+=("$(printf '%-44s %6s s' "$1" "$(elapsed "${step_started}")")"); }

# allow_and_start <brand> <site>: the brand's widget allowed on <site>, and a
# visitor there starting a conversation.
allow_and_start() {
  local brand="$1" site="$2" answer visitor
  answer="$(api PUT "/api/brands/${brand}/widget/access" "$(jq -nc --arg o "${site}" \
    '{allowedOrigins:[$o],captchaEnabled:false,captchaProvider:"turnstile",captchaSiteKey:""}')")"
  jq -e --arg o "${site}" '.access.allowedOrigins == [$o]' <<< "${answer}" > /dev/null \
    || fail "the widget was not allowed on ${site}: ${answer}"
  answer="$(curl -sS -H "origin: ${site}" -H 'content-type: application/json' \
    -d '{"locale":"en"}' "${API_URL}/api/widget/${brand}/session")"
  visitor="$(jq -r '.visitorSecret // empty' <<< "${answer}")"
  [[ -n "${visitor}" ]] || fail "no widget session on ${site}: ${answer}"
  curl -sS -H "origin: ${site}" -H 'content-type: application/json' \
    -H "authorization: Visitor ${visitor}" \
    -d "$(jq -nc --arg id "$(cat /proc/sys/kernel/random/uuid)" '{clientId:$id,text:"Hello from the widget"}')" \
    "${API_URL}/api/widget/${brand}/conversations" | jq -e '.conversation.id' > /dev/null \
    || fail "the widget on ${site} could not start a conversation"
}

# send_web_form <brand>: Channels › Web form on, and a customer sending it.
send_web_form() {
  local brand="$1" settings form submission status
  settings="$(api GET "/api/brands/${brand}/web-form")"
  api PUT "/api/brands/${brand}/web-form" "$(jq -c '{
      enabled: true,
      departmentId,
      captchaEnabled: .captcha.enabled,
      thankYou,
      fields: [.fields[] | {field, shown, required}]
    }' <<< "${settings}")" | jq -e '.enabled == true' > /dev/null || fail 'the web form would not switch on'

  form="$(curl -sS "${API_URL}/contact/${brand}")"
  submission="$(grep -o 'name="hd_submission" value="[^"]*"' <<< "${form}" | sed 's/.*value="//; s/"$//')"
  [[ -n "${submission}" ]] || fail 'the form page carries no submission id'
  status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    --data-urlencode 'name=Casey Customer' --data-urlencode 'email=casey@customer.test' \
    --data-urlencode 'subject=Where is my order?' --data-urlencode 'message=It has not arrived yet.' \
    --data-urlencode 'lang=en' --data-urlencode "hd_submission=${submission}" --data-urlencode 'hd_website=' \
    "${API_URL}/contact/${brand}")"
  [[ "${status}" == 2* ]] || fail "the form answered ${status}"
}

run_started="$(now)"

begin
if ! docker image inspect "ghcr.io/docker-hunterpedia/helpdock:${HELPDOCK_VERSION}" > /dev/null 2>&1; then
  "${compose[@]}" pull api > /dev/null 2>&1
fi
finish '0 image present (pulled if it was not)'

begin
"${compose[@]}" up -d > /dev/null 2>&1
wait_healthy api
wait_worker
finish '1 docker compose up, api healthy, worker ready'

begin
admin_email='owner@onboarding.test'
admin_password='a long onboarding passphrase'
run_wizard "${admin_email}" "${admin_password}" 'Onboarding Support' ONB
finish '2 first-run wizard'

begin
sign_in "${admin_email}" "${admin_password}"
finish '3 first sign-in (enrolling a second factor)'

begin
second_brand="$(api POST /api/install/brands \
  '{"name":"Second Brand","prefix":"SEC","defaultLocale":"ar","timezone":"Asia/Riyadh"}' \
  | jq -r '.id // empty')"
[[ -n "${second_brand}" ]] || fail 'the second brand was not created'
refresh_session
finish '4 second brand'

begin
allow_and_start "${BRAND_ID}" 'https://shop-one.example'
allow_and_start "${second_brand}" 'https://shop-two.example'
finish '5 widget on two sites, a conversation each'

begin
send_web_form "${BRAND_ID}"
finish '6 web form on, a customer sends it'

begin
tickets="$(api GET "/api/brands/${BRAND_ID}/tickets")"
[[ "$(jq '.tickets | length' <<< "${tickets}")" == 2 ]] \
  || fail "expected the widget and the form to file a ticket each: ${tickets}"
ticket_id="$(jq -r '.tickets[0].id' <<< "${tickets}")"
api POST "/api/brands/${BRAND_ID}/tickets/${ticket_id}/messages" \
  '{"kind":"public","bodyHtml":"<p>It is on its way and arrives tomorrow.</p>"}' \
  | jq -e '.seq' > /dev/null || fail 'the reply was refused'
finish '7 agent finds a ticket and replies'

printf '%s\n' "${timings[@]}"
printf '%-44s %6s s\n' 'total, from pull and up to first reply' "$(elapsed "${run_started}")"
echo 'Onboarding run passed.'
