/**
 * The Instagram scripts (Python) this publisher wraps:
 * where they are, how long each may run, and the one call that runs them.
 * @module social/python
 */
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { message } from '../../../server/src/messages.ts'
import { scriptsDir } from './context.ts'

/**
 * The scripts, as functions: the folder is a plugin setting now, so a path
 * computed at import would freeze whatever the process was started with (and be
 * computed before `setup` ever ran).
 */
/** Path to the photo publish script. */
export const PHOTO_PUBLISH_SCRIPT = (): string => join(scriptsDir(), 'instagram_photo_publish_api.py')
/** Path to the reel publish script. */
export const REEL_PUBLISH_SCRIPT = (): string => join(scriptsDir(), 'instagram_reel_publish_api.py')
/** Path to the carousel publish script. */
export const CAROUSEL_PUBLISH_SCRIPT = (): string => join(scriptsDir(), 'instagram_carousel_publish_api.py')
/** Path to the comment manager, which reads, likes and replies. */
export const COMMENT_SCRIPT = (): string => join(scriptsDir(), 'instagram_comment_manager.py')
/** Path to the story publisher. */
export const STORY_PUBLISH_SCRIPT = (): string => join(scriptsDir(), 'instagram_story_publish_api.py')

/**
 * Instagram's own "Created with AI" label.
 *
 * Set as `is_ai_generated=true` on the container, which the publish scripts do
 * behind `--ai-generated`. It is a real field, not a guess: `/media` returns
 * `is_ai_generated` on request and the account's published posts read back
 * `true`. Worth stating because the check is not obvious — Graph accepts
 * unknown POST parameters without complaint, so a misspelt name here would
 * produce no error and no label; what distinguishes a real field is that it
 * comes back with a value when read.
 */
export const AI_LABEL_FLAG = '--ai-generated'

/** Timeouts for Python script execution. */
export const TIMEOUTS = {
  /*
   * No cap (6/11/2026, at the user's request). The numbers below explain why
   * the caps existed; they are now 0, which for `execPython` means "wait as
   * long as it takes". The price: a hung script stays hung until the service
   * restarts.
   */
  /** Quick operations (verifying a post on the account). */
  quick: 0,
  /**
   * Publishing: upload, then Meta's own processing.
   *
   * Two minutes was under the floor for a reel — the script alone polls Meta
   * for up to 120s after normalising and uploading the clip, so the plugin
   * would kill a publish that was still going through, and record an error
   * for a post Instagram might yet accept.
   *
   * Three minutes was still under it. A 132s reel needs, in order: the second
   * encode that brings 97MB down under Meta's ceiling, the Drive upload, the
   * public-link call, then the 120s poll. The Drive upload alone measured
   * 178-207s over three runs on 2026-10-01, so the poll had already lost its
   * margin before it started and the 14:06 restart cut the script short: the
   * post was recorded as failed while rclone was still sending bytes.
   */
  publish: 0,
  /**
   * Reading every comment on the last twenty posts.
   *
   * One Graph call per medium, so the wall clock is the account's post count
   * times a round trip; measured at ~25s, with room for a slow one.
   *
   * 420s, not 180: on 2026-11-06 the reply pass hit the 180s ceiling while the
   * model was still thinking (`strata/qwen3.8-flash-next` spent ~150s before
   * writing anything) and the pass recorded «nessuna risposta scritta». A
   * thinking model's cost is not the round trip; the ceiling has to cover it.
   */
  comments: 0,
  /** One like or one reply: a single POST, plus the duplicate check before it. */
  commentAction: 0,
  /**
   * One story: upload to Drive, then Meta's own processing of the clip.
   *
   * The account's earlier publisher gave its watchdog 420s for the same
   * call, which is the number to keep — a story that Meta is still
   * transcoding must not be killed and recorded as failed.
   *
   * Raised with `publish`: a story runs the same normalize + Drive upload,
   * measured at 178-207s for a ~90MB clip, and only then starts its own wait
   * on Meta. A story clip is capped at 61s so it encodes faster than a reel,
   * but the upload is the fixed cost and it alone ate half of the 420s.
   */
  story: 0,
} as const

/**
 * What a script answered: its JSON on stdout, or `{ ok: true, output }` for a
 * script that printed prose and exited 0. Fields are read one by one by the
 * callers, each knowing its own script.
 */
export type ScriptResult = Readonly<Record<string, unknown>>

