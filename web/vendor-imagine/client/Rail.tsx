/**
 * The studio's left rail: the brand, search, the destinations, the project
 * list with its menus, the recent projects' thumbnails and the settings.
 *
 * Split out of ImaginePage.tsx (2026-10-21). The page keeps what other parts
 * of it read too — the search query (the projects page filters by it), the
 * open menu and the rename in progress (Escape closes them) — and the rail
 * keeps the rest.
 * @module Rail
 */

import { translate } from './locale-store.ts'
import { memo, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import {
  IconEllipsisOutlineRegular, IconFolderCloseRegular, IconPanelLeftOutlineRegular, IconPlusOutlineRegular,
  IconSearchOutlineRegular, IconSettingsOutlineRegular, IconSparkleRegular,
  Tooltip,
} from '../../shims/primitives/index.ts'
import { ComfyUIMark } from './comfyui-mark.tsx'
import { PluginMark } from './plugin-mark.tsx'
import { IconLibrary } from './canvas-icons.tsx'
import { InstagramMark } from './instagram-mark.tsx'
import { IOPaintMark, OpenjutsuMark } from './app-marks.tsx'
import { APP_FRAMES, type AppFrameView } from './AppFrame.tsx'
import { ageLabel } from './labels.ts'
import { Still } from './Still.tsx'
import { THUMB_SMALL, thumbUrlOf } from './gallery-api.ts'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import type { ImagineView } from './gallery-store.ts'
import type { ImagineProject } from '../../../shared/imagine-projects.ts'
import type { ImaginePageProps } from './props.ts'
import css from './Rail.module.css'

/** Projects the rail lists before its "show more" button. */
const RAIL_PROJECTS = 10

/** Ticks once a minute for every {@link UsedLabel} at once. */
const minuteListeners = new Set<(now: number) => void>()
let minuteTimer: ReturnType<typeof setInterval> | undefined

/**
 * A rail row's "last used" label, on a minute clock of its own: the clock
 * used to live in the page, which re-rendered whole once a minute for it.
 */
function UsedLabel({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    minuteListeners.add(setNow)
    minuteTimer ??= setInterval(() => { const tick = Date.now(); for (const listener of minuteListeners) listener(tick) }, 60_000)
    return () => {
      minuteListeners.delete(setNow)
      if (minuteListeners.size === 0 && minuteTimer !== undefined) {
        clearInterval(minuteTimer)
        minuteTimer = undefined
      }
    }
  }, [])
  return <span className={css.projectTime}>{ageLabel(at, now)}</span>
}

interface RailProps {
  readonly actions: ImaginePageProps['actions']
  readonly view: ImagineView
  readonly projectId: string | undefined
  readonly railCollapsed: boolean
  /** The rail is a drawer at this width, not a column. */
  readonly narrow: boolean
  /** The projects matching the search, in rail order. */
  readonly listed: readonly ImagineProject[]
  /** When each listed project was last worked in. */
  readonly usedAtById: ReadonlyMap<string, number>
  readonly query: string
  readonly onQuery: (query: string) => void
  readonly renaming: { id: string; title: string } | undefined
  readonly onRenaming: (renaming: { id: string; title: string } | undefined) => void
  readonly menuId: string | undefined
  readonly onMenuId: Dispatch<SetStateAction<string | undefined>>
  /**
   * Posts still to go out, for the Instagram row's count; undefined when the
   * Instagram plugin is absent or off, and then there is no row.
   */
  readonly pendingPosts: number | undefined
  /** The apps whose plugin is there (Openjutsu, IOPaint): one entry each, under Instagram. */
  readonly apps: readonly AppFrameView[]
  /** The whole inventory, newest first, for the media strip and its stack. */
  readonly items: readonly GalleryItem[]
  /** A thumbnail of the strip was clicked: show that file on its board. */
  readonly onOpenFile: (name: string) => void
  /** Any click on the rail; the page closes the viewer with it. */
  readonly onRailClick: () => void
  readonly onCloseDrawer: () => void
  readonly onNewGeneration: () => void
  readonly onNewProject: () => void
  readonly onDeleteProject: (id: string) => void
}

