/**
 * Templates: the sixteen models of the home page expand into the runs they
 * promise.
 *
 * The engine is pure — no I/O, no clock — so every case here is two values in
 * and a list of runs out: the form's answers, and the jobs the server would
 * queue. What the tests pin down, in the order the page meets it:
 *
 * - the catalog itself: sixteen models, each in a group it names, each with
 *   runs, and a locale key for every word it shows;
 * - the expansion: runs for every model, no `{{field}}` left behind, and the
 *   number of runs the models that promise several actually make;
 * - the lines a placeholder takes away when its answer says nothing (a preset
 *   colour against a colour typed by hand, a note left empty);
 * - `forEach`, once per selected value and with that value only;
 * - the `then` chains: a still put on another canvas, a sticker cut out, a
 *   character animated, words laid over a poster, a grid redrawn as a journal;
 * - the gates on photos and choices (a reference photo, a second package, a
 *   transparent background);
 * - the answers a form refuses (`templateProblems`), and `filesOf`'s ceiling.
 *
 * The two defects this file found in the engine — a choice that names its own
 * action, and a list typed by hand — are plain tests at the end: they were
 * reported, fixed, and stay here as regressions.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  TEMPLATES,
  TEMPLATE_CATEGORIES,
  expandTemplate,
  fieldOf,
  filesOf,
  templateById,
  templateProblems,
  type PlanCompose,
  type PlanJob,
  type PlanJobOrCompose,
  type Template,
  type TemplateChoiceField,
  type TemplateField,
  type TemplatePhotoField,
  type TemplateValues,
} from '../shared/imagine-templates.ts'

/** The English dictionary, read as text: another session is editing it beside us. */
const LOCALES = 'web/vendor-imagine/client/locales.ts'

/** A model of the catalog by id: a test that names one the catalog dropped fails here. */
function model(id: string): Template {
  const found = templateById(id)
  assert.ok(found, `the catalog has no model called ${id}`)
  return found
}

/** One field of a model, by id. */
function fieldOfModel(template: Template, id: string): TemplateField {
  const field = fieldOf(template, id)
  assert.ok(field, `${template.id} has no field called ${id}`)
  return field
}

/** The photo field of a model, so a change of kind is caught here. */
function photoField(template: Template, id: string): TemplatePhotoField {
  const field = fieldOfModel(template, id)
  if (field.kind !== 'photos') assert.fail(`${template.id}.${id} is not a photo field`)
  return field
}

/** The choice field of a model. */
function choiceField(template: Template, id: string): TemplateChoiceField {
  const field = fieldOfModel(template, id)
  if (field.kind !== 'choice') assert.fail(`${template.id}.${id} is not a choice field`)
  return field
}

/** The answers a valid form is submitted with, per field. */
interface FilledAnswers {
  readonly values: Record<string, string | readonly string[]>
  readonly files: Record<string, readonly string[]>
}

/**
 * The smallest valid answers a model can be submitted with.
 *
 * Every photo field gets its `min` made-up names (`p1.png`, `p2.png`, …), so a
 * field that insists on two photos arrives with two and an optional one
 * arrives empty; every choice and every aspect takes its `default` when it has
 * one, otherwise the first value it offers — or all of them when it takes
 * several, which is the case that unrolls into one run per value; every text
 * the model cannot go without gets a sentence. This is what the page sends
 * when the user fills nothing in and presses Generate.
 * @param template - the model.
 * @returns the values and the files, by field id.
 */
function fillIn(template: Template): FilledAnswers {
  const values: Record<string, string | readonly string[]> = {}
  const files: Record<string, readonly string[]> = {}
  for (const field of template.fields) {
    if (field.kind === 'photos') {
      files[field.id] = Array.from({ length: field.min }, (_ignored, index) => `p${String(index + 1)}.png`)
      continue
    }
    if (field.kind === 'text') {
      if (field.required === true) values[field.id] = `a sentence for ${field.id}`
      continue
    }
    const offered: readonly string[] = field.kind === 'aspect'
      ? field.options
      : field.options.map(option => option.value)
    const start = field.default === undefined
      ? []
      : typeof field.default === 'string' ? [field.default] : [...field.default]
    const first = field.multi === true ? offered : offered.slice(0, 1)
    const picked = start.length > 0 ? start : field.required === true ? first : []
    if (picked.length > 0) values[field.id] = picked
  }
  return { values, files }
}

/**
 * A valid form, with some answers put over the filled-in ones.
 * @param template - the model.
 * @param values - choices, aspects and texts to force.
 * @param files - photos to force, in the order the user gave them.
 * @returns the answers.
 */
function answersFor(
  template: Template,
  values: Readonly<Record<string, string | readonly string[]>> = {},
  files: Readonly<Record<string, readonly string[]>> = {},
): TemplateValues {
  const filled = fillIn(template)
  return { values: { ...filled.values, ...values }, files: { ...filled.files, ...files } }
}