/**
 * The end of one stream, which is where a Python failure says why.
 *
 * These publishers print their whole run — config banner, normalisation,
 * upload, container, transcoding — before anything goes wrong, so the head of
 * the output is never the reason and the tail almost always is.
 * @param value - the raw stream.
 * @param max - how much of the tail to keep.
 * @returns the tail, marked with an ellipsis when it was cut.
 */
function streamTail(value: string | Buffer | undefined, max = 800): string {
  const text = value?.toString().trim() ?? ''
  return text.length <= max ? text : `…${text.slice(-max)}`
}

/**
 * Execute a Python script and return parsed JSON output.
 * @param script - path to the Python script.
 * @param args - command-line arguments.
 * @param timeoutMs - execution timeout.
 * @param onLine - told each stderr line as the script prints it.
 * @returns parsed JSON output from stdout.
 */
export function execPython(script: string, args: readonly string[], timeoutMs: number, onLine?: (line: string) => void): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const child = execFile('python3', [script, ...args], {
      ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      /*
       * A script that reports its own failure still writes JSON on stdout
       * and exits 1: {"ok": false, "error": "HTTP 500: ..."}. That is an
       * answer, not a crash. Treating it as one printed the wrapper as the
       * reason: on 2026-10-20 the comment pass showed sixteen
       * "Python script failed: stdout: {... (like): HTTP 500}" where Meta
       * had said "(#2) Internal Server Error", and the real cause was gone.
       */
      const answer = stdout.toString().trim()
      if (answer !== '') {
        try {
          resolve(JSON.parse(answer) as ScriptResult)
          return
        } catch {
          /* Not JSON (a traceback on stdout): fall through to the error. */
        }
      }
      if (error) {
        /*
         * Both streams, not the first non-empty one. These scripts open
         * with `[config] IG User: …` on stderr, so a stderr-first message
         * reported that banner and threw the real reason — which is on
         * stdout — away: that is the whole of what the journal recorded
         * for the story of 2026-09-28 and the reel of 2026-10-01 14:06.
         * It also blinded isTransientPublishError, which classifies a
         * failure by reading this very text, so the one failure the retry
         * was written for could not be recognised as transient.
         */
        const parts: string[] = []
        /*
         * A timeout is named rather than inferred: the kill leaves both
         * streams mid-sentence and adds no message of its own, so without
         * this the text would be whatever the script happened to have
         * printed — and a slow upload reads nothing like a failure.
         */
        if (error.killed === true) parts.push(message('social.scriptTimeout', { seconds: Math.round(timeoutMs / 1000) }))
        const err = streamTail(stderr)
        const out = streamTail(stdout)
        if (err !== '') parts.push(`stderr: ${err}`)
        if (out !== '') parts.push(`stdout: ${out}`)
        if (parts.length === 0) parts.push(error.message)
        reject(new Error(`Python script failed: ${parts.join(' | ')}`))
        return
      }
      // Exit 0 without JSON (the JSON parse above already had its chance):
      // the human-readable output is kept for readPublishedUrl and runStory.
      resolve(answer === '' ? { ok: true } : { ok: true, output: answer })
    }).on('error', reject)
    /*
     * The publish scripts say what they are doing on stderr, one line per
     * step; the queue shows it while the post is going out, instead of a
     * bare "un momento" for the five minutes a carousel can take.
     */
    if (onLine !== undefined && child.stderr !== null) {
      let pending = ''
      child.stderr.on('data', (chunk: Buffer | string) => {
        const lines = (pending + chunk.toString()).split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) if (line.trim() !== '') onLine(line.trim())
      })
    }
  })
}

/**
 * The JSON a publish script prints behind `MEDIA_RESULT=` on stdout: an object
 * for a reel or a carousel, a list for a story. One reader for the posts and
 * the stories, which each had their own regex until 2026-11-14.
 * @param output - what the script printed.
 * @returns the parsed value, or undefined when there is no tag.
 * @throws when the tag is there and is not JSON.
 */
export function mediaResultOf(output: string): unknown {
  const tagged = /MEDIA_RESULT=(\{.*\}|\[.*\])/.exec(output)
  return tagged?.[1] === undefined ? undefined : JSON.parse(tagged[1]) as unknown
}

/**
 * The reason a script gave for refusing, as its `error`, else its `reason`,
 * else the fallback (`String(result.error ?? result.reason ?? fallback)`).
 */
export function refusalOf(result: ScriptResult | undefined, fallback: string): string {
  return String(result?.error ?? result?.reason ?? fallback)
}
