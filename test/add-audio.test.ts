/**
 * «Add audio» on the host's own route: a track laid over a clip that is
 * already there, the clip deciding the length, and the original files left
 * untouched.
 *
 * Real ffmpeg over a tiny generated clip and tone: no browser, no ComfyUI.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Handler } from '../server/src/host.ts'

const run = promisify(execFile)
const dir = await mkdtemp(join(tmpdir(), 'imagine-add-audio-'))
/*
 * The data root is read when the route module loads, so it is pointed at the
 * test's own folder first: a note written into the real home would outlive
 * the test.
 */
process.env['IMAGINE_HOME'] = join(dir, 'home')
const { createAddAudioRoute } = await import('../server/src/clips.ts')

/** A fake request carrying a JSON body, read the way route-kit reads one. */
function jsonRequest(body: unknown): unknown {
  const payload = Buffer.from(JSON.stringify(body))
  const listeners = new Map<string, ((arg?: unknown) => void)[]>()
  const req = {
    method: 'POST',
    headers: { 'content-length': String(payload.length) },
    on(event: string, listener: (arg?: unknown) => void) {
      listeners.set(event, [...listeners.get(event) ?? [], listener])
      return req
    },
    resume() { /* the body is already here */ },
  }
  setImmediate(() => {
    for (const listener of listeners.get('data') ?? []) listener(payload)
    for (const listener of listeners.get('end') ?? []) listener()
  })
  return req
}

/** A response that keeps what the handler writes, writeHead included. */
function fakeResponse(): { statusCode: number; body: string; writeHead: (status: number, headers: Record<string, string>) => void; end: (body?: string) => void } {
  const response = {
    statusCode: 0,
    body: '',
    writeHead(status: number) { response.statusCode = status },
    end(body?: string) { response.body = body ?? '' },
  }
  return response
}

async function call(handler: Handler, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = jsonRequest(body)
  const response = Object.assign(fakeResponse(), { req: request })
  await handler(request as never, response as never)
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> }
}

/** The duration and streams of a media file, as ffprobe reads them. */
async function probe(file: string): Promise<{ duration: number; audio: boolean; video: boolean }> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type', '-of', 'json', file])
  const parsed = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string }[] }
  return {
    duration: Number(parsed.format?.duration ?? 0),
    audio: (parsed.streams ?? []).some(stream => stream.codec_type === 'audio'),
    video: (parsed.streams ?? []).some(stream => stream.codec_type === 'video'),
  }
}

before(async () => {
  // One second of red, silent: the clip decides the result's length.
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=64x48:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'clip.mp4')])
  // Half a second of tone: shorter than the clip, so it has to be padded.
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-c:a', 'libmp3lame', join(dir, 'song.mp3')])
})

after(async () => { await rm(dir, { recursive: true, force: true }) })

test('a track is laid over the clip, which keeps its length and its picture', async () => {
  const handler = createAddAudioRoute(dir)
  const answer = await call(handler, { name: 'clip.mp4', track: 'song.mp3' })
  assert.equal(answer.status, 200)
  const output = String(answer.body['name'])
  assert.match(output, /^add_audio-clip-[a-z0-9]+\.mp4$/)
  const made = await probe(join(dir, output))
  assert.ok(made.video, 'the result has no picture')
  assert.ok(made.audio, 'the result has no track')
  // The tone is half a second and the clip one: the track is padded, not the
  // picture cut, so the result is still the clip's length.
  assert.ok(made.duration >= 0.9 && made.duration <= 1.2, `the clip changed length: ${String(made.duration)} s`)
  // The origin names the edit and the clip it started from.
  const note = JSON.parse(await readFile(join(dir, 'home', 'comfy', 'notes', `${output}.json`), 'utf8')) as { origin?: { action?: string; source?: string } }
  assert.equal(note.origin?.action, 'addAudio')
  assert.equal(note.origin?.source, 'clip.mp4')
})

test('a file that is not an audio track is refused before ffmpeg runs', async () => {
  const handler = createAddAudioRoute(dir)
  const answer = await call(handler, { name: 'clip.mp4', track: 'clip.mp4' })
  assert.equal(answer.status, 400)
  assert.match(String(answer.body['error']), /traccia audio/)
})

test('the clip and the track are never touched', async () => {
  const before = await readdir(dir)
  const handler = createAddAudioRoute(dir)
  await call(handler, { name: 'clip.mp4', track: 'song.mp3' })
  const after = await readdir(dir)
  const added = after.filter(name => !before.includes(name))
  assert.equal(added.length, 1, `more than the result was written: ${added.join(', ')}`)
  assert.match(added[0] ?? '', /^add_audio-/)
})
