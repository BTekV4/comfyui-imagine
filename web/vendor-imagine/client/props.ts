/**
 * What the studio's pieces are handed: the store and its actions.
 *
 * It lives here rather than in `ImaginePage.tsx` because every piece of the
 * page needs it — and half of them were importing the page's own module back
 * to name it, a type cycle through the largest component in the studio
 * (`imagine-bits` → `ImaginePage` → `imagine-bits`). Nothing here imports a
 * component.
 * @module props
 */

import type { createGalleryStore } from './gallery-store.ts'

/** The live studio store the page reads and writes. */
export type GalleryInstance = ReturnType<typeof createGalleryStore>

/**
 * Page props: the studio store (web/src/main.tsx). The texts come from
 * `translate` in `locale-store.ts`.
 */
export interface ImaginePageProps {
  /** Read a slice of the store; the page re-renders when it changes. */
  readonly useStore: <R>(selector: (state: ReturnType<GalleryInstance['getSnapshot']>) => R) => R
  readonly actions: GalleryInstance['actions']
}
