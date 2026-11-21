/**
 * The spec a run carries, the checks the code makes on it, the attempt budget
 * and the verdict the reply is built from.
 *
 * The fixture is neutral throughout: a line about a picture, a spec about a
 * framing, and a verdict written the way the vision model answers it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_ATTEMPTS, attemptFingerprint, attemptRefusal, asksExplicit, moreOf, moreWord, readEditSpec, specRefusal,
  type RunAttempt,
} from '../server/vendor/tool-comfy/edit-spec.ts'
import { changedCells, parseVerdictJson, verdictNeedsState, verdictOf } from '../server/vendor/tool-comfy/edit-verify.ts'

test('the spec keeps the owner\'s words for what stays, and falls back to the line', () => {
  const spec = readEditSpec({
    change: 'una luce più calda',
    preserve: ['Format', 'inquadratura', 'testo', 'the subjects', 'stile', 'qualcosa'],
    intensity: 'one step',
  }, 'rendi più calda la luce')
  assert.equal(spec.change, 'una luce più calda')
  assert.deepEqual(spec.preserve, ['format', 'framing', 'text', 'subjects', 'style'])
  assert.equal(spec.intensity, 'one step')
  // A model that wrote none still gets one: the line is the change.
  const fallback = readEditSpec(undefined, 'un faro al tramonto')
  assert.equal(fallback.change, 'un faro al tramonto')
  assert.deepEqual(fallback.preserve, [])
})

test('a run whose arguments contradict its own spec is refused before anything is queued', () => {
  const keepsFormat = readEditSpec({ change: 'più luce', preserve: ['format'] }, 'più luce')
  // The spec says the shape stays; the call changes it.
  assert.match(specRefusal(keepsFormat, { asked: 'più luce', prompt: 'più luce', changesShape: true, edit: true }) ?? '', /the spec says the format stays/)
  // The same spec with a call that keeps the shape is fine.
  assert.equal(specRefusal(keepsFormat, { asked: 'più luce', prompt: 'più luce', changesShape: false, edit: true }), undefined)
  // A generate is not an edit: its shape is the line's own choice.
  assert.equal(specRefusal(keepsFormat, { asked: 'più luce', prompt: 'più luce', changesShape: true, edit: false }), undefined)
})

test('a denoise that repaints the picture cannot claim it keeps the framing', () => {
  const keepsFraming = readEditSpec({ change: 'un cielo più blu', preserve: ['framing'] }, 'un cielo più blu')
  assert.match(specRefusal(keepsFraming, { asked: 'un cielo più blu', prompt: 'un cielo più blu', changesShape: false, edit: true, denoise: 0.9 }) ?? '', /repaints the picture/)
  assert.equal(specRefusal(keepsFraming, { asked: 'un cielo più blu', prompt: 'un cielo più blu', changesShape: false, edit: true, denoise: 0.3 }), undefined)
})

test('content is never pushed further than the line asked', () => {
  const mood = readEditSpec({ change: 'più sensuale' }, 'rendila più sensuale')
  // "Sensuale" is a mood: it asks for neither nudity nor an explicit change.
  assert.equal(asksExplicit('rendila più sensuale'), false)
  assert.match(
    specRefusal(mood, { asked: 'rendila più sensuale', prompt: 'una donna nuda sulla spiaggia', changesShape: false, edit: true }) ?? '',
    /the line does not ask for nudity or explicit content/,
  )
  // A line that does ask for it is not refused.
  const asked = readEditSpec({ change: 'nuda sulla spiaggia' }, 'rendila nuda sulla spiaggia')
  assert.equal(specRefusal(asked, { asked: 'rendila nuda sulla spiaggia', prompt: 'una donna nuda sulla spiaggia', changesShape: false, edit: true }), undefined)
})

test('a request has three attempts, and a set of parameters that failed is not sent again', () => {
  const first: RunAttempt = { key: 'remix:photo.png', fingerprint: 'a', state: 'failed' }
  assert.match(
    attemptRefusal([first], 'remix:photo.png', 'a') ?? '',
    /already ran exactly these parameters and they did not give what was asked/,
  )
  assert.equal(attemptRefusal([first], 'remix:photo.png', 'b'), undefined, 'another set of parameters is another attempt')
  const spent: RunAttempt[] = Array.from({ length: MAX_ATTEMPTS }, (_, index) => ({ key: 'generate', fingerprint: String(index), state: 'ran' as const }))
  assert.match(attemptRefusal(spent, 'generate', 'z') ?? '', /has had 3 attempts/)
  // A kept (completed) run is not a failure: the line may ask for it again.
  const kept: RunAttempt = { key: 'generate', fingerprint: 'a', state: 'kept' }
  assert.equal(attemptRefusal([kept], 'generate', 'a'), undefined)
})

test('the fingerprint of a run does not depend on the order of its keys', () => {
  assert.equal(
    attemptFingerprint({ prompt: 'un faro', aspect: '9:16', tweaks: { '53.steps': 12, '53.cfg': 1 } }),
    attemptFingerprint({ tweaks: { '53.cfg': 1, '53.steps': 12 }, aspect: '9:16', prompt: 'un faro' }),
  )
})

test('the verdict is what the look found, with the measures folded in', () => {
  const spec = readEditSpec({ change: 'una luce più calda', preserve: ['text', 'framing'] }, 'più calda')
  const answer = {
    description: 'Una tazza bianca su un tavolo di legno, con una scritta in alto.',
    requested_change_done: true,
    preserved_ok: { text: true, framing: false },
    text_found: ['SALE'],
    unrequested_changes: [],
  }
  const partial = verdictOf(answer, spec, { identical_to_source: false })
  assert.equal(partial.state, 'partial', 'the framing moved although the spec kept it')
  assert.deepEqual(partial.text_found, ['SALE'])
  assert.deepEqual(partial.preserved_ok, { text: true, framing: false })
  const all = verdictOf({ ...answer, preserved_ok: { text: true, framing: true } }, spec, { identical_to_source: false })
  assert.equal(all.state, 'completed')
  // The code's own measure wins over the look's claim.
  assert.equal(verdictOf({ ...answer, preserved_ok: { text: true, framing: true } }, spec, { identical_to_source: true }).state, 'failed')
  assert.equal(verdictOf({ ...answer, preserved_ok: { text: true, framing: true } }, spec, { identical_to_source: false, repeated: 'earlier.webp' }).state, 'failed')
  assert.equal(verdictOf({ ...answer, requested_change_done: false, preserved_ok: { text: true, framing: true } }, spec, { identical_to_source: false }).state, 'failed')
})

test('the JSON of a verdict is read out of an answer that wraps it in a sentence', () => {
  const parsed = parseVerdictJson('Ecco il risultato:\n{"requested_change_done": true, "text_found": []}\nSpero vada bene.')
  assert.equal(parsed?.['requested_change_done'], true)
  assert.equal(parseVerdictJson('nessun oggetto qui'), undefined)
  assert.equal(parseVerdictJson('{non è json}'), undefined)
})

test('a reply that does not carry the state the check found is sent back once', () => {
  const spec = readEditSpec({ change: 'un cielo più blu', preserve: [] }, 'cielo blu')
  const failed = verdictOf({ requested_change_done: false, preserved_ok: {}, text_found: [], unrequested_changes: [] }, spec, { identical_to_source: false })
  assert.equal(verdictNeedsState('Fatto: il cielo è più blu.', failed), true, 'no state word at all')
  assert.equal(verdictNeedsState('Parziale: il cielo è cambiato ma non del tutto.', failed), true, 'a different state is a contradiction')
  assert.equal(verdictNeedsState('Non riuscito: il cielo non è cambiato.', failed), false)
  const partial = verdictOf({ requested_change_done: true, preserved_ok: {}, text_found: [], unrequested_changes: ['sfondo diverso'] }, spec, { identical_to_source: false })
  assert.equal(verdictNeedsState('Parziale: il cielo è cambiato, lo sfondo no.', partial), false)
  assert.equal(verdictNeedsState('Fatto.', undefined), false, 'a turn with no check has no state to carry')
})

test('a failed verdict is what makes the same parameters refuse to run again', async () => {
  const { createAttempts } = await import('../server/vendor/tool-comfy/run-attempts.ts')
  const board = createAttempts()
  board.add({ key: 'generate', fingerprint: 'f', state: 'ran' })
  // While the outcome is unknown, the same parameters are the same run again.
  assert.match(attemptRefusal(board.list(), 'generate', 'f') ?? '', /already ran exactly these parameters/)
  board.mark('generate', 'f', 'failed')
  assert.match(attemptRefusal(board.list(), 'generate', 'f') ?? '', /already ran exactly these parameters/)
  board.keepFile('generate', 'a.webp')
  assert.deepEqual(board.filesOf('generate'), ['a.webp'], 'the files of an attempt are kept for the repeat check')
})

test('a "più X" is one named step on the last accepted picture, never a new idea', () => {
  assert.equal(moreWord('rendila più calda'), 'calda')
  assert.equal(moreWord('più scuro, per favore'), 'scuro')
  assert.equal(moreWord('rendila più strana'), undefined, 'an axis the studio does not move')
  assert.equal(moreWord('rifalla'), undefined)
  const base: RunAttempt = {
    key: 'remix:photo.png',
    fingerprint: 'f',
    state: 'kept',
    prompt: 'una tazza bianca su un tavolo, luce neutra',
    spec: { change: 'una tazza bianca su un tavolo, luce neutra', preserve: ['format', 'framing'] },
  }
  const next = moreOf(base, 'calda')
  assert.ok(!('error' in next))
  if ('error' in next) return
  // The base's own words stay, one small step is added, and it says so.
  assert.match(next.prompt, /^una tazza bianca su un tavolo, luce neutra, una luce più calda/)
  assert.deepEqual(next.spec.preserve, ['format', 'framing'])
  assert.equal(next.spec.intensity, 'one step')
  // No accepted picture, no step: a "più" needs something to be more of.
  assert.match((moreOf(undefined, 'calda') as { error: string }).error, /no accepted result stands for this picture/)
  assert.match((moreOf(base, undefined) as { error: string }).error, /needs an axis the studio can move one step on/)
})

test('the refusal carries the log of what was already tried, with the check\'s reason', () => {
  const log: RunAttempt[] = [
    { key: 'remix:photo.png', fingerprint: 'a', state: 'failed', prompt: 'una luce più calda', why: 'lost: text' },
    { key: 'remix:photo.png', fingerprint: 'b', state: 'kept', prompt: 'una luce dorata' },
  ]
  const refusal = attemptRefusal(log, 'remix:photo.png', 'a') ?? ''
  assert.match(refusal, /Already tried: "una luce più calda" — lost: text/)
})

test('the difference from the source is measured, and a spot reads as a spot', async () => {
  const { execFile } = await import('node:child_process')
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const dir = await mkdtemp(join(tmpdir(), 'imagine-changed-'))
  const plain = join(dir, 'plain.png')
  const spotted = join(dir, 'spotted.png')
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:s=64x64:d=1', '-frames:v', '1', plain])
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:s=64x64:d=1', '-vf', 'drawbox=x=0:y=0:w=8:h=8:color=white:t=fill', '-frames:v', '1', spotted])
  const changed = await changedCells(plain, spotted, dir)
  assert.ok(changed !== undefined)
  if (changed === undefined) return
  // One corner of sixteen: a spot, not a repaint.
  assert.ok(changed.share > 0 && changed.share < 0.1, `share ${String(changed.share)}`)
  // The corner, plus the one cell the downscale bleeds into.
  assert.equal(changed.region?.x, 0)
  assert.equal(changed.region?.y, 0)
  assert.ok((changed.region?.w ?? 1) <= 0.25 && (changed.region?.h ?? 1) <= 0.25, JSON.stringify(changed.region))
  // The same picture twice is no difference at all.
  assert.deepEqual(await changedCells(plain, plain, dir), { share: 0 })
})
