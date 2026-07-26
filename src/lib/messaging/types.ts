// ============================================================
// Provider-neutral messaging layer.
//
// The automation + flow engines used to import the Meta senders
// directly (`@/lib/flows/meta-send`). That hard-wired every automation
// to the official Cloud API. This module defines the shared contract so
// the engines can call ONE function and the resolver picks the adapter
// (Meta today, WAHA today, anything else later) from the account's
// `whatsapp_config.provider`.
//
// Every adapter is responsible for the same three things:
//   1. send through its own transport,
//   2. persist the outgoing row in `messages` (sender_type='bot'),
//   3. refresh the conversation preview columns.
// ============================================================

import type { MediaKind } from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'

export type ProviderName = 'meta' | 'waha'

/** Identifiers every engine send already has on hand. */
export interface SendContext {
  /** Tenancy key — drives contact + whatsapp_config lookups. */
  accountId: string
  /** Author of the automation/flow; audit only, never tenancy. */
  userId: string
  conversationId: string
  contactId: string
}

export interface SendTextParams extends SendContext {
  text: string
  /** Badges the persisted row as an AI reply in the inbox. */
  aiGenerated?: boolean
}

export interface SendMediaParams extends SendContext {
  kind: MediaKind
  /** Public URL the provider fetches at send time. */
  link: string
  caption?: string
  /** Document-only. */
  filename?: string
}

export interface SendTemplateParams extends SendContext {
  templateName: string
  language?: string
  params?: string[]
}

export interface SendInteractiveParams extends SendContext {
  payload: InteractiveMessagePayload
}

export interface SendResult {
  /** Provider-side message id, stored on `messages.message_id`. */
  whatsapp_message_id: string
  /** Which adapter actually delivered it. */
  provider: ProviderName
  /**
   * True when the provider had no native interactive support and the
   * menu was delivered as numbered plain text — the engine then has to
   * match replies by number/label instead of by button id.
   */
  degradedToText?: boolean
}

export interface MessagingProvider {
  readonly name: ProviderName
  sendText(params: SendTextParams): Promise<SendResult>
  sendMedia(params: SendMediaParams): Promise<SendResult>
  sendTemplate(params: SendTemplateParams): Promise<SendResult>
  /** Buttons/list. Adapters without native support fall back to text. */
  sendMenu(params: SendInteractiveParams): Promise<SendResult>
}

/** Thrown when an adapter can't fulfil a request at all. */
export class MessagingProviderError extends Error {
  readonly provider: ProviderName
  readonly code: string
  constructor(provider: ProviderName, code: string, message: string) {
    super(message)
    this.name = 'MessagingProviderError'
    this.provider = provider
    this.code = code
  }
}
