# syntax=docker/dockerfile:1
#
# One image, two roles (ARCHITECTURE §3): `APP_ROLE=api` serves HTTP and the
# admin SPA, `APP_ROLE=worker` drains the queues. Same code, same config, one
# entry point.
#
# Build it from the repository root, not from this directory:
#   docker build -f docker/Dockerfile -t helpdock:dev .
#
# Nothing here downloads a binary for a fixed architecture, so `docker buildx
# build --platform linux/amd64,linux/arm64` works without a second recipe.

ARG NODE_IMAGE=node:24-bookworm-slim

# --- deps: the whole workspace's dependencies, cached on the lockfile ---------
FROM ${NODE_IMAGE} AS deps
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=1
WORKDIR /repo
RUN corepack enable

# `pnpm fetch` populates the store from the lockfile alone, so every layer below
# it is reused until a dependency actually changes. `package.json` comes with it
# because corepack reads `packageManager` from it to pick the pnpm version.
#
# `trustLockfile` skips pnpm's supply-chain verification of the lockfile, which
# is a network round trip per entry and took sixteen minutes on the first build
# here. It is not skipped anywhere else: a developer's `pnpm install` and the CI
# step that runs before this image is built both verify the very same lockfile,
# and this build resolves nothing of its own. The setting is appended to the
# copy inside the image and never to the file in the repository; `COPY . .`
# below puts the repository's own version back.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN printf '\ntrustLockfile: true\n' >> pnpm-workspace.yaml && pnpm fetch

COPY . .
RUN pnpm install --frozen-lockfile --offline --trust-lockfile

# --- build: compile every workspace, then prune to what the api runs ----------
FROM deps AS build
WORKDIR /repo

# `apps/helpcenter` and `apps/widget` are still placeholders; their `build` is a
# `tsc` over one file, so the whole graph builds and nothing is special-cased.
RUN pnpm build

# `pnpm deploy` writes a self-contained tree: the api's own files plus the
# production dependency graph, with the workspace packages copied in rather than
# symlinked out of the monorepo. pnpm 12 needs no `injectWorkspacePackages` and
# no `--legacy` for it.
RUN pnpm --filter @helpdock/api --prod deploy /out

# --- runtime -----------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# ffmpeg normalises voice notes and takes video posters (ARCHITECTURE §9).
# ARCHITECTURE §1 names a static binary; Debian's package is what M0 installs,
# because it is multi-arch without a per-architecture download. Swapping it for
# a pinned static build is an M1 decision, when the media pipeline lands.
RUN apt-get update \
  && apt-get install --no-install-recommends --yes ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# A fixed uid so a bind-mounted volume has predictable ownership.
RUN groupadd --gid 10001 helpdock \
  && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin helpdock

WORKDIR /app
COPY --from=build /out ./
# The admin SPA the api serves at `/` on the admin host (ARCHITECTURE §3).
COPY --from=build /repo/apps/admin/dist ./admin

ENV NODE_ENV=production \
    ADMIN_DIST_DIR=/app/admin \
    PORT=3000
# `APP_ROLE` is deliberately not defaulted: Compose sets it per service, and a
# worker that silently started an HTTP listener would be a hard thing to notice.

USER helpdock
EXPOSE 3000

# There is no curl in the slim image, and Node has fetch. A worker has no
# listener, so `docker-compose.yml` disables this check for that service.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/health`).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["node", "dist/main.js"]

# Last, so a version change rebuilds only this layer.
ARG HELPDOCK_VERSION=0.0.0
LABEL org.opencontainers.image.title="Helpdock" \
      org.opencontainers.image.description="Open-source, self-hosted customer support platform." \
      org.opencontainers.image.source="https://github.com/Docker-Hunterpedia/Helpdock" \
      org.opencontainers.image.documentation="https://github.com/Docker-Hunterpedia/Helpdock/blob/main/docs/guides/install.md" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${HELPDOCK_VERSION}"
