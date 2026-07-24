-- ============================================================
-- WhatsApp provider abstraction (Meta official + WAHA unofficial)
--
-- Run this AGAINST YOUR SELF-HOSTED SUPABASE (kong.fotonardo.com.br)
-- via Studio → SQL editor, or psql. It's kept outside
-- supabase/migrations/ because that folder is reserved for the
-- managed Lovable Cloud migration tool; this project uses your own
-- Postgres instance.
--
-- Idempotent: safe to re-run.
-- ============================================================

alter table public.whatsapp_config
  add column if not exists provider text not null default 'meta',
  add column if not exists waha_base_url text,
  add column if not exists waha_api_key text,
  add column if not exists waha_session text;

-- Relax NOT NULL on Meta-only columns so WAHA rows insert without
-- placeholders. Application layer keeps them required for provider='meta'.
alter table public.whatsapp_config
  alter column phone_number_id drop not null,
  alter column access_token drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'whatsapp_config_provider_check'
  ) then
    alter table public.whatsapp_config
      add constraint whatsapp_config_provider_check
      check (provider in ('meta', 'waha'));
  end if;
end $$;

create index if not exists whatsapp_config_waha_session_idx
  on public.whatsapp_config (waha_session)
  where provider = 'waha';
