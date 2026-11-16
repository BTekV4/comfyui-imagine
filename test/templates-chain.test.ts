/**
 * A template's chains, driven by a fake studio.
 *
 * `runTemplate` hands the studio four calls (`TemplateQueue`): queue a job, wait
 * for the file it produced, compose a layout, adopt a file into a project. What
 * is worth testing is not ComfyUI — a job is minutes on a GPU — but the order
 * of the steps and what stops them, so the queue here answers at once and
 * remembers what it was asked. No job runs, `whenJobsSettle` is never reached
 * and nothing touches the media folder.
 *
 * What the chains promise, and what these tests pin:
 *
 * - the runs queued now are the top level, and the compositions are files the
 *   answer carries at once (`files`); the `then` steps go on in the background
 *   and the request is handed their promise (`done`);
 * - a step continues from the file its predecessor produced, never from
 *   nothing: the canvas a still is put on, the cut-out of a sticker, the remix
 *   of a grid;
 * - a step that produced nothing (a failure, a cancel) ends its chain instead
 *   of continuing from a file that does not exist;
 * - the board project travels with every job and every composed file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { templateById, type PlanCompose } from '../shared/imagine-templates.ts'
import {
  CHAIN_RUNNING_TIMEOUT_MS, producedFile, runTemplate, type JobWatch, type TemplateQueue,
} from '../server/vendor/tool-comfy/template-jobs.ts'
import type { JobBody, JobStartContext } from '../server/vendor/tool-comfy/job-start.ts'

/** What a job needs from the boot: a queue is injected, so only this is named. */
const ROUTES = { outputDir: '/nonexistent-media' } as unknown as JobStartContext

/** A studio that answers at once, and the record of what it was asked. */
interface FakeStudio {
  readonly queue: TemplateQueue
  /** The bodies of the jobs queued, in the order they were queued. */
  readonly started: JobBody[]
  /** The layouts composed, with the file each one worked on and the file it made. */
  readonly composed: { readonly step: PlanCompose; readonly source: string | undefined; readonly name: string }[]
  /** The files adopted into a project, and the project. */
  readonly adopted: { readonly projectId: string; readonly names: readonly string[] }[]
  /** The jobs whose file a chain asked for. */
  readonly askedFor: string[]
}

/**
 * A fake studio: jobs are `job-1`, `job-2`, …, a job's file is
 * `file-<id>.png`, a composition is `composed-<n>.png`.
 * @param producedFor - what a job produced; by default a file of its own,
 *   undefined when the test wants a step that failed.
 * @returns the queue and the record.
 */
function fakeStudio(
  producedFor: (id: string) => string | undefined = id => `file-${id}.png`,
  more: Partial<TemplateQueue> = {},
): FakeStudio {
  const started: JobBody[] = []
  const composed: { step: PlanCompose; source: string | undefined; name: string }[] = []
  const adopted: { projectId: string; names: readonly string[] }[] = []
  const askedFor: string[] = []
  let jobs = 0
  let files = 0
  const queue: TemplateQueue = {
    check: () => undefined,
    checkFile: async () => undefined,
    start: async body => {
      started.push(body)
      jobs += 1
      return { id: `job-${String(jobs)}` }
    },
    produced: async id => {
      askedFor.push(id)
      const name = producedFor(id)
      return name === undefined ? { kind: 'stopped', reason: 'failed' } : { kind: 'file', name }
    },
    compose: async (step, source) => {
      files += 1
      const name = `composed-${String(files)}.png`
      composed.push({ step, source, name })
      return name
    },
    adopt: async (projectId, names) => { adopted.push({ projectId, names }) },
    ...more,
  }
  return { queue, started, composed, adopted, askedFor }
}

/** A model of the catalog by id: a test that names one the catalog dropped fails here. */
function model(id: string) {
  const found = templateById(id)
  assert.ok(found, `the catalog has no model called ${id}`)
  return found
}

