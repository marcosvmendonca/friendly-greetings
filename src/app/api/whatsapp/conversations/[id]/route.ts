import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * DELETE /api/whatsapp/conversations/[id]
 *
 * Remove uma conversa e todas as suas mensagens/reações. Verifica que
 * a conversa pertence à conta do usuário antes de excluir.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
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

  const { data: conv } = await supabase
    .from('conversations')
    .select('id, account_id')
    .eq('id', id)
    .maybeSingle();
  if (!conv || conv.account_id !== accountId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Excluir dependentes explicitamente para não depender de cascade.
  const { data: msgs } = await supabase
    .from('messages')
    .select('id')
    .eq('conversation_id', id);
  const msgIds = (msgs ?? []).map((m: { id: string }) => m.id);
  if (msgIds.length > 0) {
    await supabase.from('message_reactions').delete().in('message_id', msgIds);
  }
  await supabase.from('messages').delete().eq('conversation_id', id);

  const { error } = await supabase.from('conversations').delete().eq('id', id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
