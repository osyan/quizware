# syntax=docker/dockerfile:1

# ---- dependencies (production only) ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM node:22-alpine
LABEL org.opencontainers.image.title="QuizWare" \
      org.opencontainers.image.description="Free browser-based quiz buzzer system: host screen, QR join, player buzz" \
      org.opencontainers.image.url="https://quizware.syss.hk" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PORT=4000 \
    BIND=0.0.0.0

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY public ./public

RUN addgroup -S quizware && adduser -S -G quizware quizware \
 && chown -R quizware:quizware /app
USER quizware

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