/** Every run of a plan, the ones its chain hangs included, top level first. */
function* walk(plans: readonly PlanJobOrCompose[]): Generator<PlanJobOrCompose> {
  for (const plan of plans) {
    yield plan
    yield* walk(plan.then)
  }
}

/** The one prompt an expansion holds: a model that makes more than one run here is a defect. */
function onlyPrompt(template: Template, values: TemplateValues): string {
  const plans = expandTemplate(template, values)
  assert.equal(plans.length, 1, `${template.id} should queue one run here, not ${String(plans.length)}`)
  const plan: PlanJobOrCompose | undefined = plans[0]
  assert.ok(plan, `${template.id} queued nothing`)
  if (plan.kind !== 'job') assert.fail(`${template.id} queued a ${plan.kind}, not a job`)
  return plan.prompt
}

/** The job a chain starts with. */
function firstJobOf(plan: PlanJobOrCompose): PlanJob {
  const step: PlanJobOrCompose | undefined = plan.then[0]
  assert.ok(step, 'the run has no chain')
  if (step.kind !== 'job') assert.fail(`the chain starts with a ${step.kind}, not a job`)
  return step
}

/** The compose a chain starts with. */
function firstComposeOf(plan: PlanJobOrCompose): PlanCompose {
  const step: PlanJobOrCompose | undefined = plan.then[0]
  assert.ok(step, 'the run has no chain')
  if (step.kind !== 'compose') assert.fail(`the chain starts with a ${step.kind}, not a compose`)
  return step
}

/** The runs a model expands to, each of which the tests below read as a job. */
function jobsOf(template: Template, values: TemplateValues): readonly PlanJob[] {
  return expandTemplate(template, values).map(plan => {
    if (plan.kind !== 'job') assert.fail(`${template.id} queued a ${plan.kind} where a job was expected`)
    return plan
  })
}

/*
 * The catalog.
 */

test('the catalog is sixteen models, each in a group it names, each with runs', () => {
  assert.equal(TEMPLATES.length, 16, 'the home page shows sixteen models')
  const ids = TEMPLATES.map(template => template.id)
  assert.equal(new Set(ids).size, ids.length, `two models share an id: ${ids.join(', ')}`)
  const groups = new Set<string>(TEMPLATE_CATEGORIES.map(category => category.id))
  for (const template of TEMPLATES) {
    // A category the page does not know would leave the card without its badge.
    assert.ok(groups.has(template.category), `${template.id} is in an unknown group: ${template.category}`)
    assert.ok(template.runs.length > 0, `${template.id} queues nothing`)
    const fieldIds = template.fields.map(field => field.id)
    assert.equal(new Set(fieldIds).size, fieldIds.length, `${template.id} repeats a field id`)
  }
})

/** Whether the English dictionary defines this key, however it is quoted. */
function hasKey(source: string, key: string): boolean {
  const quoted = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`['"]${quoted}['"]\\s*:`).test(source)
}

/** Every locale key the catalog asks the page to translate, and what it is for. */
function catalogKeys(): readonly { readonly key: string; readonly where: string }[] {
  const keys: { key: string; where: string }[] = []
  for (const category of TEMPLATE_CATEGORIES) keys.push({ key: category.labelKey, where: `the ${category.id} group` })
  for (const template of TEMPLATES) {
    keys.push({ key: template.titleKey, where: `${template.id}: title` })
    keys.push({ key: template.descriptionKey, where: `${template.id}: description` })
    keys.push({ key: template.aboutKey, where: `${template.id}: about` })
    for (const field of template.fields) {
      keys.push({ key: field.labelKey, where: `${template.id}: the ${field.id} field` })
      if (field.kind === 'text' && field.placeholderKey !== undefined) {
        keys.push({ key: field.placeholderKey, where: `${template.id}: the hint of ${field.id}` })
      }
      if (field.kind === 'choice') {
        for (const option of field.options) {
          keys.push({ key: option.labelKey, where: `${template.id}: the ${option.value} option of ${field.id}` })
        }
      }
    }
  }
  return keys
}

test('the English dictionary has a line for every word the catalog shows', () => {
  // The dictionary is read as text on purpose: another session is adding the
  // template keys to it right now, and a key that is not there yet must be
  // reported, not crash the test.
  const source = readFileSync(LOCALES, 'utf8')
  const keys = catalogKeys()
  const missing = keys.filter(entry => !hasKey(source, entry.key))
  // Every missing key is listed, not the first one: the dictionary is being
  // filled in beside this file, and whoever fills it needs the whole list.
  const lines = missing.map(entry => `${entry.key}  (${entry.where})`)
  assert.deepEqual(
    lines,
    [],
    `${String(missing.length)} of the ${String(keys.length)} catalog keys are not in ${LOCALES}:\n${lines.join('\n')}`,
  )
})

