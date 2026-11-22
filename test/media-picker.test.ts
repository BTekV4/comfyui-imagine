/**
 * The media picker's model: which files each tab shows, and what one click
 * does to the composer's staging. No DOM: the panel is drawn by the page, the
 * two lists and the ceiling are decided here.
 *
 * The names are the studio's own: a generated still is `job-<id>.webp`, an
 * upload is whatever the upload route wrote, `upload-<time>-<random>.<ext>`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isUploaded, pickerTabs, toggleStaged } from '../web/vendor-imagine/client/media-picker-model.ts'
import { MAX_STAGED_FILES } from '../shared/imagine-chat.ts'
import type { GalleryItem } from '../shared/imagine-types.ts'

/** A gallery item with only what the picker reads. */
function item(name: string, kind: GalleryItem['kind'], mtime = 1): GalleryItem {
  return { name, kind, size: 1, mtime }
}

const GALLERY: readonly GalleryItem[] = [
  item('upload-seed0001.png', 'image', 9),
  item('job-4.webp', 'image', 8),
  item('upload-track0001.mp3', 'audio', 7),
  item('job-3.mp4', 'video', 6),
  item('job-2.webp', 'image', 5),
  item('job-1.webp', 'audio', 4),
]

test('the tabs split what the studio drew from what came in through the upload route', () => {
  assert.equal(isUploaded('upload-abc123.png'), true)
  assert.equal(isUploaded('job-4.webp'), false)
  const { creations, uploads } = pickerTabs(GALLERY)
  // Newest first, as the gallery arrives: no second sort.
  assert.deepEqual(creations.map(entry => entry.name), ['job-4.webp', 'job-3.mp4', 'job-2.webp'])
  // A creation is a picture or a clip; an upload is any kind, a track included.
  assert.deepEqual(uploads.map(entry => entry.name), ['upload-seed0001.png', 'upload-track0001.mp3'])
})

test('one click stages a file, the next takes it out, and the ceiling is the chat\'s own', () => {
  assert.equal(MAX_STAGED_FILES, 24, 'the ceiling is the one the reader plans within')
  const still = item('job-4.webp', 'image')
  const added = toggleStaged([], still)
  assert.deepEqual(added.list.map(entry => entry.name), ['job-4.webp'])
  assert.equal(added.added, true)
  const removed = toggleStaged(added.list, still)
  assert.deepEqual(removed.list, [])
  assert.equal(removed.added, false)
  // A full staging refuses the click and says so, keeping what it had.
  const full = Array.from({ length: MAX_STAGED_FILES }, (_, index) => item(`job-${String(index)}.webp`, 'image'))
  const refused = toggleStaged(full, item('job-new.webp', 'image'))
  assert.equal(refused.full, true)
  assert.equal(refused.added, false)
  assert.equal(refused.list.length, MAX_STAGED_FILES)
  // Taking one out of a full staging still works.
  assert.equal(toggleStaged(full, full[0] as GalleryItem).list.length, MAX_STAGED_FILES - 1)
})

test('every picker sentence exists in both languages, with the same placeholders', () => {
  const english = readFileSync('web/vendor-imagine/client/locales.ts', 'utf8')
  const pack = JSON.parse(readFileSync('locales/it.json', 'utf8')) as Record<string, string>
  const keys = [...english.matchAll(/"(imagine\.picker[A-Za-z]*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)]
  assert.ok(keys.length >= 8, 'the picker has its own sentences')
  const missing = keys.filter(([, key]) => pack[key ?? ''] === undefined).map(([, key]) => key)
  assert.deepEqual(missing, [], `missing from the Italian pack: ${missing.join(', ')}`)
  const holes = (text: string): string[] => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map(match => match[1] ?? '').sort()
  const wrong = keys.filter(([, key, text]) => holes(text ?? '').join(',') !== holes(pack[key ?? ''] ?? '').join(','))
  assert.deepEqual(wrong.map(([, key]) => key), [], 'a placeholder the other language does not fill')
})
