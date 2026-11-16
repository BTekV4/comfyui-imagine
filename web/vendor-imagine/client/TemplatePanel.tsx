/**
 * The panel one «Models» card opens: what the model makes on the left, the few
 * questions it needs on the right, and one button that queues the runs.
 *
 * The form is the catalog read out (`shared/imagine-templates.ts`): the fields
 * keep the catalog's order — a photo field's order is a value of its own, since
 * `ugc` reads the second photo as the reference — and the answer rules are the
 * catalog's own too (`templateProblems`, and `expandTemplate` for a form that
 * would make nothing), so the page never lets a run go that the server would
 * refuse. The run itself is the page's (`runTemplateForm`): it files what
 * started in a project, as a composer run is filed.
 *
 * The panel is the flows' panel (`WorkflowPanel.module.css`), with the photo
 * strip and the model's own cover added here: one studio, one look.
 * @module client/TemplatePanel
 */

import { useMemo, useRef, useState } from 'react'
import {
  IconCloseOutlineRegular, IconPlusOutlineRegular, IconSparkleRegular,
} from '../../shims/primitives/index.ts'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import {
  TEMPLATE_CATEGORIES, expandTemplate, fieldOf, templateProblems,
  type Template, type TemplateAspectField, type TemplateChoiceField, type TemplatePhotoField,
  type TemplateProblem, type TemplateTextField, type TemplateValues,
} from '../../../shared/imagine-templates.ts'
import { aspectName } from '../../../shared/imagine-media.ts'
import { THUMB_SMALL, thumbUrlOf, uploadGalleryItem } from './gallery-api.ts'
import type { ComfyLocaleKey } from './locales.ts'
import { translate } from './locale-store.ts'
import { CoverMedia } from './cover-media.tsx'
import { messageOf } from './message-of.ts'
import { Still } from './Still.tsx'
import css from './WorkflowPanel.module.css'
import own from './TemplatePanel.module.css'

/**
 * What the form holds: the picked values of the choice and aspect fields (one
 * value, or several) and the words typed in the text boxes.
 */
type Answers = Record<string, string | string[]>

/** The catalog's keys are the locale keys: the translator takes them as such. */
const key = (name: string): ComfyLocaleKey => name as ComfyLocaleKey

/** The gradient of each group of the catalog, painted by the card's CSS. */
const CATEGORY_CLASS: Readonly<Record<string, string | undefined>> = {
  photo: own.catPhoto,
  people: own.catPeople,
  style: own.catStyle,
  product: own.catProduct,
  social: own.catSocial,
  collection: own.catCollection,
}

/** The mark of each group, as on the section's cards. */
const CATEGORY_GLYPH: Readonly<Record<string, string>> = {
  photo: '◧',
  people: '☺',
  style: '✶',
  product: '◍',
  social: '❤',
  collection: '▦',
}

/**
 * The sentences for what a form gets wrong.
 *
 * `templateProblems` names what is wrong with a key and its placeholders
 * (`template.photosCount`, `template.textRequired`, …); the words are the
 * page's, and a form that gets something wrong in a way nobody wrote a
 * sentence for still says so instead of looking complete. The photo counts are
 * the one rule with a sentence of its own: the catalog says what the field
 * wanted, the form says how far it is from it, which is what the user has to
 * do next.
 */
const PROBLEM_KEYS: Readonly<Record<string, ComfyLocaleKey>> = {
  'template.textRequired': 'imagine.templates.problem.textRequired',
  'template.textTooLong': 'imagine.templates.problem.textTooLong',
  'template.valueNotOffered': 'imagine.templates.problem.valueNotOffered',
  'template.oneValueOnly': 'imagine.templates.problem.oneValueOnly',
  'template.aspectRequired': 'imagine.templates.problem.aspectRequired',
  'template.choiceRequired': 'imagine.templates.problem.choiceRequired',
  'template.tooManyItems': 'imagine.templates.problem.tooManyItems',
}

/**
 * The words for one problem the catalog found.
 * @param problem - the problem, as `templateProblems` reports it.
 * @param template - the model, to read a photo field's count again.
 * @param files - the photos chosen so far, by field.
 * @returns the sentence.
 */
