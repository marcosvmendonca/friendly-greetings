import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { normalizeWahaMessageId } from '@/lib/whatsapp/waha-api';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { resolveMenuReply } from '@/lib/messaging/menu-reply';
import type { AutomationTriggerType } from '@/types';

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
  waha_base_url: string | null;
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

function resolveSenderChatId(msg: JsonRecord, fromMe = false): string | null {
  const data = getRecord(msg, '_data');
  const id = getRecord(msg, 'id');
  const dataId = getRecord(data, 'id');
  const key = getRecord(msg, 'key');
  const dataKey = getRecord(data, 'key');
  const sender = getRecord(msg, 'sender');

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
  const participant =
    getString(key, 'participant') ??
    getString(dataKey, 'participant') ??
    getString(msg, 'participant') ??
    getString(data, 'participant');
  if (participant && isGroupOrBroadcast(participant)) return null;

  // When the message was sent from our own account (another device or
  // WhatsApp Web), `from` is our JID and `to` is the customer. Flip the
  // priority so the counterparty chat id wins.
  const inbound = [
    msg.from,
    msg.chatId,
    msg.remoteJid,
    msg.to,
    data?.from,
    data?.chatId,
    data?.remoteJid,
    data?.to,
  ];
  const outbound = [
    msg.to,
    msg.chatId,
    msg.remoteJid,
    data?.to,
    data?.chatId,
    data?.remoteJid,
    msg.from,
    data?.from,
  ];
  const candidates = [
    ...(fromMe ? outbound : inbound),
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

interface WahaMediaBundle {
  /** Absolute URL served by the WAHA instance (needs X-Api-Key). */
  url: string | null;
  /** Base64 payload when WAHA inlined the media directly. */
  data: string | null;
  /** e.g. `image/jpeg`, may include codec params. */
  mimetype: string | null;
  /** Filename WAHA reports (documents mostly). */
  filename: string | null;
}

interface WahaContactInfo {
  phone: string | null;
  displayName: string | null;
}

function resolveMediaBundle(msg: JsonRecord): WahaMediaBundle {
  const data = getRecord(msg, '_data');
  const media = getRecord(msg, 'media');
  const file = getRecord(msg, 'file');
  const dataMedia = getRecord(data, 'media');
  // GOWS engine (used for outbound message.any events too) nests the
  // proto message under PascalCase keys; the JS engine uses lowercase.
  // Check both so mirrored outbound media surfaces its url/mimetype.
  const dataMessage = getRecord(data, 'message') ?? getRecord(data, 'Message');
  const imageMessage =
    getRecord(dataMessage, 'imageMessage') ?? getRecord(dataMessage, 'ImageMessage');
  const videoMessage =
    getRecord(dataMessage, 'videoMessage') ?? getRecord(dataMessage, 'VideoMessage');
  const audioMessage =
    getRecord(dataMessage, 'audioMessage') ?? getRecord(dataMessage, 'AudioMessage');
  const documentMessage =
    getRecord(dataMessage, 'documentMessage') ?? getRecord(dataMessage, 'DocumentMessage');
  const stickerMessage =
    getRecord(dataMessage, 'stickerMessage') ?? getRecord(dataMessage, 'StickerMessage');
  return {
    url:
      firstString(
        msg.mediaUrl,
        msg.downloadUrl,
        media?.url,
        file?.url,
        dataMedia?.url,
        data?.mediaUrl,
        data?.deprecatedMms3Url,
        imageMessage?.url,
        imageMessage?.URL,
        imageMessage?.deprecatedMms3Url,
        videoMessage?.url,
        videoMessage?.URL,
        videoMessage?.deprecatedMms3Url,
        audioMessage?.url,
        audioMessage?.URL,
        audioMessage?.deprecatedMms3Url,
        documentMessage?.url,
        documentMessage?.URL,
        documentMessage?.deprecatedMms3Url,
        stickerMessage?.url,
        stickerMessage?.URL,
        stickerMessage?.deprecatedMms3Url,
      ) ?? null,
    data:
      firstString(
        media?.data,
        file?.data,
        dataMedia?.data,
        msg.mediaData,
      ) ?? null,
    mimetype:
      firstString(
        media?.mimetype,
        media?.mimeType,
        file?.mimetype,
        file?.mimeType,
        dataMedia?.mimetype,
        data?.mimetype,
        msg.mimetype,
        imageMessage?.mimetype,
        imageMessage?.Mimetype,
        videoMessage?.mimetype,
        videoMessage?.Mimetype,
        audioMessage?.mimetype,
        audioMessage?.Mimetype,
        documentMessage?.mimetype,
        documentMessage?.Mimetype,
        stickerMessage?.mimetype,
        stickerMessage?.Mimetype,
      ) ?? null,
    filename:
      firstString(
        media?.filename,
        media?.fileName,
        file?.filename,
        file?.name,
        dataMedia?.filename,
        data?.filename,
        msg.filename,
        documentMessage?.fileName,
        documentMessage?.FileName,
        documentMessage?.filename,
      ) ?? null,
  };
}

function extractMediaBundle(value: unknown): WahaMediaBundle {
  const record = asRecord(value);
  if (!record) {
    return { url: null, data: null, mimetype: null, filename: null };
  }
  const nested = resolveMediaBundle(record);
  return {
    url: nested.url ?? firstString(record.url, record.mediaUrl, record.downloadUrl) ?? null,
    data: nested.data ?? firstString(record.data, record.mediaData) ?? null,
    mimetype:
      nested.mimetype ??
      firstString(record.mimetype, record.mimeType, record.contentType) ??
      null,
    filename:
      nested.filename ??
      firstString(record.filename, record.fileName, record.name) ??
      null,
  };
}

function hasMediaBytes(bundle: WahaMediaBundle): boolean {
  return Boolean(bundle.url || bundle.data);
}

function mapWahaContentType(type?: string, mimetype?: string | null): string {
  const t = (type ?? '').toLowerCase();
  const mime = (mimetype ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (!t || t === 'chat') {
    if (mime.startsWith('image/')) return mime === 'image/webp' ? 'sticker' : 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime) return 'document';
    return 'text';
  }
  if (t === 'ptt' || t === 'voice' || t === 'audiomessage') return 'audio';
  if (t === 'sticker' || t === 'stickermessage') return 'sticker';
  if (t === 'gif' || t === 'animation' || t === 'videomessage') return 'video';
  if (t === 'documentwithcaption' || t === 'documentmessage') return 'document';
  if (t === 'imagemessage') return 'image';

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
  if (allowed.has(t)) return t;

  // Fallback via mimetype when WAHA reports a generic type
  if (mime.startsWith('image/')) return mime === 'image/webp' ? 'sticker' : 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime) return 'document';
  return 'text';
}

const MEDIA_CONTENT_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

// Ignored non-message events. Group participant changes, receipts,
// e2e/ciphertext protocol events, and status broadcasts should never
// become chat bubbles.
const IGNORED_WAHA_TYPES = new Set([
  'revoked',
  'notification_template',
  'e2e_notification',
  'ciphertext',
  'protocol',
  'gp2',
  'unknown',
  'ack',
  'receipt',
  'call_log',
  'status',
  'broadcast_notification',
]);

interface NormalizedWahaMessageFull extends NormalizedWahaMessage {
  bundle: WahaMediaBundle;
  filename: string | null;
  mimetype: string | null;
}

function normalizeWahaMessage(body: WahaWebhookPayload, session: string): NormalizedWahaMessageFull | null {
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
  const chatId = resolveSenderChatId(msg, fromMe);
  if (!chatId || !isOneToOneChatId(chatId)) return null;

  const digits = chatId.split('@')[0]?.replace(/\D/g, '') ?? '';
  if (!digits) return null;

  // GOWS engine reports type inside _data.Info.Type / Info.MediaType.
  // Info.Type=="media" with MediaType containing "sticker" (e.g.
  // "user_created_sticker", "animated_sticker") is a sticker; when the
  // top-level `type` field is missing we fall back to that shape.
  const info = getRecord(data, 'Info');
  const infoType = (getString(info, 'Type') ?? '').toLowerCase();
  const infoMediaType = (getString(info, 'MediaType') ?? '').toLowerCase();
  const dataMessage = getRecord(data, 'message') ?? getRecord(data, 'Message');
  const hasStickerMessage = Boolean(
    getRecord(dataMessage, 'stickerMessage') ?? getRecord(dataMessage, 'StickerMessage'),
  );
  const rawType = (getString(msg, 'type') ?? getString(data, 'type') ?? infoType ?? 'chat').toLowerCase();
  if (IGNORED_WAHA_TYPES.has(rawType)) return null;
  const createdAt = resolveMessageCreatedAt(msg);
  const bundle = resolveMediaBundle(msg);
  // Detect media type from GOWS proto messages when the top-level `type`
  // is missing (common for outbound message.any events mirrored from
  // another device). Info.MediaType looks like "image"/"video"/
  // "audio"/"ptt"/"document"/"user_created_sticker"/"animated_sticker".
  const inferredFromInfo =
    infoMediaType.includes('sticker') ? 'sticker'
      : infoMediaType.startsWith('image') ? 'image'
      : infoMediaType.startsWith('video') || infoMediaType.startsWith('gif') ? 'video'
      : infoMediaType.startsWith('audio') || infoMediaType === 'ptt' || infoMediaType === 'voice' ? 'audio'
      : infoMediaType.startsWith('document') ? 'document'
      : null;
  const inferredFromProto = getRecord(dataMessage, 'imageMessage') || getRecord(dataMessage, 'ImageMessage')
    ? 'image'
    : getRecord(dataMessage, 'videoMessage') || getRecord(dataMessage, 'VideoMessage')
    ? 'video'
    : getRecord(dataMessage, 'audioMessage') || getRecord(dataMessage, 'AudioMessage')
    ? 'audio'
    : getRecord(dataMessage, 'documentMessage') || getRecord(dataMessage, 'DocumentMessage')
    ? 'document'
    : hasStickerMessage
    ? 'sticker'
    : null;
  let contentType = mapWahaContentType(rawType, bundle.mimetype);
  if (contentType === 'text' && (inferredFromInfo || inferredFromProto)) {
    contentType = (inferredFromInfo ?? inferredFromProto) as string;
  }
  if (
    hasStickerMessage ||
    infoMediaType.includes('sticker') ||
    (contentType === 'image' && (bundle.mimetype ?? '').toLowerCase().includes('webp'))
  ) {
    contentType = 'sticker';
  }

  let contentText = resolveMessageBody(msg);
  // For documents, prefer the filename as visible label when no caption
  // was provided — otherwise the bubble would render just an icon.
  if (contentType === 'document' && !contentText && bundle.filename) {
    contentText = bundle.filename;
  }
  const messageId = resolveMessageId(msg, session, chatId, createdAt);
  // Media URL is resolved AFTER insert by downloading from WAHA and
  // uploading to Supabase Storage. If the download fails, we fall back
  // to the on-demand proxy path.
  const mediaUrl = MEDIA_CONTENT_TYPES.has(contentType)
    ? `/api/whatsapp/waha-media/${encodeURIComponent(messageId)}`
    : null;
  return {
    chatId,
    phone: normalizePhone(`+${digits}`),
    fromMe,
    messageId,
    contentText,
    contentType,
    mediaUrl,
    createdAt,
    rawType,
    bundle,
    filename: bundle.filename,
    mimetype: bundle.mimetype,
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
  // GOWS engine nests it under _data.Info.PushName (whatsmeow shape).
  const info = getRecord(data, 'Info');
  return (
    firstString(
      msg.pushName,
      msg.notifyName,
      msg._pushName,
      data?.pushName,
      data?.notifyName,
      notify?.formattedName,
      info?.PushName,
      info?.pushName,
      info?.VerifiedName,
      info?.verifiedName,
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
  const normalizedName = normalizePhone(currentName ?? '');
  const normalizedCurrentPhone = normalizePhone(currentPhone);
  const nameIsAuto =
    !currentName ||
    currentName === currentPhone ||
    currentName.trim() === '' ||
    (normalizedName !== '' && normalizedName === normalizedCurrentPhone) ||
    /^[+\d\s().-]+$/.test(currentName);
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
  const select = 'id, account_id, user_id, waha_api_key, waha_base_url, waha_session, status';

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

// ============================================================
// Media persistence — download incoming WAHA media and re-host it in
// the `chat-media` Storage bucket so the browser gets a stable public
// URL that doesn't require the WAHA api key. This is what makes
// received images, stickers, audio, video and documents actually
// render in the inbox (WAHA's own media URLs are on the internal
// container network and require X-Api-Key headers, so a raw <img>
// tag in the browser can't reach them).
// ============================================================

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/zip': 'zip',
};

function normalizeMime(mime: string | null | undefined): string | null {
  if (!mime) return null;
  const cleaned = mime.split(';')[0]?.trim().toLowerCase();
  return cleaned || null;
}

function extForContent(contentType: string, mime: string | null, filename: string | null): string {
  if (filename && /\.[a-z0-9]{2,5}$/i.test(filename)) {
    const ext = filename.split('.').pop();
    if (ext) return ext.toLowerCase();
  }
  if (mime && MIME_TO_EXT[mime]) return MIME_TO_EXT[mime];
  if (contentType === 'sticker') return 'webp';
  if (contentType === 'image') return 'jpg';
  if (contentType === 'video') return 'mp4';
  if (contentType === 'audio') return 'ogg';
  return 'bin';
}

function rewriteWahaMediaUrl(url: string, baseUrl: string): string {
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '0.0.0.0'
    ) {
      const base = new URL(baseUrl);
      parsed.hostname = base.hostname;
      parsed.protocol = base.protocol;
      parsed.port = base.port;
      return parsed.toString();
    }
    return url;
  } catch {
    return `${baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
  }
}

function mediaFromWahaMessage(value: unknown): WahaMediaBundle {
  const record = asRecord(value);
  if (!record) return { url: null, data: null, mimetype: null, filename: null };
  const direct = getRecord(record, 'media');
  const data = getRecord(record, '_data');
  const dataMedia = getRecord(data, 'media');
  const downloaded = getRecord(record, 'downloadedMedia');
  const file = getRecord(record, 'file');
  const candidates = [direct, dataMedia, downloaded, file, record];
  for (const candidate of candidates) {
    const bundle = extractMediaBundle(candidate);
    if (hasMediaBytes(bundle) || bundle.mimetype || bundle.filename) return bundle;
  }
  return { url: null, data: null, mimetype: null, filename: null };
}

async function fetchWahaMessageMediaBundle(
  normalized: NormalizedWahaMessageFull,
  baseUrl: string,
  apiKey: string,
  session: string,
): Promise<WahaMediaBundle | null> {
  const headers = { Accept: 'application/json', 'X-Api-Key': apiKey };
  const encodedSession = encodeURIComponent(session);
  const encodedChatId = encodeURIComponent(normalized.chatId);
  const encodedMessageId = encodeURIComponent(normalized.messageId);
  const attempts = [
    `${baseUrl}/api/${encodedSession}/chats/${encodedChatId}/messages/${encodedMessageId}?downloadMedia=true`,
    `${baseUrl}/api/messages/${encodedMessageId}?session=${encodedSession}&downloadMedia=true`,
    `${baseUrl}/api/${encodedSession}/messages/${encodedMessageId}?downloadMedia=true`,
  ];

  for (const url of attempts) {
    try {
      const res = await fetch(url, { method: 'GET', headers });
      if (!res.ok) continue;
      const payload = await res.json().catch(() => null);
      const bundle = mediaFromWahaMessage(payload);
      if (hasMediaBytes(bundle)) return bundle;
    } catch (err) {
      console.warn(
        '[waha-webhook] message media lookup failed',
        err instanceof Error ? err.message : err,
      );
    }
  }

  return null;
}

let chatMediaBucketReady = false;
async function ensureChatMediaBucket(admin: SupabaseClient): Promise<void> {
  if (chatMediaBucketReady) return;
  const options = {
    public: true,
    fileSizeLimit: 100 * 1024 * 1024,
  };
  const { data, error } = await admin.storage.getBucket('chat-media');
  if (error || !data) {
    const { error: createErr } = await admin.storage.createBucket('chat-media', options);
    if (createErr) {
      console.warn('[waha-webhook] chat-media bucket create failed', createErr.message);
    }
  } else if (data.public !== true) {
    const { error: updateErr } = await admin.storage.updateBucket('chat-media', options);
    if (updateErr) {
      console.warn('[waha-webhook] chat-media bucket update failed', updateErr.message);
    }
  }
  chatMediaBucketReady = true;
}

async function fetchWahaMediaBytes(
  bundle: WahaMediaBundle,
  baseUrl: string,
  apiKey: string,
): Promise<{ bytes: Uint8Array; mime: string | null } | null> {
  // Preferred: WAHA gave us a URL. Fetch with X-Api-Key (WAHA's media
  // server requires it) and rewrite localhost/127.0.0.1 to the
  // configured base URL so container-internal URLs work.
  if (bundle.url) {
    const url = rewriteWahaMediaUrl(bundle.url, baseUrl);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'X-Api-Key': apiKey },
      });
      if (!res.ok) {
        console.warn('[waha-webhook] media fetch failed', { url, status: res.status });
        return null;
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      const mime = normalizeMime(res.headers.get('content-type')) ?? normalizeMime(bundle.mimetype);
      return { bytes: buf, mime };
    } catch (err) {
      console.warn('[waha-webhook] media fetch threw', err instanceof Error ? err.message : err);
      return null;
    }
  }

  // Fallback: base64 inline payload.
  if (bundle.data) {
    try {
      const raw = bundle.data.replace(/^data:[^;]+;base64,/, '');
      const buf = Uint8Array.from(Buffer.from(raw, 'base64'));
      return { bytes: buf, mime: normalizeMime(bundle.mimetype) };
    } catch (err) {
      console.warn('[waha-webhook] base64 decode failed', err instanceof Error ? err.message : err);
      return null;
    }
  }

  return null;
}

type StoreMediaResult = { url: string | null; reason: string | null };

async function storeWahaMedia(
  admin: SupabaseClient,
  config: WahaConfigRow,
  normalized: NormalizedWahaMessageFull,
  wahaBaseUrl: string,
): Promise<StoreMediaResult> {
  if (!MEDIA_CONTENT_TYPES.has(normalized.contentType)) {
    return { url: null, reason: 'not-media' };
  }
  let apiKey = '';
  if (config.waha_api_key) {
    try {
      apiKey = decrypt(config.waha_api_key);
    } catch (err) {
      console.warn('[waha-webhook] WAHA api key decrypt failed', err instanceof Error ? err.message : err);
    }
  }
  if (!apiKey && !normalized.bundle.data) {
    return { url: null, reason: 'no-api-key-and-no-inline-data' };
  }

  let bundle = normalized.bundle;
  if (!hasMediaBytes(bundle) && apiKey) {
    const lookedUp = await fetchWahaMessageMediaBundle(
      normalized,
      wahaBaseUrl,
      apiKey,
      config.waha_session ?? 'default',
    );
    if (lookedUp) bundle = lookedUp;
  }

  const fetched = await fetchWahaMediaBytes(bundle, wahaBaseUrl, apiKey);
  if (!fetched || fetched.bytes.byteLength === 0) {
    return {
      url: null,
      reason: `fetch-empty (bundle.url=${bundle.url ? 'yes' : 'no'}, bundle.data=${bundle.data ? 'yes' : 'no'})`,
    };
  }

  const mime = fetched.mime ?? normalizeMime(normalized.mimetype) ?? 'application/octet-stream';
  const ext = extForContent(normalized.contentType, mime, normalized.filename);
  const safeId = normalized.messageId.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80);
  const path = `account-${config.account_id}/waha-${safeId}.${ext}`;

  await ensureChatMediaBucket(admin);

  const { error: upErr } = await admin.storage
    .from('chat-media')
    .upload(path, fetched.bytes, {
      contentType: mime,
      upsert: true,
      cacheControl: '86400',
    });
  if (upErr) {
    console.warn('[waha-webhook] storage upload failed', upErr.message);
    return { url: null, reason: `upload-failed: ${upErr.message}` };
  }
  const { data } = admin.storage.from('chat-media').getPublicUrl(path);
  return { url: data.publicUrl ?? null, reason: null };
}

async function fetchWahaContactInfo(
  config: WahaConfigRow,
  chatId: string,
  fallbackPhone: string,
  fallbackName: string | null,
): Promise<WahaContactInfo> {
  const baseUrl = config.waha_base_url?.replace(/\/+$/, '');
  let apiKey = '';
  if (config.waha_api_key) {
    try {
      apiKey = decrypt(config.waha_api_key);
    } catch {
      apiKey = '';
    }
  }
  if (!baseUrl || !apiKey) return { phone: fallbackPhone, displayName: fallbackName };

  const queryParams = new URLSearchParams({
    contactId: chatId,
    session: config.waha_session ?? 'default',
  });
  const encodedSession = encodeURIComponent(config.waha_session ?? 'default');
  const encodedChatId = encodeURIComponent(chatId);
  const attempts = [
    `${baseUrl}/api/contacts?${queryParams.toString()}`,
    `${baseUrl}/api/contacts/${encodedChatId}?session=${encodedSession}`,
    `${baseUrl}/api/${encodedSession}/contacts/${encodedChatId}`,
  ];

  const pickContactRecord = (value: unknown): JsonRecord | null => {
    if (Array.isArray(value)) {
      const matching = value
        .map(asRecord)
        .find((item) => {
          const idValue = firstString(item?.id, item?.jid, item?.phone, item?.number);
          return idValue === chatId || idValue === normalizedChatId;
        });
      return matching ?? value.map(asRecord).find(Boolean) ?? null;
    }
    const record = asRecord(value);
    return asRecord(record?.contact) ?? record;
  };

  const normalizedChatId = normalizeWahaChatId(chatId);
  const extractPhone = (record: JsonRecord): string | null => {
    const idRecord = getRecord(record, 'id');
    const rawPhone = firstString(
      record.number,
      record.phone,
      record.phoneNumber,
      record.formattedNumber,
      idRecord?.user,
    );
    if (!rawPhone || rawPhone.includes('@lid')) return null;
    const digits = rawPhone.replace(/\D/g, '');
    if (digits.length < 8) return null;
    return normalizePhone(`+${digits}`);
  };

  try {
    for (const url of attempts) {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
      });
      if (!res.ok) continue;
      const record = pickContactRecord(await res.json().catch(() => null));
      if (!record) continue;
      const displayName =
        firstString(
          record.name,
          record.pushname,
          record.pushName,
          record.shortName,
          record.verifiedName,
          fallbackName,
        ) ?? null;
      return {
        phone: extractPhone(record) ?? fallbackPhone,
        displayName,
      };
    }
    return { phone: fallbackPhone, displayName: fallbackName };
  } catch (err) {
    console.warn('[waha-webhook] contact lookup failed', err instanceof Error ? err.message : err);
    return { phone: fallbackPhone, displayName: fallbackName };
  }
}

/**
 * Best-effort insert into `waha_webhook_events` used by the inbox
 * debug panel. Failures are swallowed — we never want debug logging
 * to break real message ingestion.
 */
async function logDebugEvent(
  admin: SupabaseClient,
  row: {
    account_id?: string | null;
    session?: string | null;
    event?: string | null;
    chat_id?: string | null;
    phone?: string | null;
    message_id?: string | null;
    outcome: string;
    reason?: string | null;
    payload?: unknown;
    normalized?: unknown;
  },
): Promise<void> {
  try {
    await admin.from('waha_webhook_events').insert({
      account_id: row.account_id ?? null,
      session: row.session ?? null,
      event: row.event ?? null,
      chat_id: row.chat_id ?? null,
      phone: row.phone ?? null,
      message_id: row.message_id ?? null,
      outcome: row.outcome,
      reason: row.reason ?? null,
      payload: row.payload ?? null,
      normalized: row.normalized ?? null,
    });
  } catch {
    // ignore
  }
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

  // Fire-and-forget: capture the raw payload for the debug panel
  // BEFORE any filtering. Even ignored events (groups, statuses, from-me)
  // land here so agents can see why nothing appeared in the inbox.
  const debugAdmin = (() => {
    try { return supabaseAdmin(); } catch { return null; }
  })();
  if (debugAdmin) {
    void logDebugEvent(debugAdmin, {
      session,
      event,
      outcome: 'received',
      payload: body,
    });
  }

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

  // WAHA emits `message` (inbound only) and `message.any` (inbound +
  // outbound). We need `message.any` to mirror messages the user sends
  // from another device / WhatsApp Web. Inserts are idempotent on wamid,
  // so duplicates between the two channels collapse safely.
  // Ignore ack/revoked/session.status etc.
  if (event !== 'message' && event !== 'message.any') {
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
  const contactInfo = await fetchWahaContactInfo(config, normalized.chatId, normalized.phone, pushName);
  const contactPhone = contactInfo.phone || normalized.phone;
  const initialName = contactInfo.displayName?.trim() || contactPhone;
  const existingByPhone = await findExistingContact(admin, config.account_id, contactPhone);
  const existingByChatIdPhone =
    contactPhone !== normalized.phone
      ? await findExistingContact(admin, config.account_id, normalized.phone)
      : null;
  const existing = existingByPhone ?? existingByChatIdPhone;
  let contactId: string | undefined = existing?.id;
  let contactWasCreated = false;
  let existingName: string | null = (existing?.name as string | null) ?? null;
  let existingAvatar: string | null = (existing?.avatar_url as string | null) ?? null;

  if (existingByChatIdPhone && !existingByPhone && contactPhone !== normalized.phone) {
    const { error: phoneUpdateErr } = await admin
      .from('contacts')
      .update({ phone: contactPhone, updated_at: new Date().toISOString() })
      .eq('id', existingByChatIdPhone.id);
    if (phoneUpdateErr) {
      console.warn('[waha-webhook] contact phone update failed:', phoneUpdateErr.message);
    }
  }

  if (!contactId) {
    const { data: inserted, error: insertErr } = await admin
      .from('contacts')
      .insert({
        account_id: config.account_id,
        user_id: config.user_id,
        phone: contactPhone,
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
      contactWasCreated = true;
      existingName = (inserted.name as string | null) ?? initialName;
      existingAvatar = (inserted.avatar_url as string | null) ?? null;
    } else {
      const raced = await findExistingContact(admin, config.account_id, contactPhone);
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
    contactPhone,
    normalized.chatId,
    contactInfo.displayName ?? pushName,
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

  // Whether this is the contact's very first inbound message — computed
  // BEFORE the insert so `first_inbound_message` stays accurate even for
  // contacts imported manually who never messaged us before. This is
  // only a *candidate*: the definitive, race-free decision is the
  // atomic claim on `conversations.first_inbound_at` below, taken only
  // after the message row is actually inserted.
  const { count: priorCustomerMsgCount } = await admin
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer');
  const mayBeFirstInbound = (priorCustomerMsgCount ?? 0) === 0;


  // Insert the message. Idempotent on wamid.
  const { data: existingMsg } = await admin
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('message_id', normalized.messageId)
    .limit(1)
    .maybeSingle();
  let insertedMessage = false;
  // WAHA renders menus as numbered text, so a tap comes back as "2" or
  // "Suporte". Map it to the original button/list id before the insert
  // so the row carries `interactive_reply_id` exactly like Meta's.
  let menuReplyId: string | null = null;
  if (!normalized.fromMe && normalized.contentType === 'text') {
    const match = await resolveMenuReply(
      admin,
      conversationId,
      normalized.contentText ?? '',
    ).catch(() => null);
    menuReplyId = match?.reply_id ?? null;
  }
  if (!existingMsg) {
    // For media messages, try to persist the binary in Storage BEFORE
    // insert so the row lands with a stable public URL. If the download
    // fails (WAHA didn't include a URL, api key missing, network hiccup)
    // we fall back to `normalized.mediaUrl` — the on-demand proxy path
    // that tries again at render time.
    let mediaUrl = normalized.mediaUrl;
    let storageReason: string | null = null;
    let storageUrl: string | null = null;
    if (
      MEDIA_CONTENT_TYPES.has(normalized.contentType) &&
      config.waha_base_url
    ) {
      const stored = await storeWahaMedia(
        admin,
        config,
        normalized,
        (config.waha_base_url as string).replace(/\/+$/, ''),
      );
      storageUrl = stored.url;
      storageReason = stored.reason;
      if (stored.url) mediaUrl = stored.url;
    }
    const { error: msgErr } = await admin.from('messages').insert({
      conversation_id: conversationId,
      sender_type: normalized.fromMe ? 'agent' : 'customer',
      content_type: normalized.contentType,
      content_text: normalized.contentText,
      media_url: mediaUrl,
      status: normalized.fromMe ? 'sent' : 'delivered',
      message_id: normalized.messageId,
      created_at: normalized.createdAt,
      interactive_reply_id: menuReplyId,
    });
    if (msgErr) {
      // Migration 039 adds a partial unique index on
      // (conversation_id, message_id). When WAHA fires `message` and
      // `message.any` back-to-back — or two webhook invocations race
      // past the SELECT above — the second INSERT trips the unique
      // constraint. Swallow it: the row is already stored, so we
      // treat this call as a duplicate delivery instead of 500'ing.
      if (isUniqueViolation(msgErr)) {
        insertedMessage = false;
      } else {
        console.error('[waha-webhook] message insert', msgErr);
        return NextResponse.json({ ok: false }, { status: 500 });
      }
    } else {
      insertedMessage = true;
    }
    // Surface storage outcome in debug so the inbox debug panel shows
    // WHY a given media message fell back to the on-demand proxy URL.
    if (debugAdmin && MEDIA_CONTENT_TYPES.has(normalized.contentType)) {
      void logDebugEvent(debugAdmin, {
        account_id: config.account_id,
        session,
        event,
        chat_id: normalized.chatId,
        phone: normalized.phone,
        message_id: normalized.messageId,
        outcome: storageUrl ? 'media-stored' : 'media-fallback',
        reason: storageReason,
        normalized: { storageUrl, storageReason, bundle: normalized.bundle },
      });
    }
  }

  const currentUnreadCount = (existingConv?.unread_count as number | null) ?? 0;
  // Messages we sent from another device shouldn't bump the unread badge.
  const nextUnreadCount =
    insertedMessage && !normalized.fromMe ? currentUnreadCount + 1 : currentUnreadCount;
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

  if (debugAdmin) {
    void logDebugEvent(debugAdmin, {
      account_id: config.account_id,
      session,
      event,
      chat_id: normalized.chatId,
      phone: normalized.phone,
      message_id: normalized.messageId,
      outcome: insertedMessage ? 'stored' : 'duplicate',
      // Include the full raw body so the debug panel can show WAHA's
      // original payload next to the DB row we created. Prior versions
      // dropped this, which made it impossible to diagnose which field
      // was missing (pushName, media, contact.number, …).
      payload: body,
      normalized,
    });
  }

  // ============================================================
  // Automation + flow dispatch (mirrors the Meta webhook).
  //
  // Only for genuinely new inbound customer messages: duplicates and
  // messages we sent from another device must never re-trigger a bot.
  // Flows run first — when a flow consumes the message the customer is
  // navigating a menu, so the content-level automation triggers are
  // suppressed. Relationship-level triggers (new contact / first
  // inbound) fire either way.
  // ============================================================
  if (insertedMessage && !normalized.fromMe) {
    const inboundText = normalized.contentText ?? '';
    // Atomic exactly-once claim (migration 040): only the invocation
    // whose conditional UPDATE actually flips `first_inbound_at` from
    // NULL is allowed to treat this as the conversation's first inbound
    // message. Two concurrent webhook deliveries can both read
    // `priorCustomerMsgCount === 0`, but only one can win this UPDATE.
    let isFirstInboundMessage = false;
    if (mayBeFirstInbound) {
      const { data: claimed, error: claimErr } = await admin
        .from('conversations')
        .update({ first_inbound_at: normalized.createdAt })
        .eq('id', conversationId)
        .is('first_inbound_at', null)
        .select('id');
      if (claimErr) {
        console.error('[waha-webhook] first-inbound claim failed', claimErr);
      } else {
        isFirstInboundMessage = (claimed?.length ?? 0) > 0;
      }
    }

    const flowResult = await dispatchInboundToFlows({
      accountId: config.account_id,
      userId: config.user_id,
      contactId,
      conversationId,
      message: menuReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: menuReplyId,
            reply_title: inboundText,
            meta_message_id: normalized.messageId,
          }
        : {
            kind: 'text',
            text: inboundText,
            meta_message_id: normalized.messageId,
          },
      isFirstInboundMessage,
    });

    const automationTriggers: AutomationTriggerType[] = [];
    if (!flowResult.consumed) {
      automationTriggers.push('new_message_received', 'keyword_match');
      // Numbered-menu answer resolved back to a button/list id → the
      // same trigger Meta fires on a native tap.
      if (menuReplyId) automationTriggers.push('interactive_reply');
    }
    if (contactWasCreated) automationTriggers.unshift('new_contact_created');
    if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message');

    for (const triggerType of automationTriggers) {
      await runAutomationsForTrigger({
        accountId: config.account_id,
        triggerType,
        contactId,
        context: {
          message_text: inboundText,
          conversation_id: conversationId,
          interactive_reply_id: menuReplyId ?? undefined,
        },
      }).catch((err) =>
        console.error('[waha-webhook] automation dispatch failed:', err),
      );
    }
  }

  return NextResponse.json({ ok: true });
}

// WAHA sanity-checks the webhook with a GET on startup in some configs.
export async function GET() {
  return NextResponse.json({ ok: true });
}
