/**
 * Naming the projects the studio created on its own: a project born on a
 * placeholder (a truncated first line, a card label, an untitled number) is
 * named by the reading model from its first content. Split out of
 * ImaginePage.tsx (2026-10-25).
 * @module use-project-naming
 */

import { useRef, type MutableRefObject } from 'react'
import type { ImagineProject } from '../../../shared/imagine-projects.ts'
import type { ModelRoute } from '../../../shared/imagine-types.ts'
import { requestProjectTitle } from './gallery-api.ts'
import { SEED_MESSAGE_PREFIX, isSeedMessage, isUntitledTitle } from './imagine-projects.ts'
import { translate } from './locale-store.ts'

export interface ProjectNaming {
  /**
   * A project is a naming candidate while its title is still one the system
   * minted: the autoTitle flag set at creation, or one of the untitled numbers
   * a project minted before the flag existed — that record carries no flag,
   * and the placeholder pattern is the mark the system left. A title the user
   * typed is never a candidate, whatever it reads.
   */
  readonly isNamingCandidate: (project: ImagineProject) => boolean
  /**
   * The content a candidate project is named from when the page opens: the
   * first line it was talked about, a line of any kind failing that, or its
   * first file. A project with none of the three has nothing to name from.
   */
  readonly namingSourceOf: (project: ImagineProject) => string | undefined
  /**
   * Settle the title of a candidate project to a name, re-checked against the
   * rail it lands on: the user may have deleted the project, opened it and
   * named it themselves, or another browser may have settled the same name
   * first. A settled title is never re-settled, and a name another project
   * already holds is kept off this one.
   */
  readonly settleTitle: (project: ImagineProject, title: string) => void
  /**
   * Ask the reading model to name a candidate project from the content it is
   * getting now. Fire and forget: the run is never held for a name, a title
   * that never comes back leaves the placeholder in place and the next content
   * asks again (once per project per page life).
   */
  readonly titleIfNeeded: (project: ImagineProject, source: string) => void
}

/**
 * @param projectsRef - the rail as last rendered.
 * @param patch - writes one project into the store.
 * @param model - the model the composer's chip is showing, read when asking.
 * @returns the naming functions, for this render.
 */
export function useProjectNaming(
  projectsRef: MutableRefObject<readonly ImagineProject[]>,
  patch: (project: ImagineProject) => void,
  model: () => ModelRoute | undefined,
): ProjectNaming {
  /*
   * Project ids this client already asked to be named, for the life of the
   * page. The ask is fire and forget: a second content line in the same
   * session must not fire a second name for the same project, while a reload
   * re-arms the set so a project the model never named is asked again.
   */
  const titledRef = useRef<Set<string>>(new Set())

  const isNamingCandidate = (project: ImagineProject): boolean =>
    project.autoTitle === true || isUntitledTitle(project.title, translate('imagine.untitled'))

  const namingSourceOf = (project: ImagineProject): string | undefined => {
    const lines = project.messages.filter(message => !isSeedMessage(message))
    // Status lines are the studio talking about itself: naming from them gave
    // "Freshly generated image" to a video, from the run's own "done" line.
    const line = lines.find(message => message.role === 'user' && message.text.trim().length > 0)
      ?? lines.find(message => message.role !== 'status' && message.text.trim().length > 0)
    return line?.text ?? project.itemNames[0]
  }

  const settleTitle = (project: ImagineProject, title: string): void => {
    // The ref is one render behind a project this same event just created;
    // the record the caller holds is current then, and it is the fallback.
    const latest = projectsRef.current.find(entry => entry.id === project.id) ?? project
    if (!isNamingCandidate(latest)) return
    if (projectsRef.current.some(entry =>
      entry.id !== latest.id && entry.title.toLowerCase() === title.toLowerCase())) return
    patch({
      ...latest,
      title,
      autoTitle: false,
      messages: latest.messages.map(message => message.id === `${SEED_MESSAGE_PREFIX}${latest.id}`
        ? { ...message, text: title }
        : message),
    })
  }

  const titleIfNeeded = (project: ImagineProject, source: string): void => {
    if (!isNamingCandidate(project) || source.trim().length === 0) return
    if (titledRef.current.has(project.id)) return
    titledRef.current.add(project.id)
    void (async () => {
      const title = await requestProjectTitle(source, model())
      if (title === undefined) return
      settleTitle(project, title)
    })()
  }

  return { isNamingCandidate, namingSourceOf, settleTitle, titleIfNeeded }
}
