import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planMontage, sungTakeAsMontage, type StoryFiles } from '../server/vendor/tool-comfy/story-jobs.ts'
import type { ImagineHost } from '../server/src/host.ts'
import type { LoadedWorkflow } from '../server/vendor/tool-comfy/index.ts'

const singing = { songAudio: { nodeId: '1', field: 'audio' }, chain: { loadNodeId: '2', saveNodeId: '3' } } as unknown as LoadedWorkflow
const take: StoryFiles = {
  intent: 'she speaks', source: 'photo.webp', sourceKind: 'image', photos: [], cuts: false, song: 'voice.m4a',
}

test('one photo over a track becomes a one-photo montage on a singing chain', () => {
  assert.deepEqual(sungTakeAsMontage(take, singing), { ...take, cuts: true, photos: ['photo.webp'], faceTake: true })
})

test('without a track, a clip source or a singing chain the take stays a take', () => {
  assert.equal(sungTakeAsMontage({ ...take, song: undefined }, singing).cuts, false)
  assert.equal(sungTakeAsMontage({ ...take, source: 'clip.mp4', sourceKind: 'video' }, singing).cuts, false)
  assert.equal(sungTakeAsMontage(take, { songAudio: singing.songAudio } as unknown as LoadedWorkflow).cuts, false)
  assert.equal(sungTakeAsMontage(take, {} as unknown as LoadedWorkflow).cuts, false)
})

test("a take on one face never asks for a wide movement", async () => {
  const { faceCameraMovements } = await import("../server/vendor/tool-comfy/story.ts")
  const moves = faceCameraMovements(8)
  assert.equal(moves.length, 8)
  assert.notEqual(moves[0], moves[1])
  for (const move of moves) assert.doesNotMatch(move, /wide|full figure|background|orbit|truck/)
})

test('the close-on-face rule goes on a beat, after whatever the beat already says', async () => {
  const { closeOnFaceBeat } = await import('../server/vendor/tool-comfy/story.ts')
  const beat = 'the dragon behind her lowers its head past her shoulder'
  const written = closeOnFaceBeat(beat)
  assert.ok(written.startsWith(beat))
  assert.match(written, /keep the face LARGE and FRONTAL/)
  assert.match(written, /never the camera moving off her/)
  // An empty beat is the rule and nothing before it.
  assert.equal(closeOnFaceBeat('   '), written.slice(beat.length + 1))
})

test('a plan that never answered still renders every shot with the face in frame', async () => {
  /*
   * No text and no vision on the host: `writeStoryPlan` falls back to the
   * user's own sentence for every beat, which is the state the 2026-11-16 run
   * of one photo over a 45-second track was left in. Before the rule was put
   * on the beats, that sentence was all the video model got, and from the
   * fourth shot on it followed the scene out of frame.
   */
  const host = {} as unknown as ImagineHost
  const photos = ['photo.png', 'closeup-photo.png']
  const spoken = await planMontage(host, '/tmp', 'a woman speaks, a dragon behind her', [6, 6, 6], photos, {
    closeOnFace: true, continuous: true, song: { seconds: 18 },
  })
  assert.equal(spoken.beats.length, 3)
  for (const beat of spoken.beats) {
    assert.match(beat, /keep the face LARGE and FRONTAL/)
    assert.match(beat, /never the camera moving off her/)
  }
  // The same montage cut without a face keeps the beats as written.
  const other = await planMontage(host, '/tmp', 'a landscape at dawn', [6, 6, 6], photos, { song: { seconds: 18 } })
  for (const beat of other.beats) assert.doesNotMatch(beat, /keep the face LARGE and FRONTAL/)
})
