/**
 * The page's per-action table (action-traits.ts) replaced seven hand-kept
 * lists in use-runner.ts and imagine-messages.ts (2026-11-15). The old lists
 * are copied here as they were, so the derived values are checked to be the
 * same for every action: the refactor changes where the facts live, not what
 * any action does.
 *
 * The plain facts then moved to shared/imagine-action-table.ts, which the host
 * reads too (job-request.ts: the accepted file kinds, the name of an unnamed
 * run, the output kind of a fixed graph). The host's old tables are copied
 * here the same way.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IMAGINE_ACTIONS, type ImagineAction } from '../shared/imagine-types.ts'
import { ACTION_TRAITS, inputKindOf } from '../web/vendor-imagine/client/action-traits.ts'
import { ACTION_TABLE } from '../shared/imagine-action-table.ts'
import { ACTION_RUNS } from '../server/vendor/tool-comfy/job-request.ts'

const OLD_NO_PROMPT = new Set<ImagineAction>(['upscale', 'bg', 'redo', 'resume', 'scanFrame', 'recreate', 'regenerate', 'relight'])
const OLD_EMPTY_LINE: Partial<Record<ImagineAction, string>> = { upscale: 'upscale', bg: 'bg' }
const OLD_CLIP_INPUT = new Set<ImagineAction>(['scanFrame', 'recreate', 'regenerate', 'objectSwap', 'swapPerson'])
const OLD_NEEDS: Partial<Record<ImagineAction, 'image' | 'video'>> = {
  remix: 'image', video: 'image', loop: 'image', bg: 'image', extend: 'video', redo: 'video', resume: 'video',
  scanFrame: 'video', recreate: 'video', regenerate: 'video', objectSwap: 'video', swapPerson: 'video', relight: 'image',
}
const OLD_VIDEO_LADDER = new Set<ImagineAction>([
  'video', 'loop', 'extend', 'story', 'redo', 'resume', 'recreate', 'scanFrame', 'regenerate', 'objectSwap', 'swapPerson',
])
const OLD_FAILED_KEYS: Partial<Record<ImagineAction, string>> = {
  music: 'imagine.failedMusic', loop: 'imagine.failedLoop', video: 'imagine.failedVideo', story: 'imagine.failedVideo',
  redo: 'imagine.failedVideo', resume: 'imagine.failedVideo', extend: 'imagine.failedExtend', generate: 'imagine.failedGenerate',
  remix: 'imagine.failedRemix', upscale: 'imagine.failedUpscale', bg: 'imagine.failedBg', voice: 'imagine.failedVoice',
  objectSwap: 'imagine.failedObjectSwap', swapPerson: 'imagine.failedSwapPerson', relight: 'imagine.failedRelight',
  speak: 'imagine.failedSpeak',
}
const OLD_DONE_KEYS: Partial<Record<ImagineAction, readonly [string, string]>> = {
  video: ['imagine.doneVideoOne', 'imagine.doneVideo'],
  story: ['imagine.doneVideoOne', 'imagine.doneVideo'],
  redo: ['imagine.doneVideoOne', 'imagine.doneVideo'],
  resume: ['imagine.doneVideoOne', 'imagine.doneVideo'],
  loop: ['imagine.doneLoopOne', 'imagine.doneLoop'],
  remix: ['imagine.doneRemixOne', 'imagine.doneRemix'],
  upscale: ['imagine.doneUpscaleOne', 'imagine.doneUpscale'],
  bg: ['imagine.doneBgOne', 'imagine.doneBg'],
  music: ['imagine.doneMusicOne', 'imagine.doneMusic'],
  objectSwap: ['imagine.doneObjectSwapOne', 'imagine.doneObjectSwap'],
  swapPerson: ['imagine.doneSwapPersonOne', 'imagine.doneSwapPerson'],
  relight: ['imagine.doneRelightOne', 'imagine.doneRelight'],
  scanFrame: ['imagine.doneScanFrameOne', 'imagine.doneScanFrame'],
  extend: ['imagine.doneExtendOne', 'imagine.doneVideo'],
  speak: ['imagine.doneSpeakOne', 'imagine.doneSpeak'],
}

for (const action of IMAGINE_ACTIONS) {
  test(`${action}: the derived traits equal the old lists`, () => {
    const traits = ACTION_TRAITS[action]
    // The old gate was `action !== 'custom' && !NO_PROMPT.has(action)`.
    assert.equal(traits.promptOptional === true, action === 'custom' || OLD_NO_PROMPT.has(action), 'prompt gate')
    assert.equal(traits.emptyLine, OLD_EMPTY_LINE[action], 'empty line')
    assert.equal(traits.ownLineOnly === true, action === 'redo' || action === 'resume', 'own line only')
    assert.equal(traits.input === 'clip', OLD_CLIP_INPUT.has(action), 'clip input')
    assert.equal(inputKindOf(action), OLD_NEEDS[action], 'needs')
    assert.equal(traits.ladder === 'video', OLD_VIDEO_LADDER.has(action), 'ladder')
    assert.equal(traits.reference === 'staged', action === 'compose' || action === 'objectSwap' || action === 'swapPerson', 'staged reference')
    assert.equal(traits.reference === 'named', action === 'remix', 'named reference')
    assert.equal(traits.titleFrom === 'input',
      action === 'bg' || action === 'upscale' || action === 'recreate' || action === 'regenerate'
      || action === 'objectSwap' || action === 'swapPerson' || action === 'relight', 'title from input')
    assert.equal(traits.titleFrom === 'lyrics', action === 'music', 'title from lyrics')
    assert.equal(traits.keepsStaging === true, action === 'generate' || action === 'music', 'keeps staging')
    assert.equal(traits.failedKey, OLD_FAILED_KEYS[action], 'failed key')
    assert.deepEqual(traits.doneKeys, OLD_DONE_KEYS[action], 'done keys')
  })
}

// The host's tables as they were in job-request.ts before the shared table.
const OLD_SERVER_KINDS: Partial<Record<ImagineAction, readonly string[]>> = {
  remix: ['image'], video: ['image'], loop: ['image'], bg: ['image'], upscale: ['image', 'video'],
  voice: ['audio', 'video'], recreate: ['video'], scanFrame: ['video'], regenerate: ['video'],
  objectSwap: ['video'], swapPerson: ['video'], relight: ['image'], compose: ['image'],
}
const OLD_UNPROMPTED: Partial<Record<ImagineAction, string>> = { upscale: 'upscale', bg: 'bg', voice: 'voice', swapPerson: 'character swap' }
const OLD_RUN_OUTPUT: Partial<Record<ImagineAction, 'image' | 'video' | 'audio'>> = {
  generate: 'image', video: 'video', loop: 'video', extend: 'video', bg: 'image', voice: 'audio', music: 'audio',
  scanFrame: 'image', recreate: 'video', regenerate: 'video', objectSwap: 'video', swapPerson: 'video',
  relight: 'image', compose: 'image',
}

for (const action of IMAGINE_ACTIONS) {
  test(`${action}: the host's derived values equal its old tables`, () => {
    const row = ACTION_TABLE[action]
    assert.deepEqual(row.accepts, OLD_SERVER_KINDS[action], 'accepted kinds')
    assert.equal(row.untitled, OLD_UNPROMPTED[action], 'unprompted name')
    assert.equal(ACTION_RUNS[action]?.output, OLD_RUN_OUTPUT[action], 'run output')
    // The page's row is the shared row plus its sentences: no fact is restated.
    for (const [key, value] of Object.entries(row)) {
      assert.deepEqual((ACTION_TRAITS[action] as unknown as Record<string, unknown>)[key], value, `page ${key}`)
    }
  })
}
