-- ============================================================
-- Debug capture for the WAHA webhook.
--
-- Persists every raw webhook body we receive so the inbox debug
-- panel can show exactly what WAHA sent, next to the DB rows we
-- ended up creating. Used to diagnose "why did name/phone/media
-- not render?" without SSHing into the box.
--
-- Idempotent. Run against your self-hosted Supabase.
-- ============================================================

create table if not exists public.waha_webhook_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid,
  session text,
  event text,
  chat_id text,
  phone text,
  message_id text,
  outcome text,
  reason text,
  payload jsonb,
  normalized jsonb,
  created_at timestamptz not null default now()
);

grant select on public.waha_webhook_events to authenticated;
grant all on public.waha_webhook_events to service_role;

alter table public.waha_webhook_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'waha_webhook_events'
      and policyname = 'debug read own account'
  ) then
    create policy "debug read own account"
      on public.waha_webhook_events
      for select
      to authenticated
      using (
        account_id in (
          select account_id from public.profiles where user_id = auth.uid()
        )
      );
  end if;
end $$;

create index if not exists waha_webhook_events_account_created_idx
  on public.waha_webhook_events (account_id, created_at desc);

create index if not exists waha_webhook_events_chat_idx
  on public.waha_webhook_events (account_id, chat_id, created_at desc);

create index if not exists waha_webhook_events_phone_idx
  on public.waha_webhook_events (account_id, phone, created_at desc);

-- Auto-prune: keep only the last ~5000 rows per account. Cheap
-- safety net so this doesn't grow unbounded in busy accounts.
create or replace function public.waha_webhook_events_prune()
returns trigger
language plpgsql
as $$
begin
  delete from public.waha_webhook_events e
  where e.account_id = new.account_id
    and e.id in (
      select id from public.waha_webhook_events
      where account_id = new.account_id
      order by created_at desc
      offset 5000
    );
  return new;
end;
$$;

drop trigger if exists waha_webhook_events_prune_trg on public.waha_webhook_events;
create trigger waha_webhook_events_prune_trg
  after insert on public.waha_webhook_events
  for each row execute function public.waha_webhook_events_prune();
