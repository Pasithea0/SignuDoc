# SignuDoc, run on a server of your own. Next.js 16 on Node 24, with
# Postgres and a directory on disk for the documents; see
# docs/self-hosting.md. Nothing here needs Vercel.
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
# --include=dev because the build needs the tooling (Tailwind, PostCSS,
# TypeScript). A NODE_ENV=production in the environment, which some platforms
# pass as a build argument, would otherwise skip it and `next build` fails on
# a missing @tailwindcss/postcss.
RUN npm ci --include=dev --no-audit --no-fund

FROM node:24-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
# The build needs no database: db/migrate.mjs runs when the container
# starts, so a redeploy applies whatever is new before the app serves.
RUN npm run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    STORAGE_DRIVER=local \
    STORAGE_LOCAL_DIR=/data/storage

RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs signudoc \
    && mkdir -p /data/storage \
    && chown -R signudoc:nodejs /data

COPY --from=builder /app/public ./public
COPY --from=builder --chown=signudoc:nodejs /app/.next/standalone ./
COPY --from=builder --chown=signudoc:nodejs /app/.next/static ./.next/static
# Read at runtime from process.cwd() (src/lib/services/pdf-fonts.ts), so they
# stay where the code looks for them.
COPY --from=builder --chown=signudoc:nodejs /app/src/assets/fonts ./src/assets/fonts
COPY --from=builder --chown=signudoc:nodejs /app/node_modules/harfbuzzjs ./node_modules/harfbuzzjs
# Applied on start, before the app is served: a fresh database gets its
# tables and a populated one only what is new.
COPY --from=builder --chown=signudoc:nodejs /app/db ./db

USER signudoc
EXPOSE 3000

# A database that is not up yet is waited for; one that never comes up stops
# the start, rather than serving pages that cannot read anything.
CMD ["sh", "-c", "tries=0; until node db/migrate.mjs --optional; do tries=$((tries+1)); if [ \"$tries\" -ge 12 ]; then echo 'database unreachable; giving up' >&2; exit 1; fi; echo \"database not ready, retrying in 5s (attempt $tries)\"; sleep 5; done; exec node server.js"]
