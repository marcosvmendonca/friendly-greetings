import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { normalizeWahaMessageId } from '@/lib/whatsapp/waha-api';
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
  return firstString(
    record._serialized,
    record.serialized,
    record.id,
    record.remote,
    record.remoteJid,
    record.chatId,
    record.from,
  );
}

function extractChatId(value: unknown): string | undefined {
  const serialized = extractSerialized(value);
  if (!serialized) return undefined;
  const direct = serialized.match(
    /(?:^|_)([0-9A-Za-z.:-]+@(?:c|g)\.us|[0-9A-Za-z.:-]+@s\.whatsapp\.net|[0-9A-Za-z.:-]+@lid)(?:_|$)/,
  );
  return direct?.[1] ?? serialized;
}

function normalizeWahaChatId(chatId: string): string {
  const jid = chatId.match(/^([^@\s]+)@(c\.us|s\.whatsapp\.net|lid)$/i);
  if (!jid) return chatId;
  const local = jid[1].split(':')[0] ?? jid[1];
  const server = jid[2].toLowerCase();
  if (server === 'lid') return `${local}@lid`;
  const digits = local.replace(/\D/g, '');
  return `${digits}@c.us`;
}

function isOneToOneChatId(chatId: string): boolean {
  return (
    chatId.endsWith('@c.us') ||
    chatId.endsWith('@s.whatsapp.net') ||
    chatId.endsWith('@lid')
  );
}

function isGroupOrBroadcast(value: string): boolean {
  return (
    value.includes('@g.us') ||
    value.includes('@broadcast') ||
    value.includes('@newsletter') ||
    value.includes('status@')
  );
}

function resolveSenderChatId(msg: JsonRecord): string | null {
  const data = getRecord(msg, '_data');
  const id = getRecord(msg, 'id');
  const dataId = getRecord(data, 'id');
  const key = getRecord(msg, 'key');
  const dataKey = getRecord(data, 'key');
  const sender = getRecord(msg, 'sender');

  // Any of these boolean/string markers means the payload is a group,
  // status broadcast, newsletter, or channel message — never a real 1:1.
  if (
    getBoolean(msg, 'isGroupMsg') === true ||
    getBoolean(msg, 'isGroup') === true ||
    getBoolean(msg, 'isStatus') === true ||
    getBoolean(msg, 'broadcast') === true ||
    getBoolean(data, 'isGroupMsg') === true ||
    getBoolean(data, 'isGroup') === true ||
    getBoolean(data, 'isStatus') === true ||
    getBoolean(data, 'broadcast') === true
  ) {
    return null;
  }
  // The `participant` field is only populated by WhatsApp on group
  // messages (it distinguishes who inside the group spoke). If it's set,
  // we're looking at a group message even if `from` looks like a 1:1 jid.
  const hasParticipant =
    Boolean(getString(key, 'participant')) ||
    Boolean(getString(dataKey, 'participant')) ||
    Boolean(getString(msg, 'participant')) ||
    Boolean(getString(data, 'participant'));
  if (hasParticipant) return null;

  const candidates = [
    msg.from,
    msg.chatId,
    msg.remoteJid,
    msg.to,
    data?.from,
    data?.chatId,
    data?.remoteJid,
    data?.to,
    id?.remote,
    id?.remoteJid,
    dataId?.remote,
    dataId?.remoteJid,
    key?.remoteJid,
    dataKey?.remoteJid,
    sender?.id,
    sender?.jid,
    id,
    dataId,
    key,
    dataKey,
    msg.author,
    data?.author,
  ];

  const chatIds = candidates
    .map(extractChatId)
    .filter((value): value is string => Boolean(value));
  // If any candidate reveals this is a group/broadcast/status/newsletter
  // chat, reject entirely — never pick a participant jid and promote it
  // to a fake 1:1 conversation.
  if (chatIds.some(isGroupOrBroadcast)) return null;
  const oneToOne = chatIds.find(isOneToOneChatId) ?? chatIds[0] ?? null;
  return oneToOne ? normalizeWahaChatId(oneToOne) : null;
}

