// ============================================================
// Meta adapter — thin wrapper over the existing, battle-tested
// senders in `@/lib/flows/meta-send` and `@/lib/automations/meta-send`.
//
// Deliberately no behaviour change: phone-variant retry, contact
// auto-fix and the `messages` insert all stay where they are. This file
// only reshapes them into the MessagingProvider contract so the engines
// can be provider-agnostic.
// ============================================================

import {
  engineSendText as metaSendText,
  engineSendMedia as metaSendMedia,
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from '@/lib/flows/meta-send'
import { engineSendTemplate as metaSendTemplate } from '@/lib/automations/meta-send'
import type {
  MessagingProvider,
  SendInteractiveParams,
  SendMediaParams,
  SendResult,
  SendTemplateParams,
  SendTextParams,
} from './types'

export function createMetaProvider(): MessagingProvider {
  return {
    name: 'meta',

    async sendText(params: SendTextParams): Promise<SendResult> {
      const r = await metaSendText(params)
      return { whatsapp_message_id: r.whatsapp_message_id, provider: 'meta' }
    },

    async sendMedia(params: SendMediaParams): Promise<SendResult> {
      const r = await metaSendMedia(params)
      return { whatsapp_message_id: r.whatsapp_message_id, provider: 'meta' }
    },

    async sendTemplate(params: SendTemplateParams): Promise<SendResult> {
      const r = await metaSendTemplate(params)
      return { whatsapp_message_id: r.whatsapp_message_id, provider: 'meta' }
    },

    async sendMenu(params: SendInteractiveParams): Promise<SendResult> {
      const { payload, accountId, userId, conversationId, contactId } = params
      const common = { accountId, userId, conversationId, contactId }
      const r =
        payload.kind === 'buttons'
          ? await engineSendInteractiveButtons({
              ...common,
              bodyText: payload.body,
              headerText: payload.header,
              footerText: payload.footer,
              buttons: payload.buttons,
            })
          : await engineSendInteractiveList({
              ...common,
              bodyText: payload.body,
              buttonLabel: payload.button_label,
              headerText: payload.header,
              footerText: payload.footer,
              sections: payload.sections,
            })
      return { whatsapp_message_id: r.whatsapp_message_id, provider: 'meta' }
    },
  }
}
