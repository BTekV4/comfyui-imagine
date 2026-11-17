/**
 * The captions a story gets when the director writes the beats and no
 * captions.
 *
 * Measured on 2026-11-18: two plans out of six came back with the beats and no
 * caption block, and the studio showed the English beat on an Italian page.
 * The fallback is one short reply for the whole plan — never one per beat,
 * never again on a redraw — asked for only when a caption is missing and the
 * page is not English. It runs beside the clips: a reply that fails, or a model
 * that stays silent, leaves the English beat on screen and never holds the
 * story, and no beat is ever touched.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/*
 * A data root of this file's own, before anything that reads it is loaded: the
 * story's record and a file's note are written under it.
 */
const home = await mkdtemp(join(tmpdir(), 'imagine-captions-'))
process.env.IMAGINE_HOME = home
await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '11',
  '-c:a', 'aac', join(home, 'voice.m4a')])

after(async () => {
  // The work a story starts is deferred: wait for the queue to go quiet, then
  // remove the folder it writes in.
  await eventually(() => listImagineJobs().every(job => job.status !== 'queued' && job.status !== 'running'), 8000)
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const { captionFallbackInstruction, writeStoryPlan } = await import('../server/vendor/tool-comfy/story.ts')
const { fileStoryCaptions, startStory } = await import('../server/vendor/tool-comfy/story-jobs.ts')
const { listImagineJobs, putJob } = await import('../server/vendor/tool-comfy/job-queue.ts')
const { readStoryManifest, writeStoryManifest } = await import('../server/vendor/tool-comfy/story-manifest.ts')
const { recallNote, rememberOrigin } = await import('../server/vendor/tool-comfy/imagine-notes.ts')
const { withLanguage } = await import('../server/src/messages.ts')

type Host = Parameters<typeof writeStoryPlan>[0]
type Workflows = Parameters<typeof startStory>[1]
type Request = Parameters<typeof startStory>[3]

/** What the model was asked, so the fake can tell the plan from the fallback. */
interface Asked {
  readonly text: string
}

/** How the fake answers one instruction. */
type Reply = { reply: string } | { fail: true } | { hang: true } | { silent: true }

/**
 * A host whose text model answers by looking at what it was asked.
 * @param answer - what one instruction gets back.
 */
function hostAnswering(answer: (asked: Asked) => Reply): { host: Host; asked: Asked[] } {
  const asked: Asked[] = []
  const host = {
    llm: {
      async *stream(options: { messages: readonly { content: readonly { text?: string }[] }[] }) {
        const text = options.messages.flatMap(entry => entry.content.map(part => part.text ?? '')).join('\n')
        const now: Asked = { text }
        asked.push(now)
        const said = answer(now)
        if ('hang' in said) {
          // Still thinking: the caller must not be waiting for it.
          await new Promise<void>(() => undefined)
          return
        }
        if ('fail' in said) throw new Error('the model is down')
        if ('reply' in said) yield { type: 'text-delta', text: said.reply }
      },
    },
  } as unknown as Host
  return { host, asked }
}

/** The route the fake model answers on: a pass with no route asks nobody. */
const MODEL = { provider: 'fake', model: 'm' }

/** Whether a request is the fallback reply rather than the plan itself. */
function isFallback(asked: Asked): boolean {
  return asked.text.includes('Write the caption of each beat')
}

/** Whether a request is the shot plan. */
function isPlan(asked: Asked): boolean {
  return asked.text.includes('You are the director')
}

/** The beats, as the director writes them. */
const BEATS = `1. The camera pushes in while she dances under a neon sign.
2. She turns towards the lens as the light flickers.
3. The light dies and she is left in the dark.`

/** The one fallback reply: one short caption per beat. */
const CAPTIONS = `1. La ragazza balla sotto un'insegna al neon.
2. Si gira verso l'obiettivo mentre la luce tremola.
3. La luce si spegne e resta al buio.`

/** Wait for a condition the deferred work sets, or give up. */
async function eventually(check: () => boolean, ms = 4000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  }
  return check()
}

/** Let the deferred work that answers at once run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
}

test('the fallback brief asks for the whole plan in one short reply', () => {
  const brief = captionFallbackInstruction(['She dances.', 'She turns.'], 'it')
  assert.match(brief, /in Italiano/)
  assert.match(brief, /1\. She dances\./)
  assert.match(brief, /2\. She turns\./)
  assert.match(brief, /one per line/)
  assert.doesNotMatch(brief, /You are the director/)
})

test('a plan with no captions draws one fallback reply for the whole plan, not one per beat', async () => {
  const { host, asked } = hostAnswering(entry => (isFallback(entry) ? { reply: CAPTIONS } : { reply: BEATS }))
  let landed = 0
  const plan = await writeStoryPlan(host, 'a girl dances', [4, 4, 4], {
    opening: false,
    captionLanguage: 'it',
    model: MODEL,
    onCaptions: () => { landed += 1 },
  })
  // The plan answers with its beats, and the caption is not waited for.
  assert.equal(plan.beats.length, 3)
  assert.match(plan.beats[0] ?? '', /The camera pushes in/)
  assert.ok(await eventually(() => landed === 1))
  assert.deepEqual(plan.captions, [
    "La ragazza balla sotto un'insegna al neon.",
    "Si gira verso l'obiettivo mentre la luce tremola.",
    'La luce si spegne e resta al buio.',
  ])
  assert.equal(plan.captionLanguage, 'it')
  // One plan, one caption reply: the fallback asked for all three beats at once.
  assert.equal(asked.filter(isPlan).length, 1)
  assert.equal(asked.filter(isFallback).length, 1)
  assert.match(asked.find(isFallback)?.text ?? '', /3\. The light dies/)
})

test('a plan missing some captions is filled once, and keeps the ones the director wrote', async () => {
  const partial = `1. The camera pushes in.
2. She turns.
3. The light dies.

Captions:
1. La camera avanza.`
  const { host, asked } = hostAnswering(entry => (isFallback(entry) ? { reply: CAPTIONS } : { reply: partial }))
  let landed = 0
  const plan = await writeStoryPlan(host, 'x', [4, 4, 4], {
    opening: false,
    captionLanguage: 'it',
    model: MODEL,
    onCaptions: () => { landed += 1 },
  })
  assert.deepEqual(plan.captions, ['La camera avanza.', '', ''])
  assert.ok(await eventually(() => landed === 1))
  assert.deepEqual(plan.captions, [
    'La camera avanza.',
    "Si gira verso l'obiettivo mentre la luce tremola.",
    'La luce si spegne e resta al buio.',
  ])
  assert.equal(asked.filter(isFallback).length, 1)
})

test('a page in English asks for no captions at all', async () => {
  const { host, asked } = hostAnswering(() => ({ reply: BEATS }))
  const plan = await writeStoryPlan(host, 'a girl dances', [4, 4], {
    opening: false,
    captionLanguage: 'en-GB',
    model: MODEL,
  })
  await settle()
  assert.equal(plan.captionLanguage, undefined)
  assert.equal(plan.captions, undefined)
  assert.equal(asked.filter(isPlan).length, 1)
  assert.equal(asked.filter(isFallback).length, 0)
})

test('a fallback that fails leaves the English beat and never holds the plan', async () => {
  const { host, asked } = hostAnswering(entry => (isFallback(entry) ? { fail: true } : { reply: BEATS }))
  let landed = 0
  const plan = await Promise.race([
    writeStoryPlan(host, 'a girl dances', [4, 4], {
      opening: false,
      captionLanguage: 'it',
      model: MODEL,
      onCaptions: () => { landed += 1 },
    }),
    new Promise<'timeout'>((resolve) => { setTimeout(() => { resolve('timeout') }, 2000) }),
  ])
  assert.notEqual(plan, 'timeout', 'the plan waited for the caption reply')
  const written = plan as Exclude<typeof plan, 'timeout'>
  assert.equal(written.beats.length, 2)
  // What the studio shows is the English beat, exactly as before.
  assert.deepEqual(written.captions, ['', ''])
  assert.ok(await eventually(() => asked.filter(isFallback).length === 1))
  assert.equal(landed, 0)
})

test('a model that stays silent on the fallback does not hold the plan either', async () => {
  const { host, asked } = hostAnswering(entry => (isFallback(entry) ? { hang: true } : { reply: BEATS }))
  const plan = await Promise.race([
    writeStoryPlan(host, 'a girl dances', [4, 4], { opening: false, captionLanguage: 'it', model: MODEL }),
    new Promise<'timeout'>((resolve) => { setTimeout(() => { resolve('timeout') }, 2000) }),
  ])
  assert.notEqual(plan, 'timeout', 'the plan waited for a silent model')
  assert.deepEqual((plan as Exclude<typeof plan, 'timeout'>).captions, ['', ''])
  assert.ok(await eventually(() => asked.filter(isFallback).length === 1))
})

test('a reply that hands the beats back is not a translation', async () => {
  const { host, asked } = hostAnswering(() => ({ reply: BEATS }))
  let landed = 0
  const plan = await writeStoryPlan(host, 'a girl dances', [4, 4, 4], {
    opening: false,
    captionLanguage: 'it',
    model: MODEL,
    onCaptions: () => { landed += 1 },
  })
  assert.ok(await eventually(() => asked.filter(isFallback).length === 1))
  await settle()
  assert.deepEqual(plan.captions, ['', '', ''])
  assert.equal(landed, 0)
})

test('the captions a fallback filled reach the jobs, the record and the file note', async () => {
  const storyId = 'caption-fill-0001'
  const shotFile = 'videoclip-abcdef-01of02.mp4'
  await writeStoryManifest({
    storyId,
    label: 'abcdef',
    createdAt: Date.now(),
    song: 'voice.m4a',
    sources: ['photo.png'],
    shots: [
      { index: 0, seconds: 6, prompt: 'The camera pushes in.' },
      { index: 1, seconds: 6, prompt: 'She turns.' },
    ],
    finals: [],
  })
  await rememberOrigin(shotFile, { action: 'video', prompt: 'The camera pushes in.' })
  putJob('caption-fill-job-0', {
    id: 'caption-fill-job-0',
    action: 'video',
    prompt: 'The camera pushes in.',
    status: 'done',
    createdAt: Date.now(),
    storyId,
    storyIndex: 0,
    storyCount: 2,
    files: [{ name: shotFile, kind: 'video' }],
  })
  putJob('caption-fill-job-1', {
    id: 'caption-fill-job-1',
    action: 'video',
    prompt: 'She turns.',
    status: 'queued',
    createdAt: Date.now(),
    storyId,
    storyIndex: 1,
    storyCount: 2,
  })
  // A caption the person can already read is never overwritten.
  putJob('caption-fill-job-2', {
    id: 'caption-fill-job-2',
    action: 'video',
    prompt: 'The light dies.',
    status: 'done',
    createdAt: Date.now(),
    storyId,
    storyIndex: 2,
    storyCount: 3,
    caption: 'La luce si spegne.',
    captionLanguage: 'it',
  })
  await fileStoryCaptions(storyId, {
    beats: ['The camera pushes in.', 'She turns.', 'The light dies.'],
    captions: ['La camera avanza.', "Si gira verso l'obiettivo.", ''],
    captionLanguage: 'it',
  })
  const live = listImagineJobs().filter(job => job.storyId === storyId)
  assert.equal(live.find(job => job.id === 'caption-fill-job-0')?.caption, 'La camera avanza.')
  assert.equal(live.find(job => job.id === 'caption-fill-job-1')?.caption, "Si gira verso l'obiettivo.")
  assert.equal(live.find(job => job.id === 'caption-fill-job-2')?.caption, 'La luce si spegne.')
  const manifest = await readStoryManifest(storyId)
  assert.equal(manifest?.shots[0]?.caption, 'La camera avanza.')
  assert.equal(manifest?.shots[1]?.caption, "Si gira verso l'obiettivo.")
  const note = await recallNote(shotFile)
  assert.equal(note?.origin?.caption, 'La camera avanza.')
  assert.equal(note?.origin?.captionLanguage, 'it')
  // The English line the video model was handed is untouched everywhere.
  assert.equal(note?.origin?.prompt, 'The camera pushes in.')
})

test('a story whose fallback never answers still queues and runs its shots', async () => {
  const { host, asked } = hostAnswering((entry) => {
    if (isFallback(entry)) return { hang: true }
    if (isPlan(entry)) return { reply: BEATS }
    return { silent: true }
  })
  const workflows = {
    videoOnSong: { songAudio: { nodeId: '1', field: 'audio' }, chain: { loadNodeId: '2', saveNodeId: '3' } },
    extendVideo: {},
    video: {},
  } as unknown as Workflows
  const request = {
    prompt: 'she speaks to the camera', source: 'photo.png', song: 'voice.m4a', seconds: 11,
    aspectRatio: '9:16 (Portrait Widescreen)', model: MODEL,
  } as unknown as Request
  const first = await withLanguage('it', () => startStory(host, workflows, home, request, async () => 'voice'))
  const storyId = first.storyId ?? ''
  const shots = (): ReturnType<typeof listImagineJobs> =>
    listImagineJobs().filter(job => job.storyId === storyId && job.storyIndex !== undefined)
  assert.ok(await eventually(() => shots().length > 0), 'the shots were never queued, the story waited for a caption')
  assert.equal(asked.filter(isFallback).length, 1)
  assert.equal(shots().every(job => job.caption === undefined), true)
  assert.ok(await eventually(() => shots().every(job => job.status !== 'queued' && job.status !== 'running')))
})
