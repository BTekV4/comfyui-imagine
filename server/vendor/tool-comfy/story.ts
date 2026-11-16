/**
 * The long video: a shot plan the chain follows, and the song laid over it.
 *
 * `extend` continues one clip by one clip, and each continuation is merged
 * into the clip it follows, so a chain of them already produces a single
 * growing video. What was missing is the director: something that turns one
 * line — "a music video of a girl dancing in a club" — into the
 * handful of beats the chain needs, each written as a CONTINUATION of the
 * last rather than as a scene of its own, because the sampler cannot cut.
 * @module tool-comfy/story
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ImagineHost } from '../../src/host.ts'
import type { ModelRoute } from '../../../shared/imagine-types.ts'
// The chain's two bounds live in `shared/imagine-media.ts`, with the reasons
// they have those values: the studio page clamps a requested length with the
// same numbers.
import { MAX_STORY_SECONDS, MIN_SHOT_SECONDS } from '../../../shared/imagine-media.ts'
import { AAC_192K, FASTSTART, ffmpegTo } from './media-tools.ts'
import { firstTextReply } from './text-pass.ts'

/**
 * The camera movements a montage is built from, in the order they rotate.
 *
 * Written here rather than left to the director because asking it to vary is
 * not enough: each beat is written on its own and the model converges on the
 * same verb. Measured on an eighteen-shot music video (2026-09-23) nearly
 * every line opened "la camera ruota", "la camera arretra" or "la camera
 * scende" — a flat clip however good the pictures are. The movement is
 * assigned per shot and the beat is written around it.
 *
 * Written in the vocabulary the video model was trained on, with the amplitude
 * and the speed where they say something (MiniMax H3 prompt guide, "Camera
 * Motion: Motion Type + Amplitude + Speed": a movement is a natural sentence
 * with a type, an amplitude and a speed, never a stack of labels). The
 * rotation is long enough that two cuts in a row never move the same way, and
 * every movement is one a ten-second shot can perform.
 */
const CAMERA_MOVEMENTS: readonly string[] = [
  'Push In with small amplitude at slow speed',
  'Static Shot: the camera stays fixed and only the subject moves',
  'Truck Right with small amplitude',
  'Arc Shot, orbiting the subject at slow speed',
  'Tilt Up from the hands to the face',
  'Pull Out that widens onto the background',
  'Pan Right with small amplitude',
  'Tracking Shot that follows the movement',
  'Pedestal Up, the camera rising with the body',
  'Pan Left with small amplitude',
]

/**
 * The movements of a take where one face sings or speaks to the track.
 *
 * The montage rotation widens on purpose — a pull out, an arc, a truck — and
 * with one photo the face goes with it: measured 2026-11-16 on an 18-second
 * spoken track over one photo, the director's "she steps back" and "full
 * figure" left the face a few dozen pixels high in shots two and three, the
 * mouth probe lost it in 48 and 86 frames of 144, and those shots scored
 * -0.14 and 0.02 while the close shots scored 0.25 and 0.56. These keep the
 * face large and frontal and still give each shot a movement of its own; the
 * life of the shot comes from the performance inside that framing.
 */
const FACE_CAMERA_MOVEMENTS: readonly string[] = [
  'Push In with small amplitude at slow speed',
  'Static Shot, the face and shoulders carrying the movement',
  'Truck Right with small amplitude, the face held centred and frontal',
  'Static Shot with a slight low angle and the lens breathing',
  'Pull Out with small amplitude, from a close-up to a medium close-up',
  'Pan Left with very small amplitude, the face kept in the same place on screen',
]

/**
 * One camera movement per shot for a take on one face, in a fixed rotation.
 * @param count - how many shots the take has.
 * @returns one movement per shot, in shot order.
 */
export function faceCameraMovements(count: number): readonly string[] {
  const total = FACE_CAMERA_MOVEMENTS.length
  return Array.from(
    { length: Math.max(0, count) },
    (_unused, index) => FACE_CAMERA_MOVEMENTS[index % total] ?? 'Static Shot, the face large and frontal',
  )
}

/**
 * One camera movement per shot, in a fixed rotation.
 *
 * Adjacent shots never share a movement, so no two cuts in a row move the same
 * way, and the rotation is long enough that a video of a few dozen shots does
 * not read as a loop. The caller may override any entry it has an opinion
 * about; the rotation is the default, not a ceiling.
 * @param count - how many shots the montage has.
 * @returns one movement per shot, in shot order.
 */
export function cameraMovements(count: number): readonly string[] {
  const total = CAMERA_MOVEMENTS.length
  return Array.from(
    { length: Math.max(0, count) },
    (_unused, index) => CAMERA_MOVEMENTS[index % total] ?? 'campo fisso',
  )
}

