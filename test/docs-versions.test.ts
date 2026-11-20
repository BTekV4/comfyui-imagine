/**
 * The package names the docs print are the package names a release attaches.
 *
 * A release renames every artifact after `package.json`'s version. The README's
 * tarball command kept `comfyui-imagine-0.1.0.tar.gz` through 0.3.1, so the line
 * offered as *the* way to install pointed at a 404 on
 * `releases/latest/download`. A person does not remember to update a number in
 * prose; the check reads the files instead.
 *
 * `scripts/check-docs-versions.mjs` is the same rule the `check` job runs, kept
 * in one place so the test and CI cannot disagree.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filesToCheck, findStale, projectVersion, staleNames, type StaleName } from '../scripts/check-docs-versions.mjs'

test('every package name in the docs carries the project version', () => {
  const problems = findStale()
  assert.deepEqual(
    problems,
    [],
    problems.map((problem) => `${problem.file}:${String(problem.line)} has ${problem.name}`).join('\n'),
  )
})

test('the check reads the files a person installs from', () => {
  const files = filesToCheck()
  for (const expected of ['README.md', 'CONTRIBUTING.md', 'install.sh', 'docs/configuration.md', 'scripts/check-appimage.sh', '.github/workflows/ci.yml']) {
    assert.ok(files.includes(expected), `${expected} is not read by the check`)
  }
})

test('a stale tarball name is caught, and a placeholder is not', () => {
  const version = projectVersion()
  assert.deepEqual(staleNames('comfyui-imagine-0.1.0.tar.gz', version).map((entry: StaleName) => entry.name), ['comfyui-imagine-0.1.0.tar.gz'])
  assert.deepEqual(staleNames('Imagine-0.2.0-windows-x64-setup.exe', version).map((entry: StaleName) => entry.name), version === '0.2.0' ? [] : ['Imagine-0.2.0-windows-x64-setup.exe'])
  assert.deepEqual(staleNames('comfyui-imagine-<version>.tar.gz', version), [])
  assert.deepEqual(staleNames('comfyui-imagine-$VERSION.tar.gz', version), [])
  assert.deepEqual(staleNames(`comfyui-imagine-${version}.tar.gz`, version), [])
  // A v0.x.y in prose is history, not a package name.
  assert.deepEqual(staleNames('v0.3.1 published a tag whose publish job died', version), [])
})

test('a stale name in a copy of the docs fails the check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imagine-docs-'))
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ version: '9.9.9' })}\n`)
  writeFileSync(join(dir, 'README.md'), readFileSync('README.md', 'utf8'))
  mkdirSync(join(dir, 'docs'))
  cpSync('docs', join(dir, 'docs'), { recursive: true })
  assert.deepEqual(findStale(dir), [])
  writeFileSync(join(dir, 'README.md'), `${readFileSync(join(dir, 'README.md'), 'utf8')}\ncurl -LO https://x/comfyui-imagine-0.4.0.tar.gz\n`)
  const problems = findStale(dir)
  assert.equal(problems.length, 1)
  assert.equal(problems[0]?.name, 'comfyui-imagine-0.4.0.tar.gz')
})
