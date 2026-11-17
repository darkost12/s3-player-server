FROM node:22-alpine AS build
WORKDIR /app

ADD https://github.com/darkost12/s3-player-server/archive/refs/heads/main.tar.gz /tmp/src.tar.gz
RUN tar -xzf /tmp/src.tar.gz --strip-components=1 -C /app \
    && rm /tmp/src.tar.gz

RUN npm ci --omit=dev \
    && npm cache clean --force

FROM node:22-alpine
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package*.json ./
COPY --from=build /app/server.js /app/index.html ./
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/styles ./styles
COPY --from=build /app/assets ./assets

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "server.js"]