test('ecommerce queues its five photos at once and composes the card', async () => {
  const studio = fakeStudio()
  const result = await runTemplate(ROUTES, model('ecommerce'), {
    files: { photo: ['p1.png'] },
    values: { benefit1: 'one', benefit2: 'two', benefit3: 'three', size: 'a coffee cup' },
  }, studio.queue)
  // The answer carries what was queued and what was composed now; the chains
  // behind it are a promise the route does not wait for.
  assert.equal(result.jobs.length, 5, 'the five photos are jobs, queued at once')
  assert.equal(studio.started.length, 5, 'each remix was handed to the queue once')
  for (const body of studio.started) {
    assert.equal(body.action, 'remix')
    assert.equal(body.source, 'p1.png', 'the product photo is the source of every shot')
    assert.equal(body.count, 1, 'a chain continues from a single file, never a batch')
  }
  // The benefits card is the sixth run, and it is ffmpeg: a file right now.
  assert.equal(result.files.length, 1, 'the benefits card is composed during the request')
  const card = studio.composed.find(entry => entry.step.layout === 'text')
  assert.ok(card, 'the card was composed')
  assert.deepEqual(card.step.lines, ['one', 'two', 'three'], 'the words are the ones the user typed')
  assert.deepEqual(result.files, [card.name], 'the answer carries the file it composed')
  await result.done
})

test('every drawn photo is put on a 1:1 canvas once it exists', async () => {
  const studio = fakeStudio()
  const result = await runTemplate(ROUTES, model('ecommerce'), {
    files: { photo: ['p1.png'] },
    values: { benefit1: 'one' },
  }, studio.queue)
  await result.done
  const resized = studio.composed.filter(entry => entry.step.layout === 'resize')
  assert.equal(resized.length, 5, 'one resize for each drawn photo')
  for (const entry of resized) {
    assert.equal(entry.step.fromPrevious, true, 'the compose works on the file before it, not on a form field')
    assert.equal(entry.step.aspectRatio, '1:1', 'a listing wants square photos')
  }
  // Each chain continues from the file the job before it produced — its own,
  // exactly once: no chain reads another job's picture.
  const sources = resized.map(entry => entry.source)
  assert.deepEqual(
    [...sources].sort(),
    result.jobs.map(id => `file-${id}.png`).sort(),
    'every resize waits for a job of this run, and one each',
  )
  assert.deepEqual([...studio.askedFor].sort(), [...result.jobs].sort(), 'the chains asked for the files of their own run')
})

test('emoji-pack: the sticker is cut out once it is drawn', async () => {
  const studio = fakeStudio()
  // One expression, so the chain is one link long and easy to read.
  const result = await runTemplate(ROUTES, model('emoji-pack'), {
    files: { photo: ['face.png'] },
    values: { pack: 'custom', list: 'sleepy' },
  }, studio.queue)
  await result.done
  assert.deepEqual(result.jobs, ['job-1'], 'one sticker is drawn')
  assert.equal(studio.started.length, 2, 'the drawing and then the cut-out')
  const [drawing, cut] = studio.started
  assert.ok(drawing)
  assert.ok(cut)
  assert.equal(drawing.action, 'remix')
  assert.equal(cut.action, 'bg', 'the cut-out is a background removal')
  assert.equal(cut.source, 'file-job-1.png', 'the cut-out reads the sticker that was drawn')
  assert.equal(studio.askedFor[0], 'job-1', 'the chain waited for the drawing')
})

test('a step that produced nothing ends its chain', async () => {
  // The drawing failed or was cancelled: `produced` has no file to give.
  const studio = fakeStudio(() => undefined)
  const result = await runTemplate(ROUTES, model('emoji-pack'), {
    files: { photo: ['face.png'] },
    values: { pack: 'custom', list: 'sleepy' },
  }, studio.queue)
  await result.done
  assert.deepEqual(result.jobs, ['job-1'], 'the drawing was queued')
  assert.equal(studio.started.length, 1, 'nothing continued: the cut-out was never queued')
  assert.deepEqual(studio.composed, [], 'and nothing was composed')
})

