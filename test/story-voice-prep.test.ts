/**
 * A story whose track still has to be measured answers at once.
 *
 * The measurement (whether the track carries a voice) decides the chain, and the
 * chain decides the length of every shot and its second of the track, so the
 * shots cannot exist before it. It is a ComfyUI job of its own, and a request
 * that waited for it sat for as long as the card was busy with nothing on the
 * board: the request answers with a preparation job instead, and the shots are
 * queued the moment the answer is in (measured 2026-11-17).
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
 * The story's record is written under the studio's data root: give this file one
 * of its own, before anything that reads it is loaded, so the suite never writes
 * into the installation it runs next to.
 */
const home = await mkdtemp(join(tmpdir(), 'imagine-voice-'))
process.env.IMAGINE_HOME = home
/*
 * A track of the length a story would really have: without a file the probe
 * reads zero seconds, the story falls back to the length it was asked for, and
 * the last shot's slice is pulled inside it.
 */
await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '45',
  '-c:a', 'aac', join(home, 'voice.m4a')])
after(async () => {
  /*
   * The work these tests start is deferred: a preparation job measures the
   * track and only then writes the story's record and queues its shots, so the
   * last write lands after the test that asked for it has answered. Removing
   * the folder while that write is in flight is a rmdir of a directory that is
   * not empty any more — ENOTEMPTY on Windows, where the test used to flake.
   * Wait for the queue to go quiet first, then remove; the retries cover a
   * write that lands between the two (rm retries ENOTEMPTY, EBUSY and EPERM).
   */
  await eventually(() => listImagineJobs().every(job => job.status !== 'queued' && job.status !== 'running'), 8000)
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const { startStory } = await import('../server/vendor/tool-comfy/story-jobs.ts')
const { listImagineJobs } = await import('../server/vendor/tool-comfy/job-queue.ts')

type Host = Parameters<typeof startStory>[0]
type Workflows = Parameters<typeof startStory>[1]
type Request = Parameters<typeof startStory>[3]
type Job = ReturnType<typeof listImagineJobs>[number]
type Voice = 'voice' | 'no-voice' | 'unknown'
type VoiceProbe = (ctx: Host, workflows: Workflows, outputDir: string, song: string) => Promise<Voice>

const clips = {
  songAudio: { nodeId: '1', field: 'audio' },
  chain: { loadNodeId: '2', saveNodeId: '3' },
}
const workflows = { videoOnSong: clips, extendVideo: {}, video: {} } as unknown as Workflows
/** A host no run may lean on: these tests are over before anything reaches ComfyUI. */
const host = {} as unknown as Host
const request = {
  prompt: 'she speaks to the camera', source: 'photo.png', song: 'voice.m4a', seconds: 11,
  aspectRatio: '9:16 (Portrait Widescreen)',
} as unknown as Request

/** Wait for a condition the deferred work sets, or give up. */
async function eventually(check: () => boolean, ms = 4000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  }
  return check()
}

/** The shots of one story, as the queue holds them. */
function shotsOf(storyId: string): Job[] {
  return listImagineJobs().filter(job => job.storyId === storyId && job.storyIndex !== undefined)
    .sort((a, b) => (a.storyIndex ?? 0) - (b.storyIndex ?? 0))
}

/**
 * Wait until every job of one story has settled.
 *
 * A story writes: the preparation writes the record before its last shot is
 * queued, and each shot writes when its turn comes. A test that ends with one
 * of those still running ends with the data folder still changing, which is
 * what the removal in `after` then trips over.
 */
async function settle(storyId: string, ms = 8000): Promise<boolean> {
  return eventually(() => {
    const jobs = listImagineJobs().filter(job => job.storyId === storyId)
    return jobs.length > 0 && jobs.every(job => job.status !== 'queued' && job.status !== 'running')
  }, ms)
}

const round = (value: number | undefined): number => Math.round((value ?? 0) * 1000) / 1000

test('a story whose track still has to be measured answers at once, with a preparation job', async () => {
  let answer: (voice: Voice) => void = () => undefined
  const slow: VoiceProbe = () => new Promise<Voice>((resolve) => { answer = resolve })
  const started = await Promise.race([
    startStory(host, workflows, home, request, slow),
    new Promise<'timeout'>((resolve) => { setTimeout(() => { resolve('timeout') }, 3000) }),
  ])
  assert.notEqual(started, 'timeout', 'the request waited for the separation')
  const prep = started as Job
  assert.equal(prep.action, 'story')
  assert.equal(prep.status, 'running')
  assert.equal(prep.notice, 'separating-voice')
  assert.equal(prep.prompt, request.prompt)
  // Nothing to render yet: the shots' length and second come from the answer.
  assert.equal(shotsOf(prep.storyId ?? '').length, 0)

  // The answer decides the shots, and it arrives before they exist.
  answer('voice')
  const storyId = prep.storyId ?? ''
  assert.ok(await eventually(() => shotsOf(storyId).length === 2))
  const shots = shotsOf(storyId)
  // A track with a voice: cut, so a shot starts where the one before it ends.
  assert.deepEqual(shots.map(shot => round(shot.songStart)), [0, 6.583])
  assert.equal(shots.every(shot => shot.chain === undefined), true)
  assert.ok(await eventually(() => listImagineJobs().some(job => job.id === prep.id && job.status === 'done')))
  assert.ok(await settle(storyId))
})

test('an instrumental track chains the shots, decided before they exist', async () => {
  const prepare = await startStory(host, workflows, home, request, async () => 'no-voice')
  assert.equal(prepare.notice, 'separating-voice')
  const storyId = prepare.storyId ?? ''
  assert.ok(await eventually(() => shotsOf(storyId).length === 2))
  // The chain gives back the head every shot after the first carries.
  assert.deepEqual(shotsOf(storyId).map(shot => round(shot.songStart)), [0, 5.667])
  assert.equal(shotsOf(storyId).every(shot => shot.chain !== undefined), true)
  assert.ok(await settle(storyId))
})

test('a separation that fails cuts the shots, like a track with a voice', async () => {
  const prepare = await startStory(host, workflows, home, request, async () => { throw new Error('comfy down') })
  const storyId = prepare.storyId ?? ''
  assert.ok(await eventually(() => shotsOf(storyId).length === 2))
  assert.deepEqual(shotsOf(storyId).map(shot => round(shot.songStart)), [0, 6.583])
  assert.equal(shotsOf(storyId).every(shot => shot.chain === undefined), true)
  assert.ok(await settle(storyId))
})

test('a story with no track answers the way it always did, with no preparation job', async () => {
  const first = await startStory(host, workflows, home, { ...request, song: undefined } as unknown as Request)
  // The track is what makes a story wait: without one the first shot is the
  // answer, and no preparation job is queued at all.
  assert.equal(first.notice, undefined)
  assert.equal(first.storyIndex, 0)
  assert.ok(await settle(first.storyId ?? ''))
})