/**
 * How long a story lasts.
 *
 * A video with a song on it lasts as long as the song: the track is what the
 * viewer follows, and a video that stops halfway through it reads as a clip
 * that failed rather than as a choice. An explicit length can cut the song
 * short but never outlast it — MiniMax Music renders shorter tracks than it
 * is asked for (80 s for 170), and a montage planned on the asked length put
 * eleven shots past the end of the file, each failing on its audio slice.
 * @param asked - the length the request named, if any.
 * @param songSeconds - the track's real length, when there is a track.
 * @param fallback - the length with neither: the photos' worth, or the default.
 * @returns whole seconds within the story's bounds.
 */
export function storyLength(asked: number | undefined, songSeconds: number | undefined, fallback: number): number {
  const wanted = songSeconds === undefined ? asked ?? fallback : Math.min(asked ?? Number.POSITIVE_INFINITY, songSeconds)
  return Math.min(MAX_STORY_SECONDS, Math.max(MIN_SHOT_SECONDS, Math.round(wanted)))
}

/** The seconds of each shot in a story, in order. */
export function storyShots(totalSeconds: number, clipSeconds: number): number[] {
  const total = Math.max(MIN_SHOT_SECONDS, Math.round(totalSeconds))
  const clip = Math.max(MIN_SHOT_SECONDS, Math.round(clipSeconds))
  /*
   * Never more clips than the floor allows: a total of ten seconds asked for
   * in threes is three shots and a two-second stub, and that stub costs a
   * whole run — the same guide, the same seam — for two seconds of video.
   */
  const count = Math.max(1, Math.min(Math.ceil(total / clip), Math.floor(total / MIN_SHOT_SECONDS)))
  const base = Math.floor(total / count)
  const extra = total - base * count
  // The remainder is spread one second at a time over the leading shots, so
  // every shot stays within a second of every other and none is a stub.
  return Array.from({ length: count }, (_unused, index) => base + (index < extra ? 1 : 0))
}

/** A story's beats, and the opening frame to generate when there is no source. */
export interface StoryPlan {
  /** One line of intent per shot, in the order they are generated. */
  readonly beats: readonly string[]
  /** A text-to-image prompt for the first frame, when the story starts from none. */
  readonly opening?: string
  /**
   * The photos of a montage in the order they are cut, once they were looked
   * at. Absent on a single take, and on a montage cut in the order given.
   */
  readonly sources?: readonly string[]
}

/**
 * The words the clips themselves sing, when there is no track to lay over.
 *
 * The video model generates its own audio (`VAEDecodeAudio` feeds `CreateVideo`
 * in the H3 graph), and its prompt format carries sung lines verbatim. So a
 * music video does not need a separate track: the song can be the clips'. What
 * it costs is continuity — each clip invents its own backing — and what it buys
 * is a character who actually sings the user's words.
 */
export interface StorySung {
  /** The lyrics, in the language they were written. */
  readonly lyrics: string
}

/** What the planner is told about the song the video is cut to. */
export interface StorySong {
  /** The track's length in seconds. */
  readonly seconds: number
  /** Its lyrics, when the job that generated it is still known. */
  readonly lyrics?: string
}

/** What the planner is told beside the shots. */
export interface StoryPlanOptions {
  song?: StorySong
  sung?: StorySung
  /** A montage: one photo per shot, cut together. */
  cuts?: boolean
  /** One line about each shot's photo, for a montage whose photos were looked at. */
  shots?: readonly string[]
  /**
   * One camera movement per shot, in shot order. A montage whose movements
   * were assigned: the beat is written around the movement it is given, so
   * no two cuts in a row move the camera the same way.
   */
  camera?: readonly string[]
  /**
   * The shots continue each other through the model's latent rather than
   * being cut together: the director must not ask for a new framing at the
   * instant a shot begins, or the model cuts to it on its own.
   */
  continuous?: boolean
  /**
   * One face sings or speaks the track for the whole video: the framing stays
   * close enough for the mouth to be rendered on the voice, and read.
   */
  closeOnFace?: boolean
  /** Whether the story starts from no photo and needs an opening frame. */
  opening: boolean
}

/**
 * The instruction that turns one line into a shot plan.
 *
 * The one rule everything else hangs off: this is a single unbroken take. Each
 * beat is handed to the continuation pass as "what the user asked for", and
 * that pass opens by holding the previous framing — so a beat that describes a
 * new place or a new set of people asks the sampler for a cut it cannot make,
 * and what comes back is the drift the airlock exists to prevent.
 * @param intent - the user's line, in whatever language they wrote it.
 * @param shots - the seconds of each shot, in order.
 * @param opts - the song being cut to, and whether an opening frame is needed.
 * @returns the prompt sent to the planning model.
 */
