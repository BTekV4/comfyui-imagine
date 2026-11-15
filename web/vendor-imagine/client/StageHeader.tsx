/**
 * The bar above the stage: the rail toggle on a narrow window, the way home,
 * the project's title, the canvas's own buttons (File/Canvas, Expand,
 * Hide canvas) and "New project". Split out of ImaginePage.tsx
 * (2026-10-25).
 * @module StageHeader
 */

import { translate } from './locale-store.ts'
import { memo, type CSSProperties } from 'react'
import { IconPanelLeftOutlineRegular, IconPlusOutlineRegular, IconSparkleRegular, Tooltip } from '../../shims/primitives/index.ts'
import type { ImagineView } from './gallery-store.ts'
import css from './StageHeader.module.css'

export interface StageHeaderProps {
  readonly view: ImagineView
  /** The open project's title, in the project view. */
  readonly title: string | undefined
  /** The open project is the History: no canvas buttons there. */
  readonly onHistory: boolean
  readonly canvasHidden: boolean
  readonly chatHidden: boolean
  readonly projectPane: 'canvas' | 'files'
  /** Whether the rail's drawer is out, for the toggle's state. */
  readonly railDrawer: boolean
  /** The chat column's width, which the canvas buttons line up with. */
  readonly chatWidth: number
  readonly saveFailed: boolean
  readonly onToggleRail: () => void
  readonly onHome: () => void
  readonly onPane: (pane: 'canvas' | 'files') => void
  readonly onCanvasHidden: (hidden: boolean) => void
  readonly onToggleChat: () => void
  readonly onNewProject: () => void
}