function resolveMessageId(msg: JsonRecord, session: string, chatId: string, createdAt: string): string {
  const data = getRecord(msg, '_data');
  const messageId =
    extractSerialized(msg.id) ??
    extractSerialized(data?.id) ??
    getString(msg, 'messageId') ??
    getString(data, 'messageId') ??
    `waha_${session}_${chatId}_${createdAt}`;
  return normalizeWahaMessageId(messageId);
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
  // WAHA/WhatsApp exposes stickers as their own type; store as sticker
  // so the bubble renderer can differentiate from a regular image.
  if (type === 'sticker') return 'sticker';

  const allowed = new Set([
    'text',
    'image',
    'document',
    'audio',
    'video',
    'location',
    'template',
    'interactive',
    'sticker',
  ]);

  return allowed.has(type) ? type : 'text';
}

// System / protocol / status events masquerade as messages in WAHA.
// Everything in this set is either a delivery/read receipt, an
// encryption-key-changed banner, a "message was deleted" tombstone, or
// an internal cipher event — none of which the user cares about.
const IGNORED_WAHA_TYPES = new Set([
  'revoked',
  'notification_template',
  'e2e_notification',
  'ciphertext',
  'protocol',
  'gp2', // group participant change
  'unknown',
  'ack',
  'receipt',
  'call_log',
  'status',
]);

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
  if (!chatId || !isOneToOneChatId(chatId)) return null;

  const digits = chatId.split('@')[0]?.replace(/\D/g, '') ?? '';
  if (!digits) return null;

  const rawType = (getString(msg, 'type') ?? getString(data, 'type') ?? 'chat').toLowerCase();
  if (IGNORED_WAHA_TYPES.has(rawType)) return null;
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

function extractPushName(body: WahaWebhookPayload): string | null {
  const root = body as JsonRecord;
  const msg =
    asRecord(root.payload) ??
    asRecord(root.message) ??
    asRecord(root.data);
  if (!msg) return null;
  const data = getRecord(msg, '_data');
  const notify = getRecord(data, 'notifyName');
  return (
    firstString(
      msg.pushName,
      msg.notifyName,
      msg._pushName,
      data?.pushName,
      data?.notifyName,
      notify?.formattedName,
    ) ?? null
  );
}

