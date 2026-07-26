// ============================================================
// Numbered-menu fallback + answer matching.
//
// Unofficial engines (WAHA/GOWS and friends) don't reliably render
// native reply buttons or lists, so a menu sent through them becomes
// plain numbered text:
//
//   Escolha o setor:
//
//   1 - Comercial
//   2 - Suporte
//
// The customer can answer with the number, the exact label, or a
// configured alias. `matchMenuOption` normalizes case, accents and
// spacing before comparing so "SUPORTE", "suporte" and "Suporté" all
// resolve to the same option.
// ============================================================

import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'

export interface MenuOption {
  /** Stable id echoed back to the engine (Meta button/row id). */
  value: string
  /** Visible label. */
  label: string
  /** Extra accepted answers (synonyms). */
  aliases?: string[]
  /** 1-based position in the rendered numbered list. */
  index: number
}

/** Strip accents, collapse whitespace, lowercase, drop trailing punctuation. */
export function normalizeAnswer(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Flatten an interactive payload into ordered menu options. */
export function menuOptionsFromPayload(
  payload: InteractiveMessagePayload,
): MenuOption[] {
  const rows =
    payload.kind === 'buttons'
      ? payload.buttons.map((b) => ({ id: b.id, title: b.title }))
      : payload.sections.flatMap((s) =>
          s.rows.map((r) => ({ id: r.id, title: r.title })),
        )
  return rows.map((r, i) => ({
    value: r.id,
    label: r.title,
    index: i + 1,
  }))
}

/**
 * Render a menu as plain text. Header/body/footer are preserved so the
 * WAHA copy reads like the Meta one.
 */
export function renderNumberedMenu(payload: InteractiveMessagePayload): string {
  const options = menuOptionsFromPayload(payload)
  const lines: string[] = []
  if (payload.header) lines.push(payload.header, '')
  lines.push(payload.body, '')
  for (const o of options) lines.push(`${o.index} - ${o.label}`)
  if (payload.footer) lines.push('', payload.footer)
  return lines.join('\n').trim()
}

/**
 * Match a customer reply against the menu. Returns the option or null
 * when nothing matches (caller then re-sends the guidance and counts
 * the attempt).
 */
export function matchMenuOption(
  answer: string,
  options: MenuOption[],
): MenuOption | null {
  const raw = (answer ?? '').trim()
  if (!raw) return null

  // 1. Plain number ("2", "2)", "opção 2" is NOT accepted as a number —
  //    only a bare numeric answer, to avoid matching "quero 2 caixas").
  const numeric = raw.replace(/[^\d]/g, '')
  if (/^\d+[).\-\s]*$/.test(raw) && numeric) {
    const byIndex = options.find((o) => String(o.index) === numeric)
    if (byIndex) return byIndex
  }

  const norm = normalizeAnswer(raw)
  if (!norm) return null

  // 2. Exact option id (native button/list tap echoes the id back).
  const byId = options.find((o) => normalizeAnswer(o.value) === norm)
  if (byId) return byId

  // 3. Exact label, then alias.
  const byLabel = options.find((o) => normalizeAnswer(o.label) === norm)
  if (byLabel) return byLabel

  const byAlias = options.find((o) =>
    (o.aliases ?? []).some((a) => normalizeAnswer(a) === norm),
  )
  if (byAlias) return byAlias

  return null
}