test('the project travels with every job and every composed file', async () => {
  const studio = fakeStudio()
  const result = await runTemplate(ROUTES, model('ecommerce'), {
    projectId: 'prj-1',
    files: { photo: ['p1.png'] },
    values: { benefit1: 'one' },
  }, studio.queue)
  await result.done
  for (const body of studio.started) {
    assert.equal(body.projectId, 'prj-1', 'the board tile of a job needs its project')
  }
  assert.equal(studio.adopted.length, studio.composed.length, 'every composed file is adopted as it exists')
  for (const entry of studio.adopted) {
    assert.equal(entry.projectId, 'prj-1')
    assert.equal(entry.names.length, 1, 'one file per call')
  }
  assert.deepEqual(
    studio.adopted.flatMap(entry => entry.names).sort(),
    studio.composed.map(entry => entry.name).sort(),
    'the same files, none adopted twice',
  )
})

test('collage: the grid is composed, then redrawn from it', async () => {
  const studio = fakeStudio()
  const result = await runTemplate(ROUTES, model('collage'), {
    files: { photos: ['a.png', 'b.png', 'c.png', 'd.png'] },
    values: { style: ['journal'] },
  }, studio.queue)
  await result.done
  assert.deepEqual(result.jobs, [], 'a journal page draws nothing at first')
  assert.deepEqual(result.files, ['composed-1.png'], 'the grid is a file right away')
  assert.equal(studio.composed.length, 1, 'only the grid is composed on the server')
  const [grid] = studio.composed
  assert.ok(grid)
  assert.equal(grid.step.layout, 'grid', 'the first step tiles the photos')
  assert.equal(grid.step.fromPrevious, undefined)
  assert.equal(studio.started.length, 1, 'the journal pass is a job of its own')
  const [redraw] = studio.started
  assert.ok(redraw)
  assert.equal(redraw.action, 'remix')
  assert.equal(redraw.source, 'composed-1.png', 'the remix reads the grid the studio just composed')
})

/**
 * Capture what `console.warn` is handed while `run` runs.
 * @param run - the work that may write warnings.
 * @returns the warnings, each as the list of arguments it was given.
 */
async function warnings(run: () => Promise<void>): Promise<unknown[][]> {
  const seen: unknown[][] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { seen.push(args) }
  try {
    await run()
  } finally {
    console.warn = original
  }
  return seen
}

test('a body the job route would refuse stops the run before anything is queued', async () => {
  // The third shot of the set is refused: nothing at all may start, or a retry
  // of the form would queue the first two again.
  let checked = 0
  const studio = fakeStudio(undefined, {
    check: () => {
      checked += 1
      return checked === 3 ? 'refused by the job route' : undefined
    },
  })
  await assert.rejects(runTemplate(ROUTES, model('ecommerce'), {
    files: { photo: ['p1.png'] },
    values: { benefit1: 'one' },
  }, studio.queue), /refused by the job route/)
  assert.deepEqual(studio.started, [], 'no job was queued')
  assert.deepEqual(studio.composed, [], 'and nothing was composed')
})

test('the chain steps are checked too, before the first run is queued', async () => {
  // The cut-out after the sticker is the step the route would refuse.
  const studio = fakeStudio(undefined, {
    check: body => (body.action === 'bg' ? 'no cut-outs today' : undefined),
  })
  await assert.rejects(runTemplate(ROUTES, model('emoji-pack'), {
    files: { photo: ['face.png'] },
    values: { pack: 'custom', list: 'sleepy' },
  }, studio.queue), /no cut-outs today/)
  assert.deepEqual(studio.started, [])
})

test('a missing gallery file stops the run before anything is queued', async () => {
  const asked: string[] = []
  const studio = fakeStudio(undefined, {
    checkFile: async (name) => {
      asked.push(name)
      return name === 'c.png' ? `missing: ${name}` : undefined
    },
  })
  await assert.rejects(runTemplate(ROUTES, model('collage'), {
    files: { photos: ['a.png', 'b.png', 'c.png'] },
    values: { style: ['grid', 'strip'] },
  }, studio.queue), /missing: c\.png/)
  assert.deepEqual([...asked].sort(), ['a.png', 'b.png', 'c.png'], 'each file is looked at once')
  assert.deepEqual(studio.composed, [], 'no layout was composed on a missing photo')
})

