/**
 * The server is type-checked without the browser's `DOM` library, so it
 * cannot reach for `window` or `document` by mistake. Node has its own
 * `Blob`, `FormData` and `fetch`; the one name they use that Node keeps in
 * `node:buffer` instead of the globals is `BlobPart`.
 */
import type { BlobPart as NodeBlobPart } from 'node:buffer'

declare global {
  type BlobPart = NodeBlobPart
}

export {}
