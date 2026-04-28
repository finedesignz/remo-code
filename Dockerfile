FROM oven/bun:1 AS deps
WORKDIR /app

# Copy workspace root and all package.json files
COPY package.json bun.lock ./
COPY hub/package.json hub/
COPY web/package.json web/
COPY agent/package.json agent/

# Install all workspace dependencies
RUN bun install --frozen-lockfile

# Build web frontend (VITE_ vars are baked into the JS bundle at build time)
FROM deps AS web-build
ARG VITE_HUB_URL
COPY web/ web/
RUN cd web && bun run build

# Final image
FROM oven/bun:1
WORKDIR /app

# Runtime env vars (Coolify passes these as ARGs; convert to ENV so they're available at runtime)
ARG DATABASE_URL
ARG JWT_SECRET
ARG HUB_ALLOWED_ORIGINS
ARG PORT=3040
ENV DATABASE_URL=$DATABASE_URL \
    JWT_SECRET=$JWT_SECRET \
    HUB_ALLOWED_ORIGINS=$HUB_ALLOWED_ORIGINS \
    PORT=$PORT

COPY package.json bun.lock ./
COPY hub/package.json hub/
COPY web/package.json web/
COPY agent/package.json agent/
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
RUN bun install --frozen-lockfile --production

COPY hub/ hub/
COPY --from=web-build /app/web/dist web/dist

RUN groupadd -r appuser && useradd -r -g appuser -d /app appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 3040

CMD ["bun", "hub/src/index.ts"]
