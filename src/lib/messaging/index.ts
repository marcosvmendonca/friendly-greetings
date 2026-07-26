// ============================================================
// Provider resolver + the unified send API the engines call.
//
//   await sendEngineText({ accountId, userId, conversationId,
//                          contactId, text })
//
// The resolver looks up `whatsapp_config` for the account, reads
// `provider`, and returns the matching adapter. Credentials stay on the
// server — nothing here is safe to expose to the frontend, and nothing
// here is imported by client components.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { createMetaProvider } from './meta-provider'
import { createWahaProvider } from './waha-provider'
import {
  MessagingProviderError,
  type MessagingProvider,
  type ProviderName,
  type SendInteractiveParams,
  type SendMediaParams,
  type SendResult,
  type SendTemplateParams,
  type SendTextParams,
} from './types'

export * from './types'
export * from './menu'

/**
 * Resolve the messaging adapter for an account's active WhatsApp
 * connection. Meta and WAHA coexist in the same table; only one row per
 * account is active, and `provider` decides which transport is used.
 */
export async function getMessagingProvider(
  accountId: string,
): Promise<MessagingProvider> {
  const db = supabaseAdmin()
  const { data: config, error } = await db
    .from('whatsapp_config')
    .select('id, provider, waha_base_url, waha_api_key, waha_session')
    .eq('account_id', accountId)
    .maybeSingle()

  if (error || !config) {
    throw new MessagingProviderError(
      'meta',
      'not_configured',
      'WhatsApp not configured for this account',
    )
  }

  const provider = ((config.provider as ProviderName | null) ?? 'meta')
  if (provider === 'waha') {
    return createWahaProvider({
      id: config.id as string,
      waha_base_url: (config.waha_base_url as string | null) ?? null,
      waha_api_key: (config.waha_api_key as string | null) ?? null,
      waha_session: (config.waha_session as string | null) ?? null,
    })
  }
  return createMetaProvider()
}

/** Which provider an account is on — for logs and trigger filtering. */
export async function getAccountProvider(
  accountId: string,
): Promise<ProviderName> {
  const db = supabaseAdmin()
  const { data } = await db
    .from('whatsapp_config')
    .select('provider')
    .eq('account_id', accountId)
    .maybeSingle()
  return ((data?.provider as ProviderName | null) ?? 'meta')
}

// ---- Unified entry points used by the automation + flow engines ----

export async function sendEngineText(
  params: SendTextParams,
): Promise<SendResult> {
  return (await getMessagingProvider(params.accountId)).sendText(params)
}

export async function sendEngineMedia(
  params: SendMediaParams,
): Promise<SendResult> {
  return (await getMessagingProvider(params.accountId)).sendMedia(params)
}

export async function sendEngineTemplate(
  params: SendTemplateParams,
): Promise<SendResult> {
  return (await getMessagingProvider(params.accountId)).sendTemplate(params)
}

export async function sendEngineMenu(
  params: SendInteractiveParams,
): Promise<SendResult> {
  return (await getMessagingProvider(params.accountId)).sendMenu(params)
}