function problemText(
  problem: TemplateProblem,
  template: Template,
  files: Readonly<Record<string, readonly string[]>>,
): string {
  if (problem.key === 'template.photosCount') {
    const field = template.fields.find(entry => entry.kind === 'photos'
      && !meetsCount(entry, files[entry.id] ?? []))
    if (field !== undefined && field.kind === 'photos') {
      const count = (files[field.id] ?? []).length
      return count < field.min
        ? translate('imagine.templates.photosShort', { count: field.min - count })
        : translate('imagine.templates.photosLong', { max: field.max })
    }
  }
  const name = PROBLEM_KEYS[problem.key]
  if (name === undefined) return translate('imagine.templates.formIncomplete')
  // The field's name in the page's language: the catalog's `label` is the
  // English one the server and the MCP tools read.
  const field = fieldOf(template, problem.field)
  const label = field === undefined ? problem.args['label'] : translate(key(field.labelKey))
  return translate(name, { ...problem.args, ...label === undefined ? {} : { label } })
}

/**
 * Whether a photo field has as many photos as it asks for.
 * @param field - the photo field.
 * @param names - the photos chosen for it, in order.
 * @returns true when the count is inside the field's range.
 */
function meetsCount(field: TemplatePhotoField, names: readonly string[]): boolean {
  return names.length >= field.min && names.length <= field.max
}

/**
 * The values a fresh form starts on: the catalog's defaults (a form left
 * alone submits those) and nothing else.
 * @param template - the model whose form is open.
 * @returns the answers to start with.
 */
function initialAnswers(template: Template): Answers {
  const answers: Answers = {}
  for (const field of template.fields) {
    if (field.kind !== 'choice' && field.kind !== 'aspect') continue
    const start = field.default
    if (start === undefined) continue
    const list = typeof start === 'string' ? [start] : [...start]
    answers[field.id] = field.multi === true ? list : (list[0] ?? '')
  }
  return answers
}

/**
 * The values a field has picked, as a list (one entry for a single choice).
 * @param answers - the form.
 * @param id - the field's id.
 * @returns the picked values, in the order the catalog offers them.
 */
function pickedOf(answers: Answers, id: string): readonly string[] {
  const value = answers[id]
  if (value === undefined) return []
  return typeof value === 'string' ? (value === '' ? [] : [value]) : value
}

