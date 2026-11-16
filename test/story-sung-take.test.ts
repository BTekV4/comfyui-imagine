import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sungTakeAsMontage, type StoryFiles } from '../server/vendor/tool-comfy/story-jobs.ts'
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
