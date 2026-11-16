/**
 * Cut the thumbnails nobody has asked for yet, newest first.
 *
 * All media shows hundreds of files on its first screen, and a missing
 * thumbnail costs a quarter of a second of ffmpeg on first request: on a cold
 * cache the page queued them and the full picture opened from it waited
 * behind the queue (2026-10-17). Cut in advance, every one is a file read.
 *
 * The files come from the gallery's own listing, so the order is the one the
 * page shows, dot-named scratch is left alone, and the first GET /comfy-media
 * after a restart finds the listing's cache already filled.
 */
import { join } from 'node:path'
import { listGallery } from '../vendor/tool-comfy/gallery.ts'
import { THUMB_WIDTHS, thumbnailOf } from '../vendor/tool-comfy/media-thumbs.ts'
import { mapWithConcurrency } from '../vendor/tool-comfy/media-tools.ts'

/**
 * Files cut side by side. Below the thumbnailer's own ceiling, so a page
 * asking for a thumbnail meanwhile still finds a free slot.
 */
const CUT_PARALLEL = 2

export function warmThumbnails(outputDir: string): void {
  void (async () => {
    let order: readonly { readonly name: string }[]
    try {
      // Newest first, as the gallery lists them; audio has no picture.
      order = (await listGallery(outputDir)).filter(item => item.kind !== 'audio')
    } catch {
      return
    }
    await mapWithConcurrency(order, CUT_PARALLEL, async ({ name }) => {
      for (const width of THUMB_WIDTHS) {
        // A cached thumbnail answers at once; a missing one is cut here.
        await thumbnailOf(join(outputDir, name), name, width).catch(() => undefined)
      }
    })
    console.log(`[imagine] thumbnails ready for ${String(order.length)} files`)
  })()
}