/*
 * The expansion of every model.
 */

test('every model expands with valid answers: runs, real prompts, no left-over placeholder', () => {
  for (const template of TEMPLATES) {
    const plans = expandTemplate(template, answersFor(template))
    assert.ok(plans.length > 0, `${template.id} expands to no run at all`)
    for (const plan of walk(plans)) {
      if (plan.kind !== 'job') continue
      assert.ok(!plan.prompt.includes('{{'), `${template.id}: a placeholder is left in "${plan.prompt}"`)
      // A cut-out reads no words, so an empty prompt is right for it; every
      // other action is described by the words it sends.
      if (plan.action !== 'bg') {
        assert.ok(plan.prompt.trim().length > 0, `${template.id}: the ${plan.action} run has an empty prompt`)
      }
    }
  }
})

test('the models that promise more than one run make exactly that many', () => {
  const promised: readonly { readonly id: string; readonly values: TemplateValues; readonly count: number; readonly why: string }[] = [
    { id: 'restyle', values: answersFor(model('restyle'), { style: ['chibi', 'comic'] }), count: 2, why: 'one run per style picked' },
    { id: 'emoji-pack', values: answersFor(model('emoji-pack'), { pack: 'expressions' }), count: 6, why: 'one run per expression of the pack' },
    { id: 'ecommerce', values: answersFor(model('ecommerce')), count: 6, why: 'five photos and the card of benefits' },
    { id: 'profile-picture', values: answersFor(model('profile-picture')), count: 4, why: 'one photo per setting' },
    { id: 'smart-resize', values: answersFor(model('smart-resize'), { ratio: ['9:16', '1:1'] }), count: 2, why: 'one compose per ratio' },
    { id: 'icon-maker', values: answersFor(model('icon-maker')), count: 4, why: 'four directions of the same idea' },
  ]
  for (const entry of promised) {
    assert.equal(expandTemplate(model(entry.id), entry.values).length, entry.count, `${entry.id}: ${entry.why}`)
  }
  // The packs are not all the same length: the gaming, love and memes sets are four.
  for (const pack of ['gaming', 'love', 'memes']) {
    const plans = expandTemplate(model('emoji-pack'), answersFor(model('emoji-pack'), { pack }))
    assert.equal(plans.length, 4, `the ${pack} pack is four stickers`)
  }
})

test('the hero reveal is one clip, on the frame the form asked for', () => {
  const template = model('hero-reveal')
  const [widescreen] = jobsOf(template, answersFor(template))
  const [portrait] = jobsOf(template, answersFor(template, { frame: '9:16' }))
  assert.ok(widescreen)
  assert.ok(portrait)
  // The form starts on 16:9; 9:16 is the ratio the run has to carry through.
  assert.equal(widescreen.action, 'video')
  assert.equal(widescreen.aspectRatio, '16:9')
  assert.equal(widescreen.seconds, 10)
  assert.equal(portrait.action, 'video')
  assert.equal(portrait.aspectRatio, '9:16', 'the ratio comes from the aspect field, not from the literal')
})

/*
 * The lines a placeholder takes away.
 */

test('product colour: the preset sentence and the typed one never both appear', () => {
  const template = model('product-color')
  const preset = onlyPrompt(template, answersFor(template, { part: 'the cap', colour: 'red' }))
  const presetLines = preset.split('\n').filter(line => line.startsWith('Recolour it to'))
  assert.equal(presetLines.length, 1, `one recolour sentence, not ${String(presetLines.length)}: ${preset}`)
  assert.ok(preset.includes('a strong tomato red'), 'the preset writes its own words')
  assert.ok(!preset.includes('{{'), 'no placeholder survives')

  // The colour typed by hand is a second field, and it only speaks when the
  // choice picked is «Another colour»: with a preset picked it says nothing at
  // all, even if the box was filled in before.
  const typedBesidePreset = onlyPrompt(template, answersFor(template, { part: 'the cap', colour: 'red', custom: 'burnt orange' }))
  assert.equal(typedBesidePreset, preset, 'a colour typed beside a preset changes nothing')

  const typed = onlyPrompt(template, answersFor(template, { part: 'the cap', colour: 'custom', custom: 'burnt orange' }))
  const typedLines = typed.split('\n').filter(line => line.startsWith('Recolour it to'))
  assert.equal(typedLines.length, 1, `one recolour sentence, not ${String(typedLines.length)}: ${typed}`)
  assert.ok(typed.includes('Recolour it to burnt orange,'), 'the typed colour is the one written')
  assert.ok(!typed.includes('{{'), 'no placeholder survives')
})

