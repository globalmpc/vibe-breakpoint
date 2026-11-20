# ponytail: npm only, alpine/musl, single stage, keeps devDependencies (migration CLIs need them offline). Upgrade when a real repo fails (D-022).
FROM node:22-alpine
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
COPY . .
ARG BUILD_CMD=true
RUN ${BUILD_CMD}