async function fetchWahaProfilePicture(
  admin: SupabaseClient,
  config: WahaConfigRow,
  chatId: string,
): Promise<string | null> {
  try {
    const { data: row } = await admin
      .from('whatsapp_config')
      .select('waha_base_url')
      .eq('id', config.id)
      .maybeSingle();
    const baseUrl = (row?.waha_base_url as string | null)?.replace(/\/+$/, '');
    const apiKey = config.waha_api_key ? decrypt(config.waha_api_key) : null;
    if (!baseUrl || !apiKey) return null;
    const params = new URLSearchParams({
      contactId: chatId,
      session: config.waha_session ?? 'default',
    });
    const res = await fetch(`${baseUrl}/api/contacts/profile-picture?${params.toString()}`, {
      method: 'GET',
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as
      | { profilePictureURL?: string; url?: string }
      | null;
    return json?.profilePictureURL ?? json?.url ?? null;
  } catch (err) {
    console.warn('[waha-webhook] profile-picture fetch failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

async function enrichContact(
  admin: SupabaseClient,
  config: WahaConfigRow,
  contactId: string,
  currentName: string | null,
  currentAvatar: string | null,
  currentPhone: string,
  chatId: string,
  pushName: string | null,
): Promise<void> {
  const patch: Record<string, unknown> = {};
  // Only override the name when it's still the raw phone (auto-created).
  const nameIsAuto = !currentName || currentName === currentPhone || currentName.trim() === '';
  if (pushName && nameIsAuto) patch.name = pushName;
  if (!currentAvatar) {
    const avatar = await fetchWahaProfilePicture(admin, config, chatId);
    if (avatar) patch.avatar_url = avatar;
  }
  if (Object.keys(patch).length === 0) return;
  const { error } = await admin.from('contacts').update(patch).eq('id', contactId);
  if (error) console.warn('[waha-webhook] contact enrich failed:', error.message);
}

async function handleWahaReaction(
  admin: SupabaseClient,
  config: WahaConfigRow,
  body: WahaWebhookPayload,
): Promise<void> {
  const root = body as JsonRecord;
  const msg =
    asRecord(root.payload) ??
    asRecord(root.message) ??
    asRecord(root.data);
  if (!msg) return;
  const reaction = getRecord(msg, 'reaction');
  const emoji = getString(reaction, 'text') ?? getString(msg, 'reactionText') ?? '';
  const targetId =
    extractSerialized(reaction?.messageId) ??
    extractSerialized(reaction?.id) ??
    extractSerialized(msg.reactionMessageId);
  const chatId = resolveSenderChatId(msg);
  if (!targetId || !chatId) return;
  const normalizedTarget = normalizeWahaMessageId(targetId);
  const fromMe =
    getBoolean(msg, 'fromMe') ??
    getBoolean(getRecord(msg, 'id'), 'fromMe') ??
    false;
  if (fromMe) return; // agent-side reactions are written by /api/whatsapp/react

  // Find the target message.
  const { data: targetMsg } = await admin
    .from('messages')
    .select('id, conversation_id, conversations!inner(contact_id, account_id)')
    .eq('message_id', normalizedTarget)
    .limit(1)
    .maybeSingle();
  const target = targetMsg as
    | { id: string; conversation_id: string; conversations: { contact_id: string; account_id: string } }
    | null;
  if (!target || target.conversations.account_id !== config.account_id) return;

  if (!emoji) {
    await admin
      .from('message_reactions')
      .delete()
      .eq('message_id', target.id)
      .eq('actor_type', 'customer')
      .eq('actor_id', target.conversations.contact_id);
    return;
  }
  await admin.from('message_reactions').upsert(
    {
      message_id: target.id,
      conversation_id: target.conversation_id,
      actor_type: 'customer',
      actor_id: target.conversations.contact_id,
      emoji,
    },
    { onConflict: 'message_id,actor_type,actor_id' },
  );
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

  // Route reactions to their own handler; they're state on an existing
  // target message, not new bubbles.
  if (event === 'message.reaction') {
    const admin = supabaseAdmin();
    const config = await resolveWahaConfig(admin, session);
    if (config?.account_id) await handleWahaReaction(admin, config, body);
    return NextResponse.json({ ok: true });
  }

  // We only care about inbound customer messages. WAHA emits both
  // `message` (inbound only) and `message.any` (inbound + outbound) for
  // the same wamid — accept only `message` to avoid duplicate inserts.
  // Everything else (message.ack, message.revoked, session.status, …) is
  // a status update that shouldn't materialize as a chat bubble.
  if (event !== 'message') {
    return NextResponse.json({ ok: true });
  }

  const normalized = normalizeWahaMessage(body, session);
  if (!normalized) {
    console.warn('[waha-webhook] message payload ignored (system/non-1:1)', {
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
  // Find-or-create contact within the account. Capture the WhatsApp
  // pushName as the initial display name so the inbox stops showing raw
  // phone numbers, and enrich existing rows on subsequent messages.
  const pushName = extractPushName(body);
  const initialName = pushName?.trim() || normalized.phone;
  const existing = await findExistingContact(admin, config.account_id, normalized.phone);
  let contactId: string | undefined = existing?.id;
  let existingName: string | null = (existing?.name as string | null) ?? null;
  let existingAvatar: string | null = (existing?.avatar_url as string | null) ?? null;

  if (!contactId) {
    const { data: inserted, error: insertErr } = await admin
      .from('contacts')
      .insert({
        account_id: config.account_id,
        user_id: config.user_id,
        phone: normalized.phone,
        name: initialName,
      })
      .select('id, name, avatar_url')
      .maybeSingle();
    if (insertErr && !isUniqueViolation(insertErr)) {
      console.error('[waha-webhook] contact insert', insertErr);
      return NextResponse.json({ ok: false }, { status: 500 });
    }
    if (inserted?.id) {
      contactId = inserted.id as string;
      existingName = (inserted.name as string | null) ?? initialName;
      existingAvatar = (inserted.avatar_url as string | null) ?? null;
    } else {
      const raced = await findExistingContact(admin, config.account_id, normalized.phone);
      contactId = raced?.id;
      existingName = (raced?.name as string | null) ?? null;
      existingAvatar = (raced?.avatar_url as string | null) ?? null;
    }
  }
  if (!contactId) return NextResponse.json({ ok: false }, { status: 500 });

  // Best-effort enrichment (name + avatar). Runs sequentially but only
  // when we're actually missing data, so most webhook hits skip it.
  await enrichContact(
    admin,
    config,
    contactId,
    existingName,
    existingAvatar,
    normalized.phone,
    normalized.chatId,
    pushName,
  );

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
