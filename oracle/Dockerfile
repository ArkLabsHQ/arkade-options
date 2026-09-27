# Oracle service and its dashboard, one port. Context is the repository root:
#   docker build -f oracle/Dockerfile -t arkade-options-oracle .
FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
COPY vendor vendor
RUN CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile
COPY app/settle-math.js app/settle-math.js
COPY contracts contracts
COPY protocol protocol
COPY oracle oracle
RUN node oracle/build.mjs
ENV DATA_DIR=/data HOST=0.0.0.0
VOLUME /data
EXPOSE 8789
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8789/api/status').then((res)=>process.exit(res.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "oracle/main.ts"]