test('a text left empty takes its own line with it and leaves no orphan', () => {
  const edit = model('photo-edit')
  const withDetails = onlyPrompt(edit, answersFor(edit, { details: 'take the lamp out' }))
  assert.ok(withDetails.endsWith('take the lamp out'), `the details are the last line: ${withDetails}`)
  const withoutDetails = onlyPrompt(edit, answersFor(edit))
  assert.ok(!withoutDetails.includes('take the lamp out'))
  // The line was `{{details}}` on its own: with nothing behind it, it goes away
  // whole — no trailing newline, no empty line in the middle of the prompt.
  assert.equal(withoutDetails, withoutDetails.trim(), 'the prompt is trimmed')
  assert.ok(!withoutDetails.includes('\n\n'), `no empty line is left: ${JSON.stringify(withoutDetails)}`)

  // The same for a note of a photo the model can run without.
  const headshot = answersFor(model('headshot'))
  const bare = onlyPrompt(model('headshot'), headshot)
  assert.ok(!bare.endsWith('\n'), 'the empty note leaves no line behind')
  const noted = onlyPrompt(model('headshot'), answersFor(model('headshot'), { notes: 'he is a doctor' }))
  assert.ok(noted.endsWith('he is a doctor'), 'a note that was typed is the last line')

  // And for a size nobody gave: the sentence that used it is gone, the rest stays.
  const ugc = model('ugc')
  const [sized] = jobsOf(ugc, answersFor(ugc, { size: 'fits in one hand' }))
  assert.ok(sized)
  assert.ok(sized.prompt.includes('It is fits in one hand.'), `a size that was typed is used: ${sized.prompt}`)
  const [unsized] = jobsOf(ugc, answersFor(ugc))
  assert.ok(unsized)
  assert.ok(!unsized.prompt.includes('It is'), `the size sentence is gone: ${unsized.prompt}`)
})

/*
 * forEach.
 */

test('forEach on a style writes every run with its own style, and with no other', () => {
  const template = model('restyle')
  const styles = ['chibi', 'comic', '3d']
  const words = new Map(choiceField(template, 'style').options.map(option => [option.value, option.prompt ?? '']))
  const plans = expandTemplate(template, answersFor(template, { style: styles }))
  assert.equal(plans.length, 3, 'one run per style picked')
  plans.forEach((plan, index) => {
    assert.equal(plan.kind, 'job')
    if (plan.kind !== 'job') return
    const own = styles[index]
    assert.ok(own, 'the run has a style')
    const mine = words.get(own)
    assert.ok(mine !== undefined && mine.length > 0, `${own} has its prompt`)
    assert.ok(plan.prompt.includes(mine), `the run for ${own} carries its own words`)
    for (const other of styles) {
      if (other === own) continue
      const theirs = words.get(other)
      assert.ok(theirs !== undefined && theirs.length > 0)
      assert.ok(!plan.prompt.includes(theirs), `the run for ${own} also carries the words of ${other}`)
    }
  })
})

test('forEach on an aspect composes one file per ratio, on that ratio', () => {
  const template = model('smart-resize')
  const ratios = ['16:9', '1:1', '4:3']
  const plans = expandTemplate(template, answersFor(template, { ratio: ratios, fit: 'pad' }))
  assert.equal(plans.length, 3, 'one composed file per ratio')
  plans.forEach((plan, index) => {
    assert.equal(plan.kind, 'compose')
    if (plan.kind !== 'compose') return
    assert.equal(plan.layout, 'resize')
    assert.equal(plan.aspectRatio, ratios[index], 'the compose canvas is the ratio it was unrolled on')
    assert.deepEqual(plan.files, ['p1.png'], 'the photo is the one the form was given')
    // `fit` comes from the choice, not from the step's literal (`fill`).
    assert.equal(plan.fit, 'pad', 'the fit follows the choice field')
  })
})

/*
 * The chains.
 */

test('ecommerce: every drawn photo is put on a square canvas afterwards', () => {
  const template = model('ecommerce')
  const plans = expandTemplate(template, answersFor(template, { benefit1: 'one', benefit2: 'two', benefit3: 'three' }))
  assert.equal(plans.length, 6, 'five photos and the benefits card')
  for (const plan of plans) {
    if (plan.kind === 'job') {
      const then = firstComposeOf(plan)
      assert.equal(then.layout, 'resize', 'a drawn photo is resized, not redrawn')
      assert.equal(then.fromPrevious, true, 'the compose works on the photo before it')
      assert.equal(then.aspectRatio, '1:1')
      assert.deepEqual(then.files, [], 'nothing is read off the form: the file is the one before')
      continue
    }
    // The benefits card is written on the server, and nothing continues it.
    assert.equal(plan.layout, 'text')
    assert.deepEqual(plan.lines, ['one', 'two', 'three'], 'the user\'s own three lines, in order')
    assert.deepEqual(plan.then, [], 'the card is the last step')
  }
})

