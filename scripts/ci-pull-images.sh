#!/usr/bin/env bash
# Pulls Docker Hub images through Google's mirror with retries, and tags each
# under every name a later step may ask for.
#
# CI has no Docker Hub account (see the top of .github/workflows/ci.yml), so
# images come through mirror.gcr.io. The mirror answers 429 or 500 now and
# then, and one refused pull used to fail a whole job. Pulling ahead with a
# backoff turns that into a short wait: Testcontainers and Compose then find
# the image locally.
#
# usage: ci-pull-images.sh <image>...        e.g. pgvector/pgvector:pg17 redis:7-alpine
set -u

MIRROR="mirror.gcr.io"
ATTEMPTS=5

pull_with_retry() {
  local source="$1" attempt=1 wait=5
  while :; do
    if docker pull --quiet "$source" >/dev/null; then
      return 0
    fi
    if [ "$attempt" -ge "$ATTEMPTS" ]; then
      return 1
    fi
    echo "pull of $source failed (attempt $attempt of $ATTEMPTS); retrying in ${wait}s" >&2
    sleep "$wait"
    attempt=$((attempt + 1))
    wait=$((wait * 2))
  done
}

status=0
for image in "$@"; do
  case "$image" in
    */*) source="$MIRROR/$image" ;;
    *) source="$MIRROR/library/$image" ;;
  esac
  if pull_with_retry "$source"; then
    # The Hub name for Compose, and the prefixed name Testcontainers builds
    # from TESTCONTAINERS_HUB_IMAGE_NAME_PREFIX (it does not add `library/`).
    docker tag "$source" "$image"
    docker tag "$source" "$MIRROR/$image"
    echo "pulled $image"
  else
    echo "::warning::could not pull $image through $MIRROR after $ATTEMPTS attempts"
    status=1
  fi
done
exit "$status"