export function storyPlanInstruction(
  intent: string,
  shots: readonly number[],
  opts: StoryPlanOptions = { opening: false },
): string {
  const total = shots.reduce((sum, seconds) => sum + seconds, 0)
  const seen = opts.shots !== undefined && opts.shots.some(note => note.trim().length > 0)
  const list = shots.map((seconds, index) => {
    const note = opts.shots?.[index]?.trim() ?? ''
    const camera = opts.camera?.[index]?.trim() ?? ''
    return `${String(index + 1)}. ${String(seconds)} seconds`
      + (note.length === 0 ? '' : ` — the photo shows: ${note}`)
      + (camera.length === 0 ? '' : ` — camera movement to use: ${camera}`)
  }).join('\n')
  const song = opts.song === undefined
    ? ''
    : `\nThe video plays over a ${opts.song.seconds.toFixed(0)}-second song: think of the beats as the parts of a music video (intro, verse, chorus, ending) and let them build in intensity with the track.${opts.song.lyrics === undefined ? '' : `\nSong lyrics:\n"""\n${opts.song.lyrics}\n"""`}\n`
  /*
   * No track over the video: the clips sing it. The lines are split across
   * the beats here, because the beat is all the continuation pass is given,
   * and that pass copies sung words verbatim rather than inventing them.
   */
  const sung = opts.sung === undefined
    ? ''
    : `\nThere is NO track to lay over the video: the video model generates the music and the singing itself, clip by clip. Spread the text below across the beats, IN ORDER and WITHOUT changing the words: in every beat write who sings and then sings: "<the exact words of that beat>". Give each beat the words that fit in its seconds (a short line every 4-5 seconds) and do not repeat words already sung.\nText to sing:\n"""\n${opts.sung.lyrics}\n"""\n`
  const asked = { intent, song, sung, list }
  if (opts.cuts === true) {
    /*
     * A montage is the opposite film: every shot is generated from its own
     * photo, so the continuity rules of a single take would be a lie — the
     * planner must be told that a cut is not a mistake here.
     */
    /*
     * Chained shots are the film in between: one photo each, like a montage,
     * but the model carries the last second of one shot into the next, so a
     * beat that opens on a new framing is a contradiction it resolves with a
     * cut of its own (measured: a hard cut at frame 661 of a chained video
     * whose beat opened "dall'alto" on a photo lying down). The airlock rule
     * from the chaining pack: hold the previous framing for a moment, with
     * something small happening, and only then move towards the photo.
     */
    if (opts.continuous === true) {
      return planPrompt({
        ...asked,
        header: `You are the director of a ${String(total)}-second video in ${String(shots.length)} shots that CONTINUE each other with no cut: every shot starts from the last moment of the one before it and carries the action forward, from the pose its own photo shows.`,
        lead: '',
        each: 'each shot',
        rules: [
          '- Every beat is an ACTION with a visible result, told in order: what the subject does, what changes because of it, and the state the shot ends on. A pose, a glance or a camera movement is not a beat on its own.',
          '- No cut and no new framing: the opening the previous shot hands over is under a second. Start the new action at once and end it mid-motion, in a state the next beat can continue. Do not spend the first seconds holding the framing.',
          '- The first beat starts from its photo and holds nothing: the body is already leaving the pose in the first frames.',
          seen
            ? '- The photo of every shot is described beside it: it is the ARRIVAL point of the beat, not the starting one. Do not describe the subject or the clothes: the photo already shows them. Write the MOVEMENT that carries the body and the camera from the previous framing to that pose, and what the person DOES there.'
            : RULE_UNSEEN_PHOTO,
          RULE_PERFORMANCE,
          RULE_SUBJECT_AND_CAMERA,
          RULE_SCENE_MOVES,
          RULE_OBJECTS,
          RULE_DENSITY,
          RULE_ARC,
          RULE_HANDOVER,
          ...opts.closeOnFace === true ? [RULE_CLOSE_ON_FACE] : [ruleSinging(false)],
          ruleOnlyWhatIs('"no glasses", "no shadows"'),
          RULE_NO_ABSTRACT,
        ],
        opening: '',
        unit: 'shot',
        count: shots.length,
      })
    }
    return planPrompt({
      ...asked,
      header: `You are the director of a ${String(total)}-second video cut in HARD CUTS: ${String(shots.length)} different shots, one per photo, following one another as cuts.`,
      lead: 'Every shot is filmed on its own, starting from a photo of its own, and then they are edited one after the other. ',
      each: 'each shot',
      rules: [
        '- Every beat is a shot OF ITS OWN: the cut between one and the next is intended. Do not write transitions ("then she turns towards", "she continues to"), do not pick up the previous action.',
        '- Every beat is an ACTION with a visible result, told in order: it opens on the pose its photo shows, the subject does something, the world around changes, and the state the shot ends on is never the state it started in. A pose or a camera movement alone is not a beat.',
        '- The first word does not undo the pose of another photo ("keeps her arms open", "lowers her fist", "unclenches her hands", "gets out of bed") and the last one does not set up the next: the shot opens and closes inside itself.',
        '- Name only what is in the description of ITS own photo. An object that belongs to another shot — a sphere, a bed, a table — does not exist here, and naming it makes the video model animate something that is not in the photo.',
        seen
          ? '- Every shot starts from the photo described beside it: write a movement consistent with that pose, that place and that light. Do not change the place or the clothes, do not describe the subject: the photo already shows it. Write only the MOVEMENT and what the person does in the seconds it has.'
          : RULE_UNSEEN_PHOTO,
        RULE_PERFORMANCE,
        RULE_SUBJECT_AND_CAMERA,
        RULE_SCENE_MOVES,
        RULE_OBJECTS,
        RULE_DENSITY,
        RULE_ARC,
        '- A cut must bring new information — a new place, state, viewpoint or time. If only the distance or the angle would change, the shot stays one and the camera moves instead.',
        ruleOnlyWhatIs('"no glasses", "no shadows", "no on-screen text"'),
        ruleSinging(true),
        RULE_NO_ABSTRACT,
      ],
      opening: '',
      unit: 'shot',
      count: shots.length,
    })
  }
  return planPrompt({
    ...asked,
    header: `You are the director of a ${String(total)}-second video shot in ONE SINGLE CONTINUOUS TAKE, with no cut at all.`,
    lead: 'The video is generated one piece at a time: every piece starts again from the last frame of the previous one and carries on its movement. ',
    each: 'beat',
    rules: [
      '- One single continuous take: same scene, same people, same clothes, same light from the first moment to the last. No new place, no new character, no new framing.',
      '- Every beat CONTINUES the previous one: it is the moment after, and it is an ACTION with a visible result — what the subject does, what changes because of it, and the state the shot ends on — not a description of what is already on screen.',
      RULE_PERFORMANCE,
      RULE_SUBJECT_AND_CAMERA,
      RULE_SCENE_MOVES,
      RULE_OBJECTS,
      RULE_DENSITY,
      RULE_ARC,
      RULE_HANDOVER,
      '- The camera never cuts: every change happens inside the frame, through movement, light and the action itself.',
      RULE_NO_ABSTRACT,
    ],
    opening: opts.opening ? OPENING_IMAGE_LINE : '',
    unit: 'beat',
    count: shots.length,
  })
}