test('emoji-pack: every sticker is cut out after it is drawn', () => {
  const template = model('emoji-pack')
  const plans = expandTemplate(template, answersFor(template, { pack: 'love' }))
  assert.equal(plans.length, 4)
  for (const plan of plans) {
    assert.equal(plan.kind, 'job')
    const cut = firstJobOf(plan)
    assert.equal(cut.action, 'bg', 'a PNG with a transparent background')
    assert.deepEqual(cut.source, { kind: 'previous' }, 'the cut-out reads the sticker before it')
    assert.equal(cut.prompt, '', 'a cut-out has no words')
  }
})

test('character-sprite: the character is drawn, then animated into a loop', () => {
  const template = model('character-sprite')
  const [plan] = jobsOf(template, answersFor(template, { motion: 'walk' }))
  assert.ok(plan)
  assert.equal(plan.action, 'generate')
  assert.equal(plan.aspectRatio, '1:1')
  const loop = firstJobOf(plan)
  assert.equal(loop.action, 'loop')
  assert.equal(loop.seconds, 5, 'a short looping clip')
  assert.equal(loop.aspectRatio, '1:1', 'the clip keeps the character\'s canvas')
  assert.deepEqual(loop.source, { kind: 'previous' })
  assert.ok(loop.prompt.includes('walks in place'), `the motion picked is the one described: ${loop.prompt}`)
})

test('editorial-poster: the words are laid on the poster after it is drawn', () => {
  const template = model('editorial-poster')
  const texts = { headline: 'Made for the morning', subtext: 'Three things it does better', small: 'From the studio, since 2026' }
  const [plan] = jobsOf(template, answersFor(template, texts))
  assert.ok(plan)
  assert.equal(plan.action, 'remix', 'the picture is drawn around the product')
  const poster = firstComposeOf(plan)
  assert.equal(poster.layout, 'text', 'the words are written on the server')
  assert.equal(poster.aspectRatio, '9:16', 'a vertical poster')
  assert.deepEqual(poster.lines, [texts.headline, texts.subtext, texts.small], 'headline, subtitle, fine print, in that order')
  for (const line of poster.lines) assert.ok(line.length > 0)
})

test('collage: the grid stays as it is, the journal is redrawn over it', () => {
  const template = model('collage')
  const photos = ['a.png', 'b.png', 'c.png', 'd.png']
  const plans = expandTemplate(template, answersFor(template, { style: ['grid', 'journal'] }, { photos }))
  assert.equal(plans.length, 2, 'one file per layout picked')
  const [grid, journal] = plans
  assert.ok(grid)
  assert.ok(journal)
  assert.equal(grid.kind, 'compose')
  assert.deepEqual(grid.then, [], 'a clean grid is the file the user asked for: nothing more')
  assert.equal(journal.kind, 'compose')
  const redraw = firstJobOf(journal)
  assert.equal(redraw.action, 'remix', 'the journal look is one more pass over the grid')
  assert.deepEqual(redraw.source, { kind: 'previous' }, 'the pass reads the grid before it')
  assert.ok(redraw.prompt.includes('travel journal'), 'the journal words, not the grid ones')
})

/*
 * The gates on photos and choices.
 */

test('icon maker: plain runs without a reference photo, redraws with one', () => {
  const template = model('icon-maker')
  const plain = jobsOf(template, answersFor(template))
  assert.equal(plain.length, 4, 'four directions either way')
  for (const plan of plain) {
    assert.equal(plan.action, 'generate', 'nothing to anchor to: the idea is drawn from the words')
    assert.equal(plan.source, undefined, 'a generated icon reads no photo')
    assert.equal(plan.aspectRatio, '1:1', 'an icon is square')
  }
  const fromPhoto = jobsOf(template, answersFor(template, {}, { reference: ['ref.png'] }))
  assert.equal(fromPhoto.length, 4, 'the same four directions')
  for (const plan of fromPhoto) {
    assert.equal(plan.action, 'remix', 'with a photo the icon is drawn after it')
    assert.deepEqual(plan.source, { kind: 'file', name: 'ref.png' }, 'from the reference photo the user gave')
  }
})

test('a transparent background adds the cut-out step, a dark one does not', () => {
  const template = model('icon-maker')
  const transparent = expandTemplate(template, answersFor(template, { background: 'transparent' }))
  assert.equal(transparent.length, 4)
  for (const plan of transparent) {
    const cut = firstJobOf(plan)
    assert.equal(cut.action, 'bg')
    assert.deepEqual(cut.source, { kind: 'previous' })
  }
  const dark = expandTemplate(template, answersFor(template, { background: 'dark' }))
  assert.equal(dark.length, 4)
  for (const plan of dark) assert.deepEqual(plan.then, [], 'an opaque background is already a finished file')

  // The mascot has the same gate, on a background of its own form.
  const mascot = model('mascot-maker')
  const chroma = expandTemplate(mascot, answersFor(mascot, { background: 'chroma' }))
  assert.equal(chroma.length, 1)
  const [mascotRun] = chroma
  assert.ok(mascotRun)
  assert.deepEqual(mascotRun.then, [], 'a chroma key is cut by the user: the chain does not run')
  const [cutOut] = expandTemplate(mascot, answersFor(mascot, { background: 'transparent' }))
  assert.ok(cutOut)
  assert.equal(firstJobOf(cutOut).action, 'bg', 'transparent is cut out here')
})

