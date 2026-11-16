/**
 * What Vite replaces at build time. Only the flag the page reads is declared:
 * the service worker is registered in the built page alone (`import.meta.env.PROD`),
 * because a dev server has no `sw.js` to register.
 */
interface ImportMetaEnv {
  readonly PROD: boolean
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
