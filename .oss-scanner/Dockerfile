# syntax=docker/dockerfile:1
#
# The audit image for Anthropic's OSS Scanner (https://github.com/anthropics/oss-scanner).
# It is not the production image; that is docker/Dockerfile.
#
# The scanner builds this file with the repository as the build context and the
# network on, then runs its audit in the finished image with no network at all.
# Everything a build or a unit test needs is fetched here. The checkout stays at
# /src with its dev dependencies and build outputs, as the scanner expects.
#
# Build it from the repository root:
#   docker build -f .oss-scanner/Dockerfile -t helpdock-oss-scanner .
# Pass `--build-arg RUN_UNIT_TESTS=0` to skip the unit test run on a small machine.
#
# What it does not provide: Postgres 17 with pgvector, Redis, object storage and
# a Docker daemon. The integration suites start those with Testcontainers, so
# they skip themselves in this image (.oss-scanner/threat_model.md, "How to
# exercise it").

# Node 24, as .nvmrc says, pinned by digest so a rebuild gets the same base.
FROM node:24.22.0-bookworm@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0

ENV DEBIAN_FRONTEND=noninteractive \
    CI=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1

# ffmpeg is what the media pipeline runs on customer voice notes and videos
# (ARCHITECTURE §9), so a reproduction can drive it. git, python3 and a
# compiler are for the scanner's own tools and for any native rebuild.
# hadolint ignore=DL3008
RUN apt-get update \
  && apt-get install --no-install-recommends --yes \
       ca-certificates git python3 build-essential ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

# pnpm at the version `packageManager` names, fetched now so it runs offline
# later. pnpm 12 downloads its native binary on first run, so run it once here.
RUN corepack enable && corepack install && pnpm --version
ENV COREPACK_ENABLE_NETWORK=0

# The same install CI runs (.github/workflows/ci.yml), lockfile verification included.
RUN pnpm install --frozen-lockfile

# Every workspace: packages/* to dist/, the admin SPA and the widget bundle with
# Vite, the api with tsc. A step of its own, so a failure names it in the log.
# hadolint ignore=DL3059
RUN pnpm exec turbo run build

# The unit suites, as CI runs them, without the integration project. A failure
# is a warning in the build log, not a failed image.
ARG RUN_UNIT_TESTS=1
RUN if [ "$RUN_UNIT_TESTS" = "1" ]; then \
      pnpm exec vitest run --project='!integration' \
        || echo "WARNING: unit tests reported failures; see the output above"; \
    fi
