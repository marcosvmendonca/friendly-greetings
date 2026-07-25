import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  fetchWahaChats,
  fetchWahaChatMessages,
  type WahaConfig,
} from '@/lib/whatsapp/waha-api';

/**
 * POST /api/whatsapp/waha/sync-all
 *
 * Puxa todas as conversas conhecidas pelo motor WAHA e reprocessa as
 * últimas N mensagens de cada uma pelo webhook interno. Ignora grupos.
 *
 * Body: { limitPerChat?: number (default 30, max 100), maxChats?: number (default 50, max 200) }
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    limitPerChat?: number;
    maxChats?: number;
  };
  const limitPerChat = Math.min(Math.max(1, Number(body.limitPerChat ?? 30) || 30), 100);
  const maxChats = Math.min(Math.max(1, Number(body.maxChats ?? 50) || 50), 200);

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

  let chats: Awaited<ReturnType<typeof fetchWahaChats>> = [];
  try {
    chats = await fetchWahaChats(cfg, maxChats);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `WAHA list chats failed: ${reason}` }, { status: 502 });
  }

  const origin = new URL(request.url).origin;
  const webhookUrl = `${origin}/api/whatsapp/waha-webhook`;
  const oneToOne = chats.filter((c) => !c.isGroup && c.id && !c.id.includes('@g.us'));

  let ingested = 0;
  let processedChats = 0;
  for (const chat of oneToOne.slice(0, maxChats)) {
    processedChats += 1;
    let messages: unknown[] = [];
    try {
      messages = await fetchWahaChatMessages(cfg, chat.id, limitPerChat);
    } catch {
      continue;
    }
    for (const raw of messages) {
      try {
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'message', session: cfg.session, payload: raw }),
        });
        if (res.ok) ingested += 1;
      } catch {
        // segue
      }
    }
  }

  return NextResponse.json({
    ok: true,
    chats_seen: chats.length,
    chats_processed: processedChats,
    ingested,
  });
}
