// ============================================================
// WAHA REST client (https://waha.devlike.pro/docs/how-to/http-api).
//
// Thin wrapper around fetch — one function per endpoint we actually
// use. Every call takes an explicit `{ baseUrl, apiKey, session }`
// bag so the caller (route handler or send layer) can pull the
// config from `whatsapp_config` and pass it in. No module-level
// state, no singletons — same pattern as `meta-api.ts`.
//
// Errors surface as `WahaApiError` with the HTTP status + upstream
// body, so route handlers can map them onto their own response shape.
// ============================================================

export interface WahaConfig {
  baseUrl: string;
  apiKey: string;
  session: string;
}

export class WahaApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `WAHA API error ${status}: ${body.slice(0, 200)}`);
    this.name = 'WahaApiError';
    this.status = status;
    this.body = body;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

async function wahaFetch(
  cfg: WahaConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = `${normalizeBaseUrl(cfg.baseUrl)}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Api-Key': cfg.apiKey,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new WahaApiError(res.status, body);
  }
  return res;
}

export interface WahaSessionInfo {
  name: string;
  status:
    | 'STOPPED'
    | 'STARTING'
    | 'SCAN_QR_CODE'
    | 'WORKING'
    | 'FAILED'
    | string;
  me?: { id: string; pushName?: string } | null;
}

export async function getWahaSession(cfg: WahaConfig): Promise<WahaSessionInfo | null> {
  try {
    const res = await wahaFetch(cfg, `/api/sessions/${encodeURIComponent(cfg.session)}`, {
      method: 'GET',
    });
    return (await res.json()) as WahaSessionInfo;
  } catch (err) {
    if (err instanceof WahaApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Create + start the session if it doesn't exist. Idempotent: WAHA
 * returns 422 when the session already exists; we swallow that.
 */
export async function startWahaSession(cfg: WahaConfig, webhookUrl?: string): Promise<void> {
  const body: Record<string, unknown> = {
    name: cfg.session,
    start: true,
  };
  if (webhookUrl) {
    body.config = {
      webhooks: [
        {
          url: webhookUrl,
          events: ['message', 'message.any', 'session.status'],
        },
      ],
    };
  }
  try {
    await wahaFetch(cfg, '/api/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch (err) {
    // 422 = already exists. Fall back to /start (idempotent).
    if (err instanceof WahaApiError && (err.status === 422 || err.status === 400)) {
      await wahaFetch(cfg, `/api/sessions/${encodeURIComponent(cfg.session)}/start`, {
        method: 'POST',
      }).catch(() => undefined);
      return;
    }
    throw err;
  }
}

export async function stopWahaSession(cfg: WahaConfig): Promise<void> {
  await wahaFetch(cfg, `/api/sessions/${encodeURIComponent(cfg.session)}/stop`, {
    method: 'POST',
  }).catch(() => undefined);
}

export async function logoutWahaSession(cfg: WahaConfig): Promise<void> {
  await wahaFetch(cfg, `/api/sessions/${encodeURIComponent(cfg.session)}/logout`, {
    method: 'POST',
  }).catch(() => undefined);
}

/**
 * Fetch the pairing QR as a data-URL. WAHA exposes both `image` and
 * `raw` endpoints; we return the image so the UI can `<img src>` it
 * directly.
 */
export async function getWahaQr(cfg: WahaConfig): Promise<string | null> {
  try {
    const res = await wahaFetch(
      cfg,
      `/api/${encodeURIComponent(cfg.session)}/auth/qr?format=image`,
      { method: 'GET' },
    );
    const contentType = res.headers.get('content-type') ?? 'image/png';
    if (contentType.startsWith('application/json')) {
      const json = (await res.json()) as { data?: string; mimetype?: string };
      if (json.data) return `data:${json.mimetype ?? 'image/png'};base64,${json.data}`;
      return null;
    }
    const buf = await res.arrayBuffer();
    const b64 = Buffer.from(buf).toString('base64');
    return `data:${contentType};base64,${b64}`;
  } catch (err) {
    if (err instanceof WahaApiError && (err.status === 404 || err.status === 422)) return null;
    throw err;
  }
}

// --------- outbound send ---------

/**
 * WAHA chat IDs use the `<digits>@c.us` format for 1:1 chats.
 * GOWS/NOWEB may expose the same contact internally as
 * `<digits>@s.whatsapp.net` or `<digits>:<device>@s.whatsapp.net`;
 * WAHA docs explicitly say to convert those to `@c.us` before sending.
 */
export function normalizeWahaChatId(value: string): string {
  const trimmed = value.trim();
  const jid = trimmed.match(/^([^@\s]+)@(c\.us|s\.whatsapp\.net|lid)$/i);
  if (jid) {
    const local = jid[1].split(':')[0] ?? jid[1];
    const server = jid[2].toLowerCase();
    if (server === 'lid') return `${local}@lid`;
    const digits = local.replace(/\D/g, '');
    return `${digits}@c.us`;
  }

  const digits = trimmed.replace(/\D/g, '');
  return `${digits}@c.us`;
}

export function toWahaChatId(e164Phone: string): string {
  return normalizeWahaChatId(e164Phone);
}

async function resolveWahaChatId(cfg: WahaConfig, toE164: string): Promise<string> {
  const fallback = toWahaChatId(toE164);
  const phone = toE164.replace(/\D/g, '');
  if (!phone) return fallback;

  try {
    const params = new URLSearchParams({ phone, session: cfg.session });
    const res = await wahaFetch(cfg, `/api/contacts/check-exists?${params.toString()}`, {
      method: 'GET',
    });
    const json = (await res.json()) as { numberExists?: boolean; chatId?: string };
    if (json.numberExists && json.chatId) return normalizeWahaChatId(json.chatId);
  } catch (err) {
    console.warn(
      '[waha-api] check-exists failed; falling back to phone chatId:',
      err instanceof Error ? err.message : String(err),
    );
  }

  return fallback;
}

export async function sendWahaText(
  cfg: WahaConfig,
  toE164: string,
  text: string,
): Promise<{ id: string }> {
  const chatId = await resolveWahaChatId(cfg, toE164);
  const res = await wahaFetch(cfg, '/api/sendText', {
    method: 'POST',
    body: JSON.stringify({
      session: cfg.session,
      chatId,
      text,
    }),
  });
  const json = (await res.json()) as { id?: { id?: string; _serialized?: string } | string };
  const id =
    typeof json.id === 'string'
      ? json.id
      : json.id?._serialized ?? json.id?.id ?? `waha_${Date.now()}`;
  return { id };
}

export type WahaMediaKind = 'image' | 'video' | 'document' | 'audio';

export async function sendWahaMedia(
  cfg: WahaConfig,
  toE164: string,
  kind: WahaMediaKind,
  mediaUrl: string,
  caption?: string | null,
  filename?: string | null,
): Promise<{ id: string }> {
  const chatId = await resolveWahaChatId(cfg, toE164);
  const endpoint =
    kind === 'image'
      ? '/api/sendImage'
      : kind === 'video'
        ? '/api/sendVideo'
        : kind === 'audio'
          ? '/api/sendVoice'
          : '/api/sendFile';
  const file: Record<string, unknown> = { url: mediaUrl };
  if (filename) file.filename = filename;
  const body: Record<string, unknown> = {
    session: cfg.session,
    chatId,
    file,
  };
  if (caption && kind !== 'audio') body.caption = caption;
  // WAHA-Plus transcodes non-OGG uploads to opus voice notes when this
  // flag is set — the browser recorder produces webm/mp4, so without it
  // the send fails with "unsupported audio format".
  if (kind === 'audio') body.convert = true;

  const res = await wahaFetch(cfg, endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { id?: { _serialized?: string; id?: string } | string };
  const id =
    typeof json.id === 'string'
      ? json.id
      : json.id?._serialized ?? json.id?.id ?? `waha_${Date.now()}`;
  return { id };
}

/**
 * Send (or clear, with empty string) a reaction to a previously-sent
 * WhatsApp message. WAHA endpoint: `PUT /api/reaction` with the target's
 * serialized message id (the value we stored on `messages.message_id`).
 */
export async function sendWahaReaction(
  cfg: WahaConfig,
  targetMessageId: string,
  emoji: string,
): Promise<void> {
  await wahaFetch(cfg, '/api/reaction', {
    method: 'PUT',
    body: JSON.stringify({
      session: cfg.session,
      messageId: targetMessageId,
      reaction: emoji,
    }),
  });
}
