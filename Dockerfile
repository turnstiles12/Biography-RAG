# syntax=docker/dockerfile:1.7
# Multi-stage build for the Next.js standalone server.
#   docker build -t biography-rag --build-arg NEXT_PUBLIC_APP_URL=https://bio.example.com .
# Debian (glibc) base image because onnxruntime-node ships glibc binaries.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS builder
COPY . .
ARG NEXT_PUBLIC_APP_URL=""
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    MODEL_CACHE_DIR=/app/.models
RUN npm run build
# Bake the local embedding model into the image so containers start without downloading it.
RUN npx tsx scripts/prefetch_model.ts

# "tools" target: full dependencies + sources, for migrations and seeding.
#   docker compose run --rm seed
FROM deps AS tools
COPY . .
COPY --from=builder /app/.models /app/.models
ENV MODEL_CACHE_DIR=/app/.models
CMD ["npm", "run", "seed"]

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    MODEL_CACHE_DIR=/app/.models
RUN groupadd --system app && useradd --system --gid app --home /app app

COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
COPY --from=builder --chown=app:app /app/migrations ./migrations
COPY --from=builder --chown=app:app /app/.models ./.models
# Server-external packages with native binaries (loaded dynamically, so copy them explicitly).
COPY --from=builder --chown=app:app /app/node_modules/@huggingface ./node_modules/@huggingface
COPY --from=builder --chown=app:app /app/node_modules/onnxruntime-node ./node_modules/onnxruntime-node
COPY --from=builder --chown=app:app /app/node_modules/onnxruntime-common ./node_modules/onnxruntime-common
COPY --from=builder --chown=app:app /app/node_modules/onnxruntime-web ./node_modules/onnxruntime-web
COPY --from=builder --chown=app:app /app/node_modules/sharp ./node_modules/sharp
COPY --from=builder --chown=app:app /app/node_modules/@img ./node_modules/@img

USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# server.js (from Next standalone output) binds to $HOSTNAME:$PORT.
CMD ["node", "server.js"]
