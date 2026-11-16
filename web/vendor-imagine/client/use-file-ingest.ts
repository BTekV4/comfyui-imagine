/**
 * Files arriving from outside: dropped on the page, picked with the upload
 * button, or sent to the Library. Split out of ImaginePage.tsx (2026-10-25).
 * @module use-file-ingest
 */

import { useState } from 'react'
import type { ImagineProject } from '../../../shared/imagine-projects.ts'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import type { ComposerStore } from './composer-store.ts'
import { uploadGalleryItem } from './gallery-api.ts'
import { modeForKind, noteFromError } from './imagine-messages.ts'
import { translate } from './locale-store.ts'

/** What the ingest reads of the page, current on every render. */
export interface FileIngestContext {
  readonly composer: ComposerStore
  readonly addItems: (items: readonly GalleryItem[]) => void
  readonly openOrCreate: (title: string) => ImagineProject
  readonly patch: (project: ImagineProject) => void
  /** Bring the chat back, in a project, for a file staged into it. */
  readonly revealChat: () => void
}

/**
 * The files a drop carries: the list, or failing that the items that are files.
 * @param transfer - the drop's data.
 * @returns the files.
 */
function filesFromTransfer(transfer: DataTransfer | null): File[] {
  if (transfer === null) return []
  const fromList = Array.from(transfer.files)
  if (fromList.length > 0) return fromList
  return Array.from(transfer.items)
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter((file): file is File => file !== null)
}

export function useFileIngest(ctx: FileIngestContext) {
  const { composer, addItems, openOrCreate, patch, revealChat } = ctx
  const [dropping, setDropping] = useState(false)
  const setNote = (note: string | undefined): void => { composer.set({ note }) }

  const ingestFiles = async (files: FileList | readonly File[]): Promise<void> => {
    const list = Array.from(files)
    if (list.length === 0) return
    setNote(undefined)
    // The mode the files were sent in, whatever the composer does meanwhile.
    const { mode } = composer.get()
    const uploaded: GalleryItem[] = []
    const failures: string[] = []
    // Each file is settled on its own: one rejection used to abandon the whole
    // selection, so the files after it were never sent and the ones already
    // written stayed out of the gallery and the project.
    for (const file of list) {
      try {
        uploaded.push(await uploadGalleryItem(file))
      } catch (error: unknown) {
        // Through the same reading as every other failure: a server that is
        // not answering put the browser's own English under the composer here.
        failures.push(noteFromError(error))
      }
    }
    if (uploaded.length > 0) {
      addItems(uploaded)
      // Every uploaded file is staged, not only the last.
      composer.set({ sources: uploaded })
      const last = uploaded[uploaded.length - 1]
      if (last !== undefined) {
        revealChat()
        /*
         * A dropped file picks between the two plain modes and nothing else:
         * it used to override a mode the user had chosen, and a preset chosen
         * before the file was gone by the time the line was read (2026-10-17).
         */
        /*
         * A photo or a clip with a track, sent in Video, is a video on that
         * track (2026-11-16): the track uploaded last used to turn the
         * composer to Music, and the video the files were for was lost.
         */
        const sungVideo = mode === 'video' && uploaded.some(item => item.kind === 'audio')
          && uploaded.some(item => item.kind === 'image' || item.kind === 'video')
        if (sungVideo) composer.set({ mode: 'video' })
        else if (mode === 'image' || mode === 'video') composer.set({ mode: modeForKind(last.kind) })
      }
      const names = uploaded.map(item => item.name)
      const base = openOrCreate(translate('imagine.uploads'))
      patch({ ...base, itemNames: [...base.itemNames, ...names.filter(name => !base.itemNames.includes(name))] })
    }
    // Ten files dropped into a studio that is offline fail for one reason, and
    // the composer has room to say it once.
    if (failures.length > 0) setNote([...new Set(failures)].join(' '))
  }

  const takeDrop = (event: { preventDefault(): void; stopPropagation(): void; dataTransfer: DataTransfer | null }): void => {
    event.preventDefault()
    event.stopPropagation()
    setDropping(false)
    const files = filesFromTransfer(event.dataTransfer)
    if (files.length > 0) void ingestFiles(files)
  }

  /** Files sent to the Library: into the gallery, on no board. */
  const uploadToLibrary = async (files: readonly File[]): Promise<void> => {
    setNote(undefined)
    for (const file of files) {
      try {
        addItems([await uploadGalleryItem(file)])
      } catch (error: unknown) {
        setNote(noteFromError(error))
      }
    }
  }

  return { dropping, setDropping, ingestFiles, takeDrop, uploadToLibrary }
}
