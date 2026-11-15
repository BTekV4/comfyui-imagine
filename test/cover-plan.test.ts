/**
 * An action's cover: one decision, for the home page and for the panel.
 *
 * On 2026-11-04 the two surfaces each resolved it their own way: the
 * "Make video" card played the repo clip while the panel showed the image the
 * user had picked, so the same action had two different covers. Now there is
 * one table, and both surfaces mount the same component. The table also keeps
 * the motion: with a personal image cover, the repo clip — where one exists —
 * still plays, with the user's image as its poster (that is what the user
 * wanted back: "some of them used to be videos").
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { coverChoiceOf, coverKeyOf, posterCoverOf, repoCoverOf } from '../web/vendor-imagine/client/cover-plan.ts'

/** An uploaded personal cover: video or image. */
const PERSONAL_VIDEO = { video: { kind: 'video', ext: '.mp4' } } as const
const PERSONAL_IMAGE = { video: { kind: 'image', ext: '.webp' } } as const
/** The repo clip for the four animated cards (`CARD_MOTION` in job-cards.ts). */
const MOTION = '/imagine/video'

test('personal video cover: it plays, with its own frame as the poster', () => {
  assert.deepEqual(coverChoiceOf(PERSONAL_VIDEO, '/imagine/video.webp', MOTION, false), {
    kind: 'video',
    src: '/imagine/video.webp',
    poster: '/imagine/video.webp?poster=1',
  })
})

test('personal image cover where the repo has a clip: the clip, with the image as the poster', () => {
  // The motion is what the user wants back: the card must not become still
  // just because the cover is an image.
  assert.deepEqual(coverChoiceOf(PERSONAL_IMAGE, '/imagine/video.webp', MOTION, false), {
    kind: 'video',
    src: '/imagine/video.webm?repo=1',
    poster: '/imagine/video.webp',
    sources: [
      { src: '/imagine/video.webm?repo=1', type: 'video/webm' },
      { src: '/imagine/video.mp4?repo=1', type: 'video/mp4' },
    ],
  })
})

test('personal image cover where the repo has no clip: the image', () => {
  assert.deepEqual(coverChoiceOf(PERSONAL_IMAGE, '/imagine/generate.webp', undefined, false), {
    kind: 'image',
    src: '/imagine/generate.webp',
  })
})

test('no personal cover: the repo one, clip included when there is one', () => {
  assert.deepEqual(coverChoiceOf({}, '/imagine/video.webp', MOTION, false), {
    kind: 'video',
    src: '/imagine/video.webm?repo=1',
    poster: '/imagine/video.webp',
    sources: [
      { src: '/imagine/video.webm?repo=1', type: 'video/webm' },
      { src: '/imagine/video.mp4?repo=1', type: 'video/mp4' },
    ],
  })
  assert.deepEqual(coverChoiceOf({}, '/imagine/generate.webp', undefined, false), {
    kind: 'image',
    src: '/imagine/generate.webp',
  })
})

test('reduced motion: always an image, never a clip', () => {
  // With a personal video cover its own poster stays, not the repo one.
  assert.deepEqual(coverChoiceOf(PERSONAL_VIDEO, '/imagine/video.webp', MOTION, true), {
    kind: 'image',
    src: '/imagine/video.webp?poster=1',
  })
  assert.deepEqual(coverChoiceOf(PERSONAL_IMAGE, '/imagine/video.webp', MOTION, true), {
    kind: 'image',
    src: '/imagine/video.webp',
  })
  assert.deepEqual(coverChoiceOf({}, '/imagine/video.webp', MOTION, true), {
    kind: 'image',
    src: '/imagine/video.webp',
  })
  assert.deepEqual(coverChoiceOf(PERSONAL_IMAGE, '/imagine/generate.webp', undefined, true), {
    kind: 'image',
    src: '/imagine/generate.webp',
  })
})

test('both surfaces mount the same component and do not resolve the cover themselves', () => {
  const surfaces = ['web/vendor-imagine/client/HomeView.tsx', 'web/vendor-imagine/client/WorkflowPanel.tsx'] as const
  for (const file of surfaces) {
    const source = readFileSync(file, 'utf8')
    const name = file.slice(file.lastIndexOf('/') + 1)
    assert.ok(source.includes("from './cover-media.tsx'"), `${name}: does not mount CoverMedia`)
    assert.ok(!source.includes('repoCoverOf'), `${name}: builds the poster itself`)
    assert.ok(!source.includes('?repo=1'), `${name}: builds a repo address itself`)
    assert.ok(!source.includes('coverInfoOf'), `${name}: reads the cover type itself`)
  }
  const media = readFileSync('web/vendor-imagine/client/cover-media.tsx', 'utf8')
  assert.ok(media.includes('coverChoiceOf'), 'CoverMedia does not use the single decision')
})

test('the list of repo clips lives in one place', () => {
  // `coverChoiceOf` does not discover clips by trying a <video>: it is given
  // them. If someone added an animated card without passing it, this fails.
  const cards = readFileSync('web/vendor-imagine/client/job-cards.ts', 'utf8')
  const motion = cards.slice(cards.indexOf('CARD_MOTION'))
  const block = motion.slice(0, motion.indexOf('\n}'))
  for (const key of ['video', 'loop', 'objectSwap', 'relight', 'recreate']) {
    assert.ok(block.includes(`  ${key}: '/imagine/${key}',`), `CARD_MOTION does not name ${key}`)
  }
  const home = readFileSync('web/vendor-imagine/client/HomeView.tsx', 'utf8')
  assert.ok(home.includes('CARD_MOTION[card.id]'), 'the card grid does not pass the repo clip')
  assert.ok(home.includes('motion={motion}'), 'the card does not pass `motion` to CoverMedia')
  assert.ok(home.includes('CARD_MOTION[panelCard]'), 'the panel does not receive the repo clip')
})

test('key and poster: the addresses the surfaces pass', () => {
  assert.equal(coverKeyOf('/imagine/video.webp'), 'video')
  assert.equal(coverKeyOf('/imagine/generate.webp'), 'generate')
  assert.equal(repoCoverOf('/imagine/video.webp'), '/imagine/video.webp?repo=1')
  assert.equal(posterCoverOf('/imagine/video.webp'), '/imagine/video.webp?poster=1')
})

test('only a personal video cover asks for `?poster=1`', () => {
  // The fallback (no poster → repo image) is done by the server, so the client
  // has a single address and need not know which posters exist.
  const personalImage = coverChoiceOf(PERSONAL_IMAGE, '/imagine/video.webp', MOTION, false)
  assert.ok(!JSON.stringify(personalImage).includes('poster=1'))
  const repoMotion = coverChoiceOf({}, '/imagine/video.webp', MOTION, false)
  assert.ok(!JSON.stringify(repoMotion).includes('poster=1'))
  const repoStill = coverChoiceOf({}, '/imagine/generate.webp', undefined, false)
  assert.ok(!JSON.stringify(repoStill).includes('poster=1'))
})
