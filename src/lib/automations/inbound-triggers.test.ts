import { describe, it, expect } from 'vitest'
import { computeInboundAutomationTriggers } from './inbound-triggers'

describe('computeInboundAutomationTriggers', () => {
  it('fires the content triggers for an ordinary inbound message', () => {
    expect(
      computeInboundAutomationTriggers({
        flowConsumed: false,
        contactWasCreated: false,
        isFirstInboundMessage: false,
      }),
    ).toEqual(['new_message_received', 'keyword_match'])
  })

  it('adds interactive_reply only when a menu answer was resolved', () => {
    expect(
      computeInboundAutomationTriggers({
        flowConsumed: false,
        contactWasCreated: false,
        isFirstInboundMessage: false,
        menuReplyId: 'btn_support',
      }),
    ).toContain('interactive_reply')

    expect(
      computeInboundAutomationTriggers({
        flowConsumed: false,
        contactWasCreated: false,
        isFirstInboundMessage: false,
        menuReplyId: null,
      }),
    ).not.toContain('interactive_reply')
  })

  it('suppresses content triggers when a flow consumed the message', () => {
    expect(
      computeInboundAutomationTriggers({
        flowConsumed: true,
        contactWasCreated: false,
        isFirstInboundMessage: false,
        menuReplyId: 'btn_support',
      }),
    ).toEqual([])
  })

  it('still fires relationship triggers when a flow consumed the message', () => {
    expect(
      computeInboundAutomationTriggers({
        flowConsumed: true,
        contactWasCreated: true,
        isFirstInboundMessage: true,
      }),
    ).toEqual(['first_inbound_message', 'new_contact_created'])
  })

  it('orders relationship triggers before content triggers', () => {
    expect(
      computeInboundAutomationTriggers({
        flowConsumed: false,
        contactWasCreated: true,
        isFirstInboundMessage: true,
        menuReplyId: 'btn_1',
      }),
    ).toEqual([
      'first_inbound_message',
      'new_contact_created',
      'new_message_received',
      'keyword_match',
      'interactive_reply',
    ])
  })

  it('never emits the same trigger twice for one message', () => {
    const triggers = computeInboundAutomationTriggers({
      flowConsumed: false,
      contactWasCreated: true,
      isFirstInboundMessage: true,
      menuReplyId: 'btn_1',
    })
    expect(new Set(triggers).size).toBe(triggers.length)
  })
})