test('a run that fails half way answers what started and the sentence of what stopped it', async () => {
  let starts = 0
  const studio = fakeStudio()
  const original = studio.queue.start
  const queue: TemplateQueue = {
    ...studio.queue,
    start: async (body) => {
      starts += 1
      if (starts === 3) throw new Error('the queue said no')
      return await original(body)
    },
  }
  const seen = await warnings(async () => {
    const result = await runTemplate(ROUTES, model('ecommerce'), {
      files: { photo: ['p1.png'] },
      values: { benefit1: 'one' },
    }, queue)
    assert.deepEqual(result.jobs, ['job-1', 'job-2'], 'the two runs that started are answered')
    assert.match(result.error ?? '', /^2 passi avviati, poi il modello si è fermato: the queue said no$/)
    await result.done
  })
  assert.equal(studio.started.filter(body => body.source === 'p1.png').length, 2, 'nothing after the failure was queued')
  assert.ok(seen.some(args => args.includes('ecommerce')), 'the log names the template')
})

test('a first run that fails is a plain refusal, with nothing started', async () => {
  const studio = fakeStudio(undefined, { start: async () => { throw new Error('no graph') } })
  await assert.rejects(runTemplate(ROUTES, model('photo-edit'), {
    files: { photo: ['p1.png'] },
    values: { edit: 'enhance' },
  }, studio.queue), /^Error: no graph$/)
})

test('a chain that stops says so in the log, with the template and the step', async () => {
  const studio = fakeStudio(() => undefined)
  const seen = await warnings(async () => {
    const result = await runTemplate(ROUTES, model('emoji-pack'), {
      files: { photo: ['face.png'] },
      values: { pack: 'custom', list: 'sleepy' },
    }, studio.queue)
    await result.done
  })
  const line = seen.find(args => String(args[0]).includes('template chain stopped'))
  assert.ok(line, 'the stop was logged')
  assert.deepEqual(line.slice(1), ['emoji-pack', 'step 0 (remix)', 'failed'])
})

/**
 * A job map with a clock: the job's status follows `script` (one status per
 * wake-up), and every wake-up moves the clock on by `step` milliseconds.
 */
function scriptedWatch(script: readonly string[], step: number, file = 'made.png'): JobWatch & { readonly wakes: () => number } {
  let at = 0
  let wakes = 0
  return {
    job: () => {
      const status = script[Math.min(wakes, script.length - 1)] as 'queued' | 'running' | 'done' | 'error' | 'cancelled'
      return status === 'done' ? { status, files: [{ name: file, kind: 'image' }] } : { status }
    },
    settle: async () => {
      wakes += 1
      at += step
    },
    now: () => at,
    wakes: () => wakes,
  } as JobWatch & { readonly wakes: () => number }
}

test('a chain waits for a step however long it sits in the queue', async () => {
  // Ten hours queued behind other runs, then a quick render: the chain goes on.
  const watch = scriptedWatch([...Array.from({ length: 10 }, () => 'queued'), 'running', 'done'], 60 * 60_000)
  assert.deepEqual(await producedFile('job-1', watch), { kind: 'file', name: 'made.png' })
  assert.equal(watch.wakes(), 11)
})

test('a step running past the ceiling stops its chain, counted from when it ran', async () => {
  const hours = CHAIN_RUNNING_TIMEOUT_MS / (60 * 60_000)
  const watch = scriptedWatch([...Array.from({ length: 5 }, () => 'queued'), 'running'], 60 * 60_000)
  assert.deepEqual(await producedFile('job-1', watch), { kind: 'stopped', reason: 'timed out' })
  assert.equal(watch.wakes(), 5 + hours, 'the hours in the queue did not count')
})

test('a failed, cancelled or empty step is a stop with its reason', async () => {
  assert.deepEqual(await producedFile('j', scriptedWatch(['error'], 1)), { kind: 'stopped', reason: 'failed' })
  assert.deepEqual(await producedFile('j', scriptedWatch(['cancelled'], 1)), { kind: 'stopped', reason: 'cancelled' })
  const empty: JobWatch = { job: () => ({ status: 'done', files: [] }), settle: async () => undefined, now: () => 0 }
  assert.deepEqual(await producedFile('j', empty), { kind: 'stopped', reason: 'no file' })
  const gone: JobWatch = { job: () => undefined, settle: async () => undefined, now: () => 0 }
  assert.deepEqual(await producedFile('j', gone), { kind: 'stopped', reason: 'gone' })
})
