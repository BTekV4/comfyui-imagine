/**
 * «Templates»: the ready-made models of the home page.
 *
 * A template is a form (photos, choices, an aspect, some words) and a list of
 * runs. The page shows the form, the server fills the runs in with what the
 * user chose and queues them; the engine here is the part both sides share, so
 * the two never disagree about what a value means.
 *
 * The prompts are English on purpose: they are read by the models, not by the
 * user. Every label (template, field, option) carries both the English text
 * and the locale key the page translates (`locales.ts` + the packs), so the
 * server and the MCP tools can describe a template without reaching into the
 * page's dictionary.
 *
 * The expansion is a pure function: `expandTemplate(template, values)` returns
 * the runs, in order, with no I/O and no clock. It follows the shape Grok
 * Imagine's own templates use, which the notes describe:
 *
 * - a run's prompt is English text with `{{fieldId}}` placeholders
 *   ({@link fillPrompt});
 * - a choice stands for the `prompt` of the value the user picked;
 * - `forEach` unrolls a run once per selected value (one photo per style);
 * - a line whose placeholders are all empty is dropped, which is what lets one
 *   template carry two wordings of the same instruction (a preset colour and a
 *   colour typed by hand);
 * - `then` hangs further runs on the output of the run before it (a picture
 *   cut out after it was drawn, a clip animated after it was framed), and a
 *   `then` run whose `source` is `previous` reads that output.
 *
 * Two of the runs are not jobs at all: a collage and a resize are composed on
 * the server with ffmpeg ({@link PlanCompose}), with no AI in the middle.
 *
 * Shared, and so free of Node and of the DOM.
 * @module imagine-templates
 */

import type { ImagineAction } from './imagine-types.ts'
import { IMAGINE_ASPECTS, type ImagineAspect } from './imagine-media.ts'

/**
 * The actions a template may run.
 *
 * Only the ones a form can express exactly: a photo it was handed, a frame it
 * can put on a new canvas, a clip it can describe. `extend`, `redo`, `resume`
 * and the swaps read things a template has no words for.
 */
export type TemplateAction = Extract<
  ImagineAction,
  'generate' | 'remix' | 'bg' | 'video' | 'loop' | 'compose'
>

/**
 * One group of the catalog: the model panel's colour and the host's and MCP
 * tools' wording. The home grid's filter chips are a table of their own
 * (`home-groups.ts` in the page).
 */
export interface TemplateCategory {
  readonly id: string
  /** The locale key the page translates. */
  readonly labelKey: string
  /** The English text, for the server and the MCP tools. */
  readonly label: string
}

/** The groups the templates fall into, in the order the page shows them. */
export const TEMPLATE_CATEGORIES = [
  { id: 'photo', labelKey: 'imagine.templates.cat.photo', label: 'Photo' },
  { id: 'people', labelKey: 'imagine.templates.cat.people', label: 'People' },
  { id: 'style', labelKey: 'imagine.templates.cat.style', label: 'Styles' },
  { id: 'product', labelKey: 'imagine.templates.cat.product', label: 'Product' },
  { id: 'social', labelKey: 'imagine.templates.cat.social', label: 'Social' },
  { id: 'collection', labelKey: 'imagine.templates.cat.collection', label: 'Collection' },
] as const satisfies readonly TemplateCategory[]

/** One of the groups above. */
export type TemplateCategoryId = (typeof TEMPLATE_CATEGORIES)[number]['id']

/** A field that takes photos from the gallery, in the order given. */
export interface TemplatePhotoField {
  readonly kind: 'photos'
  /** The id the runs name it by. */
  readonly id: string
  /** The locale key the page translates. */
  readonly labelKey: string
  /** The English label, for the server's messages and the MCP tools. */
  readonly label: string
  /** How many photos the form insists on. */
  readonly min: number
  /** How many it takes at most. */
  readonly max: number
  /** Whether the run cannot go ahead without them. */
  readonly required?: true
}

/** One value of a choice, and what choosing it writes into the prompt. */
export interface TemplateChoiceOption {
  /** The value stored in the answers (`enhance`, `transparent`, …). */
  readonly value: string
  /** The locale key the page translates. */
  readonly labelKey: string
  /** The English label. */
  readonly label: string
  /**
   * The text this choice puts in place of its placeholder.
   *
   * Absent or empty, a line that only held the placeholder is dropped — which
   * is how "pick a preset colour" and "type the colour yourself" live in one
   * template: only one of the two lines survives.
   */
  readonly prompt?: string
  /** An action this choice runs instead of the run's own (a cut-out is `bg`). */
  readonly action?: TemplateAction
  /** A canvas this choice asks for, when it is not the run's. */
  readonly aspectRatio?: ImagineAspect
  /** Seconds this choice asks for, when it is a clip. */
  readonly seconds?: number
  /**
   * A text field this choice makes necessary.
   *
   * "Another colour" is a colour the user types: picked, the box below it has
   * to hold something, and the sentence that uses it only speaks then.
   */
  readonly requiresText?: string
}

/** A set of named values, one of which the form takes (or several). */
export interface TemplateChoiceField {
  readonly kind: 'choice'
  readonly id: string
  readonly labelKey: string
  readonly label: string
  readonly options: readonly TemplateChoiceOption[]
  /** Whether several may be picked, which unrolls a `forEach` run. */
  readonly multi?: true
  readonly required?: true
  /** The value (or values) the form starts on. */
  readonly default?: string | readonly string[]
}

/** The canvas a template asks for: one ratio, or several at once. */
export interface TemplateAspectField {
  readonly kind: 'aspect'
  readonly id: string
  readonly labelKey: string
  readonly label: string
  readonly options: readonly ImagineAspect[]
  readonly multi?: true
  readonly required?: true
  readonly default?: string | readonly string[]
}

/** Words typed by the user. */
export interface TemplateTextField {
  readonly kind: 'text'
  readonly id: string
  readonly labelKey: string
  readonly label: string
  readonly required?: true
  /** Whether the form draws a box of several lines. */
  readonly multiline?: true
  /** The locale key of the hint the empty box shows. */
  readonly placeholderKey?: string
  /** The English hint, for the MCP tools. */
  readonly placeholder?: string
  /** The longest text the form accepts. */
  readonly maxLength?: number
  /**
   * The most items a list box may hold, for a box a `forEach` unrolls (one
   * run per item, separated by commas or lines): every item is a job on the
   * GPU, so a list is capped like a photo field is.
   */
  readonly maxItems?: number
  /**
   * Only this box's words are used when the choice holds one of these values.
   *
   * The companion of {@link TemplateChoiceOption.requiresText}: a colour typed
   * by hand must not also be written into the sentence of a preset colour.
   */
  readonly onlyWith?: { readonly field: string; readonly values: readonly string[] }
}

/** One field of a template's form, in the order the form shows it. */
export type TemplateField = TemplatePhotoField | TemplateChoiceField | TemplateAspectField | TemplateTextField

/**
 * How a compose run lays its photos out, on the server and with no AI.
 *
 * `grid` tiles them, `strip` stacks them in one column with white margins (the
 * photo-booth strip), `resize` puts one photo on a canvas of another ratio, and
 * `text` writes the user's own words under it (a product card, a poster).
 */
export type TemplateLayout = 'grid' | 'strip' | 'resize' | 'text'

/**
 * A run of a template that is not a job: ffmpeg composes the file.
 *
 * The three parts — the photos, the words, the canvas — are read the same way
 * a job's are, and the result is a gallery file a `then` run may continue from.
 */
export interface TemplateComposeStep {
  readonly kind: 'compose'
  readonly layout: TemplateLayout
  /**
   * The photo field whose files are laid out, in the order given, or
   * `previous` for the file the step before produced (a still put on another
   * canvas after it was drawn).
   */
  readonly field: string
  /** Photos per row, for the grid; absent, the layout picks the shape. */
  readonly columns?: number
  /** The canvas: a literal, or `{{id}}` of an aspect field. */
  readonly aspectRatio?: string
  /** How a photo meets a canvas of another ratio: cropped, or laid on a colour. */
  readonly fit?: 'fill' | 'pad'
  /** A choice field whose selected value (`fill` / `pad`) decides the fit. */
  readonly fitFrom?: string
  /** The colour behind a padded photo, as `#rrggbb`. */
  readonly background?: string
  /** The text fields drawn on the file, in order, when `layout` is `text`. */
  readonly lines?: readonly string[]
  /** A choice or aspect field that makes one compose per selected value. */
  readonly forEach?: string
  /** Only when the choice holds one of these values. */
  readonly whenChoice?: { readonly field: string; readonly values: readonly string[] }
  /** Only when none of these values is selected. */
  readonly unlessChoice?: { readonly field: string; readonly values: readonly string[] }
  /** Runs on this file, once it exists. */
  readonly then?: readonly TemplateStep[]
}

/**
 * A run of a template: one job, its intent, and what continues it.
 *
 * `source` names the photo field the run reads (its first file); `reference`
 * a second photo field (its second file, for a field holding a set); the value
 * `previous` is the file the step before produced.
 */
export interface TemplateJobStep {
  readonly kind: 'job'
  readonly action: TemplateAction
  /** The intent, in English, with `{{fieldId}}` placeholders. */
  readonly prompt: string
  /** The photo field it starts from, or `previous`. */
  readonly source?: string
  /** The second photo field it reads. */
  readonly reference?: string
  /** The canvas: a literal, or `{{id}}` of an aspect field. */
  readonly aspectRatio?: string
  /** The seconds a clip is asked for. */
  readonly seconds?: number
  /** A choice or aspect field that makes one run per selected value. */
  readonly forEach?: string
  /**
   * The choice field whose picked option overrides this run's action.
   *
   * A `forEach` run already reads the option it is unrolled over; a run that
   * is made once still has to hear the one choice that changes what it does —
   * "cut the subject out" is the `bg` action, not an edit with nothing to say.
   */
  readonly optionFrom?: string
  /** Runs on this run's output. */
  readonly then?: readonly TemplateStep[]
  /**
   * Only when this photo field holds at least this many files.
   *
   * The icon and mascot forms take an optional reference photo, and the runs
   * that read it are the redraws: without the photo they would have nothing to
   * anchor to, and the plain generations take their place. The UGC form reads
   * the second photo as the package's reference, and the runs that use it need
   * the user to have given two.
   */
  readonly whenFiles?: { readonly field: string; readonly atLeast: number }
  /** Only when this photo field holds fewer files than this (the plain runs). */
  readonly unlessFiles?: { readonly field: string; readonly fewerThan: number }
  /**
   * Only when the choice holds one of these values.
   *
   * A pack of emoji is one list of runs, one per expression; a collage is one
   * layout per style picked; a cut-out chain runs only when the user asked for
   * a transparent background. The gate is read on the step, `then` steps
   * included, so a chain can hang a step on a choice.
   */
  readonly whenChoice?: { readonly field: string; readonly values: readonly string[] }
  /** Only when none of these values is selected. */
  readonly unlessChoice?: { readonly field: string; readonly values: readonly string[] }
}

/** One run of a template, before the answers are filled in. */
export type TemplateStep = TemplateJobStep | TemplateComposeStep

