/**
 * Which cover an action draws: the decision, in one place only.
 *
 * The home and the action panel each resolved it their own way, and on
 * 2026-11-04 the same action showed two different covers: the "Make video"
 * card played the repo's clip (woman in a green coat on a neon background)
 * while the panel showed the image the user had chosen (green hair, purple
 * latex). The cause was the duplicated precedence.
 *
 * The table, a single one for every surface:
 *
 * 1. personal **video** cover → that video (muted, looping), with **its own**
 *    frame as the poster (`?poster=1`; if there is no poster, the server
 *    answers with the repo's image);
 * 2. personal **image** cover and the repo has a **clip** for that action →
 *    the repo's clip, with the personal image as the poster: the motion was
 *    there before custom covers and must not disappear;
 * 3. personal **image** cover and the repo has no clip → that image;
 * 4. **no** personal cover → the repo's: the image, or the clip with its
 *    image as the poster;
 * 5. reduced motion in the system → always an image, never a clip.
 *
 * Whether the repo has a clip is told by the caller with `motion`: the list
 * of the repo's clips is the `CARD_MOTION` constant (`job-cards.ts`), and both
 * surfaces pass the same value — so no surface can play it while another
 * ignores it. No `<video>` is probed to find out: a missing clip would leave
 * the poster, which is already the right image.
 *
 * The module is pure (no React, no requests) so the table can be tested
 * without a browser.
 * @module cover-plan
 */

import type { CoverKind } from '../../../shared/cover-kinds.ts'

/** A personal cover, as `/comfy-cover-info` reports it. */
export interface CoverInfo {
  readonly kind: CoverKind
  readonly ext: string
}

/** The known personal covers, by action key. */
export type CoverInfos = Readonly<Record<string, CoverInfo>>

/** One source file of a repo `<video>` (webm first, then mp4). */
interface CoverSource {
  readonly src: string
  readonly type: string
}

/** What to draw for an action's cover. */
type CoverChoice =
  | { readonly kind: 'image'; readonly src: string }
  | {
    readonly kind: 'video'
    readonly src: string
    readonly poster: string
    /** Present for the repo's clip, which has two sources; absent for the user's video, which is a single file. */
    readonly sources?: readonly CoverSource[]
  }

/**
 * An action's personal cover, if it has one.
 * @param known - the covers received from the server.
 * @param key - the action's key, the same as the file name.
 * @returns the cover, or undefined when the repo's one applies.
 */
function coverInfoOf(known: CoverInfos, key: string): CoverInfo | undefined {
  return known[key]
}

/**
 * The cover key of a `/imagine/<key>.webp` URL.
 * @param url - the cover URL.
 * @returns the key, i.e. the file name without folder or extension.
 */
export function coverKeyOf(url: string): string {
  return url.replace(/^\/imagine\//, '').replace(/\.[A-Za-z0-9]+$/, '')
}

/**
 * The URL of the repo's image, skipping the personal cover: it is the poster
 * of the repo's clip and the image of the cards with no cover of their own.
 * @param url - the card's cover URL.
 * @returns the same path, asking the server for the repo's file.
 */
export function repoCoverOf(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}repo=1`
}

/**
 * The poster URL of a personal video cover: its first frame
 * (`<data>/covers/<key>.poster.webp`). If there is no poster the server
 * answers with the repo's image, so the fallback is already built into the
 * URL.
 * @param url - the card's cover URL.
 * @returns the same path, asking the server for the user's poster.
 */
export function posterCoverOf(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}poster=1`
}

/**
 * What to draw for an action's cover.
 *
 * @param known - the personal covers received from the server.
 * @param cover - the URL of the repo's cover (`/imagine/<key>.webp`).
 * @param motion - the repo's clip, when the card has one (`/imagine/<key>`).
 * @param still - true when the user asked for reduced motion.
 * @returns the element to draw: an image, or a video with its poster.
 */
export function coverChoiceOf(
  known: CoverInfos,
  cover: string,
  motion: string | undefined,
  still: boolean,
): CoverChoice {
  const own = coverInfoOf(known, coverKeyOf(cover))

  // 5. Reduced motion: no clip, in any case. With a personal video cover its
  //    poster is shown (the repo's image until the poster exists); otherwise
  //    the right image is already `cover`.
  if (still) return { kind: 'image', src: own?.kind === 'video' ? posterCoverOf(cover) : cover }

  // 1. The user's video: a single file, served at the same URL as the image
  //    (the server sends the real type). The poster is its first frame: if
  //    the video does not start, its own cover shows, not the repo's.
  if (own?.kind === 'video') return { kind: 'video', src: cover, poster: posterCoverOf(cover) }

  /*
   * 2. The repo has a clip for this action: that is played, with the
   *    personal cover as the poster (if any). This is what the user wants to
   *    see again: some covers used to be videos. The poster is `cover`, which
   *    the server serves from the personal folder when the file exists.
   */
  if (motion !== undefined) {
    return {
      kind: 'video',
      src: repoCoverOf(`${motion}.webm`),
      poster: cover,
      sources: [
        { src: repoCoverOf(`${motion}.webm`), type: 'video/webm' },
        { src: repoCoverOf(`${motion}.mp4`), type: 'video/mp4' },
      ],
    }
  }

  // 3 and 4. No clip: the personal image if there is one, otherwise the
  //          repo's. The same URL serves both.
  return { kind: 'image', src: cover }
}
