// ============================================================
// WAHA adapter — implements MessagingProvider on top of the existing
// WAHA HTTP helpers (`src/lib/whatsapp/waha-api.ts`), reusing the same
// chat-id resolution the manual send path already relies on.
//
// Credentials never leave the server: the api key is decrypted here,
// used for the call, and never returned to the caller.
// ============================================================

import {
  sendWahaText,
  sendWahaMedia,
  extractWahaChatId,
  type WahaConfig,
  type WahaMediaKind,
} from '@/lib/whatsapp/waha-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { renderNumberedMenu } from './menu'
import {
  MessagingProviderError,
  type MessagingProvider,
  type SendInteractiveParams,
  type SendMediaParams,
  type SendResult,
  type SendTemplateParams,
  type SendTextParams,
  type SendContext,
} from './types'

interface WahaConfigRow {
  id: string
  waha_base_url: string | null
  waha_api_key: string | null
  waha_session: string | null
}

function fail(code: string, message: string): never {
  throw new MessagingProviderError('waha', code, message)
}

function toWahaConfig(row: WahaConfigRow): WahaConfig {
  if (!row.waha_base_url || !row.waha_api_key) {
    fail(
      'not_configured',
      'Configuração WAHA incompleta. Reconecte em Configurações → WhatsApp.',
    )
  }
  return {
    baseUrl: row.waha_base_url,
    apiKey: decrypt(row.waha_api_key),
    session: row.waha_session || 'default',
  }
}

/** Phone + preferred chat id for this conversation. */
async function resolveTarget(ctx: SendContext) {
  const db = supabaseAdmin()

  const { data: contact } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', ctx.contactId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (!contact?.phone) fail('contact_not_found', 'contact not found for this account')

  // Reuse the chat id WAHA itself gave us on the last inbound message.
  // Critical for @lid chats, where the phone-derived id doesn't resolve.
  const { data: latestInbound } = await db
    .from('messages')
    .select('message_id')
    .eq('conversation_id', ctx.conversationId)
    .eq('sender_type', 'customer')
    .not('message_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const preferredChatId =
    typeof latestInbound?.message_id === 'string'
      ? extractWahaChatId(latestInbound.message_id)
      : null

  return { phone: contact.phone as string, preferredChatId }
}

async function persist(
  ctx: SendContext,
  row: {
    content_type: string
    content_text: string | null
    media_url?: string | null
    interactive_payload?: unknown
    message_id: string
    ai_generated?: boolean
  },
  preview: string,
): Promise<void> {
  const db = supabaseAdmin()
  const { error } = await db.from('messages').insert({
    conversation_id: ctx.conversationId,
    sender_type: 'bot',
    status: 'sent',
    ...row,
  })
  if (error) {
    throw new Error(`sent via WAHA but DB insert failed: ${error.message}`)
  }
  const now = new Date().toISOString()
  await db
    .from('conversations')
    .update({ last_message_text: preview, last_message_at: now, updated_at: now })
    .eq('id', ctx.conversationId)
}

export function createWahaProvider(configRow: WahaConfigRow): MessagingProvider {
  const cfg = toWahaConfig(configRow)

  const sendText = async (params: SendTextParams): Promise<SendResult> => {
    const { phone, preferredChatId } = await resolveTarget(params)
    const { id } = await sendWahaText(cfg, phone, params.text, preferredChatId)
    await persist(
      params,
      {
        content_type: 'text',
        content_text: params.text,
        message_id: id,
        ai_generated: params.aiGenerated ?? false,
      },
      params.text,
    )
    return { whatsapp_message_id: id, provider: 'waha' }
  }

  return {
    name: 'waha',
    sendText,

    async sendMedia(params: SendMediaParams): Promise<SendResult> {
      const { phone, preferredChatId } = await resolveTarget(params)
      const { id } = await sendWahaMedia(
        cfg,
        phone,
        params.kind as WahaMediaKind,
        params.link,
        params.caption ?? null,
        params.filename ?? null,
        preferredChatId,
      )
      await persist(
        params,
        {
          content_type: params.kind,
          content_text: params.caption ?? null,
          media_url: params.link,
          message_id: id,
        },
        params.caption || `[${params.kind}]`,
      )
      return { whatsapp_message_id: id, provider: 'waha' }
    },

    async sendTemplate(params: SendTemplateParams): Promise<SendResult> {
      // WAHA has no template catalogue; the flow author must use a text
      // node instead. Failing loudly beats silently sending nothing.
      void params
      fail(
        'unsupported_by_provider',
        'Templates oficiais da Meta não existem no WAHA. Use um bloco de texto neste fluxo.',
      )
    },

    async sendMenu(params: SendInteractiveParams): Promise<SendResult> {
      // No reliable native buttons/lists → numbered text menu. The
      // engine matches the reply with `matchMenuOption`.
      const text = renderNumberedMenu(params.payload)
      const { phone, preferredChatId } = await resolveTarget(params)
      const { id } = await sendWahaText(cfg, phone, text, preferredChatId)
      await persist(
        params,
        {
          content_type: 'text',
          content_text: text,
          interactive_payload: params.payload,
          message_id: id,
        },
        params.payload.body,
      )
      return { whatsapp_message_id: id, provider: 'waha', degradedToText: true }
    },
  }
}