/** A model of the home page. */
export interface Template {
  /** The id the route and the page speak (`photo-edit`). */
  readonly id: string
  /** Which group it belongs to. */
  readonly category: TemplateCategoryId
  /**
   * The card's cover, a WebP of the repository's own renders:
   * `/imagine/tpl-<id>.webp`, made with the studio from invented subjects.
   *
   * Absent, the home card shows a plain bed and the panel the gradient of
   * its group.
   */
  readonly cover?: string
  /** The locale key of the card's title. */
  readonly titleKey: string
  /** The English title. */
  readonly title: string
  /** The locale key of the one line under the title. */
  readonly descriptionKey: string
  /** The English one-liner. */
  readonly description: string
  /** The locale key of the paragraph beside the form. */
  readonly aboutKey: string
  /** The English explanation. */
  readonly about: string
  /** The form, in the order it is shown. */
  readonly fields: readonly TemplateField[]
  /** What submitting it queues. */
  readonly runs: readonly TemplateStep[]
}

/** The answers a form was submitted with, as the route reads them off the body. */
export interface TemplateValues {
  /** Choice values (one, or several), aspect values (one, or several), texts. */
  readonly values?: Readonly<Record<string, string | readonly string[] | undefined>>
  /** The gallery files of each photo field, in the order the user put them. */
  readonly files?: Readonly<Record<string, readonly string[] | undefined>>
}

/** The file a run reads: a gallery name, or what the step before produced. */
export type PlanFile =
  | { readonly kind: 'file'; readonly name: string }
  | { readonly kind: 'previous' }

/** One run, with every value filled in: what the server queues. */
export interface PlanJob {
  readonly kind: 'job'
  readonly action: TemplateAction
  readonly prompt: string
  readonly source?: PlanFile
  readonly reference?: PlanFile
  readonly aspectRatio?: ImagineAspect
  readonly seconds?: number
  /** The runs that continue this one, with `previous` as their source. */
  readonly then: readonly PlanJobOrCompose[]
}

/** One compose run, with every value filled in. */
export interface PlanCompose {
  readonly kind: 'compose'
  readonly layout: TemplateLayout
  /** The gallery files laid out; empty when the step reads the one before. */
  readonly files: readonly string[]
  /**
   * The step before's file is the picture (a chain over a drawn still): the
   * composition reads the file the chain hands it, and `files` is empty.
   */
  readonly fromPrevious?: true
  readonly columns?: number
  readonly aspectRatio?: ImagineAspect
  readonly fit: 'fill' | 'pad'
  readonly background: string
  /**
   * The words of a `text` layout, one per line the step names and in its
   * order, an empty string for a box left empty: the position is what gives a
   * line its size, so an empty headline does not promote the line under it.
   */
  readonly lines: readonly string[]
  readonly then: readonly PlanJobOrCompose[]
}

/** One planned run. */
export type PlanJobOrCompose = PlanJob | PlanCompose

/** What is wrong with a form's answers, as a sentence the route writes. */
export interface TemplateProblem {
  /** A key of the server's message table (`template.photosCount`, …). */
  readonly key: string
  /**
   * The id of the field the problem is about: the page writes that field's
   * own label (`labelKey`) in its language, instead of the English `label`
   * the arguments carry.
   */
  readonly field: string
  /** The placeholders of that sentence. */
  readonly args: Readonly<Record<string, string | number>>
}

/** The text a placeholder with nothing behind it reads as. */
const BLANK = ''

/** A placeholder, `{{id}}`, anywhere in a line. */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g

/** Whether an aspect is one the studio draws on. */
function isAspect(value: string): value is ImagineAspect {
  return (IMAGINE_ASPECTS as readonly string[]).includes(value)
}

/**
 * The field with this id, when the template has one.
 * @param template - the template.
 * @param id - the field's id.
 * @returns the field, or undefined.
 */
export function fieldOf(template: Template, id: string): TemplateField | undefined {
  return template.fields.find(field => field.id === id)
}

/**
 * The template with this id, when the catalog has one.
 * @param id - the template's id.
 * @returns the template, or undefined.
 */
export function templateById(id: string): Template | undefined {
  return TEMPLATES.find(template => template.id === id)
}

/**
 * The values an aspect or choice field has selected: a list for the fields
 * that take several, a one-item list for the ones that take one.
 *
 * Nothing selected falls back to the field's default, which is what an empty
 * form submits. A value the field does not offer is dropped: a body is not
 * trusted, and a value that is not offered has no prompt to write.
 * @param field - the choice or aspect field.
 * @param raw - what the body carried for it.
 * @returns the selected values, in the order given.
 */
function selectedOf(
  field: TemplateChoiceField | TemplateAspectField,
  raw: string | readonly string[] | undefined,
): readonly string[] {
  const offered: readonly string[] = field.kind === 'aspect'
    ? field.options
    : field.options.map(option => option.value)
  const asked = raw === undefined ? field.default : raw
  const list = typeof asked === 'string' ? [asked] : asked ?? []
  const kept = list.filter(value => typeof value === 'string' && offered.includes(value))
  const unique = [...new Set(kept)]
  if (!field.multi && unique.length > 1) return unique.slice(0, 1)
  return unique
}

/**
 * The text of a field the user typed, trimmed; empty when there is none.
 * @param raw - what the body carried.
 * @returns the text, or an empty string.
 */
function textOf(raw: string | readonly string[] | undefined): string {
  if (typeof raw !== 'string') return BLANK
  return raw.trim()
}

/**
 * The files of a photo field: the gallery names, in the order given.
 *
 * Empty names and repeats are dropped, and the field's own ceiling is
 * enforced here as well as by {@link templateProblems}, so a body that asks
 * for forty photos cannot make forty runs (a photo collage is where that used
 * to hurt).
 * @param field - the photo field.
 * @param raw - what the body carried for it.
 * @returns the names.
 */
export function filesOf(field: TemplatePhotoField, raw: readonly string[] | undefined): readonly string[] {
  const kept = (raw ?? []).filter((name): name is string => typeof name === 'string' && name.length > 0)
  const unique = [...new Set(kept)]
  return unique.slice(0, Math.max(0, field.max))
}

/**
 * The items of a list typed by hand, the way a `forEach` unrolls them:
 * separated by commas or by lines, trimmed, the empty ones dropped.
 * @param raw - what the body carried for the box.
 * @returns the items, in the order written.
 */
export function listItems(raw: string | readonly string[] | undefined): readonly string[] {
  return textOf(raw)
    .split(/[,\n]/)
    .map(item => item.trim())
    .filter(item => item.length > 0)
}

/**
 * What the answers get wrong, as the sentences the route writes back.
 *
 * The checks are the same ones the page makes before it sends: a form that
 * lost its photos in a reload, an aspect nobody offers, a text a template
 * cannot run without, a list longer than the box takes. The photo counts come
 * first — they are the field a template is unusable without.
 *
 * The `label` argument of each problem is the field's name as `labelOf` gives
 * it: the English `label` by default, the reader's language when the caller
 * passes a translation (the route does, from the request's language; the page
 * writes its own from `field`).
 * @param template - the template.
 * @param values - the answers.
 * @param labelOf - the name of a field, in the language the sentence is written in.
 * @returns the problems, in the order the fields are shown; empty when fine.
 */
export function templateProblems(
  template: Template,
  values: TemplateValues,
  labelOf: (field: TemplateField) => string = field => field.label,
): readonly TemplateProblem[] {
  const problems: TemplateProblem[] = []
  const files = values.files ?? {}
  const answers = values.values ?? {}
  const problem = (key: string, field: TemplateField, args: Readonly<Record<string, string | number>> = {}): void => {
    problems.push({ key, field: field.id, args: { label: labelOf(field), ...args } })
  }
  for (const field of template.fields) {
    if (field.kind === 'photos') {
      const count = filesOf(field, files[field.id]).length
      const short = count < field.min
      const long = count > field.max || (files[field.id]?.length ?? 0) > field.max
      if (short || long) problem('template.photosCount', field, { min: field.min, max: field.max })
      continue
    }
    if (field.kind === 'text') {
      const text = textOf(answers[field.id])
      if (text.length === 0 && field.required === true) {
        problem('template.textRequired', field)
      } else if (field.maxLength !== undefined && text.length > field.maxLength) {
        problem('template.textTooLong', field, { max: field.maxLength })
      } else if (field.maxItems !== undefined && listItems(answers[field.id]).length > field.maxItems) {
        problem('template.tooManyItems', field, { max: field.maxItems })
      }
      continue
    }
    const raw = answers[field.id]
    const offered: readonly string[] = field.kind === 'aspect'
      ? field.options
      : field.options.map(option => option.value)
    const asked = typeof raw === 'string' ? [raw] : raw ?? []
    const unknown = asked.filter(value => !offered.includes(value))
    if (unknown.length > 0) {
      problem('template.valueNotOffered', field, { value: unknown.join(', ') })
      continue
    }
    if (asked.length > 1 && field.multi !== true) {
      problem('template.oneValueOnly', field)
      continue
    }
    const selected = selectedOf(field, raw)
    for (const value of selected) {
      const option = field.kind === 'choice' ? field.options.find(entry => entry.value === value) : undefined
      const needed = option?.requiresText === undefined ? undefined : fieldOf(template, option.requiresText)
      if (needed !== undefined && needed.kind === 'text' && textOf(answers[needed.id]).length === 0) {
        problem('template.textRequired', needed)
      }
    }
    if (selected.length === 0 && field.required === true) {
      problem(field.kind === 'aspect' ? 'template.aspectRequired' : 'template.choiceRequired', field)
    }
  }
  return problems
}

/**
 * Whether the choice a gate names holds one of its values.
 * @param template - the template.
 * @param gate - the field and the values to look for.
 * @param answers - the answers.
 * @returns true when at least one of the values is selected.
 */
function choiceHolds(
  template: Template,
  gate: { readonly field: string; readonly values: readonly string[] },
  answers: Readonly<Record<string, string | readonly string[] | undefined>>,
): boolean {
  const field = fieldOf(template, gate.field)
  if (field === undefined || field.kind === 'photos' || field.kind === 'text') return false
  return selectedOf(field, answers[gate.field]).some(value => gate.values.includes(value))
}

/**
 * One field's contribution to the prompt, for the run being written.
 *
 * A choice gives its option's `prompt`; given several, the ones the prompt
 * asks for are joined, and a run unrolled over one of them sees only that one.
 * A photo and an aspect say nothing: they are the attachments and the canvas,
 * not words.
 * @param field - the field.
 * @param answers - the answers.
 * @param scope - the value a `forEach` run is being written for, when any.
 * @returns the text the placeholder stands for; empty when it says nothing.
 */
function wordsOf(
  template: Template,
  field: TemplateField,
  answers: Readonly<Record<string, string | readonly string[] | undefined>>,
  scope: { readonly field: string; readonly value: string } | undefined,
): string {
  if (field.kind === 'photos' || field.kind === 'aspect') return BLANK
  if (field.kind === 'text') {
    if (scope !== undefined && scope.field === field.id) return scope.value
    if (field.onlyWith !== undefined && !choiceHolds(template, field.onlyWith, answers)) return BLANK
    return textOf(answers[field.id])
  }
  const selected = selectedOf(field, answers[field.id])
  const wanted = scope !== undefined && scope.field === field.id ? [scope.value] : selected
  const words = wanted
    .map(value => field.options.find(option => option.value === value)?.prompt ?? BLANK)
    .filter(prompt => prompt.length > 0)
  return words.join(' ')
}

