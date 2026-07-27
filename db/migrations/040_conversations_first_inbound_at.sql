-- Exactly-once marker for the "first inbound message" trigger.
--
-- Counting prior customer messages before the INSERT is racy: two
-- webhook deliveries (WAHA fires `message` and `message.any`, and two
-- distinct messages can arrive milliseconds apart) can both observe
-- zero prior messages and both fire the trigger.
--
-- `first_inbound_at` turns the decision into a single atomic
-- conditional UPDATE: only the invocation whose
-- `... SET first_inbound_at = now() WHERE first_inbound_at IS NULL`
-- returns a row is allowed to dispatch the trigger.
-- Safe to re-run.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS first_inbound_at timestamptz;

-- Backfill: existing conversations that already received a customer
-- message must never re-fire the trigger.
UPDATE public.conversations c
SET first_inbound_at = m.first_at
FROM (
  SELECT conversation_id, MIN(created_at) AS first_at
  FROM public.messages
  WHERE sender_type = 'customer'
  GROUP BY conversation_id
) m
WHERE m.conversation_id = c.id
  AND c.first_inbound_at IS NULL;
