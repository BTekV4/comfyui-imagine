/**
 * «Models»: the ready-made models of the home page, one card each.
 *
 * A card says what the model makes (a title and a line of description) and
 * which group it belongs to; the panel behind it asks the few questions the
 * model needs (`TemplatePanel.tsx`). The catalog and the answers' meaning live
 * in `shared/imagine-templates.ts`, so the page and the server read the same
 * sixteen models.
 *
 * Each card shows the model's cover, the studio's own render of an invented
 * subject (`/imagine/tpl-<id>.webp`, the catalog's `cover`), over the gradient
 * of its group's colour: the gradient is what shows while the picture loads,
 * and with the group's plain mark it stands in for a model that ships no
 * cover.
 * @module client/TemplatesSection
 */

import { memo } from 'react'
import {
  TEMPLATES, TEMPLATE_CATEGORIES, type Template, type TemplateCategoryId,
} from '../../../shared/imagine-templates.ts'
import { CoverMedia } from './cover-media.tsx'
import type { ComfyLocaleKey } from './locales.ts'
import { translate } from './locale-store.ts'
import css from './TemplatesSection.module.css'

/** The groups by id, so a card finds its badge's words. */
const CATEGORY_BY_ID = new Map(TEMPLATE_CATEGORIES.map(category => [category.id, category]))

/**
 * The gradient of each group, as the class that paints it. Written out one by
 * one (a `data-` attribute would do the same) so the CSS keeps a name per
 * group and each colour can be changed without counting the order.
 */
const CATEGORY_CLASS: Readonly<Record<TemplateCategoryId, string | undefined>> = {
  photo: css.catPhoto,
  people: css.catPeople,
  style: css.catStyle,
  product: css.catProduct,
  social: css.catSocial,
  collection: css.catCollection,
}

/**
 * A neutral mark for each group: no emoji faces, nothing that promises a
 * picture the card does not have. Text, so it draws everywhere.
 */
const CATEGORY_GLYPH: Readonly<Record<TemplateCategoryId, string>> = {
  photo: '◧',
  people: '☺',
  style: '✶',
  product: '◍',
  social: '❤',
  collection: '▦',
}

/** The key of a catalog text, as the page's translator takes it. */
const key = (name: string): ComfyLocaleKey => name as ComfyLocaleKey

export interface TemplatesSectionProps {
  /** Opens the model's panel, as a flow card opens its own. */
  readonly onOpen: (template: Template) => void
}

/**
 * The section: a title, one line about it, and the sixteen models.
 * @param props - how to open a model.
 * @returns the section.
 */
export const TemplatesSection = memo(function TemplatesSection({ onOpen }: TemplatesSectionProps) {
  return (
    <section className={css.wrap} aria-label={translate('imagine.templates.title')}>
      <div className={css.head}>
        <h2 className={css.title}>{translate('imagine.templates.title')}</h2>
        <p className={css.subtitle}>{translate('imagine.templates.subtitle')}</p>
      </div>
      <div className={css.grid}>
        {TEMPLATES.map(template => {
          const category = CATEGORY_BY_ID.get(template.category)
          const paint = CATEGORY_CLASS[template.category]
          const title = translate(key(template.titleKey))
          /** Whether this model ships a render of its own (all sixteen do). */
          const cover: string | undefined = template.cover
          return (
            <button
              key={template.id}
              type="button"
              className={css.face}
              title={translate(key(template.descriptionKey))}
              aria-label={translate('imagine.templates.open', { name: title })}
              onClick={() => { onOpen(template) }}
            >
              <span className={`${css.cover} ${paint ?? ''}`} aria-hidden="true">
                {/*
                  * The cover is the studio's own render of the model's
                  * subject; the gradient stays behind it while the picture is
                  * on its way, and marks a model whose render is not shipped.
                  */}
                {cover === undefined
                  ? <span className={css.glyph}>{CATEGORY_GLYPH[template.category]}</span>
                  : <CoverMedia className={css.photo} cover={cover} />}
              </span>
              <span className={css.shade} aria-hidden="true" />
              {category !== undefined && (
                <span className={css.badge}>{translate(key(category.labelKey))}</span>
              )}
              <span className={css.copy}>
                <span className={css.name}>{title}</span>
                <span className={css.hint}>{translate(key(template.descriptionKey))}</span>
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
})