test('ugc: the second photo trades the spare run for the reference one', () => {
  const template = model('ugc')
  const one = jobsOf(template, answersFor(template, {}, { photos: ['p1.png'] }))
  assert.equal(one.length, 6, 'six photos even with one package')
  assert.equal(one.filter(plan => plan.reference !== undefined).length, 0, 'one photo is nothing to compare with')
  assert.equal(one.filter(plan => plan.prompt.includes('next to an open box')).length, 1, 'the spare shot is the open box')

  const two = jobsOf(template, answersFor(template, {}, { photos: ['p1.png', 'p2.png'] }))
  assert.equal(two.length, 6, 'still six photos')
  const withReference = two.filter(plan => plan.reference !== undefined)
  assert.equal(withReference.length, 1, 'exactly one run reads the package')
  const [referenceRun] = withReference
  assert.ok(referenceRun)
  assert.deepEqual(referenceRun.source, { kind: 'file', name: 'p1.png' }, 'the product is the first photo')
  assert.deepEqual(referenceRun.reference, { kind: 'file', name: 'p2.png' }, 'the package is the second')
  assert.equal(two.filter(plan => plan.prompt.includes('next to an open box')).length, 0, 'the spare shot gave way')
  for (const plan of two) {
    if (plan === referenceRun) continue
    assert.equal(plan.reference, undefined, 'no other run reads a second photo')
  }
})

/*
 * What a form refuses.
 */

test('validation: the photo counts, both too few and too many', () => {
  const edit = model('photo-edit')
  assert.deepEqual(templateProblems(edit, { values: {}, files: {} }).filter(problem => problem.key === 'template.photosCount'), [
    { key: 'template.photosCount', field: 'photo', args: { label: 'Photo', min: 1, max: 1 } },
  ])
  // Seventeen photos into a sixteen-photo collage: `filesOf` would cut the list
  // to sixteen, so the check reads the body's raw length as well.
  const collage = model('collage')
  const many = Array.from({ length: 17 }, (_ignored, index) => `p${String(index)}.png`)
  assert.deepEqual(templateProblems(collage, { values: { style: 'grid' }, files: { photos: many } }), [
    { key: 'template.photosCount', field: 'photos', args: { label: 'Photos', min: 2, max: 16 } },
  ])
})

test('validation: a choice that is empty, unknown or doubled', () => {
  const edit = model('photo-edit')
  const files = { photo: ['p.png'] }
  assert.deepEqual(templateProblems(edit, { values: { edit: [] }, files }), [
    { key: 'template.choiceRequired', field: 'edit', args: { label: 'Fix' } },
  ])
  assert.deepEqual(templateProblems(edit, { values: { edit: 'nope' }, files }), [
    { key: 'template.valueNotOffered', field: 'edit', args: { label: 'Fix', value: 'nope' } },
  ])
  // A field that takes one value does not silently run on the first of several.
  assert.deepEqual(templateProblems(edit, { values: { edit: ['enhance', 'polish'] }, files }), [
    { key: 'template.oneValueOnly', field: 'edit', args: { label: 'Fix' } },
  ])
})

test('validation: the words a model cannot go without', () => {
  const poster = model('editorial-poster')
  assert.deepEqual(templateProblems(poster, { values: { headline: '   ' }, files: { photo: ['p.png'] } }), [
    { key: 'template.textRequired', field: 'headline', args: { label: 'Headline' } },
  ])
  // «Another colour» makes the box beside it necessary: the sentence that uses
  // the typed colour only exists when there is one.
  const product = model('product-color')
  assert.deepEqual(
    templateProblems(product, { values: { part: 'the cap', colour: 'custom' }, files: { photo: ['p.png'] } }),
    [{ key: 'template.textRequired', field: 'custom', args: { label: 'The colour you want' } }],
  )
})

test('validation: an aspect nobody picked, and answers that are fine', () => {
  const hero = model('hero-reveal')
  assert.deepEqual(templateProblems(hero, { values: { frame: [] }, files: { photo: ['p.png'] } }), [
    { key: 'template.aspectRequired', field: 'frame', args: { label: 'Frame' } },
  ])
  assert.deepEqual(templateProblems(hero, { values: { frame: '7:3' }, files: { photo: ['p.png'] } }), [
    { key: 'template.valueNotOffered', field: 'frame', args: { label: 'Frame', value: '7:3' } },
  ])
  // The answers `answersFor` writes are the ones the page sends: nothing to report.
  for (const template of TEMPLATES) {
    assert.deepEqual(templateProblems(template, answersFor(template)), [], `${template.id} refuses its own valid answers`)
  }
})

