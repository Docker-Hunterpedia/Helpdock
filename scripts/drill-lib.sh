#!/usr/bin/env bash
#
# Helpers the restore drill (`restore-drill.sh`) and the onboarding run
# (`onboarding-run.sh`) share: waiting for a stack, the first-run wizard, and a
# staff sign-in that answers a second factor. Sourced, never run.
#
# The caller sets:
#   compose   array, the `docker compose …` command for the stack
#   API_URL   where the api answers, for example http://127.0.0.1:3000
#
# Needs curl and jq on the host. TOTP codes are computed by `node` inside the
# api container, so the host needs no Node of its own.

# Seconds since the epoch, with milliseconds, for the timings tables.
now() { date +%s.%3N; }

# elapsed <start>: seconds since <start>, to one decimal.
elapsed() { awk -v start="$1" -v end="$(now)" 'BEGIN { printf "%.1f", end - start }'; }

fail() {
  echo "FAIL $*" >&2
  exit 1
}

# wait_healthy <service> [tries]: until Compose reports the service healthy.
wait_healthy() {
  local service="$1" tries="${2:-90}" state=''
  for _ in $(seq 1 "${tries}"); do
    state="$("${compose[@]}" ps --format '{{.Health}}' "${service}" | head -n1)"
    [[ "${state}" == 'healthy' ]] && return 0
    [[ "${state}" == 'unhealthy' ]] && fail "${service} went unhealthy"
    sleep 2
  done
  fail "${service} never became healthy (last state: ${state:-none})"
}

# wait_worker: until the worker has started the outbox relay.
wait_worker() {
  for _ in $(seq 1 60); do
    "${compose[@]}" logs --no-color worker 2>/dev/null | grep -q 'Worker ready' && return 0
    sleep 2
  done
  fail 'the worker never started the outbox relay'
}

# totp_at <base32 secret> <step>: the six-digit RFC 6238 code for a 30 s step.
totp_at() {
  "${compose[@]}" exec -T api node -e '
    const [secret, step] = process.argv.slice(1);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    for (const c of secret.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
    const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const mac = require("node:crypto").createHmac("sha1", key).update(counter).digest();
    const offset = mac[mac.length - 1] & 15;
    console.log(String((mac.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, "0"));
  ' "$1" "$2"
}

# The api remembers the last step it accepted per account and refuses a replay
# (ASVS 2.8.4), so a second sign-in inside the same 30 s waits for the next
# step. Sets TOTP_CODE rather than printing it: a command substitution would
# run in a subshell and forget the step it used.
LAST_TOTP_STEP=0
fresh_totp() {
  local secret="$1" step
  step="$(( $(date +%s) / 30 ))"
  while (( step <= LAST_TOTP_STEP )); do
    sleep 1
    step="$(( $(date +%s) / 30 ))"
  done
  LAST_TOTP_STEP="${step}"
  TOTP_CODE="$(totp_at "${secret}" "${step}")"
}

# The refresh cookie the sign-in routes set, as a browser would keep it.
COOKIE_JAR="$(mktemp)"

# post_json <path> <json> [extra curl args…]: the response body.
post_json() {
  local path="$1" body="$2"
  shift 2
  curl -sS -b "${COOKIE_JAR}" -c "${COOKIE_JAR}" -H 'content-type: application/json' "$@" \
    -d "${body}" "${API_URL}${path}"
}

# refresh_session: a new access token from the refresh cookie, as the admin
# takes one. It carries roles granted since the last one, a new brand's included.
refresh_session() {
  TOKEN="$(curl -sS -b "${COOKIE_JAR}" -c "${COOKIE_JAR}" -X POST \
    "${API_URL}/api/auth/refresh" | jq -r '.accessToken // empty')"
  [[ -n "${TOKEN}" ]] || fail 'the session could not be refreshed'
}

# api <method> <path> [json]: an authenticated call with ${TOKEN}.
api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "${body}" ]]; then
    curl -sS -X "${method}" -H "authorization: Bearer ${TOKEN}" \
      -H 'content-type: application/json' -d "${body}" "${API_URL}${path}"
  else
    curl -sS -X "${method}" -H "authorization: Bearer ${TOKEN}" "${API_URL}${path}"
  fi
}

# run_wizard <email> <password> <brand name> <prefix>: the first-run wizard's
# admin and brand steps, then "complete". Sets BRAND_ID.
run_wizard() {
  local email="$1" password="$2" name="$3" prefix="$4" setup_token
  local same_site=(-H 'sec-fetch-site: same-origin')

  setup_token="$(post_json /api/install/setup/admin \
    "$(jq -nc --arg e "${email}" --arg p "${password}" '{name:"Drill Admin",email:$e,password:$p,locale:"en"}')" \
    "${same_site[@]}" | jq -r '.setupToken')"
  [[ -n "${setup_token}" && "${setup_token}" != 'null' ]] || fail 'the wizard would not create an admin'

  BRAND_ID="$(post_json /api/install/setup/brand \
    "$(jq -nc --arg n "${name}" --arg p "${prefix}" '{name:$n,prefix:$p,defaultLocale:"en",timezone:"UTC"}')" \
    "${same_site[@]}" -H "x-helpdock-setup: ${setup_token}" | jq -r '.brand.id')"
  [[ -n "${BRAND_ID}" && "${BRAND_ID}" != 'null' ]] || fail 'the wizard would not create a brand'

  curl -sS -o /dev/null -X POST "${same_site[@]}" -H "x-helpdock-setup: ${setup_token}" \
    "${API_URL}/api/install/setup/complete"
}

# sign_in <email> <password>: sets TOKEN. Answers whatever second factor the
# api asks for: an enrolment for an Admin without one (which sets TOTP_SECRET),
# or a code from ${TOTP_SECRET}, which the caller may set beforehand.
sign_in() {
  local email="$1" password="$2" response kind challenge
  response="$(post_json /api/auth/sign-in \
    "$(jq -nc --arg e "${email}" --arg p "${password}" '{email:$e,password:$p}')")"
  kind="$(jq -r '.kind // empty' <<< "${response}")"
  challenge="$(jq -r '.challengeId // empty' <<< "${response}")"

  case "${kind}" in
    session) ;;
    totp-enrolment-required)
      TOTP_SECRET="$(post_json /api/auth/enrolment/start \
        "$(jq -nc --arg c "${challenge}" '{challengeId:$c}')" | jq -r '.secret')"
      [[ -n "${TOTP_SECRET}" && "${TOTP_SECRET}" != 'null' ]] || fail 'enrolment did not start'
      fresh_totp "${TOTP_SECRET}"
      response="$(post_json /api/auth/enrolment/confirm \
        "$(jq -nc --arg c "${challenge}" --arg code "${TOTP_CODE}" '{challengeId:$c,code:$code}')")"
      ;;
    totp-required)
      [[ -n "${TOTP_SECRET:-}" ]] || fail "${email} needs a second factor and no TOTP secret was given"
      fresh_totp "${TOTP_SECRET}"
      response="$(post_json /api/auth/totp \
        "$(jq -nc --arg c "${challenge}" --arg code "${TOTP_CODE}" '{challengeId:$c,code:$code,trustDevice:false}')")"
      ;;
    *) fail "sign-in refused: ${response}" ;;
  esac

  TOKEN="$(jq -r '.accessToken // empty' <<< "${response}")"
  [[ -n "${TOKEN}" ]] || fail "sign-in did not open a session: ${response}"
}
