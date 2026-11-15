/**
 * The two pieces of a file's transport: the play button and the seek bar.
 *
 * The viewer's bar and an audio tile's bar each drew both by hand on top of
 * `useMediaTransport`, with the same range input and the same play glyph,
 * which stayed a play glyph while the file played. Each surface still lays
 * the pieces out and places its own clock.
 * @module transport-bar
 */
import { IconPauseOutlineRegular, IconPlayOutlineRegular } from '../../shims/primitives/index.ts'
import { translate } from './locale-store.ts'
import type { MediaTransport } from './media-playback.ts'

/**
 * Play or pause, the glyph and the name following the state.
 * @param props.onToggle - what the press does; the transport's own toggle unless the surface adds to it.
 */
export function PlayToggle({ transport, onToggle, className, size }: {
  readonly transport: MediaTransport
  readonly onToggle?: () => void
  readonly className: string | undefined
  readonly size: number
}) {
  const label = transport.playing ? translate('imagine.pause') : translate('imagine.play')
  return (
    <button type="button" className={className} aria-label={label} onClick={onToggle ?? transport.toggle}>
      {transport.playing ? <IconPauseOutlineRegular size={size} /> : <IconPlayOutlineRegular size={size} />}
    </button>
  )
}

/** Where the file is, and where to move it. */
export function SeekBar({ transport, className }: {
  readonly transport: MediaTransport
  readonly className: string | undefined
}) {
  return (
    <input
      className={className}
      type="range"
      min={0}
      max={transport.duration || 0}
      step={0.05}
      value={transport.currentTime}
      aria-label={translate('imagine.play')}
      onChange={(event) => { transport.seek(Number(event.currentTarget.value)) }}
    />
  )
}