/** A take on one face that sings or speaks: the mouth has to stay in sight. */
const RULE_CLOSE_ON_FACE = '- One face sings or speaks the track, so the framing stays close: the face large, frontal and evenly lit in every frame, the mouth uncovered and readable, the eyes visible. All the movement goes inside that framing — the mouth and jaw on the words, the eyebrows, the hands, the shoulders, the hair and the cloth moving, the camera moving tight, the light and the space behind her changing. The face stays the subject of every frame.'

/**
 * The close-on-face rule, put on a beat where the video model reads it.
 *
 * The rule was only in the director's brief, and a brief is advice: the beats
 * are written by that model, and the run of 2026-11-16 showed both halves of
 * the hole. The director answered nothing for a 45-second take (the studio's
 * log: "the video clip shot plan: none of the 1 routes wrote usable text"), so
 * every beat fell back to the user's own sentence — which described the dragon
 * moving behind her and said nothing about the framing. The video model
 * followed that sentence: the face was in the shot for the first three shots
 * and out of frame for 31-87 frames of 136 from the fourth on, and the lipsync
 * probe read 0.07 down to -0.14 on them. A mouth that is not in the picture
 * cannot follow the voice, whatever the guide audio says.
 * @param beat - the beat the director wrote, or the user's sentence when it did not.
 * @returns the same beat with the rule appended.
 */
export function closeOnFaceBeat(beat: string): string {
  const said = beat.trim()
  return said.length === 0 ? RULE_CLOSE_ON_FACE : `${said} ${RULE_CLOSE_ON_FACE}`
}

/** The rule every film shares: the subject AND the camera move, with amplitude and speed. */
const RULE_SUBJECT_AND_CAMERA = '- The subject moves in every beat — a gesture, a step, the hands, the posture, the breath — and so does the camera: one movement, written as a natural sentence with a type, an amplitude and a speed where they say something ("the camera pushes in with small amplitude at slow speed", "the camera holds a static shot"). Use the movement written beside the shot, and never repeat the previous beat\'s movement.'

/**
 * The rule that gives a beat a performance, not a pose.
 *
 * Taken from Openjutsu's from-picture describer, which found that a video model
 * redoing a performance needs the body, the hands, the head and the mouth named
 * one by one, and the moment an expression changes: a beat that says "she looks
 * at the camera" renders a photograph, while one that says what her hands do,
 * where her gaze goes and when the smile drops renders a performance.
 */
