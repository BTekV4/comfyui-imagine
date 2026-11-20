#!/usr/bin/env node
/**
 * The package names the documentation prints must carry the version the
 * project is.
 *
 * A release renames every package after `package.json`'s version, but the
 * README's tarball command hard-coded `comfyui-imagine-0.1.0.tar.gz` and kept
 * doing so through 0.3.1: the line the page offers as *the* way to install
 * pointed at a download that no longer exists (404 on
 * `releases/latest/download`). A version is not something a person remembers
 * to update in prose, so this reads the files and refuses a package name whose
 * version is not the project's.
 *
 *   node scripts/check-docs-versions.mjs
 *
 * Exits 0 when every name matches, 1 with one line per offending place. The
 * check is a step of the `check` job (`.github/workflows/ci.yml`) and a test
 * (`test/docs-versions.test.ts`), so a branch sees it before a pull request.
 *
 * What counts is a *package name*: the four artifacts a release attaches
 * (`comfyui-imagine-<v>.tar.gz`, `Imagine-<v>-linux-x64.zip`,
 * `Imagine-<v>-linux-x64.AppImage`, `Imagine-<v>-windows-x64-setup.exe`). A
 * `<version>` placeholder, a `$VERSION` variable and a `v0.x.y` written in
 * history (a comment about what an old release did) are not package names and
 * are left alone.
 * @module scripts/check-docs-versions
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The project root: this script's folder's parent. */
export const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The files a person reads before they install, and the scripts beside them. */
const FILES = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'install.sh',
  'docker-compose.yml',
  'Dockerfile',
]

/**
 * The folders read whole: the documents a person reads, and the scripts and
 * workflows whose own comments name a package a person may copy.
 */
const FOLDERS = ['docs', 'scripts', '.github/workflows']

/** Suffixes a documentation file can have. */
const DOC_SUFFIXES = ['.md', '.sh', '.yml', '.yaml', '.txt', '.json', '.ps1']

/**
 * A package name a release attaches, with the version it carries.
 *
 * The version is every digit and dot between the name and its suffix, so a
 * hard-coded `0.1.0` and a placeholder `<version>` are both seen; the caller
 * decides which names are acceptable.
 */
const PACKAGE_NAME = /\b(comfyui-imagine|Imagine)-([0-9]+\.[0-9]+\.[0-9]+)(\.tar\.gz|-linux-x64\.zip|-linux-x64\.AppImage|-windows-x64-setup\.exe)\b/g

/** The project's version, read from its manifest. */
export function projectVersion(root = ROOT) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (typeof manifest.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+/.test(manifest.version)) {
    throw new Error(`package.json has no usable version: ${String(manifest.version)}`)
  }
  return manifest.version
}

/** Every file the check reads, relative to the root. */
export function filesToCheck(root = ROOT) {
  const files = FILES.filter(file => exists(join(root, file)))
  for (const folder of FOLDERS) {
    const dir = join(root, folder)
    if (!exists(dir)) continue
    for (const path of walk(dir)) {
      if (!DOC_SUFFIXES.some(suffix => path.endsWith(suffix))) continue
      // Forward slashes in a name, whatever the platform: the report a person
      // reads and the list a test asserts are the same on Windows.
      files.push(relative(root, path).split(sep).join('/'))
    }
  }
  return files
}

/** A name with a version that is not the project's. */
export function staleNames(text, version) {
  const stale = []
  for (const match of text.matchAll(PACKAGE_NAME)) {
    const name = `${match[1]}-${match[2]}${match[3]}`
    if (match[2] !== version) stale.push({ name, version: match[2] })
  }
  return stale
}

/**
 * The offending places, one per line of file.
 * @param root - the project root.
 * @returns `{ file, line, name, version }` entries; empty when everything matches.
 */
export function findStale(root = ROOT) {
  const version = projectVersion(root)
  const problems = []
  for (const file of filesToCheck(root)) {
    const text = readFileSync(join(root, file), 'utf8')
    strictEqualText(text, file, version, problems)
  }
  return problems
}

/** One file's lines, read against the project's version. */
function strictEqualText(text, file, version, problems) {
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    for (const stale of staleNames(line, version)) {
      problems.push({ file, line: index + 1, name: stale.name, version: stale.version })
    }
  }
}

/** Whether a path exists. */
function exists(path) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/** Every file under a folder, by name. */
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.isFile()) yield path
  }
}

// Run as a script: print every stale name and fail the job.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let problems
  try {
    problems = findStale()
  } catch (error) {
    console.error(`check-docs-versions: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
  if (problems.length === 0) {
    const version = projectVersion()
    console.log(`check-docs-versions: package names in the docs carry ${version}`)
    process.exit(0)
  }
  const version = projectVersion()
  for (const problem of problems) {
    console.error(`${problem.file}:${String(problem.line)}: ${problem.name} is not version ${version}`)
  }
  console.error(`check-docs-versions: ${String(problems.length)} package name(s) carry a version other than ${version}`)
  process.exit(1)
}
