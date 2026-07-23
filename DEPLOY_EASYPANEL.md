# Deploy do wacrm no EasyPanel

Este guia assume que o **Supabase** já está rodando no seu EasyPanel
(banco + auth + storage) e você quer subir o app Next.js ao lado.

---

## 1. Pré-requisitos

Na VPS com EasyPanel, você já tem:
- Um projeto Supabase self-hosted rodando (com URL pública e chaves)
- Domínio apontando para a VPS (ex: `crm.seudominio.com`)

Anote:
- `NEXT_PUBLIC_SUPABASE_URL` — URL pública do seu Supabase
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — anon key
- `SUPABASE_SERVICE_ROLE_KEY` — service role key (segredo!)

---

## 2. Rodar as migrations no Supabase

Antes do primeiro deploy, aplique as migrations em `supabase/migrations/`
no seu banco. Duas opções:

**A) Via Supabase CLI (recomendado):**
```bash
supabase link --project-ref <seu-ref>
supabase db push
```

**B) Manualmente:** cole cada arquivo `.sql` de `supabase/migrations/`
no SQL Editor do Supabase Studio, em ordem alfabética.

---

## 3. Criar o app no EasyPanel

1. No EasyPanel, clique em **+ Service → App**
2. **Source:** GitHub → selecione `ArnasDon/wacrm` (ou seu fork)
3. **Build:** escolha **Dockerfile** (o `Dockerfile` na raiz já está pronto)
4. **Port:** `3000`

### Build Args (aba Build)
Estas variáveis `NEXT_PUBLIC_*` precisam existir em **build-time**
(o Next.js inlineia elas no bundle do client):

| Nome | Valor |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://supabase.seudominio.com` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `eyJhbGc...` |
| `NEXT_PUBLIC_SITE_URL` | `https://crm.seudominio.com` |
| `NEXT_PUBLIC_APP_LOCALE` | `pt` (ou `en`) |

### Environment (aba Environment) — runtime secrets
| Nome | Como obter |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | mesmo do build |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | mesmo do build |
| `NEXT_PUBLIC_SITE_URL` | mesmo do build |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` (32 bytes) |
| `META_APP_SECRET` | Meta for Developers → App Settings → Basic |

> **Opcionais** (só se for usar): `ALLOWED_INVITE_HOSTS`,
> `CRON_SECRET`, `SENTRY_DSN`, etc. Ver `.env.local.example`.

---

## 4. Domínio + HTTPS

Na aba **Domains** do serviço:
- Adicione `crm.seudominio.com`
- Ative **HTTPS** (o EasyPanel emite Let's Encrypt automaticamente)
- Aponte o DNS: `A` record → IP da VPS

O `NEXT_PUBLIC_SITE_URL` deve bater com este domínio.

---

## 5. Cron jobs (opcional mas recomendado)

O wacrm tem endpoints de cron para automações e flows agendados:
- `POST /api/automations/cron`
- `POST /api/flows/cron`

No EasyPanel, use **+ Service → Scheduler** ou configure um cron externo
chamando esses endpoints a cada 1-5 minutos. Se você definir
`CRON_SECRET`, envie no header `Authorization: Bearer <secret>`.

---

## 6. Webhook do WhatsApp

Depois do deploy, configure no Meta for Developers:
- **Callback URL:** `https://crm.seudominio.com/api/whatsapp/webhook`
- **Verify Token:** o que você definir dentro do app (Settings → WhatsApp)

O `META_APP_SECRET` valida a assinatura HMAC de cada POST.

---

## 7. Deploy

Clique em **Deploy** no EasyPanel. O build leva ~3-5 min na primeira vez.
Nos deploys seguintes, use auto-deploy via webhook do GitHub.

### Verificar
- `https://crm.seudominio.com` → tela de login
- Logs no EasyPanel não devem ter `Missing env` na inicialização

---

## Troubleshooting

**Build falha com "Missing NEXT_PUBLIC_SUPABASE_URL":**
Você esqueceu os Build Args. Precisam estar na aba Build, não só em Environment.

**App sobe mas login não funciona:**
Cheque se `NEXT_PUBLIC_SUPABASE_URL` é acessível de dentro do container
(se o Supabase está em outro serviço EasyPanel, use a URL pública ou
o nome do serviço na rede interna).

**Webhook retorna 401:**
`META_APP_SECRET` errado ou não definido no Environment.
