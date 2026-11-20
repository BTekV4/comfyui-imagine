// Types for `check-docs-versions.mjs`, which the test imports. The script is
// plain JavaScript on purpose (CI runs it with no build step), so the shapes
// live here instead of in a TypeScript build of it.

/** The project's version, read from its manifest. */
export function projectVersion(root?: string): string

/** Every file the check reads, relative to the root. */
export function filesToCheck(root?: string): string[]

/** A name with a version that is not the project's. */
export interface StaleName { name: string; version: string }

export function staleNames(text: string, version: string): StaleName[]

/** The offending places, one per line of file. */
export function findStale(root?: string): { file: string; line: number; name: string; version: string }[]

/** The project root. */
export const ROOT: string
