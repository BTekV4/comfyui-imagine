/**
 * A page of the rail that shows another web app: Openjutsu or IOPaint
 * (2026-11-09). Their plugins (plugins/openjutsu, plugins/iopaint, since
 * 2026-11-15) pass them through under `/apps/<name>/`
 * (`server/src/app-proxy.ts`), so the frame is same-origin and behind the
 * studio's login; without its plugin an app has no page and no rail entry.
 *
 * The frame is mounted once and then only hidden when another page is
 * shown: going to the Library and back does not reload Openjutsu, and a job
 * it is following (its SSE stream) keeps going.
 *
 * The gallery, for the app inside (2026-11-13): Openjutsu's upload zones have
 * a «From Imagine gallery» button (`components/imagine-pick.tsx` in Openjutsu)
 * that posts `imagine:pick` to this page. The picker opens here, over the
 * studio, and the answer — `imagine:picked` with the chosen files'
 * same-origin URLs, none when it is closed — goes back to the frame, which
 * fetches them itself.
 * @module AppFrame
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { GalleryItem, MediaKind } from '../../../shared/imagine-types.ts'
import { mediaUrlOf, thumbUrlOf, THUMB_SMALL } from './gallery-api.ts'
import { formatClock } from './format.ts'
import { translate } from './locale-store.ts'
import { DialogFooter, Modal, dialogButton } from './Modal.tsx'
import { Segmented } from './Pills.tsx'
import { Still } from './Still.tsx'
import css from './AppFrame.module.css'

/** The apps the rail opens, by view. */
export const APP_FRAMES = {
  openjutsu: { title: 'Openjutsu', src: '/apps/openjutsu' },
  iopaint: { title: 'IOPaint', src: '/apps/iopaint/' },
} as const

export type AppFrameView = keyof typeof APP_FRAMES

/** What the app inside asked for. */
interface PickRequest {
  readonly id: string
  readonly kind: MediaKind
  readonly multiple: boolean
}

/** How many tiles the picker shows before «Show more». */
const PAGE = 60

/**
 * Read one `imagine:pick` message, or nothing when it is not one.
 * @param data - the message's payload.
 * @returns the request.
 */
function pickRequestOf(data: unknown): PickRequest | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const { type, id, kind, multiple } = data as Record<string, unknown>
  if (type !== 'imagine:pick' || typeof id !== 'string' || id.length === 0 || id.length > 100) return undefined
  if (kind !== 'image' && kind !== 'video') return undefined
  return { id, kind, multiple: multiple === true }
}

/**
 * The gallery as a picker: newest first, one kind, all or the liked ones.
 * @param props - the request, the gallery, the likes, and what to do with the choice.
 * @returns the dialog.
 */
