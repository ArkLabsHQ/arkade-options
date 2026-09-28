# Oracle service and its dashboard, one port.
#
# Local (context = repository root):
#   docker build -f oracle/Dockerfile -t arkade-options-oracle .
#
# Dokploy: Docker File `./Dockerfile` (or `oracle/Dockerfile`), Docker Context
# Path `/oracle` or `/`. The image clones the repo so a service-folder context
# still gets package.json, vendor, protocol, and contracts.
FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache git
ADD https://api.github.com/repos/ArkLabsHQ/arkade-options/commits/master /tmp/master.json
RUN git clone --depth 1 https://github.com/ArkLabsHQ/arkade-options.git /tmp/src \
 && cp -a /tmp/src/. /app/ \
 && rm -rf /tmp/src /app/.git \
 && corepack enable \
 && CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile \
 && pnpm oracle:page
ENV DATA_DIR=/data HOST=0.0.0.0
VOLUME /data
EXPOSE 8789
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8789/api/status').then((res)=>process.exit(res.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "--experimental-eventsource", "oracle/main.ts"]
