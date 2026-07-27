// ============================================================
// Numbered-menu reply resolution for text-only providers (WAHA).
//
// Meta echoes a button/list id back to us, so the webhook knows
// immediately which option the customer tapped. WAHA renders menus as
// plain numbered text, so the answer arrives as "2" / "Suporte". This
// helper looks at the most recent menu we sent in the conversation and
// maps the free text back to the original option id — restoring the
// `interactive_reply` trigger and flow button matching on WAHA.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import { matchMenuOption, menuOptionsFromPayload } from './menu'

/** Menus older than this are considered stale (customer moved on). */
const MENU_TTL_MS = 6 * 60 * 60 * 1000

export interface MenuReplyMatch {
  reply_id: string
  label: string
  /** Message id of the menu that was answered. */
  menu_message_id: string
}

export async function resolveMenuReply(
  db: SupabaseClient,
  conversationId: string,
  answer: string,
  now: Date = new Date(),
): Promise<MenuReplyMatch | null> {
  const text = (answer ?? '').trim()
  if (!text) return null

  const { data: menu } = await db
    .from('messages')
    .select('id, interactive_payload, created_at')
    .eq('conversation_id', conversationId)
    .not('interactive_payload', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!menu?.interactive_payload) return null

  const sentAt = menu.created_at ? Date.parse(menu.created_at as string) : NaN
  if (Number.isFinite(sentAt) && now.getTime() - sentAt > MENU_TTL_MS) return null

  let options
  try {
    options = menuOptionsFromPayload(
      menu.interactive_payload as unknown as InteractiveMessagePayload,
    )
  } catch {
    return null
  }
  if (options.length === 0) return null

  const match = matchMenuOption(text, options)
  if (!match) return null

  return {
    reply_id: match.value,
    label: match.label,
    menu_message_id: menu.id as string,
  }
}
