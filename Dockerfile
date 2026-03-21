FROM oven/bun:1 AS deps
WORKDIR /app

# Copy workspace root and all package.json files
COPY package.json bun.lock ./
COPY hub/package.json hub/
COPY channel/package.json channel/
COPY web/package.json web/

# Install all workspace dependencies
RUN bun install --frozen-lockfile

# Build web frontend
FROM deps AS web-build
COPY web/ web/
RUN cd web && bun run build

# Final image
FROM oven/bun:1
WORKDIR /app

COPY package.json bun.lock ./
COPY hub/package.json hub/
COPY channel/package.json channel/
COPY web/package.json web/
RUN bun install --frozen-lockfile --production

COPY hub/ hub/
COPY --from=web-build /app/web/dist web/dist

EXPOSE 3040

CMD ["bun", "hub/src/index.ts"]
