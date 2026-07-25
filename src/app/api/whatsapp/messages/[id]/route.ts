import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * DELETE /api/whatsapp/messages/[id]
 *
 * Remove uma mensagem do banco (hard-delete). Verifica que a mensagem
 * pertence a uma conversa da conta do usuário. Reações associadas são
 * removidas antes (sem depender de cascade).
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

  // Verifica ownership via join na conversa.
  const { data: msgRow } = await supabase
    .from('messages')
    .select('id, conversation_id, conversations!inner(account_id)')
    .eq('id', id)
    .maybeSingle();
  const msg = msgRow as
    | { id: string; conversation_id: string; conversations: { account_id: string } }
    | null;
  if (!msg || msg.conversations.account_id !== accountId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Reações primeiro (caso não haja cascade).
  await supabase.from('message_reactions').delete().eq('message_id', id);

  const { error } = await supabase.from('messages').delete().eq('id', id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
