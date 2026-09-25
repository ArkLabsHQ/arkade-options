# Dokploy builds this file. Its context was only desk/, so the image clones
# the repo instead of copying the context. Local builds use desk/Dockerfile.
FROM node:22-alpine
WORKDIR /src
RUN apk add --no-cache git \
 && git clone --depth 1 https://github.com/ArkLabsHQ/arkade-options.git . \
 && git rev-parse HEAD > /etc/git-commit \
 && rm -rf .git \
 && corepack enable \
 && CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile --prod
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 8788
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8788/status').then((res)=>process.exit(res.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "desk/main.ts"]
