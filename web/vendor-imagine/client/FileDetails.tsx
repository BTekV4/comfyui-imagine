/**
 * "Details" for a canvas tile, as Grok Imagine has: what was done to make
 * the file, with which words, from which file, and what it is.
 */
import { messageOf } from './message-of.ts'
import { translate } from './locale-store.ts'
import { useEffect, useRef, useState } from 'react'
import { askToLook, thumbUrlOf, THUMB_SMALL } from './gallery-api.ts'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import { momentLabel } from './dates.ts'
import { actionLabelOf } from './imagine-filters.ts'
import { formatDuration } from './format.ts'
import { fetchFileDetails, hostLineOf, wordsOf, type FileDetailsBody } from './file-origin.ts'
import { sizeLabel } from './labels.ts'
import { Still } from './Still.tsx'
import { useDismiss } from './use-dismiss.ts'
import { useVisibleInterval } from './use-visible-interval.ts'
import css from './FileDetails.module.css'

export interface FileDetailsProps {
  readonly item: GalleryItem
  readonly anchor: DOMRect
  readonly onClose: () => void
  /** Go to the file a run started from (select it on the board, or preview it). */
  readonly onOpenSource: (name: string) => void
  /** Put the request back in the composer, from the same starting file (Grok's "Move to canvas"). */
  readonly onReuse?: (text: string, source: string | undefined) => void
}

const WIDTH = 360