export const Rail = memo(function Rail(props: RailProps) {
  const {
    actions, view, projectId, railCollapsed, narrow, listed, usedAtById, query, onQuery, renaming, onRenaming,
    menuId, onMenuId, pendingPosts, apps, items, onOpenFile, onRailClick, onCloseDrawer, onNewGeneration,
    onNewProject, onDeleteProject,
  } = props
  /** Whether the rail lists every project, not only the first RAIL_PROJECTS. */
  const [railExpanded, setRailExpanded] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  /*
   * A collapsed rail has no room for the field, and no room for the project
   * names either — which is what one would be searching through. So the strip
   * carries the magnifier as a plain button that opens the rail, the way the
   * chat sidebar's does, and the field takes the caret once it is there.
   */
  const [searchOnExpand, setSearchOnExpand] = useState(false)
  useEffect(() => {
    if (!searchOnExpand || railCollapsed) return
    searchRef.current?.focus()
    setSearchOnExpand(false)
  }, [searchOnExpand, railCollapsed])
  /*
   * The rail shows the first RAIL_PROJECTS and a button for the rest (asked
   * 2026-10-17: 58 projects made the rail a scroll of its own). A search shows
   * every match, and the open project is always listed, wherever it sorts.
   */
  const searching = query.trim().length > 0
  const railListed = searching || railExpanded
    ? listed
    : listed.filter((project, index) => index < RAIL_PROJECTS || project.id === projectId)
  const railHidden = listed.length - railListed.length
  /*
   * Collapsed, Grok's sidebar keeps one button: the two latest pictures
   * stacked like a deck, the one behind turned 12°. Found by walking the
   * inventory until two turn up, not by filtering all of it on every render.
   */
  /**
   * Settle a rename: a name the user typed is final, so the naming pass must
   * not take it back on the next content. Enter and leaving the field both
   * land here; an empty field keeps the old name.
   * @param project - the project being renamed.
   * @param title - what the field holds.
   */
  const commitRename = (project: ImagineProject, title: string): void => {
    const name = title.trim()
    if (name.length > 0) actions.upsertProject({ ...project, title: name, autoTitle: false })
    onRenaming(undefined)
  }
  const [front, back] = useMemo(() => {
    const out: GalleryItem[] = []
    for (const item of items) {
      if (item.kind === 'audio') continue
      out.push(item)
      if (out.length === 2) break
    }
    return out
  }, [items])

  return (
    <aside
      className={css.rail}
      // A click on the rail leaves the full-screen viewer and still does
      // what it was aimed at, so the viewer never hides the page it opened.
      onClickCapture={onRailClick}
    >
      <div className={css.railHead}>
        <Tooltip label={translate('imagine.expandRail')} side="right" delayMs={400} disabled={!railCollapsed}>
          <button
            type="button"
            className={railCollapsed ? css.iconBtn : css.brand}
            aria-label={railCollapsed ? translate('imagine.expandRail') : translate('imagine.title')}
            onClick={() => {
              if (railCollapsed) actions.setRailCollapsed(false)
              else actions.go('home')
            }}
          >
            {railCollapsed ? (
              <>
                <ComfyUIMark size={16} />
                <IconPanelLeftOutlineRegular size={16} className={css.railExpandSwap} />
              </>
            ) : (
              <>
                <ComfyUIMark size={16} />
                <span className={css.brandLabel}>{translate('imagine.title')}</span>
              </>
            )}
          </button>
        </Tooltip>
        {/*
          * In a drawer this closes; in a column it collapses. Collapsing a
          * drawer left a 257px panel with every label hidden covering two
          * thirds of a 390px screen — the collapsed width belongs to the
          * wide layout, where the rail is a column with a strip to shrink
          * to, and the drawer has no such state.
          */}
        {!railCollapsed && (
          <Tooltip
            label={narrow ? translate('imagine.closeRail') : translate('imagine.collapse')}
            side="right"
            delayMs={400}
            disabled={narrow}
          >
            <button
              type="button"
              className={css.iconBtn}
              aria-label={narrow ? translate('imagine.closeRail') : translate('imagine.collapse')}
              onClick={() => {
                if (narrow) onCloseDrawer()
                else actions.setRailCollapsed(true)
              }}
            >
              <IconPanelLeftOutlineRegular size={16} />
            </button>
          </Tooltip>
        )}
      </div>
      <nav className={css.nav}>
        {railCollapsed ? (
          <Tooltip label={translate('imagine.search')} side="right" delayMs={400}>
            <button
              type="button"
              className={css.navBtn}
              aria-label={translate('imagine.search')}
              onClick={() => {
                actions.setRailCollapsed(false)
                setSearchOnExpand(true)
              }}
            >
              <IconSearchOutlineRegular size={16} />
            </button>
          </Tooltip>
        ) : (
          <label className={css.navBtn}>
            <IconSearchOutlineRegular size={16} />
            <input
              ref={searchRef}
              className={css.searchField}
              value={query}
              placeholder={translate('imagine.search')}
              onChange={(event) => { onQuery(event.target.value) }}
            />
          </label>
        )}
        {/*
          * From inside a workflow card too: "New generation" is the grid of
          * tools. In the phone drawer, though, the entry disappears when you are
          * already there: it would be a second button for the page you are on
          * (requested 2026-11-20). On the wide rail it stays as it was.
          */}
        {!(narrow && view === 'home') && (
          <button type="button" className={css.navBtn} data-active={view === 'home' || undefined} onClick={onNewGeneration}>
            <IconSparkleRegular size={16} />
            <span>{translate('imagine.newGeneration')}</span>
          </button>
        )}
        <Tooltip label={translate('imagine.host.library')} side="right" delayMs={400} disabled={!railCollapsed}>
          <button type="button" className={css.navBtn} aria-label={translate('imagine.host.library')} data-active={view === 'library' || undefined} onClick={() => { actions.go('library') }}>
            <IconLibrary />
            <span>{translate('imagine.host.library')}</span>
          </button>
        </Tooltip>
        {/*
          * The publication queue has its own page: the rail carries only the
          * way in, with the count of what is still to go out. It sits in the
          * nav group with the other destinations — as a band of its own it
          * left a gap under "new generation" that read as a missing row.
          */}
        {pendingPosts !== undefined && (
          <div className={css.queue}>
            {/* Collapsed, this is a bare glyph like the ones above it, so it
                needs the same tooltip and name they get from the rail. */}
            <Tooltip label={'Instagram'} side="right" delayMs={400} disabled={!railCollapsed}>
              <button
                type="button"
                className={css.queueLabel}
                aria-label={'Instagram'}
                data-active={view === 'social' || undefined}
                onClick={() => { actions.go('social') }}
              >
                <InstagramMark size={16} />
                <span className={css.queueName}>{'Instagram'}</span>
                {pendingPosts > 0 && (
                  <span className={css.queueCount}>{String(pendingPosts)}</span>
                )}
              </button>
            </Tooltip>
          </div>
        )}
        {/*
          * The other apps of the box, under Instagram (2026-11-09): they open
          * in a page of the studio, inside a frame (AppFrame.tsx).
          */}
        {apps.map(app => [app, app === 'openjutsu' ? OpenjutsuMark : IOPaintMark] as const).map(([app, Mark]) => (
          <Tooltip key={app} label={APP_FRAMES[app].title} side="right" delayMs={400} disabled={!railCollapsed}>
            <button
              type="button"
              className={css.navBtn}
              aria-label={APP_FRAMES[app].title}
              data-active={view === app || undefined}
              onClick={() => { actions.go(app) }}
            >
              <Mark size={16} />
              <span>{APP_FRAMES[app].title}</span>
            </button>
          </Tooltip>
        ))}
      </nav>
      <div className={css.section}>
        <div className={css.sectionHead}>
          <button type="button" className={css.sectionHeadBtn} data-active={view === 'projects' || undefined} onClick={() => { actions.go('projects') }}>
            <span>{translate('imagine.projects')}</span>
          </button>
          <button
            type="button"
            className={css.iconBtn}
            aria-label={translate('imagine.newProject')}
            onClick={onNewProject}
          >
            <IconPlusOutlineRegular size={14} />
          </button>
        </div>
        <div className={css.projectList}>
          {railListed.map(project => (
            <div key={project.id} className={css.projectRow} data-active={project.id === projectId || undefined}>
              {renaming?.id === project.id
                ? (
                  <input
                    className={css.renameField}
                    value={renaming.title}
                    autoFocus
                    aria-label={translate('imagine.rename')}
                    onChange={(event) => { onRenaming({ id: project.id, title: event.target.value }) }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitRename(project, renaming.title)
                      if (event.key === 'Escape') onRenaming(undefined)
                    }}
                    onBlur={() => { commitRename(project, renaming.title) }}
                  />
                )
                : (
                  <button
                    type="button"
                    className={css.projectBtn}
                    onClick={() => { actions.openProject(project.id) }}
                  >
                    <IconFolderCloseRegular size={16} />
                    <span>{project.title}</span>
                  </button>
                )}
              {renaming?.id !== project.id && (
                <UsedLabel at={usedAtById.get(project.id) ?? project.createdAt} />
              )}
              <button
                type="button"
                className={css.moreBtn}
                aria-label={translate('imagine.projectMenu')}
                aria-expanded={menuId === project.id}
                onClick={(event) => {
                  event.stopPropagation()
                  onMenuId(current => current === project.id ? undefined : project.id)
                }}
              >
                <IconEllipsisOutlineRegular size={14} />
              </button>
              {menuId === project.id && (
                <div className={css.projectMenu} role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onMenuId(undefined)
                      onRenaming({ id: project.id, title: project.title })
                    }}
                  >
                    {translate('imagine.rename')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      actions.upsertProject({ ...project, pinned: project.pinned !== true })
                      onMenuId(undefined)
                    }}
                  >
                    {project.pinned === true ? translate('imagine.unpin') : translate('imagine.pin')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    data-danger
                    onClick={() => {
                      if (globalThis.confirm(translate('imagine.confirmDeleteProject'))) {
                        onDeleteProject(project.id)
                      }
                      onMenuId(undefined)
                    }}
                  >
                    {translate('imagine.delete')}
                  </button>
                </div>
              )}
            </div>
          ))}
          {!searching && (railHidden > 0 || railExpanded) && listed.length > RAIL_PROJECTS && (
            <button
              type="button"
              className={css.railMore}
              onClick={() => { setRailExpanded(current => !current) }}
            >
              {railExpanded ? translate('imagine.showLess') : translate('imagine.showMore', { count: railHidden })}
            </button>
          )}
        </div>
        {/*
          * History lives here and nowhere else. The rail listed it among the
          * projects as well, which read as a project the user had made; the
          * label below the thumbnails is the one entry point into the board.
          */}
        {/*
          * As Grok Imagine's sidebar foot (2026-10-17): the latest projects
          * as a row of thumbnails, and "All media" at the end of it —
          * the History, now a page of every file.
          */}
        <div className={css.history}>
          {/* The media stack opens All media. */}
          <Tooltip label={translate('imagine.mediaContents')} side="right" delayMs={300}>
            <button type="button" className={css.mediaStack} aria-label={translate('imagine.mediaContents')} data-active={view === 'media' || undefined} onClick={() => { actions.go('media') }}>
              {back !== undefined && <Still className={css.mediaStackBack} src={thumbUrlOf(back.name, THUMB_SMALL, back.mtime)} />}
              {front !== undefined && <Still className={css.mediaStackFront} src={thumbUrlOf(front.name, THUMB_SMALL, front.mtime)} />}
            </button>
          </Tooltip>
          <div className={css.recentRow}>
            {/*
              * Files, not projects (requested 2026-11-04): the strip at the
              * bottom left is the latest work done, so three photos of a
              * lighthouse are three thumbnails, not a project's cover.
              * There used to be one face per project here, and a freshly
              * generated file never showed up unless the cover changed.
              */}
            {items.slice(0, 5).map(item => (
              <Tooltip key={item.name} label={item.name} side="top" delayMs={300}>
                <button
                  type="button"
                  className={css.recentThumb}
                  aria-label={item.name}
                  onClick={() => { onOpenFile(item.name) }}
                >
                  {item.kind === 'audio'
                    ? <span className={css.audioThumb} aria-hidden="true">♪</span>
                    : <Still src={thumbUrlOf(item.name, THUMB_SMALL, item.mtime)} />}
                </button>
              </Tooltip>
            ))}
            <Tooltip label={translate('imagine.allMedia')} side="top" delayMs={300}>
              <button
                type="button"
                className={css.recentAll}
                aria-label={translate('imagine.allMedia')}
                data-active={view === 'media' || undefined}
                onClick={() => { actions.go('media') }}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1.2" /><rect x="9" y="2" width="5" height="5" rx="1.2" /><rect x="2" y="9" width="5" height="5" rx="1.2" /><rect x="9" y="9" width="5" height="5" rx="1.2" /></svg>
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
      <div className={css.railFoot}>
        {/*
          * The deployment's own settings live here rather than under the
          * project list: they are not a destination of the studio but the
          * way it is wired, and the footer is where the rail keeps that.
          */}
        <Tooltip label={translate('imagine.plugins.open')} side="right" delayMs={400} disabled={!railCollapsed}>
          <button
            type="button"
            className={css.navBtn}
            aria-label={translate('imagine.plugins.open')}
            data-active={view === 'plugins' || undefined}
            onClick={() => { actions.go('plugins') }}
          >
            <PluginMark size={16} />
            <span>{translate('imagine.plugins.title')}</span>
          </button>
        </Tooltip>
        <Tooltip label={translate('imagine.settings.open')} side="right" delayMs={400} disabled={!railCollapsed}>
          <button
            type="button"
            className={css.navBtn}
            aria-label={translate('imagine.settings.open')}
            data-active={view === 'settings' || undefined}
            onClick={() => { actions.go('settings') }}
          >
            <IconSettingsOutlineRegular size={16} />
            <span>{translate('imagine.settings.title')}</span>
          </button>
        </Tooltip>
      </div>
    </aside>
  )
})
