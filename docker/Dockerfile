# Stage 1: Build React client
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2: Install server dependencies
FROM node:20-alpine AS server-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY prisma/ ./prisma/
RUN npx prisma generate

# Stage 3: Production image
FROM node:20-alpine
WORKDIR /app

RUN addgroup -g 1001 -S cushion && \
    adduser -S cushion -u 1001 -G cushion

COPY --from=server-deps /app/node_modules ./node_modules
COPY --from=server-deps /app/prisma ./prisma
COPY --from=client-build /app/client/dist ./client/dist
COPY src/ ./src/
COPY package.json ./

ENV NODE_ENV=production
ENV PORT=3000

USER cushion
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "src/app.js"]
