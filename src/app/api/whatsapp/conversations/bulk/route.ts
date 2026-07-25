import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * POST /api/whatsapp/conversations/bulk
 *
 * Ações em massa sobre múltiplas conversas. Escopo restrito à conta
 * do caller (RLS já filtra, mas revalidamos explicitamente antes de
 * qualquer escrita).
 *
 * Body:
 * {
 *   ids: string[];
 *   action: 'delete' | 'status' | 'assign';
 *   status?: 'open' | 'pending' | 'closed';   // quando action = 'status'
 *   assigned_agent_id?: string | null;         // quando action = 'assign'
 * }
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    ids?: string[];
    action?: 'delete' | 'status' | 'assign';
    status?: 'open' | 'pending' | 'closed';
    assigned_agent_id?: string | null;
  };

  const ids = Array.isArray(body.ids) ? body.ids.filter((v) => typeof v === 'string') : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: 'Missing ids' }, { status: 400 });
  }
  if (ids.length > 200) {
    return NextResponse.json({ error: 'Too many ids (max 200)' }, { status: 400 });
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

  // Filtra ids que realmente pertencem à conta antes de qualquer mutação.
  const { data: owned } = await supabase
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .in('id', ids);
  const ownedIds = (owned ?? []).map((r: { id: string }) => r.id);
  if (ownedIds.length === 0) {
    return NextResponse.json({ ok: true, affected: 0 });
  }

  if (body.action === 'delete') {
    // Deleta reações → mensagens → conversas, sem depender de cascade.
    const { data: msgs } = await supabase
      .from('messages')
      .select('id')
      .in('conversation_id', ownedIds);
    const msgIds = (msgs ?? []).map((m: { id: string }) => m.id);
    if (msgIds.length > 0) {
      await supabase.from('message_reactions').delete().in('message_id', msgIds);
    }
    await supabase.from('messages').delete().in('conversation_id', ownedIds);
    const { error } = await supabase.from('conversations').delete().in('id', ownedIds);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, affected: ownedIds.length });
  }

  if (body.action === 'status') {
    if (!body.status || !['open', 'pending', 'closed'].includes(body.status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }
    const { error } = await supabase
      .from('conversations')
      .update({ status: body.status, updated_at: new Date().toISOString() })
      .in('id', ownedIds);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, affected: ownedIds.length, status: body.status });
  }

  if (body.action === 'assign') {
    const agentId = body.assigned_agent_id ?? null;
    // Se atribuindo a um agente, valida que ele pertence à mesma conta.
    if (agentId) {
      const { data: member } = await supabase
        .from('profiles')
        .select('user_id')
        .eq('user_id', agentId)
        .eq('account_id', accountId)
        .maybeSingle();
      if (!member) {
        return NextResponse.json({ error: 'Agent not in this account' }, { status: 400 });
      }
    }
    const { error } = await supabase
      .from('conversations')
      .update({ assigned_agent_id: agentId, updated_at: new Date().toISOString() })
      .in('id', ownedIds);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, affected: ownedIds.length, assigned_agent_id: agentId });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