/*
 * filesOf.
 */

test('filesOf keeps the field\'s ceiling and drops the repeats', () => {
  const template = model('collage')
  const photos = photoField(template, 'photos')
  assert.equal(photos.max, 16)
  const names = ['', 'a.png', 'b.png', 'a.png', ...Array.from({ length: 20 }, (_ignored, index) => `x${String(index)}.png`)]
  const kept = filesOf(photos, names)
  assert.equal(kept.length, photos.max, `at most ${String(photos.max)} files`)
  assert.deepEqual(kept.slice(0, 2), ['a.png', 'b.png'], 'in the order given, the repeat dropped')
  assert.equal(new Set(kept).size, kept.length, 'no file twice')
  assert.ok(!kept.includes(''), 'an empty name is not a file')
  assert.deepEqual(filesOf(photos, undefined), [], 'no field in the body is no file')
  const one = photoField(model('photo-edit'), 'photo')
  assert.deepEqual(filesOf(one, ['a.png', 'b.png', 'c.png']), ['a.png'], 'a one-photo field keeps one')
})

/*
 * The two engine defects this file found, fixed on 2026-11-15 and kept here as
 * regressions: a run made once has to hear the choice that changes what it
 * does, and a list typed by hand is a list of runs.
 */

/** The one job an expansion holds, read as a job. */
function onlyJob(template: Template, values: TemplateValues): PlanJob {
  const plans = expandTemplate(template, values)
  assert.equal(plans.length, 1, `${template.id} should queue one run here, not ${String(plans.length)}`)
  const plan: PlanJobOrCompose | undefined = plans[0]
  assert.ok(plan, `${template.id} queued nothing`)
  if (plan.kind !== 'job') assert.fail(`${template.id} queued a ${plan.kind}, not a job`)
  return plan
}

test('a choice that names its own action runs it: a cut-out is a bg job', () => {
  // `photo-edit` gives its «Cut the subject out» option `action: 'bg'`, and
  // `background` does the same for «Transparent». A run made once is not
  // unrolled over anything, so it hears the picked option through the step's
  // `optionFrom`: without it the action stays `remix` and, as the option
  // carries no prompt, the run would arrive with no words to read.
  const edit = model('photo-edit')
  const isolated = onlyJob(edit, answersFor(edit, { edit: 'isolate' }))
  assert.equal(isolated.action, 'bg', 'a cut-out is a bg job')
  assert.equal(isolated.prompt, '', 'a cut-out has no words to read')
  assert.deepEqual(isolated.source, { kind: 'file', name: 'p1.png' }, 'the cut-out takes the photo the form was given')

  const background = model('background')
  const transparent = onlyJob(background, answersFor(background, { mode: 'transparent' }))
  assert.equal(transparent.action, 'bg', 'a transparent background is a bg job')
  assert.equal(transparent.prompt, '', 'the option writes no words: the job is the cut')
  // The other modes still draw, with the words of the option picked.
  const white = onlyJob(background, answersFor(background, { mode: 'white' }))
  assert.equal(white.action, 'remix', 'a background that is not cut is drawn')
  assert.ok(white.prompt.includes('pure white background'), `the white mode writes its own words: ${white.prompt}`)
})

test('the custom emoji pack makes one sticker per expression the user typed', () => {
  const template = model('emoji-pack')
  const expressions = ['laughing out loud', 'crying', 'sleepy']
  // The box is one text: the list is split on its commas and its lines, one
  // sticker per expression, and each run carries that expression only.
  const plans = expandTemplate(template, answersFor(template, { pack: 'custom', list: 'laughing out loud, crying\nsleepy' }))
  assert.equal(plans.length, 3, 'one sticker per expression of the list the user typed')
  plans.forEach((plan, index) => {
    assert.equal(plan.kind, 'job')
    if (plan.kind !== 'job') return
    const own = expressions[index]
    assert.ok(own, 'the run has an expression')
    assert.ok(plan.prompt.includes(`this expression: ${own}.`), `the run for ${own} carries its own expression: ${plan.prompt}`)
    for (const other of expressions) {
      if (other === own) continue
      assert.ok(!plan.prompt.includes(other), `the run for ${own} also carries ${other}`)
    }
    assert.deepEqual(plan.source, { kind: 'file', name: 'p1.png' }, 'the subject is the photo the form was given')
    assert.equal(firstJobOf(plan).action, 'bg', 'every sticker of the pack is cut out afterwards')
  })
})

/*
 * A compose is fed the same way a job's photo is: through `filesOf`.
 */