/** One choice field: the options as pills, one picked or several. */
function ChoiceField({ field, answers, onPick }: {
  field: TemplateChoiceField
  answers: Answers
  onPick: (value: string, multi: boolean) => void
}) {
  const multi = field.multi === true
  const picked = pickedOf(answers, field.id)
  const label = translate(key(field.labelKey))
  return (
    <div className={css.block}>
      <span className={css.blockTitle}>
        {label}
        {field.required !== true && <span className={css.optional}> · {translate('imagine.optional')}</span>}
      </span>
      <div className={css.pills} role={multi ? 'group' : 'radiogroup'} aria-label={label}>
        {field.options.map(option => {
          const on = picked.includes(option.value)
          return (
            <button
              key={option.value}
              type="button"
              className={css.pill}
              {...multi ? { 'aria-pressed': on } : { role: 'radio' as const, 'aria-checked': on }}
              data-on={on || undefined}
              onClick={() => { onPick(option.value, multi) }}
            >
              {translate(key(option.labelKey))}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** One aspect field: the ratios as pills, each one with its everyday name. */
function AspectField({ field, answers, onPick }: {
  field: TemplateAspectField
  answers: Answers
  onPick: (value: string, multi: boolean) => void
}) {
  const multi = field.multi === true
  const picked = pickedOf(answers, field.id)
  const label = translate(key(field.labelKey))
  return (
    <div className={css.block}>
      <span className={css.blockTitle}>
        {label}
        {field.required !== true && <span className={css.optional}> · {translate('imagine.optional')}</span>}
      </span>
      <div className={css.pills} role={multi ? 'group' : 'radiogroup'} aria-label={label}>
        {field.options.map(option => {
          const on = picked.includes(option)
          const nameKey = aspectName(option, 'image', 'high')
          const name = nameKey === undefined ? undefined : translate(key(nameKey))
          return (
            <button
              key={option}
              type="button"
              className={css.pill}
              {...multi ? { 'aria-pressed': on } : { role: 'radio' as const, 'aria-checked': on }}
              data-on={on || undefined}
              aria-label={name === undefined ? option : `${option} ${name}`}
              onClick={() => { onPick(option, multi) }}
            >
              {option}
              {name !== undefined && <span className={own.aspectName}>{name}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** One text box, with the catalog's ceiling and its hint. */
function TextField({ field, answers, dimmed, onChange }: {
  field: TemplateTextField
  answers: Answers
  /** The choice this box belongs to is not picked: the box is not needed now. */
  dimmed: boolean
  onChange: (value: string) => void
}) {
  const raw = answers[field.id]
  const value = typeof raw === 'string' ? raw : ''
  const label = translate(key(field.labelKey))
  const placeholder = field.placeholderKey === undefined ? '' : translate(key(field.placeholderKey))
  const change = (next: string): void => {
    onChange(field.maxLength === undefined ? next : next.slice(0, field.maxLength))
  }
  return (
    <div className={dimmed ? `${css.block} ${own.fieldOff}` : css.block}>
      <label className={css.blockTitle} htmlFor={`tpl-${field.id}`}>
        {label}
        {field.required !== true && <span className={css.optional}> · {translate('imagine.optional')}</span>}
      </label>
      {field.multiline === true
        ? (
          <textarea
            id={`tpl-${field.id}`}
            className={css.prompt}
            rows={3}
            maxLength={field.maxLength}
            placeholder={placeholder}
            value={value}
            onChange={(event) => { change(event.target.value) }}
          />
        )
        : (
          <input
            id={`tpl-${field.id}`}
            className={css.select}
            type="text"
            maxLength={field.maxLength}
            placeholder={placeholder}
            value={value}
            onChange={(event) => { change(event.target.value) }}
          />
        )}
      {field.maxLength !== undefined && (
        <span className={own.hint}>{translate('imagine.templates.charactersLeft', { count: field.maxLength - value.length })}</span>
      )}
    </div>
  )
}

/**
 * One photo field: the photos chosen, in the order they will be read, and the
 * way to add one — uploaded, or picked from the gallery the home passes down.
 */
function PhotosField({ field, chosen, items, onChange }: {
  field: TemplatePhotoField
  chosen: readonly string[]
  items: readonly GalleryItem[]
  onChange: (names: readonly string[]) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [picking, setPicking] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const room = chosen.length < field.max
  const choices = useMemo(() => items
    .filter(item => item.kind === 'image' && !chosen.includes(item.name))
    .slice()
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
    .slice(0, 36), [items, chosen])
  const upload = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    setError(undefined)
    setLoading(true)
    try {
      const item = await uploadGalleryItem(file)
      if (item.kind !== 'image') {
        setError(translate('imagine.templates.photoOnly'))
        return
      }
      onChange([...chosen, item.name])
    } catch (failure: unknown) {
      setError(messageOf(failure))
    } finally {
      setLoading(false)
    }
  }
  const move = (from: number, to: number): void => {
    if (to < 0 || to >= chosen.length) return
    const next = [...chosen]
    const moved = next[from]
    if (moved === undefined) return
    next.splice(from, 1)
    next.splice(to, 0, moved)
    onChange(next)
  }
  const label = translate(key(field.labelKey))
  const hint = field.min === 0
    ? translate('imagine.templates.photoOptional', { max: field.max })
    : field.min === field.max
      ? translate('imagine.templates.photoExact', { count: field.min })
      : translate('imagine.templates.photoNeeded', { min: field.min, max: field.max })
  return (
    <div className={css.block}>
      <div className={css.slotHead}>
        <span className={css.slotLabel}>{label}</span>
        {field.required !== true && <span className={css.optional}>{translate('imagine.optional')}</span>}
      </div>
      {chosen.length > 0 && (
        <ol className={own.strip}>
          {chosen.map((name, index) => (
            <li className={own.chip} key={name}>
              <Still className={own.chipThumb} src={thumbUrlOf(name, THUMB_SMALL)} alt={name} />
              <span className={own.chipIndex}>{index + 1}</span>
              <span className={own.chipTools}>
                <button
                  type="button"
                  className={own.move}
                  disabled={index === 0}
                  aria-label={translate('imagine.templates.moveEarlier', { name })}
                  onClick={() => { move(index, index - 1) }}
                >‹</button>
                <button
                  type="button"
                  className={own.move}
                  disabled={index === chosen.length - 1}
                  aria-label={translate('imagine.templates.moveLater', { name })}
                  onClick={() => { move(index, index + 1) }}
                >›</button>
              </span>
              <button
                type="button"
                className={own.chipRemove}
                aria-label={translate('imagine.templates.removePhoto', { name })}
                onClick={() => { onChange(chosen.filter(entry => entry !== name)) }}
              >
                <IconCloseOutlineRegular size={12} />
              </button>
            </li>
          ))}
        </ol>
      )}
      <p className={own.hint}>{loading ? translate('imagine.loading') : hint}</p>
      <div className={css.dropActions}>
        <button
          type="button"
          className={css.secondary}
          disabled={!room || loading}
          onClick={() => { input.current?.click() }}
        >
          <IconPlusOutlineRegular size={14} />
          <span>{translate('imagine.templates.addPhoto')}</span>
        </button>
        <button
          type="button"
          className={css.secondary}
          disabled={!room || choices.length === 0}
          onClick={() => { setPicking(current => !current) }}
        >
          <span>{picking ? translate('imagine.closeGallery') : translate('imagine.templates.choosePhotos')}</span>
        </button>
      </div>
      <input
        ref={input}
        type="file"
        hidden
        accept="image/*"
        onChange={(event) => {
          void upload(event.target.files?.[0])
          event.target.value = ''
        }}
      />
      {error !== undefined && <p className={own.note}>{error}</p>}
      {picking && room && (
        <div className={css.gallery}>
          {choices.map(entry => (
            <button
              key={entry.name}
              type="button"
              className={css.galleryItem}
              title={entry.name}
              aria-label={entry.name}
              onClick={() => {
                onChange([...chosen, entry.name])
                setPicking(false)
              }}
            >
              <Still className={css.galleryThumb} src={thumbUrlOf(entry.name, THUMB_SMALL, entry.mtime)} lazy />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export interface TemplatePanelProps {
  /** The model whose form this is. */
  readonly template: Template
  /** The gallery, to pick the photos from. */
  readonly items: readonly GalleryItem[]
  /** A run of the page is going on: nothing else can be queued now. */
  readonly busy: boolean
  /**
   * Send the answers: the page runs the model and files what started in a
   * project. Resolves with whether anything started and the server's sentence
   * when the run stopped half way; rejects with the refusal.
   */
  readonly onRun: (request: {
    values: Record<string, string | string[]>
    files: Record<string, string[]>
  }) => Promise<{ readonly started: boolean; readonly error?: string }>
  /** Back to the grid of models. */
  readonly onBack: () => void
  /** The runs are queued: the panel has nothing left to say. */
  readonly onDone: () => void
}

/**
 * The panel: the model's story, its form and the button that runs it.
 * @param props - the model, the gallery, the project and what to do next.
 * @returns the panel.
 */
export function TemplatePanel({ template, items, busy, onRun, onBack, onDone }: TemplatePanelProps) {
  const [answers, setAnswers] = useState<Answers>(() => initialAnswers(template))
  const [files, setFiles] = useState<Record<string, readonly string[]>>({})
  const [note, setNote] = useState<string>()
  const [sending, setSending] = useState(false)
  const form = { values: answers, files } satisfies TemplateValues
  const problems = templateProblems(template, form)
  // A form every check passes can still make nothing (a list left empty):
  // the server refuses that too, so the button does not offer it.
  const empty = problems.length === 0 && expandTemplate(template, form).length === 0
  const canRun = problems.length === 0 && !empty && !busy && !sending
  const category = TEMPLATE_CATEGORIES.find(entry => entry.id === template.category)
  const paint = CATEGORY_CLASS[template.category]

  // A sentence the server wrote is about the form as it was sent: any change
  // to the form makes it stale, and the hint goes back to the live checks.
  const pickValue = (id: string, value: string, multi: boolean): void => {
    setNote(undefined)
    setAnswers(current => {
      const picked = pickedOf(current, id)
      if (!multi) return { ...current, [id]: value }
      const next = picked.includes(value) ? picked.filter(entry => entry !== value) : [...picked, value]
      return { ...current, [id]: next }
    })
  }
  const setText = (id: string, value: string): void => {
    setNote(undefined)
    setAnswers(current => ({ ...current, [id]: value }))
  }
  const setPhotos = (id: string, names: readonly string[]): void => {
    setNote(undefined)
    setFiles(current => ({ ...current, [id]: names }))
  }

  const submit = async (): Promise<void> => {
    if (!canRun) return
    setNote(undefined)
    setSending(true)
    try {
      const fileMap: Record<string, string[]> = {}
      for (const [id, names] of Object.entries(files)) fileMap[id] = [...names]
      const answer = await onRun({ values: answers, files: fileMap })
      /*
       * Stopped half way: what started is filed in its project already, and
       * the panel stays open on the server's sentence, which says so — a
       * second press would queue the started runs again.
       */
      if (answer.error !== undefined) {
        setNote(answer.error)
        return
      }
      if (answer.started) onDone()
    } catch (failure: unknown) {
      /*
       * The server writes the sentence of a refused form and translates it
       * already (`{ error }`): it is shown as it came.
       */
      setNote(messageOf(failure))
    } finally {
      setSending(false)
    }
  }

  const title = translate(key(template.titleKey))
  /** The model's own render, when the repository ships one. */
  const cover: string | undefined = template.cover
  return (
    <section className={css.panel} aria-label={title}>
      <button type="button" className={css.back} onClick={onBack}>{translate('imagine.allTools')}</button>
      <div className={css.layout}>
        <aside className={css.intro}>
          <div className={`${own.cover} ${paint ?? ''}`} aria-hidden="true">
            {cover === undefined
              ? <span className={own.glyph}>{CATEGORY_GLYPH[template.category]}</span>
              : <CoverMedia className={own.photo} cover={cover} />}
          </div>
          {category !== undefined && (
            <span className={own.group}>{translate(key(category.labelKey))}</span>
          )}
          <h2 className={css.title}>{title}</h2>
          <p className={css.summary}>{translate(key(template.descriptionKey))}</p>
          <h3 className={css.subhead}>{translate('imagine.templates.about')}</h3>
          <p className={own.about}>{translate(key(template.aboutKey))}</p>
        </aside>

        <div className={css.form}>
          {template.fields.map(field => {
            if (field.kind === 'photos') {
              return (
                <PhotosField
                  key={field.id}
                  field={field}
                  chosen={files[field.id] ?? []}
                  items={items}
                  onChange={(names) => { setPhotos(field.id, names) }}
                />
              )
            }
            if (field.kind === 'choice') {
              return (
                <ChoiceField
                  key={field.id}
                  field={field}
                  answers={answers}
                  onPick={(value, multi) => { pickValue(field.id, value, multi) }}
                />
              )
            }
            if (field.kind === 'aspect') {
              return (
                <AspectField
                  key={field.id}
                  field={field}
                  answers={answers}
                  onPick={(value, multi) => { pickValue(field.id, value, multi) }}
                />
              )
            }
            const gate = field.onlyWith
            const dimmed = gate !== undefined
              && !pickedOf(answers, gate.field).some(value => gate.values.includes(value))
            return (
              <TextField
                key={field.id}
                field={field}
                answers={answers}
                dimmed={dimmed}
                onChange={(value) => { setText(field.id, value) }}
              />
            )
          })}

          <div className={css.runBar}>
            <button type="button" className={css.run} disabled={!canRun} onClick={() => { void submit() }}>
              <IconSparkleRegular size={16} />
              <span>{sending || busy
                ? translate('imagine.jobRunningDots', { dots: '…' })
                : translate('imagine.generate')}</span>
            </button>
            <span className={css.runHint} role="status">
              {note ?? (problems.length > 0
                ? problemText(problems[0]!, template, files)
                : empty ? translate('imagine.templates.nothingToRun') : translate('imagine.readyToRun'))}
            </span>
          </div>
        </div>
      </div>
    </section>
  )
}
