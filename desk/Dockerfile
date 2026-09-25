# Local image. Context is the repository root:
#   docker build -f desk/Dockerfile -t arkade-options-desk .
# Dokploy builds the repository Dockerfile instead, because its context was only this folder.
FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
COPY vendor vendor
RUN pnpm install --frozen-lockfile --prod
COPY protocol protocol
COPY desk desk
COPY contracts contracts
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 8788
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8788/status').then((res)=>process.exit(res.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "desk/main.ts"]
