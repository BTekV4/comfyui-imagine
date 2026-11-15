/**
 * The column on the right of the viewer, as Grok Imagine's post page has it
 * (studied 2026-11-15, docs/note/imagine-grok-post-riferimento.md): the tools
 * as icons along the top, the tool's own content, then the file's actions —
 * «Rimuovi lo sfondo», «Crea un video», «Pubblica» on white — and a row of
 * small icons at the foot (like, copy, download, more).
 *
 * Grok's five tools, in its order: Segmenti, Modifica precisa, Colori,
 * Ritaglia, Disegna (Colori and Disegna added in phase two, 2026-11-15).
 * @module PostPanel
 */

import { useRef, useState, type ReactNode } from 'react'
import { IconDots, Tooltip } from '../../shims/primitives/index.ts'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import { IconSegments } from './canvas-icons.tsx'
import { mediaUrlOf } from './gallery-api.ts'
import { translate } from './locale-store.ts'
import { MediaActionIcon, type MediaAction, type MediaActionKind } from './media-actions.tsx'
import { useDismiss } from './use-dismiss.ts'
import css from './PostPanel.module.css'

/** The tools of a photo, in Grok's order. */
export type PostTool = 'segments' | 'precise' | 'colors' | 'crop' | 'draw'

/** The actions drawn as full-width buttons, in Grok's order; publish is the white one. */
const BIG: readonly MediaActionKind[] = ['bg', 'video', 'extend', 'publish']
/** The small icons at the foot, before «more». */
const SMALL: readonly MediaActionKind[] = ['like', 'copy', 'download']