const RULE_PERFORMANCE = '- The body, the hands, the head and the mouth each do something in the beat — a step, a turn, a touch, a syllable — and the expression and the gaze change at least once, with the moment they change.'

/**
 * The rule that makes an action leave a trace.
 *
 * Same source: the describer names every object the person holds or touches
 * with its colour and material and what happens to it ("candles going out, a
 * lid opening"), because the model animates what is named and leaves the rest
 * as it found it.
 */
const RULE_OBJECTS = '- Name the objects the person touches and what happens to each one: a cup tips and the coffee spreads, a curtain falls, a candle goes out, a door swings shut.'

/**
 * The rule that sizes the beat to the seconds it has.
 *
 * Openjutsu asks its describer for 80-180 words over a five-second clip and
 * rewrites it to 60-160, one visible change after another; our beats were 40-60
 * words of framing. The video model reads a timeline, and a thin beat comes
 * back as a thin shot.
 */
const RULE_DENSITY = '- Three to five sentences, about fifty to ninety words, in the present tense: one visible change for every second of the shot, in the order it happens.'

/**
 * The rule that stops a shot reading as a photograph.
 *
 * A portrait on a still set is what the model renders when nothing in the
 * frame moves but the mouth: the H3 guide asks for environment and lighting,
 * actions and state changes, and the official example prompts carry steam,
 * rain, wind and passing people through every shot. Movement in the world is
 * also what makes the camera's own movement read as movement.
 */
const RULE_SCENE_MOVES = '- The world moves too: wind in hair and cloth, smoke, steam, dust, rain, traffic, people passing, a light that flickers, a shadow crossing the frame. Name one or two and say how they change during the beat.'

/**
 * The rule that turns a row of shots into a film.
 *
 * The H3 guide's rule is per shot ("every shot must leave the world in a state
 * it was not in"), and the official example prompts escalate across shots — a
 * fleet charging, then a flash, then an emptied space. A plan without an arc
 * renders as the same shot repeated, which is what the studio was getting.
 */
const RULE_ARC = '- Build an arc across the whole video: the first beat opens the world, the middle beats escalate (a bigger action, a closer or bolder framing, a harder light), the last one lands an end state. Each beat leaves the world in a state the previous one was not in.'

/**
 * The rule that makes a chain invisible: end on a handover, not on a stop.
 *
 * Taken from the Context Loop example scenes, which end a shot with "End while
 * he is crossing the threshold so the motion can continue" and open the next
 * with "begin new action only after the carried overlap": the join is a motion
 * that was already going, not a pose that resumes.
 */
const RULE_HANDOVER = '- End every beat in motion, at a moment the next beat can pick up and carry on (a step not yet landed, a head still turning, a door still swinging). Never end on a settled pose.'

/** The rule every film shares: no abstract words, no numbered shots. */
const RULE_NO_ABSTRACT = '- No abstract words ("cinematic", "beautiful"), no numbered shots, no [Shot 2].'

/**
 * The first frame the whole video starts from, when there is no photo.
 *
 * Written as a Krea 2 photograph, the way that model's guide asks for it: the
 * medium first (unnamed, it picks one on its own and changes it every time),
 * then the subject and what they are already doing, the framing, the light
 * with a direction and a quality, two or three named colours, the texture and
 * the background. The last clause is what the video needs from it: a frame
 * caught mid-motion, not a finished portrait, so the first beat has somewhere
 * to go. No negations — H3 samples at cfg 1 and a noun names a thing to draw.
 */
const OPENING_IMAGE_LINE = `\nOpening line, before the beats, in English:
apertura: <one paragraph for the FIRST FRAME of the video, written as a photograph for Krea 2: name the medium first ("35mm film photograph", "cinematic still", "documentary photograph"), then the subject and what they are already doing, the framing and angle, the light with its direction and quality, two or three named colours, the texture and grain, the background, the lens. A frame caught mid-motion, not a finished portrait, so the action has somewhere to go. Only what is in the frame: no negations ("no people", "no shadows"), no "4K", "beautiful" or "cinematic" on its own.>\n`

/** A montage whose photos nobody looked at: the photo decides subject and place. */
const RULE_UNSEEN_PHOTO = '- Do not describe the subject or the place: they are decided by the photo of that shot, which you have not seen. Write only the MOVEMENT and what the person does in the seconds it has.'

/**
 * The rule against naming what is absent, with the examples each film gives.
 * @param examples - the quoted examples, comma-separated.
 * @returns the rule line.
 */
