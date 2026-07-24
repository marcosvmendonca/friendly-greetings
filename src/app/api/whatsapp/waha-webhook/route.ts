import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';

/**
 * Inbound webhook for WAHA (unofficial provider).
 *
 * WAHA POSTs JSON of the shape:
 *   { event: 'message', session: '<name>', payload: { from, body, id, ... } }
 *
 * We only handle message.* events for text/media and persist them the
 * same way the Meta webhook does — find-or-create contact → find-or-
 * create conversation → insert message → touch conversation. Auth is
 * via the WAHA API key echoed back in the `X-Api-Key` header (WAHA can
 * be configured to send it via webhook config, but out-of-the-box it
 * doesn't); we cross-check the incoming session against the stored
 * config as the primary tenancy signal.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SERVICE_ROLE_KEY)!,
    );
  }
  return _adminClient;
}

interface WahaWebhookPayload {
  event?: string;
  session?: string;
  payload?: {
    id?: string;
    from?: string;
    fromMe?: boolean;
    body?: string;
    hasMedia?: boolean;
    timestamp?: number;
    type?: string;
    _data?: unknown;
  };
}

function mapWahaContentType(type?: string): string {
  if (!type || type === 'chat') return 'text';
  if (type === 'ptt') return 'audio';

  const allowed = new Set([
    'text',
    'image',
    'document',
    'audio',
    'video',
    'location',
    'template',
    'interactive',
  ]);

  return allowed.has(type) ? type : 'text';
}

function resolveMessageCreatedAt(timestamp?: number): string {
  if (!timestamp) return new Date().toISOString();
  const millis = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  return new Date(millis).toISOString();
}

export async function POST(request: Request) {
  let body: WahaWebhookPayload;
  try {
    body = (await request.json()) as WahaWebhookPayload;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const event = body.event ?? '';
  const session = body.session ?? '';
  if (!session) return NextResponse.json({ ok: true });

  // We only care about inbound customer messages.
  if (!event.startsWith('message')) {
    return NextResponse.json({ ok: true });
  }
  const msg = body.payload;
  if (!msg || msg.fromMe) return NextResponse.json({ ok: true });

  const admin = supabaseAdmin();

  // Resolve tenant by session name.
  const { data: config } = await admin
    .from('whatsapp_config')
    .select('id, account_id, user_id, waha_api_key, status')
    .eq('provider', 'waha')
    .eq('waha_session', session)
    .maybeSingle();

  if (!config?.account_id) return NextResponse.json({ ok: true });

  // First inbound message proves the WAHA session is live end-to-end.
  // Flip status→connected so the inbox banner clears immediately,
  // even before the user revisits the settings page (which is what
  // normally triggers the GET-based status refresh).
  if (config.status !== 'connected') {
    await admin
      .from('whatsapp_config')
      .update({
        status: 'connected',
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', config.id);
  }

  // Optional API-key check (WAHA can forward it as a header).
  const incomingKey = request.headers.get('x-api-key');
  if (incomingKey && config.waha_api_key) {
    try {
      if (decrypt(config.waha_api_key) !== incomingKey) {
        return NextResponse.json({ ok: false }, { status: 401 });
      }
    } catch {
      // if decryption fails we just skip the check — the session name
      // match above already scopes us to this tenant
    }
  }

  // WAHA `from` is `<digits>@c.us` for 1:1 chats. Groups (`@g.us`) are
  // skipped — the CRM's data model assumes 1:1.
  const rawFrom = msg.from ?? '';
  if (!rawFrom.endsWith('@c.us')) return NextResponse.json({ ok: true });
  const digits = rawFrom.split('@')[0]?.replace(/\D/g, '') ?? '';
  if (!digits) return NextResponse.json({ ok: true });

  const phone = normalizePhone(`+${digits}`);
  const contentText = msg.body ?? '';
  const messageType = msg.type === 'chat' ? 'text' : (msg.type ?? 'text');
  const whatsappMessageId = msg.id ?? `waha_${Date.now()}`;

  // Find-or-create contact within the account.
  let contactId: string | undefined = (
    await findExistingContact(admin, config.account_id, phone)
  )?.id;

  if (!contactId) {
    const { data: inserted, error: insertErr } = await admin
      .from('contacts')
      .insert({
        account_id: config.account_id,
        user_id: config.user_id,
        phone,
        name: phone,
      })
      .select('id')
      .maybeSingle();
    if (insertErr && !isUniqueViolation(insertErr)) {
      console.error('[waha-webhook] contact insert', insertErr);
      return NextResponse.json({ ok: false }, { status: 500 });
    }
    contactId =
      inserted?.id ??
      (await findExistingContact(admin, config.account_id, phone))
        ?.id;
  }
  if (!contactId) return NextResponse.json({ ok: false }, { status: 500 });

  // Find-or-create conversation.
  const { data: existingConv } = await admin
    .from('conversations')
    .select('id, unread_count')
    .eq('account_id', config.account_id)
    .eq('contact_id', contactId)
    .maybeSingle();

  let conversationId = existingConv?.id as string | undefined;
  if (!conversationId) {
    const { data: convInsert, error: convErr } = await admin
      .from('conversations')
      .insert({
        account_id: config.account_id,
        user_id: config.user_id,
        contact_id: contactId,
        status: 'open',
      })
      .select('id')
      .maybeSingle();
    if (convErr) {
      console.error('[waha-webhook] conversation insert', convErr);
      return NextResponse.json({ ok: false }, { status: 500 });
    }
    conversationId = convInsert?.id;
  }
  if (!conversationId) return NextResponse.json({ ok: false }, { status: 500 });

  // Insert the message. Idempotent on wamid.
  const { data: existingMsg } = await admin
    .from('messages')
    .select('id')
    .eq('message_id', whatsappMessageId)
    .maybeSingle();
  if (!existingMsg) {
    const { error: msgErr } = await admin.from('messages').insert({
      conversation_id: conversationId,
      sender_type: 'customer',
      content_type: messageType,
      content_text: contentText,
      status: 'delivered',
      message_id: whatsappMessageId,
      created_at: resolveMessageCreatedAt(msg.timestamp),
    });
    if (msgErr) {
      console.error('[waha-webhook] message insert', msgErr);
      return NextResponse.json({ ok: false }, { status: 500 });
    }
  }

  const nextUnreadCount = ((existingConv?.unread_count as number | null) ?? 0) + 1;
  await admin
    .from('conversations')
    .update({
      last_message_text: contentText || `[${msg.type ?? 'text'}]`,
      last_message_at: new Date().toISOString(),
      unread_count: nextUnreadCount,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  return NextResponse.json({ ok: true });
}

// WAHA sanity-checks the webhook with a GET on startup in some configs.
export async function GET() {
  return NextResponse.json({ ok: true });
}
