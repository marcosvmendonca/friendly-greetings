-- Prevent duplicate WhatsApp message rows when WAHA fires both
-- `message` and `message.any` for the same wamid, or when two webhook
-- invocations race past the app-level SELECT-then-INSERT dedupe.
--
-- Scope is per-account so different tenants can't collide on the same
-- provider-generated id, and the index is partial so legacy rows with
-- NULL message_id (older Meta imports, manually inserted rows) don't
-- block the migration.
--
-- Safe to re-run: `IF NOT EXISTS` on both the dedupe cleanup and the
-- index creation. The cleanup keeps the oldest row per (account_id,
-- message_id) group and deletes newer duplicates so the unique index
-- can be built.

WITH ranked AS (
  SELECT m.id,
         row_number() OVER (
           PARTITION BY c.account_id, m.message_id
           ORDER BY m.created_at ASC, m.id ASC
         ) AS rn
  FROM public.messages m
  JOIN public.conversations c ON c.id = m.conversation_id
  WHERE m.message_id IS NOT NULL
)
DELETE FROM public.messages
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS messages_account_message_id_key
  ON public.messages (conversation_id, message_id)
  WHERE message_id IS NOT NULL;
