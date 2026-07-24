import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { decrypt } from '@/lib/whatsapp/encryption';

type JsonRecord = Record<string, unknown>;

type WahaMedia = {
  url?: string;
  mimetype?: string;
  mimeType?: string;
  data?: string;
  filename?: string;
  fileName?: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null;
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

function mediaFromPayload(value: unknown): WahaMedia | null {
  const record = asRecord(value);
  if (!record) return null;
  const data = getRecord(record, '_data');
  const dataMessage = getRecord(data, 'message');
  const candidates = [
    getRecord(record, 'media'),
    getRecord(data, 'media'),
    getRecord(record, 'downloadedMedia'),
    getRecord(record, 'file'),
    getRecord(dataMessage, 'imageMessage'),
    getRecord(dataMessage, 'videoMessage'),
    getRecord(dataMessage, 'audioMessage'),
    getRecord(dataMessage, 'documentMessage'),
    getRecord(dataMessage, 'stickerMessage'),
    record,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const media: WahaMedia = {
      url: firstString(
        candidate.url,
        candidate.mediaUrl,
        candidate.downloadUrl,
        candidate.deprecatedMms3Url,
      ),
      mimetype: firstString(
        candidate.mimetype,
        candidate.mimeType,
        candidate.contentType,
      ),
      data: firstString(candidate.data, candidate.mediaData),
      filename: firstString(
        candidate.filename,
        candidate.fileName,
        candidate.name,
      ),
    };
    if (media.url || media.data || media.mimetype || media.filename) return media;
  }
  return null;
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
    }
    return parsed.toString();
  } catch {
    return `${baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
  }
}

/**
 * On-demand WAHA media proxy.
 *
 * WAHA does NOT expose a public URL for received media by default —
 * the webhook payload only carries an encrypted WhatsApp reference.
 * Rather than base64-inlining every attachment into the DB, we store
 * a pointer of the form `/api/whatsapp/waha-media/<messageId>` and
 * fetch on demand: pull the full message from WAHA with
 * `downloadMedia=true`, then stream the binary back to the browser.
 *
 * Auth: the caller must be signed in AND own a conversation that
 * contains this `message_id`. That both scopes access to the tenant
 * and prevents an authenticated attacker from enumerating other
 * accounts' media.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const { messageId: rawId } = await params;
  const messageId = decodeURIComponent(rawId);
  if (!messageId) {
    return NextResponse.json({ error: 'Missing messageId' }, { status: 400 });
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

  // Confirm the message belongs to this account before touching WAHA.
  const { data: msgRow } = await supabase
    .from('messages')
    .select('id, conversation_id, conversations!inner(account_id)')
    .eq('message_id', messageId)
    .limit(1)
    .maybeSingle();
  const msg = msgRow as
    | { id: string; conversations: { account_id: string } }
    | null;
  if (!msg || msg.conversations.account_id !== accountId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('waha_base_url, waha_api_key, waha_session, provider')
    .eq('account_id', accountId)
    .maybeSingle();
  if (!config || config.provider !== 'waha' || !config.waha_base_url) {
    return NextResponse.json({ error: 'WAHA not configured' }, { status: 400 });
  }

  const baseUrl = (config.waha_base_url as string).replace(/\/+$/, '');
  const session = (config.waha_session as string) ?? 'default';
  let apiKey = '';
  try {
    apiKey = config.waha_api_key ? decrypt(config.waha_api_key as string) : '';
  } catch {
    return NextResponse.json({ error: 'Bad WAHA credentials' }, { status: 500 });
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers['X-Api-Key'] = apiKey;

  // Ask WAHA for the message with media downloaded. Both endpoints
  // exist across WAHA engines; we try the newer `?session=` query
  // form first and fall back to the legacy path-scoped one.
  const encodedId = encodeURIComponent(messageId);
  const attempts = [
    `${baseUrl}/api/messages/${encodedId}?session=${encodeURIComponent(session)}&downloadMedia=true`,
    `${baseUrl}/api/${encodeURIComponent(session)}/messages/${encodedId}?downloadMedia=true`,
  ];

  let media: WahaMedia | null = null;
  for (const url of attempts) {
    try {
      const res = await fetch(url, { method: 'GET', headers });
      if (!res.ok) continue;
      const payload = await res.json().catch(() => null);
      const found = mediaFromPayload(payload);
      if (found) {
        media = found;
        break;
      }
    } catch {
      // try next
    }
  }

  if (!media) {
    return NextResponse.json({ error: 'Media unavailable' }, { status: 404 });
  }

  const contentType = media.mimetype || 'application/octet-stream';
  const cacheHeader = 'private, max-age=86400';

  // Preferred: WAHA returned a URL — stream it through so the browser
  // doesn't need any WAHA credentials.
  if (media.url) {
    const upstream = await fetch(rewriteWahaMediaUrl(media.url, baseUrl), {
      method: 'GET',
      headers: apiKey ? { 'X-Api-Key': apiKey } : undefined,
    });
    if (!upstream.ok) {
      return NextResponse.json({ error: 'Upstream failed' }, { status: 502 });
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || contentType,
        'Cache-Control': cacheHeader,
      },
    });
  }

  // Fallback: WAHA inlined the base64 payload directly on the message.
  if (media.data) {
    const raw = media.data.replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(raw, 'base64');
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': cacheHeader,
      },
    });
  }

  return NextResponse.json({ error: 'Media unavailable' }, { status: 404 });
}
