import { describe, it, expect } from 'vitest'
import {
  matchMenuOption,
  menuOptionsFromPayload,
  normalizeAnswer,
  renderNumberedMenu,
  type MenuOption,
} from './menu'

const payload = {
  kind: 'list' as const,
  body: 'Escolha o setor:',
  button_label: 'Ver setores',
  footer: 'Responda com o número',
  sections: [
    {
      rows: [
        { id: 'dep-comercial', title: 'Comercial' },
        { id: 'dep-suporte', title: 'Suporte' },
        { id: 'dep-financeiro', title: 'Financeiro' },
      ],
    },
  ],
}

const options: MenuOption[] = [
  { value: 'dep-comercial', label: 'Comercial', index: 1, aliases: ['vendas'] },
  { value: 'dep-suporte', label: 'Suporte', index: 2, aliases: ['ajuda'] },
]

describe('renderNumberedMenu', () => {
  it('renders body, numbered options and footer', () => {
    expect(renderNumberedMenu(payload)).toBe(
      'Escolha o setor:\n\n1 - Comercial\n2 - Suporte\n3 - Financeiro\n\nResponda com o número',
    )
  })

  it('includes the header when present', () => {
    expect(
      renderNumberedMenu({
        kind: 'buttons',
        header: 'Atendimento',
        body: 'Opções:',
        buttons: [{ id: 'a', title: 'Sim' }],
      }),
    ).toBe('Atendimento\n\nOpções:\n\n1 - Sim')
  })
})

describe('menuOptionsFromPayload', () => {
  it('flattens list sections into 1-based options', () => {
    expect(menuOptionsFromPayload(payload)).toEqual([
      { value: 'dep-comercial', label: 'Comercial', index: 1 },
      { value: 'dep-suporte', label: 'Suporte', index: 2 },
      { value: 'dep-financeiro', label: 'Financeiro', index: 3 },
    ])
  })
})

describe('normalizeAnswer', () => {
  it('strips accents, case and punctuation', () => {
    expect(normalizeAnswer('  Suporté! ')).toBe('suporte')
  })
})

describe('matchMenuOption', () => {
  it('matches a bare number', () => {
    expect(matchMenuOption('2', options)?.value).toBe('dep-suporte')
    expect(matchMenuOption('1)', options)?.value).toBe('dep-comercial')
  })

  it('matches the label regardless of case/accents', () => {
    expect(matchMenuOption('COMERCIAL', options)?.value).toBe('dep-comercial')
    expect(matchMenuOption(' suporté ', options)?.value).toBe('dep-suporte')
  })

  it('matches configured aliases', () => {
    expect(matchMenuOption('vendas', options)?.value).toBe('dep-comercial')
  })

  it('matches the option id (native button tap)', () => {
    expect(matchMenuOption('dep-suporte', options)?.value).toBe('dep-suporte')
  })

  it('returns null for invalid answers and out-of-range numbers', () => {
    expect(matchMenuOption('quero falar com alguém', options)).toBeNull()
    expect(matchMenuOption('9', options)).toBeNull()
    expect(matchMenuOption('', options)).toBeNull()
  })

  it('does not treat a sentence containing a digit as a number pick', () => {
    expect(matchMenuOption('quero 2 caixas', options)).toBeNull()
  })
})
