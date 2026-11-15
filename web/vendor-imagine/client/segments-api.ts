/**
 * «Segmenti» on the page: the analysis of the open photo, the masks the
 * pointer is tested against, and the mask of what is selected.
 * @module segments-api
 */

import { useEffect, useRef, useState } from 'react'
import { getJson, postJson } from './http.ts'
import { useVisibleInterval } from './use-visible-interval.ts'
import { segmentFileUrl, type ImagineSegment, type ImagineSegmentsIndex, type ImagineSegmentsStatus } from '../../../shared/imagine-segments.ts'

/** How often a running analysis is asked about. */
const POLL_MS = 3000

/** Long side the masks are kept at for pointer tests: plenty for a pixel under a cursor. */
const BITS_SIDE = 512

/**
 * The analysis of one photo while the panel is open: read it, start it when
 * the photo has none (Grok segments a photo it has no layers for as soon as
 * it is shown), follow it while it runs.
 * @param photo - the gallery name, or undefined when the panel is closed.
 * @returns the state, and `retry` after a failure.
 */
export function useSegments(photo: string | undefined): {
  readonly status: ImagineSegmentsStatus | undefined
  readonly error: string | undefined
  readonly retry: () => void
} {
  const [status, setStatus] = useState<ImagineSegmentsStatus>()
  const [error, setError] = useState<string>()
  // An answer for a photo the viewer has already left is dropped.
  const asked = useRef(photo)
  asked.current = photo

  const take = (name: string, next: ImagineSegmentsStatus): void => {
    if (asked.current === name) setStatus(next)
  }
  const fail = (name: string, caught: unknown): void => {
    if (asked.current === name) setError(caught instanceof Error ? caught.message : String(caught))
  }
  const start = (name: string, again: boolean): void => {
    setError(undefined)
    postJson<ImagineSegmentsStatus>('/api/segments', { name, again }, 'segmenti').then(
      (next) => { take(name, next) },
      (caught: unknown) => { fail(name, caught) },
    )
  }
  const read = (): void => {
    if (photo === undefined) return
    const name = photo
    getJson<ImagineSegmentsStatus>(`/api/segments?name=${encodeURIComponent(name)}`, 'segmenti').then(
      (next) => {
        take(name, next)
        if (next.state === 'none' && asked.current === name) start(name, false)
      },
      (caught: unknown) => { fail(name, caught) },
    )
  }
  useEffect(() => {
    setStatus(undefined)
    setError(undefined)
    read()
  }, [photo])
  useVisibleInterval(read, status?.state === 'running' ? POLL_MS : null)
  return { status, error, retry: () => { if (photo !== undefined) start(photo, true) } }
}

/** One picture, loaded from the studio. */
function picture(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => { resolve(image) }
    image.onerror = () => { reject(new Error(url)) }
    image.src = url
  })
}

/** A mask kept small, one byte per pixel: 1 where the part is. */
export interface MaskBits {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
}

/**
 * The masks of an analysis, kept small for pointer tests: the part under the
 * cursor is the one whose mask holds that pixel, as on Grok, not the one
 * whose box does (a box holds the sky around an umbrella).
 * @param index - the analysis, or undefined.
 * @returns one mask per segment index, once they have all loaded.
 */
export function useMaskBits(index: ImagineSegmentsIndex | undefined): ReadonlyMap<number, MaskBits> {
  const [bits, setBits] = useState<ReadonlyMap<number, MaskBits>>(new Map())
  useEffect(() => {
    setBits(new Map())
    if (index === undefined) return
    let cancelled = false
    const scale = Math.min(1, BITS_SIDE / Math.max(index.width, index.height))
    const width = Math.max(1, Math.round(index.width * scale))
    const height = Math.max(1, Math.round(index.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) return
    void (async () => {
      const next = new Map<number, MaskBits>()
      for (const segment of index.segments) {
        try {
          const image = await picture(segmentFileUrl(index, segment.mask))
          if (cancelled) return
          context.clearRect(0, 0, width, height)
          context.drawImage(image, 0, 0, width, height)
          const rgba = context.getImageData(0, 0, width, height).data
          const data = new Uint8Array(width * height)
          for (let i = 0; i < data.length; i += 1) data[i] = rgba[i * 4]! > 127 ? 1 : 0
          next.set(segment.index, { width, height, data })
        } catch {
          // A mask that does not load is only left out of the pointer test.
        }
      }
      if (!cancelled) setBits(next)
    })()
    return () => { cancelled = true }
  }, [index?.photo, index?.createdAt])
  return bits
}

/**
 * The part under a point of the photo: among the masks that hold it, the
 * smallest, so a ring wins over the hand and the hand over the person.
 * @param segments - the analysis' segments.
 * @param bits - their small masks.
 * @param fx - the point, as a fraction of the photo's width.
 * @param fy - the point, as a fraction of its height.
 * @returns the segment's index, or undefined over nothing.
 */
export function segmentUnder(segments: readonly ImagineSegment[], bits: ReadonlyMap<number, MaskBits>, fx: number, fy: number): number | undefined {
  let best: ImagineSegment | undefined
  for (const segment of segments) {
    const mask = bits.get(segment.index)
    if (mask === undefined) continue
    const x = Math.min(mask.width - 1, Math.max(0, Math.floor(fx * mask.width)))
    const y = Math.min(mask.height - 1, Math.max(0, Math.floor(fy * mask.height)))
    if (mask.data[y * mask.width + x] === 1 && (best === undefined || segment.area < best.area)) best = segment
  }
  return best?.index
}

/**
 * The masks of the chosen segments as one PNG at the photo's own size, white
 * where they are: what «Modifica precisa» takes.
 * @param index - the photo's analysis.
 * @param chosen - the segments to join.
 * @returns a `data:image/png;base64,…` URL.
 */
export async function joinedMask(index: ImagineSegmentsIndex, chosen: readonly ImagineSegment[]): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = index.width
  canvas.height = index.height
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('canvas')
  context.fillStyle = '#000'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.globalCompositeOperation = 'lighten'
  for (const image of await Promise.all(chosen.map(segment => picture(segmentFileUrl(index, segment.mask))))) {
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
  }
  return canvas.toDataURL('image/png')
}
