import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { sendReactionMessage } from '@/lib/whatsapp/meta-api';
import { sendWahaReaction } from '@/lib/whatsapp/waha-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/**
 * POST /api/whatsapp/react
 *
 * Body: { message_id: <internal UUID>, emoji: <single emoji or "" to remove> }
 *
 * Dispatches to Meta or WAHA depending on the account's active provider,
 * then mirrors the reaction into `message_reactions` (delete on empty
 * emoji). Customer-side reactions are handled by the webhook — this route
 * only writes `actor_type = 'agent'` rows.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const limit = checkRateLimit(`react:${user.id}`, RATE_LIMITS.react);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle();
    const accountId = profile?.account_id as string | undefined;
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      );
    }

    const body = await request.json();
    const { message_id, emoji } = body as {
      message_id?: string;
      emoji?: string;
    };

    if (!message_id || typeof emoji !== 'string') {
      return NextResponse.json(
        { error: 'message_id and emoji are required' },
        { status: 400 },
      );
    }

    const { data: targetMessage, error: msgError } = await supabase
      .from('messages')
      .select('id, message_id, conversation_id')
      .eq('id', message_id)
      .maybeSingle();

    if (msgError || !targetMessage) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    if (!targetMessage.message_id) {
      return NextResponse.json(
        { error: 'Cannot react to a message that has not been sent to WhatsApp' },
        { status: 400 },
      );
    }

    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id, account_id, contact:contacts(phone)')
      .eq('id', targetMessage.conversation_id)
      .eq('account_id', accountId)
      .maybeSingle();

    if (convError || !conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 },
      );
    }

    const contact = Array.isArray(conversation.contact)
      ? conversation.contact[0]
      : conversation.contact;
    if (!contact?.phone) {
      return NextResponse.json(
        { error: 'Contact phone number not found' },
        { status: 400 },
      );
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single();

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured.' },
        { status: 400 },
      );
    }

    const provider = (config.provider as 'meta' | 'waha' | undefined) ?? 'meta';

    try {
      if (provider === 'waha') {
        if (!config.waha_base_url || !config.waha_api_key) {
          return NextResponse.json(
            { error: 'WAHA config incompleta. Reconecte em Settings → WhatsApp.' },
            { status: 400 },
          );
        }
        await sendWahaReaction(
          {
            baseUrl: config.waha_base_url as string,
            apiKey: decrypt(config.waha_api_key as string),
            session: (config.waha_session as string) || 'default',
          },
          targetMessage.message_id,
          emoji,
        );
      } else {
        const accessToken = decrypt(config.access_token);
        const sanitizedPhone = sanitizePhoneForMeta(contact.phone);
        await sendReactionMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: sanitizedPhone,
          targetMessageId: targetMessage.message_id,
          emoji,
        });
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown provider error';
      console.error(`[whatsapp/react] ${provider} send failed:`, message);
      return NextResponse.json(
        { error: `${provider === 'waha' ? 'WAHA' : 'Meta'} error: ${message}` },
        { status: 502 },
      );
    }

    if (emoji === '') {
      const { error: delError } = await supabase
        .from('message_reactions')
        .delete()
        .eq('message_id', targetMessage.id)
        .eq('actor_type', 'agent')
        .eq('actor_id', user.id);

      if (delError) {
        console.error('[whatsapp/react] DB delete failed:', delError.message);
        return NextResponse.json(
          { error: 'Reaction sent but DB delete failed' },
          { status: 500 },
        );
      }
    } else {
      const { error: upsertError } = await supabase.from('message_reactions').upsert(
        {
          message_id: targetMessage.id,
          conversation_id: targetMessage.conversation_id,
          actor_type: 'agent',
          actor_id: user.id,
          emoji,
        },
        { onConflict: 'message_id,actor_type,actor_id' },
      );

      if (upsertError) {
        console.error('[whatsapp/react] DB upsert failed:', upsertError.message);
        return NextResponse.json(
          { error: 'Reaction sent but DB upsert failed' },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error in WhatsApp react POST:', message);
    return NextResponse.json(
      { error: `Failed to react: ${message}` },
      { status: 500 },
    );
  }
}
