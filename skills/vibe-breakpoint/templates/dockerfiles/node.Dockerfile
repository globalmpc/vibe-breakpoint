# ponytail: npm/pnpm/yarn by lockfile (D-060), alpine/musl, single stage, keeps devDependencies (migration CLIs need them offline). Not covered: pnpm/yarn workspaces, pnpm lockfiles older than latest pnpm (no packageManager), Yarn Berry PnP, Yarn 4 --frozen-lockfile alias (best effort, unverified), private registries. pnpm 10 dependency build scripts are allowed via env var, image only (D-064): all dependency build scripts run at build time with network. Upgrade when a real repo fails (D-022).
FROM node:22-alpine
ENV NEXT_TELEMETRY_DISABLED=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 YARN_NODE_LINKER=node-modules
RUN apk add --no-cache openssl
WORKDIR /app
COPY package*.json pnpm-lock.yaml* yarn.lock* ./
RUN if [ -f pnpm-lock.yaml ]; then corepack enable pnpm && npm_config_dangerously_allow_all_builds=true pnpm_config_dangerously_allow_all_builds=true pnpm install --frozen-lockfile; elif [ -f yarn.lock ]; then corepack enable yarn && yarn install --frozen-lockfile; elif [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
COPY . .
ARG BUILD_CMD=true
# D-067: the fake env (same values the app gets) is a build secret: visible to BUILD_CMD only, never in a layer, history or the image env
RUN --mount=type=secret,id=vbenv while IFS== read -r k v; do [ -z "$k" ] || export "$k=$v"; done < /run/secrets/vbenv; sh -c "$BUILD_CMD"
