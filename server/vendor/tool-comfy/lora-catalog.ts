/**
 * The LoRA catalog the owner wrote in Settings → General, as the chat reads it.
 *
 * A LoRA is a file on the ComfyUI box, outside this repository, and the studio
 * never reads one to learn what it does: the owner names it, says what it is
 * for in their own words, and, when the graph switches it on from the text,
 * the word that has to appear there. This module is the one reader of that
 * list, so the settings page, the agent's instruction and the MCP see the same
 * order and the same normalisation.
 * @module tool-comfy/lora-catalog
 */

import type { LoraEntry } from '../../../shared/host-settings.ts'

/** One LoRA as the studio may talk about it. */
export interface LoraCard {
  /** The tag ComfyUI knows the LoRA by, exactly as the owner wrote it. */
  readonly file: string
  /** What it is for, in the owner's words. */
  readonly purpose: string
  /** The word that switches it on in the prompt, when the graph reads one. */
  readonly trigger?: string
  /** The strength the owner recommends, between 0 and 2. */
  readonly weight?: number
}

/** The longest a purpose or a trigger may be: they end up in a prompt. */
const MAX_TEXT = 160

/** The strength range a LoRA is meaningful in. */
export const LORA_WEIGHT_RANGE = { min: 0, max: 2 } as const

/**
 * One catalog entry, checked: a file and a purpose are required, the rest is
 * optional and dropped when it makes no sense.
 * @param raw - the entry as the settings file or the page sent it.
 * @returns the entry, or undefined when it says nothing usable.
 */
export function loraEntryOf(raw: unknown): LoraCard | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const entry = raw as Partial<LoraEntry>
  const file = typeof entry.file === 'string' ? entry.file.trim() : ''
  const purpose = typeof entry.purpose === 'string' ? entry.purpose.trim() : ''
  if (file.length === 0 || file.length > MAX_TEXT) return undefined
  if (purpose.length === 0 || purpose.length > MAX_TEXT) return undefined
  const trigger = typeof entry.trigger === 'string' ? entry.trigger.trim() : ''
  const weight = typeof entry.weight === 'number' && Number.isFinite(entry.weight)
    ? Math.min(LORA_WEIGHT_RANGE.max, Math.max(LORA_WEIGHT_RANGE.min, entry.weight))
    : undefined
  return {
    file,
    purpose,
    ...trigger.length === 0 || trigger.length > MAX_TEXT ? {} : { trigger },
    ...weight === undefined ? {} : { weight },
  }
}

/**
 * The catalog, as the studio reads it: the usable entries, in the owner's
 * order, without duplicates (the same tag listed twice is one LoRA).
 * @param settings - the host settings, or the field alone as the page holds it.
 * @returns the cards, possibly empty.
 */
export function loraCatalog(settings: { readonly loraCatalog?: readonly LoraEntry[] } | undefined): readonly LoraCard[] {
  const raw = settings?.loraCatalog
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const cards: LoraCard[] = []
  for (const entry of raw) {
    const card = loraEntryOf(entry)
    if (card === undefined) continue
    const key = card.file.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    cards.push(card)
  }
  return cards
}

/**
 * The catalog as the agent's instruction writes it, one card per line.
 *
 * The trigger is said to be literal because that is what it is: a graph that
 * switches something on from the text compares the prompt with that word, and
 * a synonym never matches. The purpose is quoted as the owner wrote it, so the
 * model can decide whether the line is about that LoRA without guessing from a
 * file name.
 * @param cards - the catalog.
 * @returns one line per card, or an empty string when there is none.
 */
export function loraLines(cards: readonly LoraCard[]): string {
  return cards.map((card) => {
    const trigger = card.trigger === undefined
      ? ''
      : ` — switched on when the prompt contains "${card.trigger}" literally`
    const weight = card.weight === undefined ? '' : ` — weight ${String(card.weight)}`
    return `- ${card.purpose}: ${card.file}${trigger}${weight}`
  }).join('\n')
}
