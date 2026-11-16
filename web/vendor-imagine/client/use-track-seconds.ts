/**
 * The length of a staged track, for the controls that give way to it.
 *
 * Shared by the composer and the cards' panels (2026-11-16): wherever a track
 * is staged for a video, the video lasts as long as the track, and the length
 * buttons are replaced by the track's own length.
 */

import { useEffect, useState } from 'react'
import { mediaUrlOf } from './gallery-api.ts'
import type { GalleryItem } from '../../../shared/imagine-types.ts'

/**
 * How long a staged track lasts, in whole seconds, once it is known.
 *
 * The gallery reads the length of MP4 containers only (an .m4a has it, an
 * .mp3 or a .wav does not), so the browser reads the rest from the file's
 * metadata, without downloading the track.
 * @param item - the staged track, if there is one.
 * @returns the seconds, or undefined while unknown.
 */
export function useTrackSeconds(item: GalleryItem | undefined): number | undefined {
  const [read, setRead] = useState<{ name: string; seconds: number } | undefined>(undefined)
  const name = item?.name
  const known = item?.duration
  useEffect(() => {
    if (name === undefined || known !== undefined) return undefined
    const audio = new Audio()
    audio.preload = 'metadata'
    const done = (): void => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) setRead({ name, seconds: audio.duration })
    }
    audio.addEventListener('loadedmetadata', done)
    audio.src = mediaUrlOf(name)
    return () => {
      audio.removeEventListener('loadedmetadata', done)
      audio.removeAttribute('src')
      audio.load()
    }
  }, [name, known])
  const seconds = known ?? (read !== undefined && read.name === name ? read.seconds : undefined)
  return seconds === undefined ? undefined : Math.round(seconds)
}
