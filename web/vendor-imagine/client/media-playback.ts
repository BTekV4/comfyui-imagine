/**
 * Playback rules shared by the media on the board.
 */
import { useRef, useState, useSyncExternalStore, type RefObject, type SyntheticEvent } from 'react'

/**
 * One media at a time: two tracks over each other are noise, and the board had
 * let a second tile start while the first kept going. Asked for the songs on
 * 2026-09-10 and for the videos on 2026-09-24; both go through here so the rule
 * is stated once, and the still images on the board are not media elements and
 * are untouched.
 * @param node - the element that just started playing.
 */
function pauseOtherMedia(node: HTMLMediaElement): void {
  for (const other of document.querySelectorAll('audio, video')) {
    if (other === node) continue
    const media = other as HTMLMediaElement
    if (!media.paused) media.pause()
  }
}

/*
 * The board's clips, as Grok Imagine's canvas (read 2026-11-15): several may
 * play at once, looping, but only one is heard — the last one started takes
 * the audio (`claimAudioFocus`) and the others go on silently. A track or the
 * viewer still stops everything else (`pauseOtherMedia`).
 */
let audioFocus: string | undefined
const focusListeners = new Set<() => void>()

/** Give the board's audio to one clip; the others play on muted. */
export function claimAudioFocus(id: string): void {
  if (audioFocus === id) return
  audioFocus = id
  for (const listener of focusListeners) listener()
}

/** Whether this clip has the board's audio. */
export function useAudioFocus(id: string): boolean {
  return useSyncExternalStore(
    (listener) => { focusListeners.add(listener); return () => { focusListeners.delete(listener) } },
    () => audioFocus === id,
  )
}

/** Pause the tracks: a clip started with sound would play over them. */
function pauseTracks(): void {
  for (const track of document.querySelectorAll('audio')) {
    if (!track.paused) track.pause()
  }
}

/** A clip's or a track's transport: what the play button and the seek bar read. */
export interface MediaTransport {
  readonly ref: RefObject<HTMLMediaElement>
  readonly playing: boolean
  readonly currentTime: number
  readonly duration: number | undefined
  /** The element's events, to spread on the `<audio>` or `<video>`. */
  readonly events: {
    onLoadedMetadata: (event: SyntheticEvent<HTMLMediaElement>) => void
    onTimeUpdate: (event: SyntheticEvent<HTMLMediaElement>) => void
    onPlay: (event: SyntheticEvent<HTMLMediaElement>) => void
    onPause: () => void
    onEnded: () => void
  }
  /** Play when paused, pause when playing. */
  readonly toggle: () => void
  /** Move the bar, and the element when there is one. */
  readonly seek: (time: number) => void
  /** Back to the start, for a new file in the same element. */
  readonly reset: (duration?: number) => void
}

/**
 * The state the board's tiles and the viewer keep for a playing file, with
 * one-at-a-time playback (`pauseOtherMedia`) built in.
 * @param initialDuration - the length the inventory already knows, if any.
 * @param exclusive - false for a board clip: it pauses only the tracks, and
 *   the other clips keep playing without sound (see `claimAudioFocus`).
 * @returns the transport.
 */
export function useMediaTransport(initialDuration?: number, exclusive = true): MediaTransport {
  const ref = useRef<HTMLMediaElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState<number | undefined>(initialDuration)
  return {
    ref,
    playing,
    currentTime,
    duration,
    events: {
      onLoadedMetadata: (event) => { setDuration(event.currentTarget.duration) },
      onTimeUpdate: (event) => { setCurrentTime(event.currentTarget.currentTime) },
      onPlay: (event) => {
        setPlaying(true)
        if (exclusive) pauseOtherMedia(event.currentTarget)
        else pauseTracks()
      },
      onPause: () => { setPlaying(false) },
      onEnded: () => { setPlaying(false) },
    },
    toggle: () => {
      const node = ref.current
      if (node === null) return
      if (node.paused) void node.play()
      else node.pause()
    },
    seek: (time) => {
      setCurrentTime(time)
      if (ref.current !== null) ref.current.currentTime = time
    },
    reset: (next) => {
      setPlaying(false)
      setCurrentTime(0)
      setDuration(next)
    },
  }
}
