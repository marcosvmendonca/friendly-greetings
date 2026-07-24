import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { encrypt, decrypt } from '@/lib/whatsapp/encryption';
import {
  getWahaSession,
  startWahaSession,
  stopWahaSession,
  logoutWahaSession,
  getWahaQr,
  WahaApiError,
  type WahaConfig,
} from '@/lib/whatsapp/waha-api';

/**
 * Manage the WAHA session bound to the caller's account.
 *
 * GET    → returns current status + QR (base64 data URL) if scanning
 * POST   → save/update WAHA credentials and start the session
 * DELETE → logout + stop the session and clear WAHA credentials
 *
 * The Meta config route (`/api/whatsapp/config`) stays untouched — this
 * one owns the WAHA-provider path so the two flows don't fight over
 * shared state.
 */

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle();
  return (data?.account_id as string | undefined) ?? null;
}

function buildWahaConfigFromRow(row: {
  waha_base_url: string | null;
  waha_api_key: string | null;
  waha_session: string | null;
}): WahaConfig {
  if (!row.waha_base_url || !row.waha_api_key) {
    throw new Error('WAHA config incomplete');
  }
  return {
    baseUrl: row.waha_base_url,
    apiKey: decrypt(row.waha_api_key),
    session: row.waha_session || 'default',
  };
}