/**
 * Fill a run's prompt in, and drop the lines that came out empty.
 *
 * A line that held a placeholder and whose placeholders all say nothing goes
 * away whole, its own words with it: that is what makes one template carry
 * both "the colour you picked" and "the colour you typed" without the sentence
 * that did not apply. Then blank lines fold and the text is trimmed.
 * @param template - the template.
 * @param templatePrompt - the run's intent, with placeholders.
 * @param values - the answers.
 * @param scope - the value a `forEach` run is being written for, when any.
 * @returns the prompt to send.
 */
export function fillPrompt(
  template: Template,
  templatePrompt: string,
  values: TemplateValues,
  scope?: { readonly field: string; readonly value: string },
): string {
  const answers = values.values ?? {}
  const filled = (line: string): { readonly text: string; readonly empty: boolean } => {
    let seen = 0
    let said = false
    const text = line.replace(PLACEHOLDER, (_whole, id: string) => {
      seen += 1
      const field = fieldOf(template, id)
      const words = field === undefined ? BLANK : wordsOf(template, field, answers, scope)
      if (words.length > 0) said = true
      return words
    })
    return { text: text.trim(), empty: seen > 0 && !said }
  }
  const lines = templatePrompt.split('\n')
    .map(filled)
    .filter(line => !line.empty && line.text.length > 0)
    .map(line => line.text)
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * The canvas a run asks for: the literal, the aspect field's value, or the
 * value of the choice the run was unrolled over.
 * @param asked - the run's `aspectRatio`.
 * @param values - the answers.
 * @param scope - the value a `forEach` run is being written for.
 * @returns the ratio, or undefined when none was asked for.
 */
function aspectOf(
  template: Template,
  asked: string | undefined,
  values: TemplateValues,
  scope: { readonly field: string; readonly value: string } | undefined,
): ImagineAspect | undefined {
  if (asked === undefined) {
    // A `forEach` over an aspect field unrolls the run on that ratio.
    if (scope === undefined) return undefined
    const field = fieldOf(template, scope.field)
    return field?.kind === 'aspect' && isAspect(scope.value) ? scope.value : undefined
  }
  const found = /^\{\{\s*([A-Za-z0-9_-]+)\s*\}\}$/.exec(asked)
  if (found === null) return isAspect(asked) ? asked : undefined
  const field = fieldOf(template, found[1]!)
  if (field?.kind === 'aspect') {
    const value = scope !== undefined && scope.field === field.id ? scope.value : selectedOf(field, values.values?.[field.id])[0]
    return value !== undefined && isAspect(value) ? value : undefined
  }
  if (field?.kind === 'choice') {
    const value = scope !== undefined && scope.field === field.id
      ? scope.value
      : selectedOf(field, values.values?.[field.id])[0]
    const option = field.options.find(entry => entry.value === value)
    return option?.aspectRatio
  }
  return undefined
}

/**
 * The photo a run reads out of a field: the first, or the second when the run
 * asks for the reference — of the list as {@link filesOf} keeps it, so a
 * repeated name is not read as the reference.
 * @param template - the template.
 * @param values - the answers.
 * @param fieldId - the field the run names.
 * @param which - the first file, or the second.
 * @returns the file, or undefined.
 */
function fileOf(template: Template, values: TemplateValues, fieldId: string, which: 'source' | 'reference'): PlanFile | undefined {
  const list = photosOf(template, values, fieldId)
  const name = which === 'source' ? list[0] : list[1]
  return typeof name === 'string' && name.length > 0 ? { kind: 'file', name } : undefined
}

/**
 * The files of a field as the runs read them: {@link filesOf}'s list (no
 * empty names, no repeats, the field's ceiling) for a photo field, the
 * non-empty names for anything else.
 * @param template - the template.
 * @param values - the answers.
 * @param fieldId - the field.
 * @returns the names, in the order given.
 */
function photosOf(template: Template, values: TemplateValues, fieldId: string): readonly string[] {
  const field = fieldOf(template, fieldId)
  const raw = values.files?.[fieldId]
  if (field?.kind === 'photos') return filesOf(field, raw)
  return (raw ?? []).filter(name => typeof name === 'string' && name.length > 0)
}

/** Whether a step runs on these answers: its gates pass. */
function runsFor(template: Template, step: TemplateStep, values: TemplateValues): boolean {
  const when = step.kind === 'job' ? step.whenFiles : undefined
  const unless = step.kind === 'job' ? step.unlessFiles : undefined
  // Counted on the deduplicated list: the same photo given twice is one photo.
  if (when !== undefined && photosOf(template, values, when.field).length < when.atLeast) return false
  if (unless !== undefined && photosOf(template, values, unless.field).length >= unless.fewerThan) return false
  const picked = (gate: { readonly field: string; readonly values: readonly string[] } | undefined): boolean => {
    if (gate === undefined) return false
    const field = fieldOf(template, gate.field)
    if (field === undefined || field.kind === 'photos' || field.kind === 'text') return false
    const selected = selectedOf(field, values.values?.[gate.field])
    return selected.some(value => gate.values.includes(value))
  }
  if (step.whenChoice !== undefined && !picked(step.whenChoice)) return false
  if (step.unlessChoice !== undefined && picked(step.unlessChoice)) return false
  return true
}

/**
 * The values a `forEach` step is unrolled over.
 *
 * A choice gives its selected values; an aspect its selected ratios. A step
 * unrolled over a field that takes one value still makes one run per value
 * chosen, so a form with nothing chosen falls back to the field's default.
 * @param template - the template.
 * @param forEach - the field id.
 * @param values - the answers.
 * @returns the values to unroll over; empty when the field selected nothing.
 */
function unrollOf(template: Template, forEach: string, values: TemplateValues): readonly string[] {
  const field = fieldOf(template, forEach)
  if (field === undefined || field.kind === 'photos') return []
  // A list typed by hand is unrolled the way it is written: separated by
  // commas or by lines, one run per item, never more than the box takes
  // (`templateProblems` refuses a longer one; this is the ceiling for a
  // caller that did not ask).
  if (field.kind === 'text') {
    const items = listItems(values.values?.[forEach])
    return field.maxItems === undefined ? items : items.slice(0, field.maxItems)
  }
  return selectedOf(field, values.values?.[forEach])
}

/**
 * Expand one step of a template into the runs it stands for.
 * @param template - the template.
 * @param step - the step.
 * @param values - the answers.
 * @param scope - the value a `forEach` run is being written for, when any.
 * @param source - the run's source when it is not its own (a `previous` chain).
 * @returns the runs.
 */
function expandStep(
  template: Template,
  step: TemplateStep,
  values: TemplateValues,
  scope: { readonly field: string; readonly value: string } | undefined,
  source: PlanFile | undefined,
): readonly PlanJobOrCompose[] {
  if (!runsFor(template, step, values)) return []
  if (step.forEach !== undefined) {
    const valuesOf = unrollOf(template, step.forEach, values)
    return valuesOf.flatMap(value => expandOnce(template, step, values, { field: step.forEach!, value }, source))
  }
  return expandOnce(template, step, values, scope, source)
}

/** One step, for one value of the field it may be unrolled over. */
function expandOnce(
  template: Template,
  step: TemplateStep,
  values: TemplateValues,
  scope: { readonly field: string; readonly value: string } | undefined,
  source: PlanFile | undefined,
): readonly PlanJobOrCompose[] {
  const then = (step.then ?? []).flatMap(next => expandStep(template, next, values, scope, { kind: 'previous' }))
  if (step.kind === 'compose') {
    const previous = step.field === 'previous'
    const files = previous ? [] : photosOf(template, values, step.field)
    // A compose on the step before only exists inside a chain: at the top
    // there is no file to continue from.
    if (!previous && files.length === 0) return []
    if (previous && source === undefined) return []
    const ratio = aspectOf(template, step.aspectRatio, values, scope)
    const fit = fitOf(template, step, values)
    const plan: PlanCompose = {
      kind: 'compose',
      layout: step.layout,
      files,
      ...previous ? { fromPrevious: true } : {},
      ...step.columns === undefined ? {} : { columns: step.columns },
      ...ratio === undefined ? {} : { aspectRatio: ratio },
      fit,
      background: step.background ?? '#ffffff',
      // Every line keeps its place, an empty box included: the place is the
      // size the composition draws it at.
      lines: (step.lines ?? []).map(id => textOf(values.values?.[id])),
      then,
    }
    return [plan]
  }
  const chosen = scope === undefined
    ? optionFromOf(template, step.optionFrom, values)
    : optionOf(template, scope)
  const action = chosen?.action ?? step.action
  const fromField = step.source === undefined ? undefined : fileOf(template, values, step.source, 'source')
  const readSource = source ?? fromField
  const reference = step.reference === undefined ? undefined : fileOf(template, values, step.reference, 'reference')
  const ratio = aspectOf(template, step.aspectRatio, values, scope) ?? chosen?.aspectRatio
  const seconds = chosen?.seconds ?? step.seconds
  const plan: PlanJob = {
    kind: 'job',
    action,
    prompt: fillPrompt(template, step.prompt, values, scope),
    ...readSource === undefined ? {} : { source: readSource },
    ...reference === undefined ? {} : { reference },
    ...ratio === undefined ? {} : { aspectRatio: ratio },
    ...seconds === undefined ? {} : { seconds },
    then,
  }
  return [plan]
}

/**
 * How a composed photo meets its canvas: the step's own choice, or the value
 * of the choice field it names (`Crop to fill` / `Keep the whole photo`).
 * @param template - the template.
 * @param step - the compose step.
 * @param values - the answers.
 * @returns the fit; cropped when nobody said otherwise.
 */
function fitOf(template: Template, step: TemplateComposeStep, values: TemplateValues): 'fill' | 'pad' {
  const field = step.fitFrom === undefined ? undefined : fieldOf(template, step.fitFrom)
  if (field?.kind === 'choice') {
    const value = selectedOf(field, values.values?.[field.id])[0]
    if (value === 'pad' || value === 'fill') return value
  }
  return step.fit ?? 'fill'
}

/** The option a `forEach` run is being written for, when any. */
function optionOf(template: Template, scope: { readonly field: string; readonly value: string }): TemplateChoiceOption | undefined {
  const field = fieldOf(template, scope.field)
  return field?.kind === 'choice' ? field.options.find(option => option.value === scope.value) : undefined
}

/**
 * The option a run that is made once hears: the one picked on the field it
 * names in `optionFrom`.
 * @param template - the template.
 * @param optionFrom - the choice field the run listens to.
 * @param values - the answers.
 * @returns the option, when the field is a choice and one value is picked.
 */
function optionFromOf(template: Template, optionFrom: string | undefined, values: TemplateValues): TemplateChoiceOption | undefined {
  if (optionFrom === undefined) return undefined
  const field = fieldOf(template, optionFrom)
  if (field?.kind !== 'choice') return undefined
  const value = selectedOf(field, values.values?.[field.id])[0]
  return value === undefined ? undefined : field.options.find(option => option.value === value)
}

/**
 * Expand a template with a form's answers: the runs to queue, in order.
 *
 * Pure: the same template and the same answers always give the same runs. The
 * caller validates first ({@link templateProblems}); expansion trusts the
 * answers, keeps what it can read and drops the rest.
 * @param template - the template.
 * @param values - the answers.
 * @returns the runs, top level first, each carrying its chain.
 */
export function expandTemplate(template: Template, values: TemplateValues): readonly PlanJobOrCompose[] {
  return template.runs.flatMap(step => expandStep(template, step, values, undefined, undefined))
}

/**
 * The four directions an icon pack is drawn in: one run each, so the same idea
 * comes back four ways and the user picks.
 */
const ICON_DIRECTIONS = [
  'a solid, heavy glyph centred in the frame',
  'a glyph set inside a rounded square badge',
  'a glyph with a soft shadow, lifted a little off the background',
  'a light, minimal glyph that uses the empty space around it',
] as const

/** A still put on a canvas of another ratio: a remix keeps the canvas it found. */
function onCanvas(aspectRatio: ImagineAspect, fit: 'fill' | 'pad' = 'fill'): TemplateComposeStep {
  return { kind: 'compose', layout: 'resize', field: 'previous', aspectRatio, fit }
}

/** A run's output cut out, for a file with a transparent background. */
function cutOut(): TemplateStep {
  return { kind: 'job', action: 'bg', prompt: '', source: 'previous' }
}

/** The same, only when the user picked the transparent background. */
function cutOutWhenTransparent(): TemplateStep {
  return { ...cutOut(), whenChoice: { field: 'background', values: ['transparent'] } }
}

/** The character of a sprite, animated into the clip the form asked for. */
function animate(): TemplateStep {
  return { kind: 'job', action: 'loop', source: 'previous', aspectRatio: '1:1', seconds: 5, prompt: '{{motion}}' }
}

/**
 * The catalog: the sixteen models of the home page, in the order it shows them.
 *
 * Every prompt here is written for this studio in English; the titles, the
 * labels and the one-liners carry a locale key each (`imagine.tpl.<id>…`) and
 * the English text the host and the MCP tools read. The form fields follow the
 * order a person fills them in.
 */
export const TEMPLATES = [
  {
    id: 'photo-edit',
    category: 'photo',
    cover: '/imagine/tpl-photo-edit.webp',
    titleKey: 'imagine.tpl.photoEdit.title',
    title: 'Photo edit',
    descriptionKey: 'imagine.tpl.photoEdit.desc',
    description: 'Nine quick fixes for one photo: clean it up, retouch it, take the subject out, restyle the light.',
    aboutKey: 'imagine.tpl.photoEdit.about',
    about: 'Pick the fix you want and, if you like, add a line in your own words. The edit is anchored to your photo, and the instruction is grounded on what is really in the frame.',
    fields: [
      { kind: 'photos', id: 'photo', labelKey: 'imagine.tpl.photoEdit.f.photo', label: 'Photo', min: 1, max: 1, required: true },
      {
        kind: 'choice', id: 'edit', labelKey: 'imagine.tpl.photoEdit.f.edit', label: 'Fix', required: true,
        options: [
          {
            value: 'enhance', labelKey: 'imagine.tpl.photoEdit.o.edit.enhance', label: 'Clean up and enhance',
            prompt: 'Clean this photo up: recover the light in the shadows and in the highlights, take out the noise and the colour cast, and bring back the fine detail, leaving every person and every object exactly where it is.',
          },
          {
            value: 'remove-object', labelKey: 'imagine.tpl.photoEdit.o.edit.removeObject', label: 'Remove an object',
            prompt: 'Take out the small distracting object named below and rebuild the background behind it so the area matches its surroundings: the same texture and the same light, with nothing left of the object.',
            // "The object named below" is the details box: without it there is
            // nothing to take out.
            requiresText: 'details',
          },
          {
            value: 'polish', labelKey: 'imagine.tpl.photoEdit.o.edit.polish', label: 'Polish the photo',
            prompt: 'Retouch the photo the way a careful retoucher would: even out the skin while keeping its texture, tidy the stray hairs and the edges, and balance the colour, without changing the person.',
          },
          {
            value: 'new-background', labelKey: 'imagine.tpl.photoEdit.o.edit.newBackground', label: 'New background',
            prompt: 'Replace the background with a clean studio backdrop that is softly lit and matches the light already on the subject, keeping the subject, its edges and its shadow exactly as they are.',
          },
          {
            value: 'isolate', labelKey: 'imagine.tpl.photoEdit.o.edit.isolate', label: 'Cut the subject out',
            action: 'bg',
          },
          {
            value: 'black-and-white', labelKey: 'imagine.tpl.photoEdit.o.edit.blackAndWhite', label: 'Black and white',
            prompt: 'Turn this photo into a rich black and white: deep but open blacks, soft midtones and a fine grain, with the same framing and the same light it has now.',
          },
          {
            value: 'warm', labelKey: 'imagine.tpl.photoEdit.o.edit.warm', label: 'Warm and cosy',
            prompt: 'Grade this photo warm and cosy: golden late-afternoon light, soft shadows and gentle contrast, the mood of a quiet Sunday at home.',
          },
          {
            value: 'sharpen', labelKey: 'imagine.tpl.photoEdit.o.edit.sharpen', label: 'Sharpen',
            prompt: 'Raise the micro-contrast so that textures and edges read crisp and clean, with no halos and no extra grain.',
          },
          {
            value: 'blur-background', labelKey: 'imagine.tpl.photoEdit.o.edit.blurBackground', label: 'Blur the background',
            prompt: 'Blur the background into a smooth bokeh, as if the photo had been taken with a wide-open lens, while the subject stays sharp.',
          },
        ],
      },
      {
        kind: 'text', id: 'details', labelKey: 'imagine.tpl.photoEdit.f.details', label: 'Details', multiline: true, maxLength: 400,
        placeholderKey: 'imagine.tpl.photoEdit.ph.details', placeholder: 'What is the object, and what else should change?',
      },
    ],
    runs: [
      { kind: 'job', action: 'remix', source: 'photo', optionFrom: 'edit', prompt: '{{edit}}\n{{details}}' },
    ],
  },
  {
    id: 'background',
    category: 'photo',
    cover: '/imagine/tpl-background.webp',
    titleKey: 'imagine.tpl.background.title',
    title: 'Background',
    descriptionKey: 'imagine.tpl.background.desc',
    description: 'Cut the subject out on transparency, put it on pure white, or drop it into a scene you describe.',
    aboutKey: 'imagine.tpl.background.about',
    about: 'Transparency comes back as a PNG with alpha. A described scene keeps the light that is already on the subject, so it does not look pasted in.',
    fields: [
      { kind: 'photos', id: 'photo', labelKey: 'imagine.tpl.background.f.photo', label: 'Photo', min: 1, max: 1, required: true },
      {
        kind: 'choice', id: 'mode', labelKey: 'imagine.tpl.background.f.mode', label: 'Background', required: true,
        options: [
          { value: 'transparent', labelKey: 'imagine.tpl.background.o.mode.transparent', label: 'Transparent', action: 'bg' },
          {
            value: 'white', labelKey: 'imagine.tpl.background.o.mode.white', label: 'Pure white',
            prompt: 'Put the subject on a pure white background, evenly lit, with only a soft contact shadow underneath and nothing else in the frame.',
          },
          {
            value: 'scene', labelKey: 'imagine.tpl.background.o.mode.scene', label: 'A scene you describe',
            prompt: 'Place the subject in the setting described below, matching the direction and the colour of the light that is already on it, with a floor and a background that hold up in perspective.',
            requiresText: 'scene',
          },
        ],
      },
      {
        kind: 'text', id: 'scene', labelKey: 'imagine.tpl.background.f.scene', label: 'The scene', multiline: true, maxLength: 300,
        placeholderKey: 'imagine.tpl.background.ph.scene', placeholder: 'A warm kitchen, a stone wall at sunset, a blue paper backdrop…',
        // A scene typed before switching to white must not reach the white prompt.
        onlyWith: { field: 'mode', values: ['scene'] },
      },
    ],
    runs: [
      { kind: 'job', action: 'remix', source: 'photo', optionFrom: 'mode', prompt: '{{mode}}\nThe setting: {{scene}}' },
    ],
  },
  {
    id: 'headshot',
    category: 'people',
    cover: '/imagine/tpl-headshot.webp',
    titleKey: 'imagine.tpl.headshot.title',
    title: 'Professional headshot',
    descriptionKey: 'imagine.tpl.headshot.desc',
    description: 'Turn a casual photo into a headshot with proper light, a clean background and the right clothes.',
    aboutKey: 'imagine.tpl.headshot.about',
    about: 'The face, the hair and the identity stay the ones in your photo: what changes is the light, the framing and the clothes.',
    fields: [
      { kind: 'photos', id: 'photo', labelKey: 'imagine.tpl.headshot.f.photo', label: 'Photo', min: 1, max: 1, required: true },
      {
        kind: 'choice', id: 'attire', labelKey: 'imagine.tpl.headshot.f.attire', label: 'What to wear', required: true,
        options: [
          { value: 'suit', labelKey: 'imagine.tpl.headshot.o.attire.suit', label: 'A suit', prompt: 'a tailored dark suit over a crisp shirt' },
          { value: 'business-casual', labelKey: 'imagine.tpl.headshot.o.attire.businessCasual', label: 'Business casual', prompt: 'a neat business-casual shirt or a fine knit, with no jacket' },
          { value: 'neutral', labelKey: 'imagine.tpl.headshot.o.attire.neutral', label: 'Plain and neutral', prompt: 'plain, neutral clothing with no logos and no patterns' },
        ],
      },
      {
        kind: 'text', id: 'notes', labelKey: 'imagine.tpl.headshot.f.notes', label: 'Notes', multiline: true, maxLength: 300,
        placeholderKey: 'imagine.tpl.headshot.ph.notes', placeholder: 'Anything the shot has to say about the person?',
      },
    ],
    runs: [
      {
        kind: 'job', action: 'remix', source: 'photo',
        prompt: 'Reshoot this photo as a professional headshot: head and shoulders, the body slightly turned, a confident and relaxed expression.\nLight it with a soft key light and a gentle fill, against a quietly graded studio background.\nDress the person in {{attire}}.\nKeep the face, the hair, the skin tone and the identity exactly as they are in the photo.\n{{notes}}',
      },
    ],
  },
  {
    id: 'profile-picture',
    category: 'people',
    cover: '/imagine/tpl-profile-picture.webp',
    titleKey: 'imagine.tpl.profilePicture.title',
    title: 'Profile picture',
    descriptionKey: 'imagine.tpl.profilePicture.desc',
    description: 'Four profile photos of the same person, in four everyday settings, keeping or changing the outfit.',
    aboutKey: 'imagine.tpl.profilePicture.about',
    about: 'Four runs, one per setting, so you can pick the one that looks like you. The face is the one in your photo in every one of them.',
    fields: [
      { kind: 'photos', id: 'photo', labelKey: 'imagine.tpl.profilePicture.f.photo', label: 'Photo', min: 1, max: 1, required: true },
      {
        kind: 'choice', id: 'outfit', labelKey: 'imagine.tpl.profilePicture.f.outfit', label: 'The outfit', required: true, default: 'keep',
        options: [
          { value: 'keep', labelKey: 'imagine.tpl.profilePicture.o.outfit.keep', label: 'Keep the same outfit', prompt: 'in the clothes they are already wearing' },
          { value: 'change', labelKey: 'imagine.tpl.profilePicture.o.outfit.change', label: 'A different outfit', prompt: 'in different everyday clothes that suit the setting' },
        ],
      },
    ],
    runs: [
      { kind: 'job', action: 'remix', source: 'photo', prompt: 'A natural profile photo of the person {{outfit}}, outdoors in the soft golden light of late afternoon, with a street or a park softly out of focus behind them.\nKeep the face, the hair and the identity exactly as they are in the photo; the expression friendly and unposed, the look of a photo taken by a friend.' },
      { kind: 'job', action: 'remix', source: 'photo', prompt: 'A natural profile photo of the person {{outfit}}, sitting in a bright cafe by the window, warm daylight coming from the side and the room softly blurred behind them.\nKeep the face, the hair and the identity exactly as they are in the photo; the expression friendly and unposed, the look of a photo taken by a friend.' },
      { kind: 'job', action: 'remix', source: 'photo', prompt: 'A natural profile photo of the person {{outfit}}, against a plain gently lit wall, the light soft and even, nothing else in the frame.\nKeep the face, the hair and the identity exactly as they are in the photo; the expression friendly and unposed, the look of a photo taken by a friend.' },
      { kind: 'job', action: 'remix', source: 'photo', prompt: 'A natural profile photo of the person {{outfit}}, on a city street in the morning, the light fresh and the street alive but out of focus behind them.\nKeep the face, the hair and the identity exactly as they are in the photo; the expression friendly and unposed, the look of a photo taken by a friend.' },
    ],
  },
  {
    id: 'restyle',
    category: 'style',
    cover: '/imagine/tpl-restyle.webp',
    titleKey: 'imagine.tpl.restyle.title',
    title: 'Restyle',
    descriptionKey: 'imagine.tpl.restyle.desc',
    description: 'Redraw the photo in the styles you pick: one picture per style, the same subject and pose.',
    aboutKey: 'imagine.tpl.restyle.about',
    about: 'Pick one style or several: every style is its own run and its own file. Pose and framing stay; what changes is how it is drawn.',
    fields: [
      { kind: 'photos', id: 'photo', labelKey: 'imagine.tpl.restyle.f.photo', label: 'Photo', min: 1, max: 1, required: true },
      {
        kind: 'choice', id: 'style', labelKey: 'imagine.tpl.restyle.f.style', label: 'Styles', multi: true, required: true,
        options: [
          { value: 'chibi', labelKey: 'imagine.tpl.restyle.o.style.chibi', label: 'Chibi', prompt: 'Redraw the person as a small chibi character: an oversized head, a compact body, rounded shapes, clean outlines and flat bright colours.' },
          { value: 'comic', labelKey: 'imagine.tpl.restyle.o.style.comic', label: 'Comic book', prompt: 'Redraw the scene as a comic-book panel: bold ink outlines, halftone shading, saturated colour and a dramatic angle.' },
          { value: '3d', labelKey: 'imagine.tpl.restyle.o.style.3d', label: '3D character', prompt: 'Redraw the subject as a polished 3D character from an animated feature film: soft global light, translucent skin and stylised proportions.' },
          { value: 'street-70s', labelKey: 'imagine.tpl.restyle.o.style.street70s', label: '1970s street', prompt: 'Restyle it as a 1970s street photograph: warm faded film, heavy grain, a wide lens and a little flare.' },
          { value: 'anime-80s', labelKey: 'imagine.tpl.restyle.o.style.anime80s', label: '1980s anime', prompt: 'Redraw it as a hand-painted 1980s anime cel: painted backgrounds, a limited palette, strong highlights and a touch of film grain.' },
          { value: 'sunday', labelKey: 'imagine.tpl.restyle.o.style.sunday', label: 'Sunday morning', prompt: 'Restyle it as a soft Sunday morning: hazy golden light, pastel colours and a gentle glow over everything.' },
        ],
      },
      {
        kind: 'text', id: 'extra', labelKey: 'imagine.tpl.restyle.f.extra', label: 'Something to keep', multiline: true, maxLength: 300,
        placeholderKey: 'imagine.tpl.restyle.ph.extra', placeholder: 'Keep the red scarf, the glasses, the cat…',
      },
    ],
    runs: [
      {
        kind: 'job', action: 'remix', source: 'photo', forEach: 'style',
        prompt: '{{style}}\nKeep the subject, the pose and the framing of the photo; change only the way it is drawn, its palette and its textures.\n{{extra}}',
      },
    ],
  },
  {
    id: 'product-color',
    category: 'product',
    cover: '/imagine/tpl-product-color.webp',
    titleKey: 'imagine.tpl.productColor.title',
    title: 'Product colour',
    descriptionKey: 'imagine.tpl.productColor.desc',
    description: 'Recolour one part of a product, from a preset or a colour you type, keeping the material as it is.',
    aboutKey: 'imagine.tpl.productColor.about',
    about: 'Name the part (the cap, the sole, the frame) and pick the colour. Material, light and every other detail of the product stay untouched.',
    fields: [
      { kind: 'photos', id: 'photo', labelKey: 'imagine.tpl.productColor.f.photo', label: 'Product photo', min: 1, max: 1, required: true },
      {
        kind: 'text', id: 'part', labelKey: 'imagine.tpl.productColor.f.part', label: 'Which part', required: true, maxLength: 80,
        placeholderKey: 'imagine.tpl.productColor.ph.part', placeholder: 'the cap, the sole, the frame, the label…',
      },
      {
        kind: 'choice', id: 'colour', labelKey: 'imagine.tpl.productColor.f.colour', label: 'Colour', required: true,
        options: [
          { value: 'black', labelKey: 'imagine.tpl.productColor.o.colour.black', label: 'Black', prompt: 'a deep matte black' },
          { value: 'white', labelKey: 'imagine.tpl.productColor.o.colour.white', label: 'White', prompt: 'a clean bright white' },
          { value: 'cream', labelKey: 'imagine.tpl.productColor.o.colour.cream', label: 'Cream', prompt: 'a warm cream' },
          { value: 'navy', labelKey: 'imagine.tpl.productColor.o.colour.navy', label: 'Navy blue', prompt: 'a rich navy blue' },
          { value: 'green', labelKey: 'imagine.tpl.productColor.o.colour.green', label: 'Forest green', prompt: 'a deep forest green' },
          { value: 'red', labelKey: 'imagine.tpl.productColor.o.colour.red', label: 'Red', prompt: 'a strong tomato red' },
          { value: 'pink', labelKey: 'imagine.tpl.productColor.o.colour.pink', label: 'Blush pink', prompt: 'a soft blush pink' },
          { value: 'silver', labelKey: 'imagine.tpl.productColor.o.colour.silver', label: 'Silver', prompt: 'a brushed silver' },
          { value: 'custom', labelKey: 'imagine.tpl.productColor.o.colour.custom', label: 'Another colour', requiresText: 'custom' },
        ],
      },
      {
        kind: 'text', id: 'custom', labelKey: 'imagine.tpl.productColor.f.custom', label: 'The colour you want', maxLength: 80,
        placeholderKey: 'imagine.tpl.productColor.ph.custom', placeholder: 'a burnt orange, a pale lilac…',
        onlyWith: { field: 'colour', values: ['custom'] },
      },
    ],
    runs: [
      {
        kind: 'job', action: 'remix', source: 'photo',
        prompt: 'Which part of the product to recolour: {{part}}.\nRecolour it to {{colour}}, keeping the material, its texture, the light and every other part of the product exactly as it is.\nRecolour it to {{custom}}, keeping the material, its texture, the light and every other part of the product exactly as it is.',
      },
    ],
  },
  {
    id: 'smart-resize',
    category: 'photo',
    cover: '/imagine/tpl-smart-resize.webp',
    titleKey: 'imagine.tpl.smartResize.title',
    title: 'Smart resize',
    descriptionKey: 'imagine.tpl.smartResize.desc',
    description: 'The same photo on the ratios you need: one file per ratio, cropped or laid on a clean canvas.',
    aboutKey: 'imagine.tpl.smartResize.about',
    about: 'Composed on the server, with no AI in the middle: nothing in the photo is redrawn. Crop fills the new frame; pad keeps the whole photo on a white canvas.',
    fields: [
      { kind: 'photos', id: 'photo', labelKey: 'imagine.tpl.smartResize.f.photo', label: 'Photo', min: 1, max: 1, required: true },
      {
        kind: 'aspect', id: 'ratio', labelKey: 'imagine.tpl.smartResize.f.ratio', label: 'Ratios', multi: true, required: true,
        options: ['1:1', '9:16', '16:9', '4:3', '2:3'], default: ['9:16', '1:1'],
      },
      {
        kind: 'choice', id: 'fit', labelKey: 'imagine.tpl.smartResize.f.fit', label: 'How to fit', required: true, default: 'fill',
        options: [
          { value: 'fill', labelKey: 'imagine.tpl.smartResize.o.fit.fill', label: 'Crop to fill' },
          { value: 'pad', labelKey: 'imagine.tpl.smartResize.o.fit.pad', label: 'Keep the whole photo' },
        ],
      },
    ],
    runs: [
      { kind: 'compose', layout: 'resize', field: 'photo', forEach: 'ratio', aspectRatio: '{{ratio}}', fit: 'fill', fitFrom: 'fit' },
    ],
  },
  {
    id: 'collage',
    category: 'collection',
    cover: '/imagine/tpl-collage.webp',
    titleKey: 'imagine.tpl.collage.title',
    title: 'Photo collage',
    descriptionKey: 'imagine.tpl.collage.desc',
    description: 'Two to sixteen photos into one picture: a clean grid, a photo-booth strip, or a styled page.',
    aboutKey: 'imagine.tpl.collage.about',
    about: 'The grid and the strip are put together on the server with ffmpeg, so the photos stay exactly as they are. The paper, bento and journal styles are one more pass over that grid.',
    fields: [
      { kind: 'photos', id: 'photos', labelKey: 'imagine.tpl.collage.f.photos', label: 'Photos', min: 2, max: 16, required: true },
      {
        kind: 'choice', id: 'style', labelKey: 'imagine.tpl.collage.f.style', label: 'Layouts', multi: true, required: true, default: 'grid',
        options: [
          { value: 'grid', labelKey: 'imagine.tpl.collage.o.style.grid', label: 'A clean grid' },
          { value: 'strip', labelKey: 'imagine.tpl.collage.o.style.strip', label: 'Photo-booth strip' },
          { value: 'torn', labelKey: 'imagine.tpl.collage.o.style.torn', label: 'Torn paper' },
          { value: 'bento', labelKey: 'imagine.tpl.collage.o.style.bento', label: 'Bento' },
          { value: 'journal', labelKey: 'imagine.tpl.collage.o.style.journal', label: 'Travel journal' },
        ],
      },
    ],
    runs: [
      { kind: 'compose', layout: 'grid', field: 'photos', columns: 3, whenChoice: { field: 'style', values: ['grid'] } },
      { kind: 'compose', layout: 'strip', field: 'photos', whenChoice: { field: 'style', values: ['strip'] } },
      {
        kind: 'compose', layout: 'grid', field: 'photos', columns: 2, whenChoice: { field: 'style', values: ['torn'] },
        then: [{
          kind: 'job', action: 'remix', source: 'previous',
          prompt: 'Redraw this grid of photos as a torn-paper collage: rough torn edges, a little tape at the corners, a scrapbook feel, with every photo still where it is and still readable.',
        }],
      },
      {
        kind: 'compose', layout: 'grid', field: 'photos', columns: 3, whenChoice: { field: 'style', values: ['bento'] },
        then: [{
          kind: 'job', action: 'remix', source: 'previous',
          prompt: 'Give this grid of photos the look of a modern bento collage: even rounded tiles, generous white gaps, a subtle drop shadow under each tile and a soft neutral background.',
        }],
      },
      {
        kind: 'compose', layout: 'grid', field: 'photos', columns: 2, whenChoice: { field: 'style', values: ['journal'] },
        then: [{
          kind: 'job', action: 'remix', source: 'previous',
          prompt: 'Turn this grid of photos into a page of a travel journal: paper texture, washi tape at the corners, warm faded tones and a few little margin doodles, with every photo still in place.',
        }],
      },
    ],
  },
  {
    id: 'ecommerce',
    category: 'product',
    cover: '/imagine/tpl-ecommerce.webp',
    titleKey: 'imagine.tpl.ecommerce.title',
    title: 'E-commerce set',
    descriptionKey: 'imagine.tpl.ecommerce.desc',
    description: 'Six product photos for a listing: hero on white, lifestyle, detail, in hand, benefits, flat lay.',
    aboutKey: 'imagine.tpl.ecommerce.about',
    about: 'Five of the six are drawn from your photo, so the product stays the one you sell. The benefits card writes your own three lines under it, with no model in the middle.',
    fields: [
      { kind: 'photos', id: 'photo', labelKey: 'imagine.tpl.ecommerce.f.photo', label: 'Product photo', min: 1, max: 1, required: true },
      { kind: 'text', id: 'benefit1', labelKey: 'imagine.tpl.ecommerce.f.benefit1', label: 'First benefit', maxLength: 60, placeholderKey: 'imagine.tpl.ecommerce.ph.benefit1', placeholder: 'Keeps the coffee hot for hours' },
      { kind: 'text', id: 'benefit2', labelKey: 'imagine.tpl.ecommerce.f.benefit2', label: 'Second benefit', maxLength: 60, placeholderKey: 'imagine.tpl.ecommerce.ph.benefit2', placeholder: 'One-hand lid that never leaks' },
      { kind: 'text', id: 'benefit3', labelKey: 'imagine.tpl.ecommerce.f.benefit3', label: 'Third benefit', maxLength: 60, placeholderKey: 'imagine.tpl.ecommerce.ph.benefit3', placeholder: 'Made to be repaired, not replaced' },
      {
        kind: 'text', id: 'size', labelKey: 'imagine.tpl.ecommerce.f.size', label: 'Its size', maxLength: 80,
        placeholderKey: 'imagine.tpl.ecommerce.ph.size', placeholder: 'about as tall as a coffee cup',
      },
    ],
    runs: [
      {
        kind: 'job', action: 'remix', source: 'photo',
        prompt: 'Studio hero shot of this product on a seamless white background: soft high-key light, a gentle reflection underneath, the product centred and complete in the frame, nothing else.',
        then: [onCanvas('1:1')],
      },
      {
        kind: 'job', action: 'remix', source: 'photo',
        prompt: 'This product on a warm wooden table in a bright home: morning light through a window, a plant and a cup softly out of focus behind it, room to breathe around the product.',
        then: [onCanvas('1:1')],
      },
      {
        kind: 'job', action: 'remix', source: 'photo',
        prompt: 'Extreme close-up of the surface of this product: the texture, the stitching and the finish, raking light that reveals it, a shallow depth of field.',
        then: [onCanvas('1:1')],
      },
      {
        kind: 'job', action: 'remix', source: 'photo',
        prompt: 'A hand holding this product up next to a familiar everyday object, so its real size reads at a glance, on a plain background in natural daylight.\nIt is {{size}}.',
        then: [onCanvas('1:1')],
      },
      {
        kind: 'compose', layout: 'text', field: 'photo', aspectRatio: '1:1', fit: 'pad', background: '#ffffff',
        lines: ['benefit1', 'benefit2', 'benefit3'],
      },
      {
        kind: 'job', action: 'remix', source: 'photo',
        prompt: 'Flat lay of this product on a light neutral surface seen from above, next to a few props that belong with it, soft even light, empty space around it.',
        then: [onCanvas('1:1')],
      },
    ],
  },
  {
    id: 'ugc',
    category: 'social',
    cover: '/imagine/tpl-ugc.webp',
    titleKey: 'imagine.tpl.ugc.title',
    title: 'UGC photos',
    descriptionKey: 'imagine.tpl.ugc.desc',
    description: 'Six vertical photos of a product the way a customer would shoot it: unboxing, in use, detail, on a shelf.',
    aboutKey: 'imagine.tpl.ugc.about',
    about: 'Phone-camera look, vertical frame, real rooms. Give a second photo of the package and one of the six uses it as a reference.',
    fields: [
      { kind: 'photos', id: 'photos', labelKey: 'imagine.tpl.ugc.f.photos', label: 'Product photos', min: 1, max: 8, required: true },
      {
        kind: 'choice', id: 'vibe', labelKey: 'imagine.tpl.ugc.f.vibe', label: 'The vibe', required: true, default: 'home',
        options: [
          { value: 'home', labelKey: 'imagine.tpl.ugc.o.vibe.home', label: 'At home', prompt: 'in a lived-in kitchen at home, in the morning light, with everyday things around' },
          { value: 'out', labelKey: 'imagine.tpl.ugc.o.vibe.out', label: 'Out and about', prompt: 'out and about, in a car or on a street, in plain daylight, a little hurried' },
          { value: 'calm', labelKey: 'imagine.tpl.ugc.o.vibe.calm', label: 'Calm and quiet', prompt: 'in a calm room with a plant and soft daylight, unhurried' },
        ],
      },
      {
        kind: 'text', id: 'size', labelKey: 'imagine.tpl.ugc.f.size', label: 'Its size on camera', maxLength: 80,
        placeholderKey: 'imagine.tpl.ugc.ph.size', placeholder: 'fits in one hand, as long as a phone…',
      },
    ],
    runs: [
      {
        kind: 'job', action: 'remix', source: 'photos',
        prompt: 'A casual phone photo of this product being taken out of its packaging, seen from above, hands in the frame, {{vibe}}.\nNothing posed, no studio light, the real clutter of the room around it.\nIt is {{size}}.',
        then: [onCanvas('9:16')],
      },
      {
        kind: 'job', action: 'remix', source: 'photos',
        prompt: 'A casual phone photo, taken from the side, of this product being used, {{vibe}}.\nOne hand in the frame, the shot a little off-centre, the light of the room as it is.\nIt is {{size}}.',
        then: [onCanvas('9:16')],
      },
      {
        kind: 'job', action: 'remix', source: 'photos',
        prompt: 'A casual phone close-up of this product, filling most of the frame, {{vibe}}.\nThe focus on the material and the detail, the background falling away.\nIt is {{size}}.',
        then: [onCanvas('9:16')],
      },
      {
        kind: 'job', action: 'remix', source: 'photos',
        prompt: 'A casual phone photo of this product standing on a shelf among everyday objects, {{vibe}}, the colours of the room around it.\nIt is {{size}}.',
        then: [onCanvas('9:16')],
      },
      {
        kind: 'job', action: 'remix', source: 'photos',
        prompt: 'A casual phone photo of this product held up in front of the camera, on a plain wall, its size reading at a glance against the hand, {{vibe}}.\nIt is {{size}}.',
        then: [onCanvas('9:16')],
      },
      {
        kind: 'job', action: 'remix', source: 'photos', reference: 'photos', whenFiles: { field: 'photos', atLeast: 2 },
        prompt: 'A casual phone photo of this product next to the package it came in, the second photo, arranged on a table, {{vibe}}.\nBoth of them in frame, real daylight, nothing staged.',
        then: [onCanvas('9:16')],
      },
      {
        kind: 'job', action: 'remix', source: 'photos', unlessFiles: { field: 'photos', fewerThan: 2 },
        prompt: 'A casual phone photo of this product on a table next to an open box, {{vibe}}, as if it had just been unpacked.\nReal daylight, the room slightly messy.',
        then: [onCanvas('9:16')],
      },
    ],
  },
  {
    id: 'editorial-poster',
    category: 'product',
    cover: '/imagine/tpl-editorial-poster.webp',
    titleKey: 'imagine.tpl.editorialPoster.title',
    title: 'Editorial poster',
    descriptionKey: 'imagine.tpl.editorialPoster.desc',
    description: 'A vertical poster for a product, maximal or minimal, with your own headline and fine print.',
    aboutKey: 'imagine.tpl.editorialPoster.about',
    about: 'The picture is drawn around your product; the words are written on the poster on the server, so they come out exactly as you typed them.',
    fields: [
      { kind: 'photos', id: 'photo', labelKey: 'imagine.tpl.editorialPoster.f.photo', label: 'Product photo', min: 1, max: 1, required: true },
      {
        kind: 'choice', id: 'tone', labelKey: 'imagine.tpl.editorialPoster.f.tone', label: 'Tone', required: true, default: 'minimal',
        options: [
          { value: 'maximal', labelKey: 'imagine.tpl.editorialPoster.o.tone.maximal', label: 'Maximal', prompt: 'Make it loud and maximalist: the product large and central, layered blocks of saturated colour behind it, bold shadows and a playful density of shapes.' },
          { value: 'minimal', labelKey: 'imagine.tpl.editorialPoster.o.tone.minimal', label: 'Minimal', prompt: 'Make it quiet and minimal: the product small and perfectly placed, a large empty field of one soft colour, a single subtle shadow and nothing competing with it.' },
        ],
      },
      { kind: 'text', id: 'headline', labelKey: 'imagine.tpl.editorialPoster.f.headline', label: 'Headline', required: true, maxLength: 60, placeholderKey: 'imagine.tpl.editorialPoster.ph.headline', placeholder: 'Made for the morning' },
      { kind: 'text', id: 'subtext', labelKey: 'imagine.tpl.editorialPoster.f.subtext', label: 'Subtitle', maxLength: 90, placeholderKey: 'imagine.tpl.editorialPoster.ph.subtext', placeholder: 'Three things it does better than the one you have' },
      { kind: 'text', id: 'small', labelKey: 'imagine.tpl.editorialPoster.f.small', label: 'Fine print', maxLength: 120, placeholderKey: 'imagine.tpl.editorialPoster.ph.small', placeholder: 'From the studio, since 2026. Free returns.' },
    ],
    runs: [
      {
        kind: 'job', action: 'remix', source: 'photo',
        prompt: 'Turn this product photo into the background of a vertical editorial poster.\n{{tone}}\nLeave the upper half of the frame quiet and open: words will be laid over it.\nKeep the real shape, the materials and the colour of the product.',
        then: [{
          kind: 'compose', layout: 'text', field: 'previous', aspectRatio: '9:16', fit: 'fill',
          lines: ['headline', 'subtext', 'small'],
        }],
      },
    ],
  },
  {
    id: 'icon-maker',
    category: 'style',
    cover: '/imagine/tpl-icon-maker.webp',
    titleKey: 'imagine.tpl.iconMaker.title',
    title: 'Icon maker',
    descriptionKey: 'imagine.tpl.iconMaker.desc',
    description: 'Four icon directions from one idea, in the style and on the background you pick.',
    aboutKey: 'imagine.tpl.iconMaker.about',
    about: 'Four runs, four compositions of the same idea, so you have something to choose from. Give a reference photo and the icon is drawn after it instead.',
    fields: [
      {
        kind: 'text', id: 'concept', labelKey: 'imagine.tpl.iconMaker.f.concept', label: 'What the icon is', required: true, multiline: true, maxLength: 200,
        placeholderKey: 'imagine.tpl.iconMaker.ph.concept', placeholder: 'a paint roller, a paper plane, a coffee bean…',
      },
      {
        kind: 'choice', id: 'style', labelKey: 'imagine.tpl.iconMaker.f.style', label: 'Style', required: true, default: 'flat',
        options: [
          { value: 'flat', labelKey: 'imagine.tpl.iconMaker.o.style.flat', label: 'Flat vector', prompt: 'in flat vector shapes, solid colour, no gradients' },
          { value: 'line', labelKey: 'imagine.tpl.iconMaker.o.style.line', label: 'Line icon', prompt: 'as a single-weight line icon with rounded caps, two colours at most' },
          { value: 'glossy', labelKey: 'imagine.tpl.iconMaker.o.style.glossy', label: 'Glossy 3D', prompt: 'as a glossy 3D icon with soft studio reflections, rounded edges and a gentle inner glow' },
          { value: 'hand', labelKey: 'imagine.tpl.iconMaker.o.style.hand', label: 'Hand-drawn', prompt: 'as a hand-drawn icon, slightly wobbly outlines, ink texture, a warm paper feel' },
          { value: 'isometric', labelKey: 'imagine.tpl.iconMaker.o.style.isometric', label: 'Isometric', prompt: 'as an isometric icon on a thirty-degree grid, clean geometry and soft ambient shadows' },
          { value: 'pixel', labelKey: 'imagine.tpl.iconMaker.o.style.pixel', label: 'Pixel art', prompt: 'as a pixel-art icon on a small grid, a limited palette and crisp squares' },
        ],
      },
      {
        kind: 'choice', id: 'background', labelKey: 'imagine.tpl.iconMaker.f.background', label: 'Background', required: true, default: 'light',
        options: [
          { value: 'light', labelKey: 'imagine.tpl.iconMaker.o.background.light', label: 'White', prompt: 'on a plain white background' },
          { value: 'dark', labelKey: 'imagine.tpl.iconMaker.o.background.dark', label: 'Dark', prompt: 'on a plain dark charcoal background' },
          { value: 'colour', labelKey: 'imagine.tpl.iconMaker.o.background.colour', label: 'A soft colour', prompt: 'on a soft single-colour background that suits the icon' },
          { value: 'transparent', labelKey: 'imagine.tpl.iconMaker.o.background.transparent', label: 'Transparent', prompt: 'on a plain white background, alone, nothing else in the frame' },
        ],
      },
      {
        kind: 'photos', id: 'reference', labelKey: 'imagine.tpl.iconMaker.f.reference', label: 'A reference photo', min: 0, max: 1,
      },
    ],
    runs: ICON_DIRECTIONS.flatMap(direction => [
      {
        kind: 'job', action: 'generate', aspectRatio: '1:1', unlessFiles: { field: 'reference', fewerThan: 1 },
        prompt: `A single app icon of {{concept}}, {{style}}, {{background}}: ${direction}.\nNo text, no lettering, no watermark, nothing else in the frame.`,
        then: [cutOutWhenTransparent()],
      },
      {
        kind: 'job', action: 'remix', source: 'reference', aspectRatio: '1:1', whenFiles: { field: 'reference', atLeast: 1 },
        prompt: `Redraw what is in this photo as a single app icon, {{style}}, {{background}}: ${direction}.\nNo text, no lettering, no watermark, nothing else in the frame.`,
        then: [cutOutWhenTransparent()],
      },
    ]),
  },
  {
    id: 'emoji-pack',
    category: 'social',
    cover: '/imagine/tpl-emoji-pack.webp',
    titleKey: 'imagine.tpl.emojiPack.title',
    title: 'Emoji pack',
    descriptionKey: 'imagine.tpl.emojiPack.desc',
    description: 'A set of expressions of the same subject, each one cut out on transparency.',
    aboutKey: 'imagine.tpl.emojiPack.about',
    about: 'One run per expression, each one cut out afterwards, so every emoji comes back as a PNG with a transparent background.',
    fields: [
      { kind: 'photos', id: 'photo', labelKey: 'imagine.tpl.emojiPack.f.photo', label: 'The subject', min: 1, max: 1, required: true },
      {
        kind: 'choice', id: 'pack', labelKey: 'imagine.tpl.emojiPack.f.pack', label: 'Pack', required: true, default: 'expressions',
        options: [
          { value: 'expressions', labelKey: 'imagine.tpl.emojiPack.o.pack.expressions', label: 'Expressions' },
          { value: 'gaming', labelKey: 'imagine.tpl.emojiPack.o.pack.gaming', label: 'Gaming' },
          { value: 'love', labelKey: 'imagine.tpl.emojiPack.o.pack.love', label: 'Love' },
          { value: 'memes', labelKey: 'imagine.tpl.emojiPack.o.pack.memes', label: 'Memes' },
          { value: 'custom', labelKey: 'imagine.tpl.emojiPack.o.pack.custom', label: 'My own list', requiresText: 'list' },
        ],
      },
      {
        kind: 'choice', id: 'style', labelKey: 'imagine.tpl.emojiPack.f.style', label: 'Style', required: true, default: 'cartoon',
        options: [
          { value: 'cartoon', labelKey: 'imagine.tpl.emojiPack.o.style.cartoon', label: '3D cartoon', prompt: 'as a glossy 3D cartoon sticker with soft studio light' },
          { value: 'flat', labelKey: 'imagine.tpl.emojiPack.o.style.flat', label: 'Flat vector', prompt: 'as a flat vector sticker with solid colour and a thick outline' },
          { value: 'marker', labelKey: 'imagine.tpl.emojiPack.o.style.marker', label: 'Marker pen', prompt: 'as a sticker drawn with a marker pen, bold lines, a little paper texture' },
        ],
      },
      {
        kind: 'text', id: 'list', labelKey: 'imagine.tpl.emojiPack.f.list', label: 'Your own expressions', multiline: true, maxLength: 300,
        placeholderKey: 'imagine.tpl.emojiPack.ph.list', placeholder: 'laughing, crying, sleepy, pretending to be surprised',
        // One sticker and one cut-out per item: twelve is already 24 jobs.
        maxItems: 12,
        onlyWith: { field: 'pack', values: ['custom'] },
      },
    ],
    runs: [
      { kind: 'job', action: 'remix', source: 'photo', whenChoice: { field: 'pack', values: ['expressions'] }, prompt: 'A sticker of the subject in the photo, {{style}}, with a huge grin that lifts the cheeks and squints the eyes.\nThe head fills the frame, nothing else around it.', then: [cutOut()] },
      { kind: 'job', action: 'remix', source: 'photo', whenChoice: { field: 'pack', values: ['expressions'] }, prompt: 'A sticker of the subject in the photo, {{style}}, laughing out loud, the head tilted back a little and the eyes shut.\nThe head fills the frame, nothing else around it.', then: [cutOut()] },
      { kind: 'job', action: 'remix', source: 'photo', whenChoice: { field: 'pack', values: ['expressions'] }, prompt: 'A sticker of the subject in the photo, {{style}}, winking with one eye closed and a small lopsided smile.\nThe head fills the frame, nothing else around it.', then: [cutOut()] },
      { kind: 'job', action: 'remix', source: 'photo', whenChoice: { field: 'pack', values: ['expressions'] }, prompt: 'A sticker of the subject in the photo, {{style}}, looking sad with the corners of the mouth down and the eyes wide.\nThe head fills the frame, nothing else around it.', then: [cutOut()] },
      { kind: 'job', action: 'remix', source: 'photo', whenChoice: { field: 'pack', values: ['expressions'] }, prompt: 'A sticker of the subject in the photo, {{style}}, shocked: the mouth open in a small O and the eyebrows high.\nThe head fills the frame, nothing else around it.', then: [cutOut()] },
      { kind: 'job', action: 'remix', source: 'photo', whenChoice: { field: 'pack', values: ['expressions'] }, prompt: 'A sticker of the subject in the photo, {{style}}, sleepy: the eyes half closed and the head drooping to one side.\nThe head fills the frame, nothing else around it.', then: [cutOut()] },
      { kind: 'job', action: 'remix', source: 'photo', whenChoice: { field: 'pack', values: ['gaming'] }, prompt: 'A sticker of the subject in the photo, {{style}}, with a headset on and a confident victory grin.\nThe head fills the frame, nothing else around it.', then: [cutOut()] },
      { kind: 'job', action: 'remix', source: 'photo', whenChoice: { field: 'pack', values: ['gaming'] }, prompt: 'A sticker of the subject in the photo, {{style}}, raging at the screen: the teeth clenched and the eyes narrowed.\nThe head fills the frame, nothing else around it.', then: [cutOut()] },
      { kind: 'job', action: 'remix', source: 'photo', whenChoice: { field: 'pack', values: ['gaming'] }, prompt: 'A sticker of the subject in the photo, {{style}}, celebrating with both arms up and a wide open mouth.\nThe head fills the frame, nothing else around it.', then: [cutOut()] },
      { kind: 'job', action: 'remix', source: 'photo', whenChoice: { field: 'pack', values: ['gaming'] }, prompt: 'A sticker of the subject in the photo, {{style}}, leaning in with a sly, focused look, as if reading a health bar.\nThe head fills the frame, nothing else around it.', then: [cutOut()] },
      { kind: 'job', action: 'remix', source: 'photo', whenChoice: { field: 'pack', values: ['love'] }, prompt: 'A sticker of the subject in the photo, {{style}}, with two big hearts instead of the pupils and a soft smile.\nThe head fills the frame, nothing else around it.', then: [cutOut()] },
      { kind: 'job', action: 'remix', source: 'photo', whenChoice: { field: 'pack', values: ['love'] }, prompt: 'A sticker of the subject in the photo, {{style}}, blowing a kiss with one cheek puffed and the hand near the mouth.\nThe head fills the frame, nothing else around it.', then: [cutOut()] },
      { kind: 'job', action: 'remix', source: 'photo', whenChoice: { field: 'pack', values: ['love'] }, prompt: 'A sticker of the subject in the photo, {{style}}, blushing hard with the cheeks pink and the eyes looking away.\nThe head fills the frame, nothing else around it.', then: [cutOut()] },
      { kind: 'job', action: 'remix', source: 'photo', whenChoice: { field: 'pack', values: ['love'] }, prompt: 'A sticker of the subject in the photo, {{style}}, with a small sparkle beside the head and a warm closed smile.\nThe head fills the frame, nothing else around it.', then: [cutOut()] },
      { kind: 'job', action: 'remix', source: 'photo', whenChoice: { field: 'pack', values: ['memes'] }, prompt: 'A sticker of the subject in the photo, {{style}}, with a deadpan stare straight at the camera and no smile at all.\nThe head fills the frame, nothing else around it.', then: [cutOut()] },
      { kind: 'job', action: 'remix', source: 'photo', whenChoice: { field: 'pack', values: ['memes'] }, prompt: 'A sticker of the subject in the photo, {{style}}, with a knowingly raised eyebrow and a flat mouth.\nThe head fills the frame, nothing else around it.', then: [cutOut()] },
      { kind: 'job', action: 'remix', source: 'photo', whenChoice: { field: 'pack', values: ['memes'] }, prompt: 'A sticker of the subject in the photo, {{style}}, screaming in mock despair with the hands on the cheeks.\nThe head fills the frame, nothing else around it.', then: [cutOut()] },
      { kind: 'job', action: 'remix', source: 'photo', whenChoice: { field: 'pack', values: ['memes'] }, prompt: 'A sticker of the subject in the photo, {{style}}, looking deeply unimpressed, one eye half shut.\nThe head fills the frame, nothing else around it.', then: [cutOut()] },
      {
        kind: 'job', action: 'remix', source: 'photo', whenChoice: { field: 'pack', values: ['custom'] }, forEach: 'list',
        prompt: 'A sticker of the subject in the photo, {{style}}, with this expression: {{list}}.\nThe head fills the frame, nothing else around it.', then: [cutOut()],
      },
    ],
  },
  {
    id: 'mascot-maker',
    category: 'style',
    cover: '/imagine/tpl-mascot-maker.webp',
    titleKey: 'imagine.tpl.mascotMaker.title',
    title: 'Mascot maker',
    descriptionKey: 'imagine.tpl.mascotMaker.desc',
    description: 'A mascot from an idea: pick the style, the palette and whether it comes cut out.',
    aboutKey: 'imagine.tpl.mascotMaker.about',
    about: 'One character, one pose, transparent on request: the background is cut out after the character is drawn.',
    fields: [
      {
        kind: 'text', id: 'concept', labelKey: 'imagine.tpl.mascotMaker.f.concept', label: 'The character', required: true, multiline: true, maxLength: 300,
        placeholderKey: 'imagine.tpl.mascotMaker.ph.concept', placeholder: 'a friendly fox courier with a satchel, a round little robot barista…',
      },
      {
        kind: 'choice', id: 'style', labelKey: 'imagine.tpl.mascotMaker.f.style', label: 'Style', required: true, default: 'flat',
        options: [
          { value: 'flat', labelKey: 'imagine.tpl.mascotMaker.o.style.flat', label: 'Flat vector', prompt: 'flat vector shapes with solid colour and clean outlines' },
          { value: '3d', labelKey: 'imagine.tpl.mascotMaker.o.style.3d', label: '3D render', prompt: 'a soft 3D render with rounded shapes, plush materials and a gentle studio light' },
          { value: 'hand', labelKey: 'imagine.tpl.mascotMaker.o.style.hand', label: 'Hand-drawn', prompt: 'a hand-drawn character with wobbly ink lines and a warm paper texture' },
          { value: 'sticker', labelKey: 'imagine.tpl.mascotMaker.o.style.sticker', label: 'Sticker', prompt: 'a sticker with a thick white die-cut border and a soft shadow' },
        ],
      },
      {
        kind: 'choice', id: 'palette', labelKey: 'imagine.tpl.mascotMaker.f.palette', label: 'Palette', required: true, default: 'bright',
        options: [
          { value: 'bright', labelKey: 'imagine.tpl.mascotMaker.o.palette.bright', label: 'Bright', prompt: 'a bright palette of primary colours' },
          { value: 'pastel', labelKey: 'imagine.tpl.mascotMaker.o.palette.pastel', label: 'Pastel', prompt: 'a soft pastel palette' },
          { value: 'earth', labelKey: 'imagine.tpl.mascotMaker.o.palette.earth', label: 'Earthy', prompt: 'an earthy palette of clay, moss and cream' },
          { value: 'mono', labelKey: 'imagine.tpl.mascotMaker.o.palette.mono', label: 'One colour', prompt: 'a single colour with its tints and shades' },
        ],
      },
      {
        kind: 'choice', id: 'background', labelKey: 'imagine.tpl.mascotMaker.f.background', label: 'Background', required: true, default: 'transparent',
        options: [
          { value: 'transparent', labelKey: 'imagine.tpl.mascotMaker.o.background.transparent', label: 'Transparent', prompt: 'on a plain white background, alone, nothing else in the frame' },
          { value: 'scene', labelKey: 'imagine.tpl.mascotMaker.o.background.scene', label: 'A soft scene', prompt: 'in a simple, softly coloured scene that belongs to the character' },
          { value: 'chroma', labelKey: 'imagine.tpl.mascotMaker.o.background.chroma', label: 'Chroma green', prompt: 'on a flat chroma green background, evenly lit, for keying' },
        ],
      },
    ],
    runs: [
      {
        kind: 'job', action: 'generate', aspectRatio: '1:1',
        prompt: 'A character design of {{concept}}, {{style}}, {{palette}}, {{background}}.\nFull body, standing, facing the camera, centred, the whole figure inside the frame with room around it.',
        then: [cutOutWhenTransparent()],
      },
    ],
  },
  {
    id: 'character-sprite',
    category: 'style',
    cover: '/imagine/tpl-character-sprite.webp',
    titleKey: 'imagine.tpl.characterSprite.title',
    title: 'Character sprite',
    descriptionKey: 'imagine.tpl.characterSprite.desc',
    description: 'A character on a plain canvas, then a small looping clip of the motion you pick.',
    aboutKey: 'imagine.tpl.characterSprite.about',
    about: 'There is no sprite sheet in this studio: the character is drawn first, then animated into a short looping clip, which is what a game screen can play.',
    fields: [
      {
        kind: 'text', id: 'character', labelKey: 'imagine.tpl.characterSprite.f.character', label: 'The character', required: true, multiline: true, maxLength: 300,
        placeholderKey: 'imagine.tpl.characterSprite.ph.character', placeholder: 'a knight in dented armour with a lantern, a small witch with a broom…',
      },
      {
        kind: 'choice', id: 'style', labelKey: 'imagine.tpl.characterSprite.f.style', label: 'Style', required: true, default: 'pixel',
        options: [
          { value: 'pixel', labelKey: 'imagine.tpl.characterSprite.o.style.pixel', label: 'Pixel art', prompt: 'in pixel art on a small grid, a limited palette, crisp squares' },
          { value: 'painted', labelKey: 'imagine.tpl.characterSprite.o.style.painted', label: 'Painted', prompt: 'as a painted game character, hand-rendered, a soft light from above' },
          { value: 'flat', labelKey: 'imagine.tpl.characterSprite.o.style.flat', label: 'Flat vector', prompt: 'as a flat vector character with clean shapes and solid colour' },
        ],
      },
      {
        kind: 'choice', id: 'motion', labelKey: 'imagine.tpl.characterSprite.f.motion', label: 'Motion', required: true, default: 'idle',
        options: [
          { value: 'idle', labelKey: 'imagine.tpl.characterSprite.o.motion.idle', label: 'Idle breathing', prompt: 'The character stands and breathes: the chest rises and falls, the shoulders settle, the head drifts a little. The camera stays still.' },
          { value: 'walk', labelKey: 'imagine.tpl.characterSprite.o.motion.walk', label: 'Walking', prompt: 'The character walks in place, the arms swinging with the steps, the body bobbing. The camera stays still.' },
          { value: 'attack', labelKey: 'imagine.tpl.characterSprite.o.motion.attack', label: 'Attack', prompt: 'The character swings a weapon in one quick arc and comes back to the ready pose. The camera stays still.' },
          { value: 'celebrate', labelKey: 'imagine.tpl.characterSprite.o.motion.celebrate', label: 'Celebrating', prompt: 'The character jumps once and lands, arms up, a small bounce at the end. The camera stays still.' },
        ],
      },
      {
        kind: 'choice', id: 'background', labelKey: 'imagine.tpl.characterSprite.f.background', label: 'Background', required: true, default: 'plain',
        options: [
          { value: 'plain', labelKey: 'imagine.tpl.characterSprite.o.background.plain', label: 'Plain colour', prompt: 'on a plain, softly coloured background' },
          { value: 'transparent', labelKey: 'imagine.tpl.characterSprite.o.background.transparent', label: 'Cut out', prompt: 'on a plain white background, alone, nothing else in the frame' },
        ],
      },
      { kind: 'photos', id: 'reference', labelKey: 'imagine.tpl.characterSprite.f.reference', label: 'A reference photo', min: 0, max: 1 },
    ],
    runs: [
      {
        kind: 'job', action: 'generate', aspectRatio: '1:1', unlessFiles: { field: 'reference', fewerThan: 1 },
        prompt: 'A full-body character design of {{character}}, {{style}}, {{background}}.\nThe whole figure in the frame, centred, standing in a neutral pose, facing the camera.',
        then: [animate()],
      },
      {
        kind: 'job', action: 'remix', source: 'reference', aspectRatio: '1:1', whenFiles: { field: 'reference', atLeast: 1 },
        prompt: 'Redraw the character in this photo as a full-body game character, {{style}}, {{background}}.\nThe whole figure in the frame, centred, standing in a neutral pose, facing the camera.',
        then: [animate()],
      },
    ],
  },
  {
    id: 'hero-reveal',
    category: 'product',
    cover: '/imagine/tpl-hero-reveal.webp',
    titleKey: 'imagine.tpl.heroReveal.title',
    title: 'Hero product reveal',
    descriptionKey: 'imagine.tpl.heroReveal.desc',
    description: 'A short cinematic clip of a product: three shots, one light, the object turning.',
    aboutKey: 'imagine.tpl.heroReveal.about',
    about: 'One clip of about ten seconds, in three shots written for it. The product stays the one in your photo.',
    fields: [
      { kind: 'photos', id: 'photo', labelKey: 'imagine.tpl.heroReveal.f.photo', label: 'Product photo', min: 1, max: 1, required: true },
      {
        kind: 'aspect', id: 'frame', labelKey: 'imagine.tpl.heroReveal.f.frame', label: 'Frame', required: true, options: ['16:9', '9:16', '1:1'], default: '16:9',
      },
    ],
    runs: [
      {
        kind: 'job', action: 'video', source: 'photo', aspectRatio: '{{frame}}', seconds: 10,
        prompt: 'A cinematic product film of the product in this photo, in three shots.\nShot one: a slow push in across a dark surface while a single light sweeps over the product.\nShot two: the product turns in the air, the light catching its edges and its texture.\nShot three: the product lands on a plain surface, the camera settles and the light goes soft.\nKeep the real shape, the materials and the colour of the product in every shot.',
      },
    ],
  },
] as const satisfies readonly Template[]
