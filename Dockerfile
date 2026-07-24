# =============================================================
# wacrm — Dockerfile para deploy no EasyPanel (Next.js standalone)
# =============================================================
# Multi-stage build:
#   1. deps    — instala node_modules com bun (lockfile-first)
#   2. builder — faz `next build` (usa output: "standalone")
#   3. runner  — imagem final mínima, apenas server.js + assets
#
# Uso no EasyPanel:
#   App type: Dockerfile
#   Port:     3000
#   Env vars: preencha as required do .env.local.example
# =============================================================

# ---- 1. deps ------------------------------------------------
FROM oven/bun:1.2-alpine AS deps
WORKDIR /app

# Copia apenas os manifests para cachear o install
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

# ---- 2. builder ---------------------------------------------
# IMPORTANTE: usamos Node (não Bun) para o `next build` porque o
# Next.js 16 depende de módulos nativos N-API (SWC/lightningcss)
# que o Bun ainda não carrega corretamente — resulta em
# "symbol 'napi_register_module_v1' not found in native module".
FROM node:20-alpine AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Vars públicas (NEXT_PUBLIC_*) precisam existir em build-time
# porque o Next inlineia elas no bundle do client. As secret/server
# vars (SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY, META_APP_SECRET)
# são lidas em runtime, então NÃO precisam estar aqui — configure
# no painel do EasyPanel.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_APP_LOCALE
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_APP_LOCALE=$NEXT_PUBLIC_APP_LOCALE

RUN npx --yes next build

# ---- 3. runner (imagem final) -------------------------------
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Usuário não-root
RUN addgroup --system --gid 1001 nodejs \
  && adduser  --system --uid 1001 nextjs

# Assets estáticos e output standalone
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