function resolveWebhookUrl(request: Request): string {
  const override =
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL;
  const base = override
    ? override.replace(/\/+$/, '')
    : new URL(request.url).origin;
  return `${base}/api/whatsapp/waha-webhook`;
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const accountId = await resolveAccountId(supabase, user.id);
  if (!accountId) {
    return NextResponse.json({ connected: false, reason: 'no_account' });
  }

  const webhookUrl = resolveWebhookUrl(request);

  const { data: row } = await supabase
    .from('whatsapp_config')
    .select(
      'provider, waha_base_url, waha_api_key, waha_session, status, connected_at',
    )
    .eq('account_id', accountId)
    .maybeSingle();

  if (!row || row.provider !== 'waha' || !row.waha_base_url) {
    return NextResponse.json({
      connected: false,
      reason: 'no_config',
      message: 'WAHA não configurado.',
      webhook_url: webhookUrl,
    });
  }

  let cfg: WahaConfig;
  try {
    cfg = buildWahaConfigFromRow(row);
  } catch {
    return NextResponse.json({
      connected: false,
      reason: 'token_corrupted',
      needs_reset: true,
      message: 'Chave API do WAHA não pôde ser decifrada.',
      webhook_url: webhookUrl,
    });
  }

  try {
    const session = await getWahaSession(cfg);
    let qr: string | null = null;
    if (session?.status === 'SCAN_QR_CODE') {
      qr = await getWahaQr(cfg).catch(() => null);
    }
    return NextResponse.json({
      connected: session?.status === 'WORKING',
      status: session?.status ?? 'STOPPED',
      me: session?.me ?? null,
      qr,
      base_url: row.waha_base_url,
      session: row.waha_session || 'default',
      webhook_url: webhookUrl,
    });
  } catch (err) {
    const msg =
      err instanceof WahaApiError
        ? `WAHA ${err.status}: ${err.body.slice(0, 200)}`
        : err instanceof Error
          ? err.message
          : 'Erro desconhecido';
    return NextResponse.json(
      {
        connected: false,
        reason: 'waha_api_error',
        message: msg,
        webhook_url: webhookUrl,
      },
      { status: 200 },
    );
  }
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const accountId = await resolveAccountId(supabase, user.id);
  if (!accountId) {
    return NextResponse.json(
      { error: 'Sem conta vinculada.' },
      { status: 403 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const {
    base_url,
    api_key,
    session = 'default',
  } = body as { base_url?: string; api_key?: string; session?: string };

  if (!base_url || !api_key) {
    return NextResponse.json(
      { error: 'base_url e api_key são obrigatórios.' },
      { status: 400 },
    );
  }

  let encryptedApiKey: string;
  try {
    encryptedApiKey = encrypt(api_key);
  } catch {
    return NextResponse.json(
      { error: 'Falha ao encriptar a chave. Verifique ENCRYPTION_KEY.' },
      { status: 500 },
    );
  }

  const cfg: WahaConfig = { baseUrl: base_url, apiKey: api_key, session };
  const webhookUrl = resolveWebhookUrl(request);

  // Kick off the session on WAHA first — no point saving credentials
  // that can't actually reach the WAHA instance.
  try {
    await startWahaSession(cfg, webhookUrl);
  } catch (err) {
    const msg =
      err instanceof WahaApiError
        ? `WAHA ${err.status}: ${err.body.slice(0, 200)}`
        : err instanceof Error
          ? err.message
          : 'Erro desconhecido';
    return NextResponse.json(
      { error: `Não foi possível iniciar a sessão WAHA: ${msg}` },
      { status: 400 },
    );
  }

  const { data: existing } = await supabase
    .from('whatsapp_config')
    .select('id')
    .eq('account_id', accountId)
    .maybeSingle();

  // Switching to WAHA: null out Meta-only fields so the Meta panel
  // doesn't keep reporting a broken/corrupted Meta connection on a row
  // that is now owned by WAHA. Only one provider can be active per
  // account.
  const row = {
    provider: 'waha' as const,
    waha_base_url: base_url,
    waha_api_key: encryptedApiKey,
    waha_session: session,
    status: 'disconnected' as const,
    phone_number_id: null,
    waba_id: null,
    access_token: null,
    verify_token: null,
    registered_at: null,
    subscribed_apps_at: null,
    last_registration_error: null,
    connected_at: null,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    const { error } = await supabase
      .from('whatsapp_config')
      .update(row)
      .eq('account_id', accountId);
    if (error) {
      return NextResponse.json(
        { error: 'Falha ao salvar configuração WAHA.' },
        { status: 500 },
      );
    }
  } else {
    const { error } = await supabase.from('whatsapp_config').insert({
      account_id: accountId,
      user_id: user.id,
      ...row,
    });
    if (error) {
      return NextResponse.json(
        { error: 'Falha ao criar configuração WAHA.' },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ success: true });
}

export async function DELETE() {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const accountId = await resolveAccountId(supabase, user.id);
  if (!accountId) {
    return NextResponse.json({ error: 'Sem conta.' }, { status: 403 });
  }

  const { data: row } = await supabase
    .from('whatsapp_config')
    .select('waha_base_url, waha_api_key, waha_session, provider')
    .eq('account_id', accountId)
    .maybeSingle();

  if (row && row.provider === 'waha' && row.waha_base_url && row.waha_api_key) {
    try {
      const cfg = buildWahaConfigFromRow(row);
      await logoutWahaSession(cfg).catch(() => undefined);
      await stopWahaSession(cfg).catch(() => undefined);
    } catch {
      // best effort — still clear the row below
    }
  }

  await supabase.from('whatsapp_config').delete().eq('account_id', accountId);
  return NextResponse.json({ success: true });
}

/**
 * PATCH → reapply webhook + restart session on WAHA without touching
 * stored credentials. Useful when the app URL changed (new deployment
 * domain) or the WAHA session got stuck.
 */
export async function PATCH(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const accountId = await resolveAccountId(supabase, user.id);
  if (!accountId) return NextResponse.json({ error: 'Sem conta.' }, { status: 403 });

  const { data: row } = await supabase
    .from('whatsapp_config')
    .select('waha_base_url, waha_api_key, waha_session, provider')
    .eq('account_id', accountId)
    .maybeSingle();

  if (!row || row.provider !== 'waha') {
    return NextResponse.json({ error: 'WAHA não configurado.' }, { status: 400 });
  }

  let cfg: WahaConfig;
  try {
    cfg = buildWahaConfigFromRow(row);
  } catch {
    return NextResponse.json({ error: 'Chave corrompida.' }, { status: 400 });
  }

  const webhookUrl = resolveWebhookUrl(request);
  try {
    // Stop then start to force WAHA to pick up the new webhook config.
    await stopWahaSession(cfg).catch(() => undefined);
    await startWahaSession(cfg, webhookUrl);
    return NextResponse.json({ success: true, webhook_url: webhookUrl });
  } catch (err) {
    const msg =
      err instanceof WahaApiError
        ? `WAHA ${err.status}: ${err.body.slice(0, 200)}`
        : err instanceof Error
          ? err.message
          : 'Erro desconhecido';
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