export const StageHeader = memo(function StageHeader({
  view, title, onHistory, canvasHidden, chatHidden, projectPane, railDrawer, chatWidth, saveFailed,
  onToggleRail, onHome, onPane, onCanvasHidden, onToggleChat, onNewProject,
}: StageHeaderProps) {
  const project = view === 'project' && title !== undefined
  return (
    /* All media carries its own bar, as Grok's page: on a wide screen the
       studio's strip above it would only push the grid down. */
    <div
      className={css.stageTop}
      data-media={view === 'media' || undefined}
      data-canvas-hidden={canvasHidden || undefined}
      data-chat-hidden={view === 'project' && chatHidden ? true : undefined}
      style={view === 'project' ? { '--imagine-chat-w': chatHidden || canvasHidden ? '0px' : `${String(chatWidth)}px` } as CSSProperties : undefined}
      // The chat drag writes the width here while the pointer moves.
      data-imagine-chat-w={view === 'project' && !chatHidden && !canvasHidden ? true : undefined}
    >
      <button
        type="button"
        className={`${css.iconBtn} ${css.railToggle}`}
        // What it does, not the brand's name: two buttons read "ComfyUI Imagine".
        aria-label={translate('imagine.sidebar')}
        aria-expanded={railDrawer}
        onClick={onToggleRail}
      >
        <IconPanelLeftOutlineRegular size={16} />
      </button>
      {/*
        * Off the project pages the button shows on the phone only — and not on
        * the home itself, where it would be a star that goes to the page you
        * are already on (requested 2026-11-20). On a wide screen it was
        * `display: none` there anyway, so nothing moves.
        */}
      {view !== 'home' && (
        <button
          type="button"
          // The project page has no bar over its chat on Grok: there the
          // star is the phone's way home only, as on the other pages.
          className={view === 'projects' ? css.iconBtn : `${css.iconBtn} ${css.mobileHome}`}
          aria-label={translate('imagine.newGeneration')}
          onClick={onHome}
        >
          <IconSparkleRegular size={16} />
        </button>
      )}
      {/* Grok's project page shows no title over the chat (2026-11-15): the
          project is the one lit in the rail. */}
      {/*
        * The canvas's own buttons, in the header as Grok Imagine has them
        * along its top edge (2026-10-17): File and Canvas where the canvas
        * begins, Expand and Hide canvas at the far end.
        */}
      {project && !onHistory && (
        <>
          <div className={css.headCanvasLeft}>
            {!canvasHidden && (
              <div className={css.canvasTopGroup}>
                <Tooltip label={translate('imagine.projectFilesHead')} side="bottom" delayMs={150} portal>
                  <button type="button" className={css.canvasTopBtn} aria-label={translate('imagine.projectFilesHead')} aria-pressed={projectPane === 'files'} data-on={projectPane === 'files' || undefined} onClick={() => { onPane('files') }}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true"><path d="M4.5 1.75h4.75l3.25 3.25v8a1.25 1.25 0 0 1-1.25 1.25h-6.75A1.25 1.25 0 0 1 3.25 13V3A1.25 1.25 0 0 1 4.5 1.75Z" /><path d="M9.25 1.75V5h3.25" /><path d="M5.75 8.5h4.5M5.75 11h3" /></svg>
                  </button>
                </Tooltip>
                <Tooltip label={translate('imagine.projectCanvasHead')} side="bottom" delayMs={150} portal>
                  <button type="button" className={css.canvasTopBtn} aria-label={translate('imagine.projectCanvasHead')} aria-pressed={projectPane === 'canvas'} data-on={projectPane === 'canvas' || undefined} onClick={() => { onPane('canvas') }}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">{[3.5, 8, 12.5].flatMap(x => [3.5, 8, 12.5].map(y => <circle key={`${String(x)}${String(y)}`} cx={x} cy={y} r="1.15" />))}</svg>
                  </button>
                </Tooltip>
              </div>
            )}
          </div>
          <div className={css.headCanvasRight} data-chat-hidden={chatHidden || undefined}>
            <div className={css.canvasTopGroup}>
              {canvasHidden
                ? (
                  <Tooltip label={translate('imagine.showCanvas')} side="bottom" delayMs={150} portal>
                    <button type="button" className={css.canvasTopBtn} aria-label={translate('imagine.showCanvas')} onClick={() => { onCanvasHidden(false) }}>
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2.5" /><path d="M10 2.5v11" /></svg>
                    </button>
                  </Tooltip>
                )
                : (
                  <>
                    <Tooltip label={chatHidden ? translate('imagine.collapseWorkspace') : translate('imagine.expandWorkspace')} side="bottom" delayMs={150} portal>
                      <button type="button" className={css.canvasTopBtn} aria-label={chatHidden ? translate('imagine.collapseWorkspace') : translate('imagine.expandWorkspace')} data-on={chatHidden || undefined} onClick={onToggleChat}>
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d={chatHidden ? 'M3 9h4v4M13 7H9V3M7 9l-4.5 4.5M9 7l4.5-4.5' : 'M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9'} />
                        </svg>
                      </button>
                    </Tooltip>
                    <Tooltip label={translate('imagine.hideCanvas')} side="bottom" delayMs={150} portal>
                      <button type="button" className={css.canvasTopBtn} aria-label={translate('imagine.hideCanvas')} onClick={() => { onCanvasHidden(true) }}>
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2.5" /><path d="M10 2.5v11" /><path d="M11.5 6.5h1M11.5 9h1" strokeLinecap="round" /></svg>
                      </button>
                    </Tooltip>
                  </>
                )}
            </div>
          </div>
        </>
      )}

      {view === 'projects' && (
        <span className={css.projectTitle}>{translate('imagine.projects')}</span>
      )}
      {view !== 'project' && view !== 'social' && view !== 'openjutsu' && view !== 'iopaint' && (
        <button
          type="button"
          className={css.primary}
          aria-label={translate('imagine.newProject')}
          onClick={onNewProject}
        >
          <IconPlusOutlineRegular size={16} />
          <span className={css.primaryLabel}>{translate('imagine.newProject')}</span>
        </button>
      )}
      {saveFailed && (
        <span className={css.syncFailed} role="status">{translate('imagine.saveFailed')}</span>
      )}
    </div>
  )
})
