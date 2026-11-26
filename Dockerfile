FROM node:22-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS semgrep-build

ARG SEMGREP_VERSION=1.187.0
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates patchelf python3 python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /usr/local/lib/semgrep \
  && /usr/local/lib/semgrep/bin/pip install --no-cache-dir "semgrep==${SEMGREP_VERSION}" \
  && core="/usr/local/lib/semgrep/lib/python3.11/site-packages/semgrep/bin/semgrep-core" \
  && patchelf --set-rpath "$(dirname "$core")/libs" "$core"

FROM node:22-bookworm-slim AS gitleaks-build

ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_SHA256_X64=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
ARG GITLEAKS_SHA256_ARM64=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && arch="$(dpkg --print-architecture)" \
  && case "$arch" in \
    amd64) asset_arch=x64; sha256="$GITLEAKS_SHA256_X64" ;; \
    arm64) asset_arch=arm64; sha256="$GITLEAKS_SHA256_ARM64" ;; \
    *) echo "unsupported gitleaks architecture: $arch" >&2; exit 1 ;; \
  esac \
  && curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${asset_arch}.tar.gz" -o /tmp/gitleaks.tar.gz \
  && echo "$sha256  /tmp/gitleaks.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/gitleaks.tar.gz -C /tmp gitleaks

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap ca-certificates git python3 util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data /opt/opencode \
  && chown node:node /data /opt/opencode

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY --from=semgrep-build /usr/local/lib/semgrep /usr/local/lib/semgrep
COPY --from=gitleaks-build /tmp/gitleaks /usr/local/bin/gitleaks
RUN ln -s /usr/local/lib/semgrep/bin/semgrep /usr/local/bin/semgrep \
  && chmod 755 /usr/local/bin/gitleaks
COPY README.md LICENSE ./
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/maomao.sqlite \
    WORKSPACE_ROOT=/data/workspaces \
    HOME=/opt/opencode \
    OPENCODE_BIN=/opt/opencode/.opencode/bin/opencode \
    PATH=/opt/opencode/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
