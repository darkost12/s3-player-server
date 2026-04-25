FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js  .
COPY index.html .
COPY scripts/   scripts/
COPY styles/    styles/
COPY assets/    assets/

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "server.js"]
