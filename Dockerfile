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
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
COPY web/ web/
RUN cd web && bun run build

# Final image
FROM oven/bun:1
WORKDIR /app

# Runtime env vars (Coolify passes these as ARGs; convert to ENV so they're available at runtime)
ARG SUPABASE_URL
ARG SUPABASE_ANON_KEY
ARG SUPABASE_SERVICE_ROLE_KEY
ARG HUB_ALLOWED_ORIGINS
ARG PORT=3040
ENV SUPABASE_URL=$SUPABASE_URL \
    SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY \
    SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY \
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
