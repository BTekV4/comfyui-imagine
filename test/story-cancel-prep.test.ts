/**
 * Cancelling a story while its track's voice is being measured.
 *
 * The measurement is a run of its own — it holds the queue's place and the shots
 * exist only after its answer — so stopping it has to stop the whole story: no
 * shot queued when the answer lands late, no story left for the boot sweep, and
 * the job itself in the state every other stopped job takes.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const home = await mkdtemp(join(tmpdir(), 'imagine-cancel-'))
process.env.IMAGINE_HOME = home
after(async () => { await rm(home, { recursive: true, force: true }) })

const { startStory, resumeUnfinishedStories } = await import('../server/vendor/tool-comfy/story-jobs.ts')
const { cancelImagineJob, listImagineJobs } = await import('../server/vendor/tool-comfy/job-queue.ts')
const { absorbJobFiles } = await import('../web/vendor-imagine/client/imagine-projects.ts')

type Host = Parameters<typeof startStory>[0]
type Workflows = Parameters<typeof startStory>[1]
type Request = Parameters<typeof startStory>[3]
type Job = ReturnType<typeof listImagineJobs>[number]
type Voice = 'voice' | 'no-voice' | 'unknown'
type VoiceProbe = (ctx: Host, workflows: Workflows, outputDir: string, song: string) => Promise<Voice>

/*
 * A track of the length a story would really have: without a file the probe
 * reads zero seconds and the last shot's slice is pulled inside it.
 */
await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '45',
  '-c:a', 'aac', join(home, 'voice.m4a')])

const clips = {
  songAudio: { nodeId: '1', field: 'audio' },
  chain: { loadNodeId: '2', saveNodeId: '3' },
}
const workflows = { videoOnSong: clips, extendVideo: {}, video: {} } as unknown as Workflows
/** A host no run may lean on: these tests stop before anything reaches ComfyUI. */
const host = {} as unknown as Host
const request = {
  prompt: 'she speaks to the camera', source: 'photo.png', song: 'voice.m4a', seconds: 11,
  aspectRatio: '9:16 (Portrait Widescreen)',
} as unknown as Request

const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** The shots of one story, as the queue holds them. */
function shotsOf(storyId: string): Job[] {
  return listImagineJobs().filter(job => job.storyId === storyId && job.storyIndex !== undefined)
}

test('a preparation cancelled while the measurement is pending queues no shot', async () => {
  let answer: (voice: Voice) => void = () => undefined
  const slow: VoiceProbe = () => new Promise<Voice>((resolve) => { answer = resolve })
  const prep = await startStory(host, workflows, home, request, slow)
  assert.equal(prep.notice, 'separating-voice')

  assert.equal(await cancelImagineJob(host, prep.id), true)
  assert.equal(listImagineJobs().find(job => job.id === prep.id)?.status, 'cancelled')

  /*
   * The measurement answers anyway — it was stopped on ComfyUI, and one that
   * lands late is a fact about the track, not about this story — and nothing
   * may be queued for it.
   */
  answer('voice')
  await wait(150)
  assert.equal(shotsOf(prep.storyId ?? '').length, 0)
  assert.equal(listImagineJobs().find(job => job.id === prep.id)?.status, 'cancelled')
})

test('a story cancelled in preparation leaves nothing for the boot sweep', async () => {
  const prep = await startStory(host, workflows, home, request, async () => 'voice')
  await cancelImagineJob(host, prep.id)
  // A manifest is written when the shots are queued, and they never were: a
  // cancelled story is not one to carry on with after a restart.
  const manifests = await readdir(join(home, 'comfy', 'stories')).catch(() => [] as string[])
  assert.equal(manifests.includes(`${prep.storyId ?? ''}.json`), false)
  assert.deepEqual(await resumeUnfinishedStories(host, workflows, home), [])
})

test('cancelling after the shots started is what it always was', async () => {
  const prep = await startStory(host, workflows, home, request, async () => 'no-voice')
  const storyId = prep.storyId ?? ''
  const deadline = Date.now() + 4000
  while (shotsOf(storyId).length < 2 && Date.now() < deadline) await wait(10)
  assert.equal(shotsOf(storyId).length, 2)
  // The preparation is over: stopping it now is a no-op on a settled job, which
  // keeps the state it reached (today's rule for any finished job).
  while (listImagineJobs().find(job => job.id === prep.id)?.status !== 'done' && Date.now() < deadline) await wait(10)
  assert.equal(await cancelImagineJob(host, prep.id), false)
  // And the shots are the story's own: none of them is cancelled here.
  assert.equal(shotsOf(storyId).every(shot => shot.status !== 'cancelled'), true)
})

test('the measurement is stopped with the job, not left waiting on the card', async () => {
  let seen: AbortSignal | undefined
  const slow = (
    _ctx: Host, _workflows: Workflows, _outputDir: string, _song: string,
    _onPrompt?: (promptId: string) => void, signal?: AbortSignal,
  ): Promise<Voice> => {
    seen = signal
    return new Promise<Voice>((resolve) => {
      signal?.addEventListener('abort', () => { resolve('unknown') })
    })
  }
  const prep = await startStory(host, workflows, home, request, slow)
  // The preparation runs on the job's own run control: the same one a Cancel
  // aborts for every other job.
  assert.notEqual(seen, undefined)
  assert.equal(seen?.aborted, false)
  await cancelImagineJob(host, prep.id)
  assert.equal(seen?.aborted, true)
  await wait(50)
  assert.equal(shotsOf(prep.storyId ?? '').length, 0)
})

test('the preparation notice is a live row, not a line in the conversation', async () => {
  const project = {
    id: 'p1', title: 'Cancel Demo', createdAt: 1, itemNames: [] as string[], jobIds: ['prep', 'shot'],
    messages: [] as unknown[],
  }
  const jobs = [
    { id: 'prep', action: 'story', status: 'running', notice: 'separating-voice' },
    { id: 'shot', action: 'video', status: 'running', notice: 'montage-repairing' },
  ]
  const told = absorbJobFiles(project as never, jobs as never, () => 'done', key => `notice:${key}`)
  const texts = (told.messages as readonly { text?: string }[]).map(message => message.text ?? '')
  // The preparation says what it is doing in its own row, which carries the
  // Cancel; a copy in the chat is a line with nothing to stop.
  assert.equal(texts.some(text => text.includes('separating-voice')), false)
  // Every other notice is still spoken.
  assert.equal(texts.some(text => text.includes('montage-repairing')), true)
  // And no line is left empty: an empty bubble is drawn as a bare hour.
  assert.equal(texts.every(text => text.trim() !== ''), true)
})

test('a running preparation leaves the chat with no line at all', async () => {
  const project = {
    id: 'p2', title: 'Cancel Demo', createdAt: 1, itemNames: [] as string[], jobIds: ['prep'],
    messages: [] as unknown[],
  }
  const told = absorbJobFiles(project as never, [
    { id: 'prep', action: 'story', status: 'running', notice: 'separating-voice' },
  ] as never, () => 'done', key => `notice:${key}`)
  // Nothing was said, so nothing is drawn: the row is where this run talks.
  assert.deepEqual(told.messages, [])
  // And the same project before the run is untouched, not even a copy.
  assert.equal(told, project)
})