function ruleOnlyWhatIs(examples: string): string {
  return `- Write ONLY what is there. Never name what is missing or what must be removed (${examples}): this model cannot render absence, and naming a thing makes it appear.`
}

/**
 * The rule that keeps a singing face readable.
 * @param framed - the montage's version, which also asks for sharp features
 *   and a medium or close shot.
 * @returns the rule line.
 */
function ruleSinging(framed: boolean): string {
  return `- When the person sings, the face is in full, even light, the eyes open and clearly visible with catchlights${framed ? ', the features sharp' : ''}: while singing the mouth and the face stay readable${framed ? ' (medium or close shot)' : ''}, with the hair and the cloth moving around them.`
}

/**
 * The shape every shot plan instruction shares: who the director is, the
 * user's line and the song, the shots to fill, the rules, and the numbered
 * reply.
 * @param parts - the film's own pieces.
 * @returns the instruction.
 */
function planPrompt(parts: {
  readonly header: string
  readonly intent: string
  readonly song: string
  readonly sung: string
  readonly lead: string
  readonly each: string
  readonly list: string
  readonly rules: readonly string[]
  readonly opening: string
  readonly unit: string
  /** How many beats the reply must carry: the shots of the film. */
  readonly count: number
}): string {
  return `${parts.header}

The user asked for: "${parts.intent}"
${parts.song}${parts.sung}
${parts.lead}Write what happens in ${parts.each}:

${parts.list}

Binding rules:
${parts.rules.join('\n')}
${parts.opening}
Write every beat in English and in the present tense: the video model is trained on English and reads the beat directly when the prompt pass is skipped. Dialogue, singing and on-screen text stay in their own language, word for word.

Reply ONLY with the lines, with no preamble: ${parts.count === 1 ? 'ONE line for the shot' : `exactly ${String(parts.count)} lines, one per shot`}, numbered like this:
1. <what happens in ${parts.unit} 1>
${parts.count === 1 ? '' : `2. <what happens in ${parts.unit} 2>
...`}${parts.count === 1 ? `Inside that one line, the shot's own timeline, in order: first ..., then ..., finally .... The reply carries no second line.

` : ''}`
}

/** Longest beat accepted; past this the model is writing the whole prompt. */
const MAX_BEAT_LENGTH = 600

/**
 * Read a shot plan out of the planner's reply.
 *
 * Tolerant on purpose: the numbering may be `1.`, `1)` or `- `, the reply may
 * open with a line of preamble, and a model that answers with fewer beats than
 * asked is better used than discarded. Undefined means nothing usable came
 * back, and the caller runs the user's own line on every shot.
 * @param text - the model's reply.
 * @param count - how many shots the chain has.
 * @returns the plan, or undefined when the reply carries no beat.
 */
function parseStoryPlan(text: string | undefined, count: number): StoryPlan | undefined {
  if (text === undefined) return undefined
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  const openingLine = lines.find(line => /^apertura\s*:/i.test(line))
  const opening = openingLine?.replace(/^apertura\s*:\s*/i, '').trim()
  const beats: string[] = []
  for (const line of lines) {
    const beat = /^(?:\d+\s*[.)]|[-*])\s*(.+)$/.exec(line)?.[1]?.trim()
    if (beat === undefined || beat.length === 0 || beat.length > MAX_BEAT_LENGTH) continue
    beats.push(beat)
  }
  if (beats.length === 0) return undefined
  // A short reply is padded with its own last beat rather than with the user's
  // line: the tail of a plan continues the plan.
  const last = beats[beats.length - 1] ?? ''
  const filled = Array.from({ length: count }, (_unused, index) => beats[index] ?? last)
  return {
    beats: filled,
    ...opening === undefined || opening.length === 0 ? {} : { opening },
  }
}

/**
 * Write the shot plan with the chat model.
 *
 * Never throws and never blocks the chain: no model, a slow one, or a reply in
 * the wrong shape all fall back to the user's own line on every shot — a
 * weaker video than a planned one, and a much better answer than a refused
 * run. The planner is a text call, so it costs no GPU and runs while the card
 * is still busy with the previous clip.
 * @param ctx - plugin context, carrying `auxiliary` and `llm` when set up.
 * @param intent - the user's line.
 * @param shots - the seconds of each shot, in order.
 * @param opts - the song being cut to, and whether an opening frame is needed.
 * @returns the plan; always one beat per shot.
 */
export async function writeStoryPlan(
  ctx: ImagineHost,
  intent: string,
  shots: readonly number[],
  opts: StoryPlanOptions & { model?: ModelRoute } = { opening: false },
): Promise<StoryPlan> {
  /*
   * Every route in turn, the way the song's caption is written. Stopping at
   * the first one left a whole music video on the user's bare line —
   * "videoclip ALOY HORIZON" as every beat — the one time the chip's model
   * answered nothing in its budget, and nothing reported it: the video was
   * just flatter.
   */
  const plan = await firstTextReply(ctx, opts.model, storyPlanInstruction(intent, shots, opts),
    written => parseStoryPlan(written, shots.length), 'the video clip shot plan')
  return plan ?? { beats: shots.map(() => intent) }
}