function GalleryPick({ request, items, liked, onDone }: {
  readonly request: PickRequest
  readonly items: readonly GalleryItem[]
  readonly liked: ReadonlySet<string>
  readonly onDone: (names: readonly string[]) => void
}) {
  const [filter, setFilter] = useState<'all' | 'liked'>('all')
  const [limit, setLimit] = useState(PAGE)
  const [chosen, setChosen] = useState<readonly string[]>([])
  const choices = useMemo(() => items
    .filter(item => item.kind === request.kind && (filter === 'all' || liked.has(item.name)))
    // Kept although the host sends the inventory newest first: files the
    // studio adds while it runs are put in front whatever their mtime.
    .slice()
    .sort((a, b) => b.mtime - a.mtime), [items, request.kind, filter, liked])
  const shown = choices.slice(0, limit)
  const toggle = (name: string) => {
    if (!request.multiple) {
      onDone([name])
      return
    }
    setChosen(now => now.includes(name) ? now.filter(entry => entry !== name) : [...now, name])
  }
  return (
    <Modal title={translate('imagine.appPick.title')} onClose={() => { onDone([]) }} className={css.pickDialog}>
      <div className={css.pickBar}>
        <Segmented
          label={translate('imagine.appPick.title')}
          values={['all', 'liked'] as const}
          value={filter}
          onPick={(next) => { setFilter(next); setLimit(PAGE) }}
          format={entry => translate(entry === 'all' ? 'imagine.mediaAll' : 'imagine.mediaLiked')}
          group={css.pickFilter}
          pill={css.pickFilterBtn}
        />
        <span className={css.pickCount}>{String(choices.length)}</span>
      </div>
      {choices.length === 0
        ? <p className={css.pickEmpty}>{translate('imagine.appPick.empty')}</p>
        : (
          <div className={css.pickGrid}>
            {shown.map(item => (
              <button
                key={item.name}
                type="button"
                className={css.pickTile}
                data-on={chosen.includes(item.name) || undefined}
                title={item.name}
                onClick={() => { toggle(item.name) }}
              >
                <Still className={css.pickThumb} lazy src={thumbUrlOf(item.name, THUMB_SMALL, item.mtime)} />
                {item.kind === 'video' && item.duration !== undefined && (
                  <span className={css.pickDuration}>{formatClock(item.duration)}</span>
                )}
                {chosen.includes(item.name) && (
                  <span className={css.pickMark} aria-hidden="true">{String(chosen.indexOf(item.name) + 1)}</span>
                )}
              </button>
            ))}
          </div>
        )}
      {(choices.length > limit || request.multiple) && (
        <DialogFooter
          spaced
          hint={null}
          lead={choices.length > limit && (
            <button type="button" className={dialogButton.secondary} onClick={() => { setLimit(now => now + PAGE) }}>
              {translate('imagine.showMore', { count: Math.min(PAGE, choices.length - limit) })}
            </button>
          )}
        >
          {request.multiple && (
            <button type="button" className={dialogButton.primary} disabled={chosen.length === 0} onClick={() => { onDone(chosen) }}>
              {translate('imagine.appPick.add', { count: chosen.length })}
            </button>
          )}
        </DialogFooter>
      )}
    </Modal>
  )
}

/**
 * One app, full size in the stage.
 * @param props.app - which app.
 * @param props.shown - false keeps it mounted but out of sight.
 * @param props.items - the gallery, for the app's «From Imagine gallery».
 * @param props.liked - the liked files, the picker's second filter.
 * @returns the frame.
 */
export function AppFrame({ app, shown, items, liked }: {
  readonly app: AppFrameView
  readonly shown: boolean
  readonly items: readonly GalleryItem[]
  readonly liked: ReadonlySet<string>
}) {
  const { title, src } = APP_FRAMES[app]
  const frame = useRef<HTMLIFrameElement>(null)
  const [request, setRequest] = useState<PickRequest | undefined>(undefined)
  const pending = useRef<PickRequest | undefined>(undefined)

  /** Answer the open request (none chosen is an answer too: the button stops waiting). */
  const answer = (names: readonly string[]) => {
    const open = pending.current
    if (open === undefined) return
    const files = names.map(name => ({ name, url: mediaUrlOf(name) }))
    frame.current?.contentWindow?.postMessage({ type: 'imagine:picked', id: open.id, files }, window.location.origin)
    pending.current = undefined
    setRequest(undefined)
  }
  const answerRef = useRef(answer)
  answerRef.current = answer

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      // Only this frame, and only from this origin: the app is served under it.
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return
      const asked = pickRequestOf(event.data)
      if (asked === undefined) return
      // A second ask closes the first, so no button is left waiting for ever.
      answerRef.current([])
      pending.current = asked
      setRequest(asked)
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [])

  // Leaving the page while the picker is open counts as closing it.
  useEffect(() => {
    if (!shown) answerRef.current([])
  }, [shown])

  return (
    <div className={css.page} hidden={!shown || undefined} data-app={app}>
      <iframe
        ref={frame}
        className={css.frame}
        title={title}
        src={src}
        allow="clipboard-read; clipboard-write; fullscreen"
      />
      <a className={css.open} href={src} target="_blank" rel="noopener">{`${title} ↗`}</a>
      {request !== undefined && <GalleryPick request={request} items={items} liked={liked} onDone={answer} />}
    </div>
  )
}