test('a compose lays out at most the field\'s ceiling, and no photo twice', () => {
  const template = model('collage')
  const photos = photoField(template, 'photos')
  const many = ['a.png', 'a.png', ...Array.from({ length: 20 }, (_ignored, index) => `x${String(index)}.png`)]
  const plans = expandTemplate(template, answersFor(template, { style: 'grid' }, { photos: many }))
  assert.equal(plans.length, 1)
  const plan: PlanJobOrCompose | undefined = plans[0]
  assert.ok(plan)
  if (plan.kind !== 'compose') assert.fail('a grid is composed, not drawn')
  assert.equal(plan.files.length, photos.max, `at most ${String(photos.max)} photos go on the grid`)
  assert.equal(new Set(plan.files).size, plan.files.length, 'a name given twice is laid out once')
  assert.deepEqual(plan.files.slice(0, 2), ['a.png', 'x0.png'], 'in the order given, the repeat dropped')
})

/*
 * The fixes of the 2026-11-16 review.
 */

test('the custom emoji list is capped at twelve, with a sentence of its own', () => {
  const template = model('emoji-pack')
  const thirteen = Array.from({ length: 13 }, (_ignored, index) => `mood ${String(index)}`).join(', ')
  const values = answersFor(template, { pack: 'custom', list: thirteen })
  assert.deepEqual(templateProblems(template, values), [
    { key: 'template.tooManyItems', field: 'list', args: { label: 'Your own expressions', max: 12 } },
  ])
  // A caller that did not ask the checks still cannot queue more than twelve.
  assert.equal(expandTemplate(template, values).length, 12)
  const twelve = Array.from({ length: 12 }, (_ignored, index) => `mood ${String(index)}`).join('\n')
  assert.deepEqual(templateProblems(template, answersFor(template, { pack: 'custom', list: twelve })), [])
})

test('the options that need words say so: my own list, a scene, an object to remove', () => {
  const emoji = model('emoji-pack')
  assert.deepEqual(templateProblems(emoji, answersFor(emoji, { pack: 'custom', list: '  ' })), [
    { key: 'template.textRequired', field: 'list', args: { label: 'Your own expressions' } },
  ])
  const background = model('background')
  assert.deepEqual(templateProblems(background, answersFor(background, { mode: 'scene', scene: '' })), [
    { key: 'template.textRequired', field: 'scene', args: { label: 'The scene' } },
  ])
  const edit = model('photo-edit')
  assert.deepEqual(templateProblems(edit, answersFor(edit, { edit: 'remove-object', details: '' })), [
    { key: 'template.textRequired', field: 'details', args: { label: 'Details' } },
  ])
  // The fixes that read the photo alone go without.
  assert.deepEqual(templateProblems(edit, answersFor(edit, { edit: 'new-background', details: '' })), [])
  assert.deepEqual(templateProblems(edit, answersFor(edit, { edit: 'isolate', details: '' })), [])
})

test('a scene typed before switching to white does not reach the white prompt', () => {
  const background = model('background')
  const white = onlyJob(background, answersFor(background, { mode: 'white', scene: 'a neon alley' }))
  assert.ok(!white.prompt.includes('neon alley'), `the scene leaked into the white prompt: ${white.prompt}`)
  assert.ok(!white.prompt.includes('The setting'), 'and the sentence that carries it is gone')
  const scene = onlyJob(background, answersFor(background, { mode: 'scene', scene: 'a neon alley' }))
  assert.ok(scene.prompt.includes('The setting: a neon alley'), `the scene mode reads it: ${scene.prompt}`)
})

test('problems carry the field they are about, and the label in the caller\'s words', () => {
  const edit = model('photo-edit')
  const problems = templateProblems(edit, { values: { edit: 'nope' }, files: {} }, field => `«${field.id}»`)
  assert.deepEqual(problems.map(problem => [problem.key, problem.field, problem.args['label']]), [
    ['template.photosCount', 'photo', '«photo»'],
    ['template.valueNotOffered', 'edit', '«edit»'],
  ])
})

test('an empty benefit keeps its place: the next line is not promoted to headline', () => {
  const template = model('ecommerce')
  const card = expandTemplate(template, answersFor(template, { benefit1: '', benefit2: 'two', benefit3: '' }))
    .find((plan): plan is PlanCompose => plan.kind === 'compose' && plan.layout === 'text')
  assert.ok(card, 'the card is planned')
  assert.deepEqual(card.lines, ['', 'two', ''], 'one entry per line the step names, in its place')
})

test('a photo given twice is one photo for the gates and the reference', () => {
  // UGC reads the second photo as the package: the same name twice is one
  // product photo, so the run that reads a package must not appear, and the
  // spare shot stays.
  const ugc = model('ugc')
  const plans = expandTemplate(ugc, answersFor(ugc, {}, { photos: ['p1.png', 'p1.png'] }))
  const jobs = plans.filter((plan): plan is PlanJob => plan.kind === 'job')
  assert.equal(jobs.filter(plan => plan.reference !== undefined).length, 0, 'no run reads a repeated photo as the package')
  assert.equal(jobs.filter(plan => plan.prompt.includes('next to an open box')).length, 1, 'the one-photo shot is kept')
})