/** How long the song is faded down for when the video ends before it does. */
const SONG_FADE_SECONDS = 2

/**
 * The ffmpeg call that puts the song on the finished video.
 *
 * The generated soundtrack is dropped rather than mixed under: H3 writes
 * ambience and voices per clip, and a bed of that behind a song is noise the
 * viewer cannot place. The video is not re-encoded — only the audio is
 * replaced and the whole is cut to whichever of the two ends first — so a
 * chain that has already been through the sampler and two joins does not lose
 * another generation of quality here.
 * @param video - the finished video.
 * @param song - the track to lay over it.
 * @param videoDuration - the video's length in seconds.
 * @param songDuration - the track's length in seconds.
 * @param out - where to write the result.
 * @returns the ffmpeg arguments.
 */
function songArgs(
  video: string,
  song: string,
  videoDuration: number,
  songDuration: number,
  out: string,
): string[] {
  const end = Math.min(videoDuration, songDuration)
  // Only a song cut short needs an ending written for it; one that runs out
  // first already has its own.
  const cut = songDuration > end + 0.25 && end > SONG_FADE_SECONDS
  return [
    '-y',
    '-i', video,
    '-i', song,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-t', end.toFixed(3),
    ...cut ? ['-af', `afade=t=out:st=${(end - SONG_FADE_SECONDS).toFixed(3)}:d=${String(SONG_FADE_SECONDS)}`] : [],
    '-c:v', 'copy',
    ...AAC_192K,
    ...FASTSTART,
    out,
  ]
}

/**
 * Lay a song over a finished video.
 * @param video - absolute path of the finished video.
 * @param song - absolute path of the track.
 * @param videoDuration - the video's length in seconds.
 * @param songDuration - the track's length in seconds.
 * @param outputDir - directory to write the result in.
 * @returns the absolute path of the scored video.
 */
export async function laySongOver(
  video: string,
  song: string,
  videoDuration: number,
  songDuration: number,
  outputDir: string,
): Promise<string> {
  // Dot-named, so the gallery skips it until the caller renames it; ffmpegTo
  // removes it when ffmpeg fails.
  const out = join(outputDir, `.scored-${randomUUID()}.mp4`)
  return ffmpegTo(out, songArgs(video, song, videoDuration, songDuration, out), 300_000)
}

/**
 * Below this a sung shot's mouth is not following the voice.
 *
 * The probe's number is the correlation at zero lag between the mouth's
 * aperture and the vocal's loudness. Measured on the 2c6807 videoclip
 * (2026-09-10): 0.19-0.20 on shots whose lips ran a second off the voice,
 * 0.47-0.54 on shots that sang in time, nothing in between. A shot under
 * this is rendered again with a new seed before it is accepted.
 */
export const LIPSYNC_MIN = 0.3

/**
 * Below this movement correlation the mouth never followed the voice.
 *
 * The probe reports, beside the aperture's position, the correlation at zero
 * lag of the mouth's *movement* (|delta aperture|) against the voice. A mouth
 * painted open and held there scores near zero on both, and that is the take
 * worth rendering again: measured on AUTUNNO (2026-09-26) the takes the archive
 * kept for two such shots range from 0.014 to 0.295 on the movement, so the
 * seed does change the drawing even where it never changed the position. A shot
 * already above this articulates, and what is left to fix there is phase, not
 * drawing.
 */
export const LIPSYNC_ARTICULATION = 0.2

/**
 * Above this share of frames with no face, the probe's score is about the
 * detector, not the mouth.
 *
 * The probe replaces missing frames with the median aperture, which flattens
 * the series and makes the correlation meaningless. Measured on AUTUNNO
 * (2026-09-26): three shots had no face in 83-122 frames out of 192-226 — a fan
 * in front of the mouth, a face leaving the frame.
 */
export const LIPSYNC_FACE_LOST = 0.2

/**
 * The prompt a shot is given when its slice of the vocals is silent.
 *
 * Same document as {@link singingPrompt} — the recording is still reused as
 * the final audio, so the model does not write a soundtrack of its own — but
 * the subject is told there is nothing to sing. Measured 2026-09-08: over a
 * sixteen-second instrumental intro the singing prompt had the mouth wide
 * open on every frame; a silent reference alone does not close it.
 * @param beat - what this shot is doing, as the story director wrote it.
 * @returns the document for the shot.
 */