const S = ({ children }: { children: ReactNode }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
/** Grok's «Modifica precisa»: a brush over a dotted zone. */
const IconPrecise = () => <S><path d="M4 20c1.5 0 3-1 3-3a2 2 0 1 0-4 0" /><path d="m7 15 9.5-9.5a2.1 2.1 0 0 1 3 3L10 18" /><path d="M14 4.5 15.5 3M19.5 9 21 7.5" /></S>
const IconCropTool = () => <S><path d="M6 2v14a2 2 0 0 0 2 2h14" /><path d="M18 22V8a2 2 0 0 0-2-2H2" /></S>
/** Grok's «Colori»: a full colour wheel. */
const IconColors = () => <span aria-hidden="true" style={{ display: 'block', width: 20, height: 20, borderRadius: '50%', background: 'conic-gradient(from 180deg, #6155f5, #cb30e0, #ff383c, #ff8d28, #ffcc00, #34c759, #0088ff, #6155f5)' }} />
const IconDraw = () => <S><path d="m15 5 4 4" /><path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1Z" /></S>

export function PostPanel({
  item, tool, onTool, actions, liked, onAction, children,
}: {
  item: GalleryItem
  /** The tool open, for a photo; undefined for a clip or a track. */
  tool: PostTool | undefined
  onTool: (tool: PostTool) => void
  actions: readonly MediaAction[]
  liked: boolean
  onAction: (kind: MediaActionKind, anchor: DOMRect) => void
  /** The open tool's own content. */
  children?: ReactNode
}) {
  const [menu, setMenu] = useState(false)
  const menuBox = useRef<HTMLDivElement>(null)
  useDismiss(menuBox, () => { setMenu(false) }, menu)
  const big = BIG.map(kind => actions.find(action => action.kind === kind)).filter((action): action is MediaAction => action !== undefined)
  const small = SMALL.map(kind => actions.find(action => action.kind === kind)).filter((action): action is MediaAction => action !== undefined)
  const shown = new Set<MediaActionKind>([...BIG, ...SMALL, 'region', 'crop', 'open'])
  const more = actions.filter(action => !shown.has(action.kind))
  const tools: readonly { id: PostTool; label: string; icon: ReactNode }[] = [
    { id: 'segments', label: translate('imagine.segments'), icon: <IconSegments size={20} /> },
    { id: 'precise', label: translate('imagine.regionEdit'), icon: <IconPrecise /> },
    { id: 'colors', label: translate('imagine.colors'), icon: <IconColors /> },
    { id: 'crop', label: translate('imagine.crop'), icon: <IconCropTool /> },
    { id: 'draw', label: translate('imagine.draw'), icon: <IconDraw /> },
  ]
  const fire = (action: MediaAction, target: HTMLElement): void => {
    setMenu(false)
    onAction(action.kind, target.getBoundingClientRect())
  }

  return (
    <aside className={css.panel} aria-label={translate('imagine.postDetails')}>
      {tool !== undefined && (
        <div className={css.tools} role="toolbar" aria-label={translate('imagine.postTools')}>
          {tools.map(entry => (
            <Tooltip key={entry.id} label={entry.label} side="bottom" delayMs={200} portal>
              <button type="button" className={css.tool} aria-label={entry.label} aria-pressed={tool === entry.id} onClick={() => { onTool(entry.id) }}>
                {entry.icon}
              </button>
            </Tooltip>
          ))}
        </div>
      )}
      <div className={css.body}>{children}</div>
      <div className={css.actions}>
        {big.map(action => (
          <button
            key={action.kind}
            type="button"
            className={css.big}
            data-primary={action.kind === 'publish' || undefined}
            disabled={action.disabled}
            onClick={(event) => { fire(action, event.currentTarget) }}
          >
            <span className={css.bigIcon}><MediaActionIcon kind={action.kind} /></span>
            <span className={css.bigLabel}>{action.label}</span>
            <span className={css.bigIcon} />
          </button>
        ))}
      </div>
      <div className={css.foot}>
        {small.map(action => (action.kind === 'download'
          ? (
            <a key={action.kind} className={css.icon} href={mediaUrlOf(item.name)} download={item.name} aria-label={action.label} title={action.label}>
              <MediaActionIcon kind={action.kind} />
            </a>
          )
          : (
            <button
              key={action.kind}
              type="button"
              className={css.icon}
              aria-label={action.label}
              title={action.label}
              aria-pressed={action.kind === 'like' ? liked : undefined}
              disabled={action.disabled}
              onClick={(event) => { fire(action, event.currentTarget) }}
            >
              <MediaActionIcon kind={action.kind} liked={liked} />
            </button>
          )))}
        {more.length > 0 && (
          <div className={css.menuBox} ref={menuBox}>
            <button type="button" className={css.icon} aria-label={translate('imagine.moreActions')} title={translate('imagine.moreActions')} aria-expanded={menu} onClick={() => { setMenu(open => !open) }}>
              <IconDots />
            </button>
            {menu && (
              <div className={css.menu} role="menu">
                {more.map(action => (
                  <button
                    key={action.kind}
                    type="button"
                    role="menuitem"
                    className={css.menuItem}
                    data-danger={action.danger || undefined}
                    disabled={action.disabled}
                    onClick={(event) => { fire(action, event.currentTarget) }}
                  >
                    <MediaActionIcon kind={action.kind} />
                    <span>{action.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}

/** «Modifica precisa»'s own content: the brush size, as Grok's (12-66). */
export function PreciseTool({ brush, onBrush, painted, onClear }: {
  brush: number
  onBrush: (size: number) => void
  painted: boolean
  onClear: () => void
}) {
  return (
    <div className={css.section}>
      <span className={css.sectionTitle}>{translate('imagine.brushSize')}</span>
      <div className={css.slider}>
        <span className={css.dotSmall} aria-hidden="true" />
        <input type="range" min={12} max={66} step={1} value={brush} aria-label={translate('imagine.brushSize')} onChange={(event) => { onBrush(Number(event.currentTarget.value)) }} />
        <span className={css.dotLarge} aria-hidden="true" />
      </div>
      <p className={css.hint}>{painted ? translate('imagine.preciseReady') : translate('imagine.precisePaint')}</p>
      {painted && <button type="button" className={css.link} onClick={onClear}>{translate('imagine.clearAll')}</button>}
    </div>
  )
}
