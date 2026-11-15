/**
 * «Colori» and «Disegna», the post page's last two tools, as Grok Imagine's
 * (read from its code 2026-11-15, docs/note/imagine-grok-post-riferimento.md):
 * the palettes and the sentence a palette is applied with, the drawing
 * styles and the sentence a sketch is finished with.
 * @module shared/imagine-post-tools
 */

/** Grok's ten ready palettes, with its colours. */
export const PALETTE_PRESETS = [
  { id: 'terracotta', colors: ['#9C4A2F', '#D9B382', '#4F5D45', '#F3EDE3'] },
  { id: 'nordic', colors: ['#E3F2FD', '#90CAF9', '#2196F3', '#0D47A1'] },
  { id: 'emerald', colors: ['#091413', '#285A48', '#408A71', '#B0E4CC'] },
  { id: 'sunset', colors: ['#E73F1E', '#FB6C00', '#F9B637', '#FFDD9C'] },
  { id: 'orchid', colors: ['#1D1233', '#6D28D9', '#A78BFA', '#F1EAFE'] },
  { id: 'blossom', colors: ['#FDF1F4', '#F3B8C8', '#D96C8B', '#6E3247'] },
  { id: 'cyanotype', colors: ['#0B1B33', '#123C69', '#4A7BA7', '#D9E4EC'] },
  { id: 'newsprint', colors: ['#F2EFE6', '#C8C3B6', '#4A4A4A', '#111111'] },
  { id: 'screenprint', colors: ['#F4E3C1', '#E2483C', '#2C3E7B', '#14110F'] },
  { id: 'sepia', colors: ['#F1E4CE', '#C8A165', '#8A5A2B', '#3B2412'] },
] as const

/** A few named colours, for the words that go with each hex in the sentence. */
const NAMED: readonly (readonly [string, number, number, number])[] = [
  ['black', 15, 15, 15], ['charcoal', 60, 60, 60], ['grey', 128, 128, 128], ['silver', 192, 192, 192], ['white', 245, 245, 245],
  ['cream', 243, 237, 220], ['beige', 217, 190, 150], ['tan', 200, 160, 110], ['brown', 120, 72, 40], ['dark brown', 60, 36, 18],
  ['terracotta', 160, 80, 50], ['red', 220, 40, 40], ['crimson', 150, 20, 40], ['orange', 245, 120, 20], ['amber', 245, 180, 50],
  ['yellow', 245, 220, 60], ['olive', 100, 110, 60], ['green', 50, 150, 70], ['dark green', 30, 80, 60], ['mint', 170, 225, 200],
  ['teal', 40, 130, 130], ['sky blue', 140, 200, 245], ['blue', 35, 110, 220], ['navy', 15, 40, 100], ['slate blue', 90, 105, 140],
  ['purple', 110, 40, 210], ['lavender', 170, 140, 245], ['plum', 100, 40, 80], ['pink', 240, 170, 200], ['rose', 215, 105, 140],
]

/** `#rrggbb` as numbers, or undefined when it is not one. */
export function rgbOf(hex: string): [number, number, number] | undefined {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  return m === null ? undefined : [Number.parseInt(m[1]!, 16), Number.parseInt(m[2]!, 16), Number.parseInt(m[3]!, 16)]
}

