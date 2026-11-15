/**
 * The projects page: one card per project, its chosen cover and first files
 * as a mosaic, its title and how many files it holds. Split out of
 * ImaginePage.tsx (2026-10-25).
 * @module ProjectsGrid
 */

import { memo } from 'react'
import { IconSparkleRegular } from '../../shims/primitives/index.ts'
import type { ImagineProject } from '../../../shared/imagine-projects.ts'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import { thumbUrlOf, THUMB_SMALL } from './gallery-api.ts'
import { Still } from './Still.tsx'
import shared from './imagine-shared.module.css'
import css from './ProjectsGrid.module.css'
import { translate } from './locale-store.ts'

export const ProjectsGrid = memo(function ProjectsGrid({ listed, allByName, onOpen }: {
  /** The projects matching the search, in rail order. */
  listed: readonly ImagineProject[]
  /** Every file of the inventory, by name. */
  allByName: ReadonlyMap<string, GalleryItem>
  onOpen: (id: string) => void
}) {
  return (
    <div className={css.projectsView}>
      <div className={css.projectsGrid}>
        {listed.map((project) => {
          // The chosen cover first, then the board's files in order.
          const order = project.cover !== undefined && project.itemNames.includes(project.cover)
            ? [project.cover, ...project.itemNames.filter(name => name !== project.cover)]
            : project.itemNames
          const thumbs: GalleryItem[] = []
          for (const name of order) {
            const file = allByName.get(name)
            if (file !== undefined) thumbs.push(file)
            if (thumbs.length === 4) break
          }
          const gridCols = thumbs.length <= 2 ? 2 : 3
          /*
           * Counted against the gallery, not against itemNames. A project
           * keeps the name of a file deleted elsewhere, and the card claimed a
           * tile the board would never draw.
           */
          const count = project.itemNames.filter(name => allByName.has(name)).length
          return (
            <button
              key={project.id}
              type="button"
              className={css.projectCard}
              onClick={() => { onOpen(project.id) }}
            >
              <div className={css.projectCardCover}>
                <div
                  className={css.projectCardMosaic}
                  style={{ gridTemplateColumns: `repeat(${gridCols}, 1fr)` }}
                >
                  {thumbs.map(item => item.kind === 'audio'
                    ? <span key={item.name} className={css.audioThumb} aria-hidden="true">♪</span>
                    : <Still key={item.name} src={thumbUrlOf(item.name, THUMB_SMALL, item.mtime)} />)}
                  {thumbs.length === 0 && (
                    <span className={css.projectCardEmpty} aria-hidden="true">
                      <IconSparkleRegular size={22} />
                    </span>
                  )}
                </div>
              </div>
              <span className={css.projectCardTitle}>{project.title}</span>
              <span className={css.projectCardMeta}>
                {translate(count === 1 ? 'imagine.itemCountOne' : 'imagine.itemCount', { count: String(count) })}
              </span>
            </button>
          )
        })}
        {listed.length === 0 && (
          <p className={shared.note}>{translate('imagine.emptyProject')}</p>
        )}
      </div>
    </div>
  )
})
