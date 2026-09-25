FROM debian:bookworm-slim AS sandbox-build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev linux-libc-dev && rm -rf /var/lib/apt/lists/*
COPY deploy/pdf-sandbox/launcher.c /tmp/launcher.c
RUN cc -std=c11 -O2 -Wall -Wextra -Werror -D_FORTIFY_SOURCE=2 -fPIE -pie -Wl,-z,relro,-z,now /tmp/launcher.c -o /usr/local/bin/signhere-pdf-sandbox

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json vite.config.ts vite.central.config.ts ./
COPY server ./server
COPY web ./web
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

# Optional central trust service (signhere.se / signhere.prpl.se). Not needed by self-hosted
# installations. Build with: docker build --target central .
FROM node:24-bookworm-slim AS central
ENV NODE_ENV=production PORT=3100 HOST=0.0.0.0 CENTRAL_KEYS_DIR=/keys CENTRAL_WEB_DIR=/app/dist/central-web
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE ./
RUN install -d -o node -g node -m 0700 /keys
USER node
VOLUME ["/keys"]
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3100/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/central/index.js"]

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 DATA_DIR=/data \
    SIGNHERE_KEYS_DIR=/keys SIGNHERE_SEAL_PYTHON=/opt/signhere-seal/bin/python \
    SIGNHERE_PDF_SANDBOX_LAUNCHER=/usr/local/bin/signhere-pdf-sandbox SIGNHERE_REQUIRE_PDF_SANDBOX=true \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
# The PDF/CMS library is bundled; operators do not install Python or a certificate.
# A virtualenv avoids modifying Debian's externally managed Python installation.
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/pdf-seal/requirements.txt /tmp/pdf-seal-requirements.txt
RUN python3 -m venv /opt/signhere-seal \
    && /opt/signhere-seal/bin/pip install --no-cache-dir --require-hashes -r /tmp/pdf-seal-requirements.txt \
    && rm /tmp/pdf-seal-requirements.txt
COPY --from=sandbox-build /usr/local/bin/signhere-pdf-sandbox /usr/local/bin/signhere-pdf-sandbox
# Code stays root-owned: the parser sandbox may read it, and must never be able to
# truncate it, even when a deployment omits the read-only root filesystem.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE ./
COPY scripts ./scripts
RUN install -d -o node -g node -m 0700 /data /keys
USER node
VOLUME ["/data", "/keys"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/start.mjs"]
