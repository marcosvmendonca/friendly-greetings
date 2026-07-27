import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AutomationTriggerType } from '@/types'

// Integration-style harness: the real automation engine runs against a
// fake service-role client that honours the account/trigger/active
// filters, so each test proves a trigger fires in the right context and
// exactly once per event.
const h = vi.hoisted(() => ({
  state: {
    automations: [] as Record<string, unknown>[],
    stepsByAutomation: {} as Record<string, Record<string, unknown>[]>,
    executions: [] as string[],
  },
}))

vi.mock('./admin-client', () => {
  const { state } = h

  function matches(row: Record<string, unknown>, filters: [string, string, unknown][]) {
    return filters.every(([op, k, v]) => op !== 'eq' || row[k] === v)
  }

  function resolve(ops: {
    table: string
    type: string
    payload?: unknown
    filters: [string, string, unknown][]
  }) {
    const { table, type, filters } = ops
    if (table === 'contacts') {
      if (type === 'update') return { data: null, error: null }
      return { data: { id: 'c1' }, error: null }
    }
    if (table === 'automations') {
      return { data: state.automations.filter((a) => matches(a, filters)), error: null }
    }
    if (table === 'automation_steps') {
      const automationId = filters.find(([, k]) => k === 'automation_id')?.[2] as string
      return { data: state.stepsByAutomation[automationId] ?? [], error: null }
    }
    if (table === 'automation_logs') {
      if (type === 'insert') {
        const payload = ops.payload as { automation_id: string }
        state.executions.push(payload.automation_id)
        return { data: { id: `log-${state.executions.length}` }, error: null }
      }
      if (type === 'update') return { data: null, error: null }
      return { data: { steps_executed: [], status: 'success' }, error: null }
    }
    return { data: null, error: null }
  }

  function builder(table: string) {
    const ops = {
      table,
      type: 'select',
      payload: undefined as unknown,
      filters: [] as [string, string, unknown][],
    }
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((ops.type = 'insert'), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = 'update'), (ops.payload = p), b),
      delete: () => ((ops.type = 'delete'), b),
      upsert: (p: unknown) => ((ops.type = 'upsert'), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (ops.filters.push(['eq', k, v]), b),
      gte: () => b,
      is: () => b,
      order: () => b,
      limit: () => b,
      single: () => Promise.resolve(resolve(ops)),
      maybeSingle: () => Promise.resolve(resolve(ops)),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(ops)).then(onF, onR),
    }
    return b
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
      rpc: () => Promise.resolve({ error: null }),
    }),
  }
})

vi.mock('./meta-send', () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
  engineSendInteractive: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
}))

import { runAutomationsForTrigger } from './engine'
import { computeInboundAutomationTriggers } from './inbound-triggers'

const ACCOUNT = 'acct-1'

function automation(
  id: string,
  triggerType: AutomationTriggerType,
  triggerConfig: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    account_id: ACCOUNT,
    user_id: 'u1',
    name: id,
    trigger_type: triggerType,
    trigger_config: triggerConfig,
    is_active: true,
    ...overrides,
  }
}

function noopStep(automationId: string) {
  return {
    id: `${automationId}-s1`,
    automation_id: automationId,
    step_type: 'update_contact_field',
    position: 0,
    parent_step_id: null,
    step_config: { field: 'company', value: 'x' },
  }
}

function register(rows: Record<string, unknown>[]) {
  h.state.automations = rows
  for (const row of rows) {
    h.state.stepsByAutomation[row.id as string] = [noopStep(row.id as string)]
  }
}

beforeEach(() => {
  h.state.automations = []
  h.state.stepsByAutomation = {}
  h.state.executions = []
})

