import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * Debug endpoint powering the inbox debug panel.
 *
 * Returns the raw DB rows for a conversation (conversation, contact,
 * last N messages) plus the raw WAHA webhook events captured for
 * that chat. Used to diagnose why name/phone/media didn't render —
 * agents can compare what WAHA sent against what the app persisted.
 *
 * Scoped to the caller's account. RLS on `waha_webhook_events`
 * enforces the account boundary; we additionally verify the
 * conversation belongs to the caller before returning anything.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: conversationId } = await params;
  if (!conversationId) {
    return NextResponse.json({ error: 'Missing conversation id' }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle();
  const accountId = profile?.account_id as string | undefined;
  if (!accountId) {
    return NextResponse.json({ error: 'No account' }, { status: 403 });
  }

  const { data: conversation } = await supabase
    .from('conversations')
    .select('*')
    .eq('id', conversationId)
    .maybeSingle();
  if (!conversation || conversation.account_id !== accountId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { data: contact } = await supabase
    .from('contacts')
    .select('*')
    .eq('id', conversation.contact_id)
    .maybeSingle();

  const { data: messages } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(30);

  // Match webhook events by any identifier we know about: the contact
  // phone (digits) or one of the WhatsApp chat-id shapes (`<phone>@c.us`,
  // `<phone>@s.whatsapp.net`). Widen with ilike so `@lid` variants and
  // device-suffixed ids still show up.
  const phoneDigits = (contact?.phone ?? '').replace(/\D/g, '');
  let eventsQuery = supabase
    .from('waha_webhook_events')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (phoneDigits) {
    eventsQuery = eventsQuery.or(
      [
        `phone.eq.${phoneDigits}`,
        `chat_id.ilike.%${phoneDigits}%`,
      ].join(','),
    );
  }
  const { data: events } = await eventsQuery;

  // Best-effort diagnostic hints. Cheap to compute here and much more
  // useful than making the UI re-derive them.
  const diagnostics: string[] = [];
  if (!contact?.name || contact.name === contact.phone) {
    diagnostics.push('Contact name equals phone or is empty — pushName was not captured by the webhook.');
  }
  if (!contact?.phone) {
    diagnostics.push('Contact has no phone — chat id likely used an @lid variant without a resolvable number.');
  }
  if (!contact?.avatar_url) {
    diagnostics.push('No avatar_url on contact — WAHA profile-picture fetch failed or was skipped.');
  }
  const mediaTypes = new Set(['image', 'video', 'audio', 'document', 'sticker']);
  const mediaWithoutUrl = (messages ?? []).filter(
    (m) => mediaTypes.has(m.content_type) && !m.media_url,
  );
  if (mediaWithoutUrl.length > 0) {
    diagnostics.push(
      `${mediaWithoutUrl.length} media message(s) have no media_url — Storage upload failed or WAHA didn't return the binary.`,
    );
  }
  const proxyPointers = (messages ?? []).filter(
    (m) => typeof m.media_url === 'string' && m.media_url.startsWith('/api/whatsapp/'),
  );
  if (proxyPointers.length > 0) {
    diagnostics.push(
      `${proxyPointers.length} message(s) still use on-demand WAHA proxy pointers (not Storage) — check ensureChatMediaBucket.`,
    );
  }

  return NextResponse.json({
    conversation,
    contact,
    messages: messages ?? [],
    events: events ?? [],
    diagnostics,
    matched_by: { phone_digits: phoneDigits },
  });
}
