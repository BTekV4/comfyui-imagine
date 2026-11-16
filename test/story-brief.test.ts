/**
 * The brief the director answers: what the three kinds of film ask for.
 *
 * The rule the studio was missing is that a beat is an ACTION — what happens
 * and what changes — not a pose under a camera move. These tests pin the
 * briefs to the video model's own guides (MiniMax H3 prompt writing: a
 * description anchored on the first frame that develops forward to a result;
 * camera as type + amplitude + speed inside the sentence; each shot leaving the
 * world in a state it was not in; no negations, no abstract words) and to the
 * chaining pack's example scenes (end mid-motion so the next shot can carry
 * on). They also pin the language: the beat is what H3 reads when the prompt
 * pass is skipped, so it is English.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cameraMovements, faceCameraMovements, storyPlanInstruction } from '../server/vendor/tool-comfy/story.ts'

const song = { seconds: 24 }

const chained = storyPlanInstruction('a singer in a club', [6, 6, 6, 6], {
  opening: false, cuts: true, continuous: true, closeOnFace: true, camera: faceCameraMovements(4), shots: ['', '', '', ''], song,
})

const montage = storyPlanInstruction('she crosses the city', [6, 6, 5], {
  opening: false, cuts: true, camera: cameraMovements(3), shots: ['a girl under a streetlamp', '', ''], song,
})

const oneTake = storyPlanInstruction('a cat knocks a cup off the table', [6], { opening: true })

test('a beat is an action with a visible result, not a pose', () => {
  for (const brief of [chained, montage, oneTake]) {
    assert.match(brief, /ACTION with a visible result/)
    assert.match(brief, /the state the shot ends on/)
  }
})

test('the subject and the camera both move, with amplitude and speed', () => {
  assert.match(chained, /The subject moves in every beat/)
  assert.match(chained, /type, an amplitude and a speed/)
  // The movements handed to the director are the model's own vocabulary.
  assert.match(chained, /Push In with small amplitude at slow speed/)
  assert.match(faceCameraMovements(3).join(' '), /Static Shot/)
  assert.match(cameraMovements(4).join(' '), /Arc Shot/)
})

test('the world moves, and the film has an arc and a handover', () => {
  for (const brief of [chained, montage, oneTake]) {
    assert.match(brief, /The world moves too/)
    assert.match(brief, /Build an arc across the whole video/)
  }
  assert.match(chained, /End every beat in motion/)
  assert.match(oneTake, /End every beat in motion/)
})

test('a chained shot starts the action at once instead of holding the frame', () => {
  assert.match(chained, /under a second/)
  assert.match(chained, /Do not spend the first seconds holding the framing/)
  assert.doesNotMatch(chained, /for a couple of seconds/)
})

test('a cut must bring new information', () => {
  assert.match(montage, /cut must bring new information/)
  assert.match(montage, /the shot stays one and the camera moves instead/)
})

test('the face take keeps the face close and puts the movement inside the framing', () => {
  assert.match(chained, /the framing stays close/)
  assert.match(chained, /face large, frontal and evenly lit/)
  assert.match(chained, /All the movement goes inside that framing/)
  // A plain montage or take does not carry the face rule.
  assert.doesNotMatch(montage, /face large, frontal and evenly lit/)
})

test('beats are written in English, in the number the film has', () => {
  assert.match(chained, /Write every beat in English/)
  assert.doesNotMatch(chained, /Write every beat in Italian/)
  assert.match(chained, /exactly 4 lines, one per shot/)
  assert.match(oneTake, /ONE line for the shot/)
  assert.match(oneTake, /first \.\.\., then \.\.\., finally \.\.\./)
})

test('a beat carries a performance, its objects and the seconds it has', () => {
  // From Openjutsu's from-picture describer: body, hands, head and mouth named
  // one by one, the objects touched and what happens to each, one visible
  // change per second, in the present tense.
  for (const brief of [chained, montage, oneTake]) {
    assert.match(brief, /The body, the hands, the head and the mouth each do something/)
    assert.match(brief, /Name the objects the person touches and what happens to each one/)
    assert.match(brief, /Three to five sentences, about fifty to ninety words/)
    assert.match(brief, /in the present tense/i)
  }
  assert.match(chained, /already leaving the pose in the first frames/)
})

test('the opening frame is written the way Krea 2 asks for it', () => {
  assert.match(oneTake, /written as a photograph for Krea 2/)
  assert.match(oneTake, /name the medium first/)
  assert.match(oneTake, /two or three named colours/)
  assert.match(oneTake, /no negations/)
  // A montage with photos has no opening line.
  assert.doesNotMatch(montage, /apertura:/)
})