describe('automation triggers — fires in the right context', () => {
  it('new_message_received fires on any inbound text', async () => {
    register([automation('a-new-msg', 'new_message_received')])
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { message_text: 'oi', conversation_id: 'conv-1' },
    })
    expect(h.state.executions).toEqual(['a-new-msg'])
  })

  it('first_inbound_message fires only for its own trigger type', async () => {
    register([automation('a-first', 'first_inbound_message')])

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { message_text: 'oi' },
    })
    expect(h.state.executions).toEqual([])

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'first_inbound_message',
      contactId: 'c1',
      context: { message_text: 'oi' },
    })
    expect(h.state.executions).toEqual(['a-first'])
  })

  it('new_contact_created fires on contact creation only', async () => {
    register([automation('a-contact', 'new_contact_created')])
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_contact_created',
      contactId: 'c1',
      context: {},
    })
    expect(h.state.executions).toEqual(['a-contact'])
  })

  it('keyword_match fires only when the keyword is present', async () => {
    register([
      automation('a-kw', 'keyword_match', {
        keywords: ['preço'],
        match_type: 'contains',
        case_sensitive: false,
      }),
    ])

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'keyword_match',
      contactId: 'c1',
      context: { message_text: 'bom dia' },
    })
    expect(h.state.executions).toEqual([])

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'keyword_match',
      contactId: 'c1',
      context: { message_text: 'qual o PREÇO?' },
    })
    expect(h.state.executions).toEqual(['a-kw'])
  })

  it('tag_added fires only for the configured tag', async () => {
    register([automation('a-tag', 'tag_added', { tag_id: 'tag-a' })])

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'tag_added',
      contactId: 'c1',
      context: { tag_id: 'tag-b' },
    })
    expect(h.state.executions).toEqual([])

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'tag_added',
      contactId: 'c1',
      context: { tag_id: 'tag-a' },
    })
    expect(h.state.executions).toEqual(['a-tag'])
  })

  it('conversation_assigned fires when a conversation is handed to an agent', async () => {
    register([automation('a-assign', 'conversation_assigned')])
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'conversation_assigned',
      contactId: 'c1',
      context: { conversation_id: 'conv-1', agent_id: 'agent-9' },
    })
    expect(h.state.executions).toEqual(['a-assign'])
  })

  it('time_based fires from the scheduler without message context', async () => {
    register([automation('a-time', 'time_based')])
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'time_based',
      contactId: 'c1',
      context: {},
    })
    expect(h.state.executions).toEqual(['a-time'])
  })

  it('interactive_reply fires only for the tapped reply id', async () => {
    register([automation('a-reply', 'interactive_reply', { reply_ids: ['btn_support'] })])

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'interactive_reply',
      contactId: 'c1',
      context: { interactive_reply_id: 'btn_sales' },
    })
    expect(h.state.executions).toEqual([])

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'interactive_reply',
      contactId: 'c1',
      context: { interactive_reply_id: 'btn_support' },
    })
    expect(h.state.executions).toEqual(['a-reply'])
  })

  it('ignores inactive automations and other accounts', async () => {
    register([
      automation('a-off', 'new_message_received', {}, { is_active: false }),
      automation('a-foreign', 'new_message_received', {}, { account_id: 'acct-2' }),
    ])
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { message_text: 'oi' },
    })
    expect(h.state.executions).toEqual([])
  })
})

describe('inbound dispatch — no duplication per conversation', () => {
  /** Replays the webhook's dispatch loop for one inbound message. */
  async function deliverInbound(opts: {
    flowConsumed?: boolean
    contactWasCreated?: boolean
    isFirstInboundMessage?: boolean
    menuReplyId?: string | null
    text?: string
  }) {
    const triggers = computeInboundAutomationTriggers({
      flowConsumed: opts.flowConsumed ?? false,
      contactWasCreated: opts.contactWasCreated ?? false,
      isFirstInboundMessage: opts.isFirstInboundMessage ?? false,
      menuReplyId: opts.menuReplyId ?? null,
    })
    for (const triggerType of triggers) {
      await runAutomationsForTrigger({
        accountId: ACCOUNT,
        triggerType,
        contactId: 'c1',
        context: {
          message_text: opts.text ?? 'oi',
          conversation_id: 'conv-1',
          interactive_reply_id: opts.menuReplyId ?? undefined,
        },
      })
    }
  }

  it('runs the first-message automation once for the first inbound only', async () => {
    register([automation('a-first', 'first_inbound_message')])

    await deliverInbound({ isFirstInboundMessage: true })
    // Second delivery in the same conversation: the atomic first_inbound_at
    // claim in the webhook loses, so the trigger is no longer emitted.
    await deliverInbound({ isFirstInboundMessage: false })
    await deliverInbound({ isFirstInboundMessage: false })

    expect(h.state.executions.filter((id) => id === 'a-first')).toHaveLength(1)
  })

  it('runs the new-contact automation once even on the very first message', async () => {
    register([
      automation('a-contact', 'new_contact_created'),
      automation('a-first', 'first_inbound_message'),
    ])

    await deliverInbound({ contactWasCreated: true, isFirstInboundMessage: true })

    expect(h.state.executions).toEqual(['a-first', 'a-contact'])
  })

  it('does not run content automations twice when a menu reply is resolved', async () => {
    register([
      automation('a-new-msg', 'new_message_received'),
      automation('a-reply', 'interactive_reply', { reply_ids: ['btn_support'] }),
    ])

    await deliverInbound({ menuReplyId: 'btn_support', text: '1' })

    expect(h.state.executions).toEqual(['a-new-msg', 'a-reply'])
  })

  it('suppresses content automations when a flow consumed the message', async () => {
    register([
      automation('a-new-msg', 'new_message_received'),
      automation('a-kw', 'keyword_match', { keywords: ['1'], match_type: 'exact' }),
    ])

    await deliverInbound({ flowConsumed: true, text: '1' })

    expect(h.state.executions).toEqual([])
  })
})
