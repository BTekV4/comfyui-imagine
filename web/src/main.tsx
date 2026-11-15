/**
 * Entry of the Imagine studio: the page rendered as the whole document, with
 * its store.
 */
import { StrictMode, useCallback, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '../tokens.css'
import { loadPacks } from '../vendor-imagine/client/locale-store.ts'

/*
 * The language pack is read BEFORE the page is imported. Some modules
 * translate their constants when they load (the Library tabs, the filters,
 * the workflow labels): imported before the pack, they stayed in English for
 * good, even with Italian chosen (2026-11-07). That is why the page and the
 * store are imported only after `loadPacks`.
 */
async function start(): Promise<void> {
  await loadPacks()
  const [{ ImaginePage }, { createGalleryStore }] = await Promise.all([
    import('../vendor-imagine/client/ImaginePage.tsx'),
    import('../vendor-imagine/client/gallery-store.ts'),
  ])

  const instance = createGalleryStore()
  type State = ReturnType<typeof instance.getSnapshot>
  const actions = instance.actions

  function useStore<R>(selector: (state: State) => R): R {
    const select = useCallback(() => selector(instance.getSnapshot()), [selector])
    return useSyncExternalStore(instance.subscribe, select, select)
  }

  /*
   * The components read their texts from `translate` (locale-store.ts) on every
   * render. The pack is already loaded here, and choosing another language
   * reloads the page, so no translator has to be handed down or watched.
   */
  function Root(): ReactNode {
    return <ImaginePage useStore={useStore} actions={actions} />
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  )
}

void start()