/** Numbers as `#RRGGBB`. */
function hexOf(r: number, g: number, b: number): string {
  return `#${[r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

/** The nearest of a few plain colour names. */
export function colorName(hex: string): string {
  const rgb = rgbOf(hex)
  if (rgb === undefined) return 'colour'
  let best = NAMED[0]!
  let bestD = Infinity
  for (const named of NAMED) {
    const d = (named[1] - rgb[0]) ** 2 + (named[2] - rgb[1]) ** 2 + (named[3] - rgb[2]) ** 2
    if (d < bestD) { best = named; bestD = d }
  }
  return best[0]
}

/**
 * The sentence a palette is applied with: Grok's own (`aY`/`aK`), one
 * colour as a monochrome, two as a duotone, more as a palette.
 * @param colors - `#rrggbb` colours, at least one.
 * @returns the prompt.
 */
export function palettePrompt(colors: readonly string[]): string {
  const listed = colors.map(color => `${color.toUpperCase()} (${colorName(color)})`).join(', ')
  const palette = colors.length === 1
    ? `1-colour palette: ${listed}, rendered as a monochrome treatment in tints and shades of that one colour`
    : colors.length === 2
      ? `2-colour palette: ${listed}, rendered as a duotone treatment using those two colours`
      : `${String(colors.length)}-colour palette: ${listed}`
  return `Restyle this design so that every colour in it comes from this ${palette}. Keep the layout, artwork, typography and wording exactly as they are, and do not add any swatches, labels or extra text.`
}

/** The drawing styles «Disegna» finishes a sketch in; Grok keeps its own on the server. */
export const DRAW_STYLES = [
  { id: 'photo', words: 'in the same style, light and texture as the photo around it' },
  { id: 'manga', words: 'as clean black-and-white manga line art with screentone shading' },
  { id: 'anime', words: 'in a polished anime illustration style with cel shading' },
  { id: 'watercolor', words: 'as a soft watercolour painting with visible paper texture' },
  { id: 'pencil', words: 'as a detailed graphite pencil drawing' },
  { id: 'oil', words: 'as a rich oil painting with visible brush strokes' },
  { id: 'pixel', words: 'as crisp retro pixel art' },
  { id: 'cartoon3d', words: 'as a glossy 3D cartoon render' },
] as const

export type DrawStyleId = typeof DRAW_STYLES[number]['id']

/**
 * The sentence a sketch is finished with: the strokes become a real part of
 * the picture, in the chosen style, and nothing else moves.
 * @param style - the style picked.
 * @param words - what the user says they drew, optional.
 * @returns the prompt.
 */
export function drawPrompt(style: DrawStyleId, words: string): string {
  const what = words.trim().replace(/\s+/g, ' ').replace(/[.!?…]+$/, '')
  const found = DRAW_STYLES.find(entry => entry.id === style) ?? DRAW_STYLES[0]
  return `The image has a rough hand-drawn sketch on it in coloured strokes. Turn the sketched strokes into a finished, natural part of the picture${what === '' ? '' : ` showing ${what}`}, rendered ${found.words}, following the shapes and colours of the strokes. Remove every trace of the strokes themselves and keep everything outside the sketch exactly as it is.`
}

/**
 * The main colours of a picture: a few rounds of k-means over its pixels,
 * started from the darkest to the lightest so the answer does not change
 * from one run to the next. Grok extracts four.
 * @param pixels - RGBA bytes of a small copy of the picture.
 * @param count - how many colours.
 * @returns `#RRGGBB` colours, from darkest to lightest.
 */
export function mainColors(pixels: ArrayLike<number>, count = 4): string[] {
  const points: [number, number, number][] = []
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if ((pixels[i + 3] ?? 0) < 128) continue
    points.push([pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0])
  }
  if (points.length === 0) return []
  const light = (p: readonly number[]): number => 0.299 * p[0]! + 0.587 * p[1]! + 0.114 * p[2]!
  const sorted = [...points].sort((a, b) => light(a) - light(b))
  let centres = Array.from({ length: Math.min(count, sorted.length) }, (_, k) => [...sorted[Math.floor((k + 0.5) / count * sorted.length)]!] as [number, number, number])
  for (let round = 0; round < 10; round += 1) {
    const sums = centres.map(() => ({ r: 0, g: 0, b: 0, n: 0 }))
    for (const p of points) {
      let best = 0
      let bestD = Infinity
      centres.forEach((c, k) => {
        const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2
        if (d < bestD) { best = k; bestD = d }
      })
      const sum = sums[best]
      if (sum === undefined) continue
      sum.r += p[0]; sum.g += p[1]; sum.b += p[2]; sum.n += 1
    }
    centres = centres.map((c, k) => {
      const sum = sums[k]
      return sum === undefined || sum.n === 0 ? c : [sum.r / sum.n, sum.g / sum.n, sum.b / sum.n] as [number, number, number]
    })
  }
  return centres.sort((a, b) => light(a) - light(b)).map(c => hexOf(c[0], c[1], c[2]))
}
