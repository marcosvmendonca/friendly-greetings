import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { decrypt } from '@/lib/whatsapp/encryption';
import { fetchWahaChatMessages, toWahaChatId, type WahaConfig } from '@/lib/whatsapp/waha-api';

/**
 * POST /api/whatsapp/conversations/[id]/sync
 *
 * Puxa as últimas N mensagens do chat direto da API WAHA e reprocessa
 * cada uma pela rota de webhook interna, para reaproveitar TODA a
 * lógica de normalização, dedup e storage de mídia.
 *
 * Body: { limit?: number (default 50, max 300) }
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { limit?: number };
  const rawLimit = Number(body.limit ?? 50);
  const limit = Math.min(Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 50), 300);

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
  if (!accountId) return NextResponse.json({ error: 'No account' }, { status: 403 });

  const { data: conv } = await supabase
    .from('conversations')
    .select('id, account_id, contact:contact_id(phone)')
    .eq('id', id)
    .maybeSingle();
  if (!conv || conv.account_id !== accountId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const contact = (conv as { contact?: { phone?: string | null } | null }).contact ?? null;
  const phone = contact?.phone;
  if (!phone) return NextResponse.json({ error: 'Contact has no phone' }, { status: 400 });

  const { data: cfgRow } = await supabase
    .from('whatsapp_config')
    .select('provider, waha_base_url, waha_api_key, waha_session')
    .eq('account_id', accountId)
    .maybeSingle();
  if (!cfgRow || cfgRow.provider !== 'waha' || !cfgRow.waha_base_url || !cfgRow.waha_api_key) {
    return NextResponse.json({ error: 'WAHA not configured' }, { status: 400 });
  }

  let cfg: WahaConfig;
  try {
    cfg = {
      baseUrl: cfgRow.waha_base_url as string,
      apiKey: decrypt(cfgRow.waha_api_key as string),
      session: (cfgRow.waha_session as string | null) || 'default',
    };
  } catch {
    return NextResponse.json({ error: 'Failed to decrypt WAHA key' }, { status: 500 });
  }

  const chatId = toWahaChatId(phone);
  let messages: unknown[] = [];
  try {
    messages = await fetchWahaChatMessages(cfg, chatId, limit);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `WAHA fetch failed: ${reason}` }, { status: 502 });
  }

  const origin = new URL(request.url).origin;
  const webhookUrl = `${origin}/api/whatsapp/waha-webhook`;
  let ingested = 0;
  for (const raw of messages) {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'message',
          session: cfg.session,
          payload: raw,
        }),
      });
      if (res.ok) ingested += 1;
    } catch {
      // segue com as próximas
    }
  }

  return NextResponse.json({ ok: true, fetched: messages.length, ingested });
}
