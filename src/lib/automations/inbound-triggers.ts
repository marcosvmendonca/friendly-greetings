import type { AutomationTriggerType } from '@/types'

export interface InboundTriggerInput {
  /** A flow already consumed the message (customer is navigating a menu). */
  flowConsumed: boolean
  /** The contact row was created by this very webhook delivery. */
  contactWasCreated: boolean
  /** This delivery won the atomic `conversations.first_inbound_at` claim. */
  isFirstInboundMessage: boolean
  /** Numbered-menu answer resolved back to a button / list-row id. */
  menuReplyId?: string | null
}

/**
 * Decide which automation triggers an inbound customer message fires.
 *
 * Relationship-level triggers (new contact / first inbound) always fire,
 * even when a flow consumed the message. Content-level triggers are
 * suppressed in that case — the text belongs to the flow, not to a
 * keyword automation.
 *
 * Ordering is meaningful: relationship triggers run before content ones
 * so an onboarding automation sees the contact before a keyword reply.
 * The result is always de-duplicated, so a trigger can never run twice
 * for a single message.
 */
export function computeInboundAutomationTriggers(
  input: InboundTriggerInput,
): AutomationTriggerType[] {
  const content: AutomationTriggerType[] = []
  if (!input.flowConsumed) {
    content.push('new_message_received', 'keyword_match')
    if (input.menuReplyId) content.push('interactive_reply')
  }

  const ordered: AutomationTriggerType[] = []
  if (input.isFirstInboundMessage) ordered.push('first_inbound_message')
  if (input.contactWasCreated) ordered.push('new_contact_created')
  ordered.push(...content)

  return Array.from(new Set(ordered))
}
