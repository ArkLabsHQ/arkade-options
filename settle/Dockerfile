# Third-party settler. It watches filled-vault events on nostr.arkade.sh.
#
# Local (context = repository root):
#   docker build -f settle/Dockerfile -t arkade-options-settle .
#
# Dokploy: Docker File `settle/Dockerfile`, Docker Context Path `/` or `/settle`.
# The image clones the repo so a service-folder context still gets protocol and contracts.
FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache git
ADD https://api.github.com/repos/ArkLabsHQ/arkade-options/commits/master /tmp/master.json
RUN git clone --depth 1 https://github.com/ArkLabsHQ/arkade-options.git /tmp/src \
 && git -C /tmp/src rev-parse HEAD > /etc/git-commit \
 && cp -a /tmp/src/. /app/ \
 && rm -rf /tmp/src /app/.git \
 && corepack enable \
 && CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile --prod
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 8790
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8790/status').then((res)=>process.exit(res.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "settle/main.ts"]
