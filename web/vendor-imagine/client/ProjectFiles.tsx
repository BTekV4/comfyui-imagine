/**
 * The project's "File" view, as Grok Imagine's canvas has beside "Canvas"
 * (2026-10-17): the files in folders by kind on the left, the one picked
 * shown large on the right, played when it plays.
 */
import { translate } from './locale-store.ts'
import type { ComfyLocaleKey } from './locales.ts'
import { useMemo, useState } from 'react'
import { mediaUrlOf, thumbUrlOf, THUMB_SMALL } from './gallery-api.ts'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import { Still } from './Still.tsx'
import css from './ProjectFiles.module.css'

const FOLDERS: readonly { kind: GalleryItem['kind']; label: ComfyLocaleKey }[] = [
  { kind: 'image', label: 'imagine.libImages' },
  { kind: 'video', label: 'imagine.libVideos' },
  { kind: 'audio', label: 'imagine.libAudios' },
]

export interface ProjectFilesProps {
  readonly items: readonly GalleryItem[]
  readonly onFullscreen: (item: GalleryItem) => void
  readonly onShowOnCanvas: (item: GalleryItem) => void
}

export function ProjectFiles({ items, onFullscreen, onShowOnCanvas }: ProjectFilesProps) {
  const sorted = useMemo(() => [...items].sort((a, b) => b.mtime - a.mtime), [items])
  const [pickedName, setPickedName] = useState<string | undefined>(undefined)
  const [open, setOpen] = useState<Record<string, boolean>>({ image: true, video: true, audio: true })
  // Nothing picked, or a pick that left the project, shows the newest file.
  const picked = sorted.find(item => item.name === pickedName) ?? sorted[0]

  return (
    <div className={css.files}>
      <nav className={css.tree} aria-label={translate('imagine.projectFiles')}>
        <span className={css.treeHead}>{translate('imagine.projectFilesHead')}</span>
        {FOLDERS.map((folder) => {
          const inside = sorted.filter(item => item.kind === folder.kind)
          if (inside.length === 0) return null
          return (
            <div key={folder.kind}>
              <button type="button" className={css.folder} aria-expanded={open[folder.kind] !== false} onClick={() => { setOpen(state => ({ ...state, [folder.kind]: state[folder.kind] === false })) }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><path d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-8Z" /></svg>
                <span className={css.folderName}>{translate(folder.label)}</span>
                <span className={css.count}>{String(inside.length)}</span>
              </button>
              {open[folder.kind] !== false && inside.map(item => (
                <button
                  key={item.name}
                  type="button"
                  className={css.file}
                  data-on={picked?.name === item.name || undefined}
                  title={item.name}
                  onClick={() => { setPickedName(item.name) }}
                  onDoubleClick={() => { onFullscreen(item) }}
                >
                  {item.kind === 'audio'
                    ? <span className={css.note} aria-hidden="true">♪</span>
                    : <Still className={css.fileThumb} lazy src={thumbUrlOf(item.name, THUMB_SMALL, item.mtime)} />}
                  <span className={css.fileName}>{item.name}</span>
                </button>
              ))}
            </div>
          )
        })}
        {sorted.length === 0 && <p className={css.empty}>{translate('imagine.projectNoFiles')}</p>}
      </nav>
      <section className={css.preview}>
        {picked !== undefined && (
          <>
            <div className={css.previewBar}>
              <span className={css.previewName} title={picked.name}>{picked.name}</span>
              {picked.width !== undefined && <span className={css.previewMeta}>{`${String(picked.width)}×${String(picked.height)}`}</span>}
              <span className={css.grow} />
              <button type="button" className={css.action} onClick={() => { onShowOnCanvas(picked) }}>{translate('imagine.showOnCanvas')}</button>
              {picked.kind !== 'audio' && <button type="button" className={css.action} onClick={() => { onFullscreen(picked) }}>{translate('imagine.fullScreen')}</button>}
              <a className={css.action} href={mediaUrlOf(picked.name)} download={picked.name}>{translate('imagine.download')}</a>
            </div>
            <div className={css.previewStage}>
              {picked.kind === 'image' && <Still key={picked.name} className={css.previewMedia} urgent src={`${mediaUrlOf(picked.name)}?v=${String(picked.mtime)}`} />}
              {picked.kind === 'video' && <video key={picked.name} className={css.previewMedia} src={mediaUrlOf(picked.name)} controls playsInline preload="metadata" />}
              {picked.kind === 'audio' && <audio key={picked.name} className={css.previewAudio} src={mediaUrlOf(picked.name)} controls preload="metadata" />}
            </div>
          </>
        )}
      </section>
    </div>
  )
}