export function listeningPrompt(beat: string): string {
  const action = beat.trim().length === 0 ? 'listens to the music, swaying gently' : beat.trim()
  return h3ReferencePrompt([
    ['subject_definitions', [
      '<Subject 1> is the person in <Picture 1>, with their face, hair, clothing and setting.',
      '<Audio 1> is the complete supplied recording, reused 1:1 as the final audio. It is instrumental'
      + ' here: nobody sings in it.',
    ]],
    ['summary', [
      '[reference generation + audio reuse] The target video shows <Subject 1> NOT singing — listening to'
      + ' the music with the mouth closed — while the supplied audio track stays locked as the complete'
      + ' final audio.',
    ]],
    ['retention_analysis', [
      '<Subject 1>: fully_preserved - face, hair, clothing and setting of <Picture 1> retained.',
      AUDIO_FULLY_COPIED,
    ]],
    ['detailed_description', [
      SHOT_STYLE,
      '[Shot 1] <Subject 1> (S1) does not sing: lips closed, no mouth movement, breathing calmly,'
      + ' feeling the music. Her face stays fully lit and uncovered, both eyes open and clearly visible'
      + ` with catchlights. ${action}.`,
    ]],
    ['overall_soundscape', ['Subtle room tone under the music.']],
    ['non_diegetic_music', [AUDIO_REUSED]],
  ])
}

/**
 * One document in the sectioned form H3's reference generation reads:
 * `label:` on its own line, the section's lines under it, a blank line
 * between sections. The song shots and the object swap
 * (`object-swap-texts.ts`) write their documents through it.
 * @param sections - each section's label and lines, in order.
 * @returns the document.
 */
export function h3ReferencePrompt(sections: readonly (readonly [string, readonly string[]])[]): string {
  return sections.map(([label, lines]) => [`${label}:`, ...lines].join('\n')).join('\n\n')
}

/** The retention line of a shot whose supplied recording is the final audio. */
const AUDIO_FULLY_COPIED = '<Audio 1>: fully_copy - The complete source audio serves as the target video\'s complete final'
  + ' audio track without modification.'

/** The music line of the same shot. */
const AUDIO_REUSED = '<Audio 1> is directly reused as the complete final audio track.'

/** The style sentence every song shot opens its description with. */
const SHOT_STYLE = 'A cinematic music-video shot with natural skin texture, soft even frontal light on her face and'
  + ' a physically grounded camera.'

/**
 * The prompt a shot that must sing a supplied track is given.
 *
 * MiniMax H3 reads a structured document for reference generation, and one
 * line in it decides everything: `<Audio 1>: fully_copy` under
 * `retention_analysis` means "the supplied recording is the final audio". The
 * default relationship is `reference`, documented as "the signal is not copied
 * directly; only timbre, rhythm, style or dialogue content is referenced" —
 * so a plain sentence about the camera makes H3 sing its own version of the
 * song, and the mouth follows that invention rather than the track.
 *
 * Measured on one segment with only the prompt changed: the clip's own audio
 * matched its slice of the track at 0.99 with this document and at 0.05 with a
 * sentence. English because the model's own guide is written in it.
 * @param beat - what this shot is doing, as the story director wrote it.
 * @returns the document for the shot.
 * @see https://huggingface.co/MiniMaxAI/MiniMax-H3 VIDEO_PROMPT_WRITING_GUIDE
 */
export function singingPrompt(beat: string): string {
  const action = beat.trim().length === 0 ? 'sings to camera' : beat.trim()
  return h3ReferencePrompt([
    ['subject_definitions', [
      '<Subject 1> is the performer in <Picture 1>: her facial identity, hair, wardrobe and body'
      + ' proportions come from that picture.',
      '<Audio 1> is the voice-timbre reference for <Subject 1> (S1): the supplied recording is reused'
      + ' 1:1 as the target video\'s final audio.',
    ]],
    ['summary', [
      '[reference generation + audio reuse] The target video shows <Subject 1> (S1) performing the'
      + ' supplied song on camera while that recording stays locked as the complete final audio.',
    ]],
    ['retention_analysis', [
      '<Subject 1> (appears throughout [Shot 1]): fully_preserved - the referenced facial identity,'
      + ' hair, wardrobe, colours and body proportions are retained.',
      AUDIO_FULLY_COPIED,
    ]],
    ['detailed_description', [
      SHOT_STYLE,
      '[Shot 1] <Subject 1> (S1) keeps visibly singing with clearly readable mouth and jaw articulation,'
      + ' in exact synchronization with the master-song audio. Her face stays fully lit and uncovered,'
      + ' both eyes open and clearly visible with catchlights, her features sharp and recognizable.'
      + ` ${action}.`,
    ]],
    ['overall_soundscape', ['Subtle room tone under the vocal.']],
    ['non_diegetic_music', [AUDIO_REUSED]],
  ])
}
