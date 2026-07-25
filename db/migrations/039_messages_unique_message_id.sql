-- Prevent duplicate WhatsApp message rows when WAHA fires both
-- `message` and `message.any` for the same wamid, or when two webhook
-- invocations race past the app-level SELECT-then-INSERT dedupe.
--
-- Matches the existing app-level dedupe (per conversation + message_id)
-- and is partial so legacy rows with NULL message_id don't block the
-- index build. Safe to re-run.

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY conversation_id, message_id
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM public.messages
  WHERE message_id IS NOT NULL
)
DELETE FROM public.messages
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS messages_conversation_message_id_key
  ON public.messages (conversation_id, message_id)
  WHERE message_id IS NOT NULL;