export function FileDetails({ item, anchor, onClose, onOpenSource, onReuse }: FileDetailsProps) {
  const box = useRef<HTMLDivElement>(null)
  const [details, setDetails] = useState<FileDetailsBody>()
  const [error, setError] = useState<string>()
  const [showPrompt, setShowPrompt] = useState(false)
  const [copied, setCopied] = useState(false)
  /** The vision pass asked for from here, and the poll that waits for it. */
  const [looking, setLooking] = useState(false)

  useEffect(() => {
    let cancelled = false
    setDetails(undefined)
    setError(undefined)
    fetchFileDetails(item.name)
      .then((body) => { if (!cancelled) setDetails(body) })
      .catch((caught: unknown) => { if (!cancelled) setError(messageOf(caught)) })
    return () => { cancelled = true }
  }, [item.name])

  /*
   * A file with no description — an old upload, a clip from before the upload
   * scan existed — can be looked at from here. The host answers at once and
   * looks behind; this card polls the file until the description is filed,
   * and gives up after a minute: a vision pass on a shared backend is 10-60 s
   * and never worth a spinner with no end.
   */
  const shownName = useRef(item.name)
  shownName.current = item.name
  useVisibleInterval(() => {
    const name = item.name
    void fetchFileDetails(name).then((body) => {
      if (body.sight === undefined || shownName.current !== name) return
      setDetails(body)
      setLooking(false)
    }).catch(() => undefined)
  }, looking ? 2500 : null)
  useEffect(() => {
    if (!looking) return undefined
    const stop = globalThis.setTimeout(() => { setLooking(false) }, 90_000)
    return () => { globalThis.clearTimeout(stop) }
  }, [looking, item.name])

  useDismiss(box, onClose)

  // Beside the tile — right when it fits, else left — and as high as its top
  // while still whole on screen: below it ran off the bottom, over it hid the
  // picture it describes.
  const tall = Math.min(560, window.innerHeight - 16)
  const right = anchor.right + 12
  const left = right + WIDTH <= window.innerWidth - 8
    ? right
    : anchor.left - 12 - WIDTH >= 8 ? anchor.left - 12 - WIDTH : Math.max(8, window.innerWidth - WIDTH - 8)
  const top = Math.max(8, Math.min(anchor.top, window.innerHeight - tall - 8))
  const origin = details?.origin
  const words = wordsOf(origin)
  const made = details === undefined ? undefined : momentLabel(new Date(details.mtime).toISOString(), 'full')

  return (
    <div ref={box} className={css.card} role="dialog" aria-label={translate('imagine.details')} style={{ left, top, width: WIDTH, maxHeight: tall }}>
      <div className={css.head}>
        <span className={css.title}>{translate('imagine.details')}</span>
        <button type="button" className={css.close} aria-label={translate('imagine.closeShort')} onClick={onClose}>×</button>
      </div>
      {error !== undefined && <p className={css.muted}>{error}</p>}
      {details === undefined && error === undefined && <p className={css.muted}>{translate('imagine.loadingShort')}</p>}
      {details !== undefined && (
        <>
          <p className={css.action}>{origin === undefined ? (details.name.startsWith('upload-') ? translate('imagine.fileUploaded') : translate('imagine.fileOriginUnknown')) : hostLineOf(origin) ?? actionLabelOf(origin.action) ?? origin.action}</p>
          {words !== undefined && (
            <div className={css.section}>
              <span className={css.label}>{origin?.action === 'look' ? translate('imagine.look') : translate('imagine.detailsPrompt')}</span>
              <p className={css.text}>{words}</p>
              <div className={css.wordActions}>
                <button
                  type="button"
                  className={css.toggle}
                  onClick={() => { void navigator.clipboard?.writeText(words).then(() => { setCopied(true) }, () => undefined) }}
                >
                  {copied ? translate('imagine.detailsCopied') : translate('imagine.detailsCopy')}
                </button>
                {onReuse !== undefined && (
                  <button type="button" className={css.toggle} onClick={() => { onReuse(words, origin?.source) }}>
                    {translate('imagine.detailsReuse')}
                  </button>
                )}
              </div>
            </div>
          )}
          {origin?.pose !== undefined && (
            <div className={css.section}><span className={css.label}>{translate('imagine.pose')}</span><p className={css.text}>{origin.pose}</p></div>
          )}
          {origin?.changes !== undefined && (
            <div className={css.section}><span className={css.label}>{translate('imagine.detailsChanges')}</span><p className={css.text}>{origin.changes}</p></div>
          )}
          {origin?.source !== undefined && (
            <div className={css.section}>
              <span className={css.label}>{translate('imagine.detailsSource')}</span>
              <button type="button" className={css.source} onClick={() => { onOpenSource(origin.source ?? '') }}>
                <Still className={css.sourceThumb} src={thumbUrlOf(origin.source, THUMB_SMALL)} />
                <span className={css.sourceName}>{origin.source}</span>
              </button>
            </div>
          )}
          <dl className={css.facts}>
            {details.width !== undefined && <><dt>{translate('imagine.detailsDimensions')}</dt><dd>{`${String(details.width)}×${String(details.height)}`}</dd></>}
            {details.duration !== undefined && <><dt>{translate('imagine.duration')}</dt><dd>{`${details.duration.toFixed(1)} s`}</dd></>}
            {origin?.tookMs !== undefined && <><dt>{translate('imagine.detailsGeneration')}</dt><dd>{formatDuration(origin.tookMs)}</dd></>}
            {origin?.aspect !== undefined && <><dt>{translate('imagine.detailsAspect')}</dt><dd>{origin.aspect}</dd></>}
            {origin?.lipsync !== undefined && <><dt>{translate('imagine.detailsLipsync')}</dt><dd>{`${String(Math.round(origin.lipsync * 100))}%`}</dd></>}
            <dt>{translate('imagine.detailsWeight')}</dt><dd>{sizeLabel(details.size)}</dd>
            {made !== undefined && <><dt>{translate('imagine.detailsCreated')}</dt><dd>{made}</dd></>}
            <dt>{translate('imagine.detailsFile')}</dt><dd className={css.name} title={details.name}>{details.name}</dd>
          </dl>
          {item.kind !== 'audio' && (
            <div className={css.section} data-imagine-sight={details.sight === undefined ? 'missing' : 'filed'}>
              <span className={css.label}>{translate('imagine.whatYouSee')}</span>
              {details.sight !== undefined
                ? <p className={css.text}>{details.sight}</p>
                : looking
                  ? <p className={css.muted}>{translate('imagine.fileLooking')}</p>
                  : (
                    <>
                      <p className={css.muted}>{translate('imagine.noDescription')}</p>
                      <button
                        type="button"
                        className={css.toggle}
                        onClick={() => {
                          setLooking(true)
                          void askToLook([item.name])
                        }}
                      >
                        {translate('imagine.describeWithVision')}
                      </button>
                    </>
                  )}
            </div>
          )}
          {details.writtenPrompt !== undefined && (
            <div className={css.section}>
              <button type="button" className={css.toggle} onClick={() => { setShowPrompt(current => !current) }}>
                {showPrompt ? translate('imagine.fileHidePrompt') : translate('imagine.fileShowPrompt')}
              </button>
              {showPrompt && <pre className={css.prompt}>{details.writtenPrompt}</pre>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
