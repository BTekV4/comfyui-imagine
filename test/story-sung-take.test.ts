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
  assert.match(written, /face large, frontal and evenly lit/)
  assert.match(written, /face stays the subject/)
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
    assert.match(beat, /face large, frontal and evenly lit/)
    assert.match(beat, /face stays the subject/)
  }
  // The same montage cut without a face keeps the beats as written.
  const other = await planMontage(host, '/tmp', 'a landscape at dawn', [6, 6, 6], photos, { song: { seconds: 18 } })
  for (const beat of other.beats) assert.doesNotMatch(beat, /face large, frontal and evenly lit/)
})

test('a track with a voice in it is cut, an instrumental one keeps the chain', async () => {
  /*
   * Every shot of a montage on the song graph is handed the isolated vocal and
   * told to sing it, whatever the number of photos, so the chain is decided on
   * the track and not on the pictures. Measured 2026-11-17 on the 45-second
   * spoken track (test instance, 480p, one photo, the same beat and graph): the
   * window 6.583-12.250 s scored 0.00 and 0.27 over two chained takes and 0.451
   * and 0.567, at lag zero, when the same seconds were rendered without a head.
   * An instrumental track has no lips to line up and keeps the chain, which is
   * what makes a shot continue the framing of the one before it.
   */
  const { chainedShots, songStartOf } = await import('../server/vendor/tool-comfy/story-jobs.ts')
  // A montage over a track with a voice: cut. Eight photos sing like one.
  assert.equal(chainedShots({ cuts: true, song: 'voice.m4a' }, true, false, 'voice'), false)
  // A montage over an instrumental track: chained, exactly as before.
  assert.equal(chainedShots({ cuts: true, song: 'music.mp3' }, true, false, 'no-voice'), true)
  // A track whose voice could not be measured: cut, like a voice does.
  assert.equal(chainedShots({ cuts: true, song: 'music.mp3' }, true, false, 'unknown'), false)
  // A montage with no track: never chained, before and after.
  assert.equal(chainedShots({ cuts: true, song: undefined }, true, false, 'no-voice'), false)
  // The guards that were already there.
  assert.equal(chainedShots({ cuts: false, song: 'voice.m4a' }, true, false, 'voice'), false)
  assert.equal(chainedShots({ cuts: true, song: 'music.mp3' }, true, true, 'no-voice'), false)
  assert.equal(chainedShots({ cuts: true, song: 'music.mp3' }, false, false, 'no-voice'), false)
  /*
   * And the offsets follow: a cut shot starts where the shots before it end, on
   * what the sampler really renders (a six-second shot is 158 frames, 6.583 s),
   * instead of a head's worth earlier for every shot.
   */
  const round = (values: readonly number[]): number[] => values.map(value => Math.round(value * 1000) / 1000)
  assert.deepEqual(round([0, 1, 2].map(index => songStartOf([6, 6, 6], index, 45))), [0, 6.583, 13.167])
  assert.deepEqual(round([0, 1, 2].map(index => songStartOf([6, 6, 6], index, 45, 22 / 24))), [0, 5.667, 11.333])
})

test('a track is a voice when enough of its isolated vocal is above the silence floor', async () => {
  /*
   * Measured 2026-11-17 on the 32 isolated vocals on disk: the spoken tracks
   * come out at 0.87-0.89 and the lowest track that carries a voice at 0.40;
   * where nobody sings the separator leaves a residue under -40 dBFS, so an
   * instrumental lands near zero. A track that could not be read is not known to
   * have no voice, and the caller cuts on that.
   */
  const { voicedShare, VOICED_SHARE_MIN } = await import('../server/vendor/tool-comfy/vocal-silence.ts')
  const levels = (voiced: number): number[] => Array.from({ length: 100 }, (_unused, index) => index < voiced ? -20 : -70)
  assert.equal(voicedShare([]), undefined)
  assert.equal(voicedShare(levels(87)), 0.87)
  assert.ok(0.87 >= VOICED_SHARE_MIN)
  assert.equal(voicedShare(levels(4)), 0.04)
  assert.ok(0.04 < VOICED_SHARE_MIN)
  // The gap the threshold sits in: nothing measured lands between 0.10 and 0.40.
  assert.ok(VOICED_SHARE_MIN > 0.1 && VOICED_SHARE_MIN < 0.4)
})

test('a mouth a beat off the voice is rendered again, however high the zero-lag score', async () => {
  /*
   * The chained takes that articulated on 2026-11-17 peaked 20 frames ahead of
   * the voice while scoring 0.00-0.27 at zero lag: the score alone cannot see a
   * uniform lead or lag, and the probe already reports where the aperture
   * peaks. A shot a full beat off is a shot to take again.
   */
  const { worthRetrying } = await import('../server/vendor/tool-comfy/story-jobs.ts')
  assert.equal(worthRetrying({ corr0: 0.52, bestLag: 0.83, bestCorr: 0.9, movCorr0: 0.4, frames: 136, noFace: 0 }, 0.3), true)
  assert.equal(worthRetrying({ corr0: 0.52, bestLag: -0.75, bestCorr: 0.9, movCorr0: 0.4, frames: 136, noFace: 0 }, 0.3), true)
  // A mouth that peaks on the voice is accepted when it scores, as before.
  assert.equal(worthRetrying({ corr0: 0.52, bestLag: 0.04, bestCorr: 0.6, movCorr0: 0.4, frames: 136, noFace: 0 }, 0.3), false)
  // A lag measured over a clip whose face was lost most of the time says
  // nothing about the mouth, and is not a reason to spend the card again.
  assert.equal(worthRetrying({ corr0: 0.52, bestLag: 0.9, bestCorr: 0.9, movCorr0: 0.4, frames: 136, noFace: 40 }, 0.3), false)
})
