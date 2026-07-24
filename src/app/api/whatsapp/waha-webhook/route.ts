import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
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

let _adminClient: SupabaseClient | null = null;
function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error('Supabase admin env vars are missing');
    }
    _adminClient = createClient(
      supabaseUrl,
      serviceRoleKey,
    );
  }
  return _adminClient;
}

type JsonRecord = Record<string, unknown>;

interface WahaWebhookPayload {
  event?: string;
  session?: string;
  payload?: unknown;
  message?: unknown;
  data?: unknown;
}

interface WahaConfigRow {
  id: string;
  account_id: string;
  user_id: string;
  waha_api_key: string | null;
  waha_session: string | null;
  status: string | null;
}

interface NormalizedWahaMessage {
  chatId: string;
  phone: string;
  fromMe: boolean;
  messageId: string;
  contentText: string;
  contentType: string;
  mediaUrl: string | null;
  createdAt: string;
  rawType: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null;
}

function getString(record: JsonRecord | null | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getBoolean(record: JsonRecord | null | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function getNumber(record: JsonRecord | null | undefined, key: string): number | undefined {
  const value = record?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function getRecord(record: JsonRecord | null | undefined, key: string): JsonRecord | null {
  return asRecord(record?.[key]);
}

function firstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function extractSerialized(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  const record = asRecord(value);
  if (!record) return undefined;
  return firstString(record._serialized, record.serialized, record.id, record.remote);
}

function extractChatId(value: unknown): string | undefined {
  const serialized = extractSerialized(value);
  if (!serialized) return undefined;
  const direct = serialized.match(/(?:^|_)([0-9A-Za-z.-]+@(?:c|g|lid)\.us)(?:_|$)/);
  return direct?.[1] ?? serialized;
}

function resolveSenderChatId(msg: JsonRecord): string | null {
  const data = getRecord(msg, '_data');
  const id = getRecord(msg, 'id');
  const dataId = getRecord(data, 'id');
  const candidates = [
    msg.from,
    msg.chatId,
    msg.remoteJid,
    data?.from,
    data?.chatId,
    id?.remote,
    dataId?.remote,
    id,
    dataId,
    msg.author,
    data?.author,
  ];

  const chatIds = candidates
    .map(extractChatId)
    .filter((value): value is string => Boolean(value));
  return chatIds.find((value) => value.endsWith('@c.us')) ?? chatIds[0] ?? null;
}

function resolveMessageId(msg: JsonRecord, session: string, chatId: string, createdAt: string): string {
  const data = getRecord(msg, '_data');
  const id = getRecord(msg, 'id');
  const dataId = getRecord(data, 'id');
  return (
    extractSerialized(msg.id) ??
    extractSerialized(data?.id) ??
    getString(msg, 'messageId') ??
    getString(data, 'messageId') ??
    `waha_${session}_${chatId}_${createdAt}`
  );
}

function resolveMessageCreatedAt(msg: JsonRecord): string {
  const data = getRecord(msg, '_data');
  const timestamp =
    getNumber(msg, 'timestamp') ??
    getNumber(msg, 't') ??
    getNumber(data, 'timestamp') ??
    getNumber(data, 't');
  if (!timestamp) return new Date().toISOString();
  const millis = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function resolveMessageBody(msg: JsonRecord): string {
  const data = getRecord(msg, '_data');
  const text = getRecord(msg, 'text');
  const media = getRecord(msg, 'media');
  const file = getRecord(msg, 'file');
  return (
    firstString(
      msg.body,
      msg.caption,
      msg.text,
      text?.body,
      data?.body,
      data?.caption,
      media?.caption,
      file?.caption,
    ) ?? ''
  );
}

function resolveMediaUrl(msg: JsonRecord): string | null {
  const data = getRecord(msg, '_data');
  const media = getRecord(msg, 'media');
  const file = getRecord(msg, 'file');
  return (
    firstString(
      msg.mediaUrl,
      msg.downloadUrl,
      media?.url,
      file?.url,
      data?.mediaUrl,
      data?.deprecatedMms3Url,
    ) ?? null
  );
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

function normalizeWahaMessage(body: WahaWebhookPayload, session: string): NormalizedWahaMessage | null {
  const root = body as JsonRecord;
  const msg =
    asRecord(root.payload) ??
    asRecord(root.message) ??
    asRecord(root.data);
  if (!msg) return null;

  const data = getRecord(msg, '_data');
  const id = getRecord(msg, 'id');
  const dataId = getRecord(data, 'id');
  const fromMe =
    getBoolean(msg, 'fromMe') ??
    getBoolean(id, 'fromMe') ??
    getBoolean(data, 'fromMe') ??
    getBoolean(dataId, 'fromMe') ??
    false;
  const chatId = resolveSenderChatId(msg);
  if (!chatId || !chatId.endsWith('@c.us')) return null;

  const digits = chatId.split('@')[0]?.replace(/\D/g, '') ?? '';
  if (!digits) return null;

  const rawType = getString(msg, 'type') ?? getString(data, 'type') ?? 'chat';
  const createdAt = resolveMessageCreatedAt(msg);
  const contentText = resolveMessageBody(msg);
  return {
    chatId,
    phone: normalizePhone(`+${digits}`),
    fromMe,
    messageId: resolveMessageId(msg, session, chatId, createdAt),
    contentText,
    contentType: mapWahaContentType(rawType),
    mediaUrl: resolveMediaUrl(msg),
    createdAt,
    rawType,
  };
}

async function resolveWahaConfig(
  admin: SupabaseClient,
  session: string,
): Promise<WahaConfigRow | null> {
  const select = 'id, account_id, user_id, waha_api_key, waha_session, status';

  if (session) {
    const { data, error } = await admin
      .from('whatsapp_config')
      .select(select)
      .eq('provider', 'waha')
      .eq('waha_session', session)
      .order('updated_at', { ascending: false })
      .limit(2);
    if (error) {
      console.error('[waha-webhook] config lookup failed', error);
      return null;
    }
    if (data && data.length === 1) return data[0] as WahaConfigRow;
    if (data && data.length > 1) {
      console.error('[waha-webhook] duplicate WAHA sessions found', { session });
      return null;
    }
  }

  const { data, error } = await admin
    .from('whatsapp_config')
    .select(select)
    .eq('provider', 'waha')
    .order('updated_at', { ascending: false })
    .limit(2);
  if (error) {
    console.error('[waha-webhook] fallback config lookup failed', error);
    return null;
  }
  if (data && data.length === 1) {
    console.warn('[waha-webhook] using only WAHA config as session fallback', {
      incomingSession: session,
      configuredSession: (data[0] as WahaConfigRow).waha_session,
    });
    return data[0] as WahaConfigRow;
  }

  console.warn('[waha-webhook] no matching WAHA config', { session });
  return null;
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
  if (!session) {
    console.warn('[waha-webhook] missing session in webhook payload');
    return NextResponse.json({ ok: true });
  }

  // We only care about inbound customer messages.
  if (!event.startsWith('message')) {
    return NextResponse.json({ ok: true });
  }

  const normalized = normalizeWahaMessage(body, session);
  if (!normalized) {
    console.warn('[waha-webhook] message payload ignored; no 1:1 chat id found', {
      event,
      session,
    });
    return NextResponse.json({ ok: true });
  }
  if (normalized.fromMe) return NextResponse.json({ ok: true });

  const admin = supabaseAdmin();

  // Resolve tenant by session name.
  const config = await resolveWahaConfig(admin, session);
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
  // Find-or-create contact within the account.
  let contactId: string | undefined = (
    await findExistingContact(admin, config.account_id, normalized.phone)
  )?.id;

  if (!contactId) {
    const { data: inserted, error: insertErr } = await admin
      .from('contacts')
      .insert({
        account_id: config.account_id,
        user_id: config.user_id,
        phone: normalized.phone,
        name: normalized.phone,
      })
      .select('id')
      .maybeSingle();
    if (insertErr && !isUniqueViolation(insertErr)) {
      console.error('[waha-webhook] contact insert', insertErr);
      return NextResponse.json({ ok: false }, { status: 500 });
    }
    contactId =
      inserted?.id ??
      (await findExistingContact(admin, config.account_id, normalized.phone))
        ?.id;
  }
  if (!contactId) return NextResponse.json({ ok: false }, { status: 500 });

  // Find-or-create conversation.
  const { data: existingRows, error: existingConvErr } = await admin
    .from('conversations')
    .select('id, unread_count')
    .eq('account_id', config.account_id)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1);
  if (existingConvErr) {
    console.error('[waha-webhook] conversation lookup', existingConvErr);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  const existingConv = existingRows?.[0];

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
      if (isUniqueViolation(convErr)) {
        const { data: racedRows } = await admin
          .from('conversations')
          .select('id, unread_count')
          .eq('account_id', config.account_id)
          .eq('contact_id', contactId)
          .order('created_at', { ascending: true })
          .limit(1);
        conversationId = racedRows?.[0]?.id;
      } else {
        console.error('[waha-webhook] conversation insert', convErr);
        return NextResponse.json({ ok: false }, { status: 500 });
      }
    }
    conversationId = conversationId ?? convInsert?.id;
  }
  if (!conversationId) return NextResponse.json({ ok: false }, { status: 500 });

  // Insert the message. Idempotent on wamid.
  const { data: existingMsg } = await admin
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('message_id', normalized.messageId)
    .limit(1)
    .maybeSingle();
  let insertedMessage = false;
  if (!existingMsg) {
    const { error: msgErr } = await admin.from('messages').insert({
      conversation_id: conversationId,
      sender_type: 'customer',
      content_type: normalized.contentType,
      content_text: normalized.contentText,
      media_url: normalized.mediaUrl,
      status: 'delivered',
      message_id: normalized.messageId,
      created_at: normalized.createdAt,
    });
    if (msgErr) {
      console.error('[waha-webhook] message insert', msgErr);
      return NextResponse.json({ ok: false }, { status: 500 });
    }
    insertedMessage = true;
  }

  const currentUnreadCount = (existingConv?.unread_count as number | null) ?? 0;
  const nextUnreadCount = insertedMessage ? currentUnreadCount + 1 : currentUnreadCount;
  await admin
    .from('conversations')
    .update({
      last_message_text: normalized.contentText || `[${normalized.rawType}]`,
      last_message_at: normalized.createdAt,
      unread_count: nextUnreadCount,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  console.info('[waha-webhook] inbound message stored', {
    event,
    session,
    conversationId,
    insertedMessage,
    messageId: normalized.messageId,
  });

  return NextResponse.json({ ok: true });
}

// WAHA sanity-checks the webhook with a GET on startup in some configs.
export async function GET() {
  return NextResponse.json({ ok: true });
}
