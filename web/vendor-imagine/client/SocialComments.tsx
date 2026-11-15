/**
 * The comments Instagram has left on the account, and what was done about
 * them.
 *
 * The host reads, likes and replies on its own three times a day; this is the
 * record of that, not the thing that drives it. What the page adds is the two
 * cases the pass deliberately leaves alone — a comment it chose not to answer,
 * and one it flagged — where a person can step in and reply by hand.
 */

import { messageOf } from './message-of.ts'
import { translate } from './locale-store.ts'
import { useMemo, useState } from 'react'
import { momentLabel } from './dates.ts'
import { usePolled } from './use-visible-interval.ts'
import type { SocialComment, SocialCommentPass } from './gallery-api.ts'
import { fetchSocialComments, likeSocialComment, replySocialComment, runSocialCommentPass } from './gallery-api.ts'
import css from './SocialComments.module.css'

/** Props for the comment list. */
export interface SocialCommentsProps {
  /**
   * Show only the comments under one post.
   *
   * The record carries each comment's permalink, and a published post carries
   * its own, so the two match up without the host having to relate them.
   */
  readonly permalink?: string
  /**
   * Leave a filtered view.
   *
   * Set when `permalink` came from clicking one post rather than from being
   * inside it: the list then says whose comments these are and offers the way
   * back to all of them.
   */
  readonly onClearFilter?: () => void
  /** Inside a post panel: no pass controls, no empty-state prose. */
  readonly inline?: boolean
}

/** How often the list re-reads itself. A pass runs three times a day. */
const REFRESH_MS = 60_000

/** The list before the first read: one array, so the sort below is not redone each render. */
const NO_COMMENTS: readonly SocialComment[] = []

/** How each classification reads, for the ones worth naming. */
const KIND_LABEL: Record<string, string> = {
  positive: 'positivo',
  question: 'domanda',
  offensive: 'offensivo',
  spam: 'spam',
}

/**
 * One comment, with what was done and what can still be done to it.
 * @param props - the comment and the two actions.
 * @returns the row.
 */
function CommentRow({ comment, onChanged }: {
  readonly comment: SocialComment
  readonly onChanged: (next: SocialComment) => void
}) {
  const [writing, setWriting] = useState(false)
  const [draft, setDraft] = useState(comment.proposedReply ?? '')
  const [busy, setBusy] = useState(false)

  const like = async () => {
    setBusy(true)
    try {
      onChanged(await likeSocialComment(comment.id))
    } catch (e) {
      onChanged({ ...comment, likeError: messageOf(e) })
    } finally {
      setBusy(false)
    }
  }

  /**
   * Send a reply. The text is an argument, not read from `draft`: the
   * proposal's "Send" set the draft and called this in the same click, and
   * this still read the old draft — nothing, or what the user had typed and
   * dismissed.
   */
  const reply = async (written: string) => {
    const text = written.trim()
    if (text === '') return
    setBusy(true)
    try {
      onChanged(await replySocialComment(comment.id, text))
      setWriting(false)
    } catch (e) {
      onChanged({ ...comment, replyError: messageOf(e) })
    } finally {
      setBusy(false)
    }
  }

  const kind = comment.classification === undefined ? undefined : KIND_LABEL[comment.classification]
  return (
    <div className={css.row} data-flagged={comment.flagged === true || undefined}>
      <div className={css.head}>
        <span className={css.author}>{comment.author ?? 'utente Instagram'}</span>
        {kind !== undefined && <span className={css.kind} data-kind={comment.classification}>{kind}</span>}
        <span className={css.when}>{momentLabel(comment.timestamp ?? comment.seenAt, 'short')}</span>
        {comment.permalink !== undefined && (
          <a className={css.permalink} href={comment.permalink} target="_blank" rel="noopener noreferrer">
            sul post ↗
          </a>
        )}
      </div>

      {/* Meta hands back a comment with no body often enough to matter — an
          emoji Instagram strips, or a caption-only mention. The row still has
          a like worth giving, so it stays, saying what it is. */}
      {(comment.text ?? '').trim() === ''
        ? <p className={css.noText}>{translate('imagine.cmtNoText')}</p>
        : <p className={css.text}>{comment.text}</p>}

      {/* What already happened: the like, then the reply that went out. */}
      <div className={css.actions}>
        <button
          type="button"
          className={css.likeBtn}
          data-on={comment.liked === true || undefined}
          disabled={busy || comment.liked === true}
          onClick={() => { void like() }}
          title={comment.liked === true ? translate('imagine.alreadyLiked') : translate('imagine.likeComment')}
          /*
           * The glyph is the only content, so `title` was the only thing
           * naming this control and a tooltip is not a reliable accessible
           * name. The label states the action and the comment it applies to.
           */
          aria-label={comment.liked === true
            ? translate('imagine.cmtLiked', { author: comment.author ?? '' })
            : translate('imagine.cmtLike', { author: comment.author ?? '' })}
        >
          {comment.liked === true ? '❤️' : '🤍'}
        </button>
        {comment.replied === true
          ? <span className={css.done}>{translate('imagine.cmtReplied')}</span>
          : (
            <button type="button" className={css.replyBtn} onClick={() => { setWriting(w => !w) }}>
              {writing ? translate('imagine.cmtCancel') : translate('imagine.cmtReply')}
            </button>
          )}
        {comment.replied !== true && comment.skipReason !== undefined && (
          <span className={css.skip}>{comment.skipReason}</span>
        )}
      </div>

      {comment.replyText !== undefined && (
        <p className={css.reply}>
          <span className={css.replyMark}>↳</span>
          {comment.replyText}
          <span className={css.when}>{momentLabel(comment.repliedAt, 'short')}</span>
        </p>
      )}

      {/* A reply a rehearsal pass worked out but did not send. Without this it
          sat in the record unseen: the row looked untouched, and the only way
          to the words was to open the box and find them already typed. */}
      {comment.replied !== true && comment.proposedReply !== undefined && !writing && (
        <p className={css.proposal}>
          <span className={css.replyMark}>↳</span>
          <span>{comment.proposedReply}</span>
          <span className={css.proposalTag}>da mandare</span>
          <button
            type="button"
            className={css.sendBtn}
            disabled={busy}
            onClick={() => { setDraft(comment.proposedReply ?? ''); void reply(comment.proposedReply ?? '') }}
          >
            {busy ? '⏳' : translate('imagine.send')}
          </button>
        </p>
      )}

      {writing && comment.replied !== true && (
        <div className={css.composer}>
          <textarea
            className={css.input}
            value={draft}
            rows={2}
            placeholder={translate('imagine.cmtPublic')}
            onChange={(e) => { setDraft(e.target.value) }}
          />
          <button
            type="button"
            className={css.sendBtn}
            disabled={busy || draft.trim() === ''}
            onClick={() => { void reply(draft) }}
          >
            {busy ? '⏳' : translate('imagine.send')}
          </button>
        </div>
      )}

      {(comment.likeError ?? comment.replyError) !== undefined && (
        <p className={css.error}>{comment.replyError ?? comment.likeError}</p>
      )}
    </div>
  )
}

/**
 * The comment record, whole or filtered to one post.
 * @param props - which comments to show, and how.
 * @returns the list.
 */
export function SocialComments({ permalink, onClearFilter, inline = false }: SocialCommentsProps) {
  // Refreshed while the tab is in view; a hidden tab stops asking. Inside a
  // post panel the list is read once.
  const { data, loaded, reload, update } = usePolled(fetchSocialComments, inline ? null : REFRESH_MS)
  const comments = data?.comments ?? NO_COMMENTS
  const lastRunAt = data?.lastRunAt ?? null
  const lastError = data?.lastError ?? null
  const hours = data?.hours ?? []
  const [pass, setPass] = useState<SocialCommentPass | null>(null)
  const [running, setRunning] = useState(false)

  const run = async () => {
    setRunning(true)
    try {
      setPass(await runSocialCommentPass())
      await reload()
    } finally {
      setRunning(false)
    }
  }

  // Newest first, by Instagram's own clock rather than by the order a pass
  // happened to read the posts in: the record is appended per medium, so its
  // stored order groups by post and interleaves the days.
  const shown = useMemo(() => {
    const kept = permalink === undefined ? comments : comments.filter(c => c.permalink === permalink)
    return [...kept].sort((a, b) => (
      Date.parse(b.timestamp ?? b.seenAt ?? '') || 0) - (Date.parse(a.timestamp ?? a.seenAt ?? '') || 0))
  }, [comments, permalink])
  const replace = (next: SocialComment) => {
    update(read => read && { ...read, comments: read.comments.map(c => (c.id === next.id ? next : c)) })
  }

  if (inline) {
    if (!loaded || shown.length === 0) return null
    return (
      <div className={css.inline}>
        <span className={css.inlineTitle}>{`Commenti (${String(shown.length)})`}</span>
        {shown.map(c => <CommentRow key={c.id} comment={c} onChanged={replace} />)}
      </div>
    )
  }

  const waiting = shown.filter(c => c.replied !== true).length
  const flagged = shown.filter(c => c.flagged === true).length
  return (
    <section className={css.section}>
      <div className={css.header}>
        <h3 className={css.sectionTitle}>
          {onClearFilter === undefined
            ? `Commenti (${String(shown.length)})`
            : translate('imagine.cmtCount', { count: shown.length })}
        </h3>
        {onClearFilter !== undefined && (
          <button type="button" className={css.clearBtn} onClick={onClearFilter}>
            {translate('imagine.allComments')}
          </button>
        )}
        <div className={css.headerRight}>
          <span className={css.note}>
            {lastRunAt === null
              ? hours.length > 0 ? translate('imagine.cmtNextPass', { hours: hours.map(h => `${String(h)}:00`).join(', ') }) : translate('imagine.cmtNoPass')
              : translate('imagine.social.lastCheck', { when: momentLabel(lastRunAt, 'short') })}
          </span>
          <button type="button" className={css.runBtn} disabled={running} onClick={() => { void run() }}>
            {running ? translate('imagine.cmtReading') : translate('imagine.cmtCheckNow')}
          </button>
        </div>
      </div>

      {/* The counters of the last pass, and only when one has run from here:
          they answer "did it do anything", which the list alone does not. */}
      {pass !== null && (
        <p className={css.pass}>
          {translate('imagine.cmtPassCounts', { read: pass.read, liked: pass.liked, replied: pass.replied, skipped: pass.skipped })}
          {pass.errors > 0 ? translate('imagine.cmtPassErrors', { count: pass.errors }) : ''}
          {(pass.likePending ?? 0) > 0 ? translate('imagine.cmtLikePending', { count: pass.likePending ?? 0 }) : ''}
        </p>
      )}
      {lastError !== null && <p className={css.error}>{lastError}</p>}
      {/*
        Meta refusing every like the same way is one condition of the account,
        not a failure of any single comment: it goes here once, not as a red
        error on each row (it did, until 2026-10-20).
      */}
      {(pass?.likePending ?? 0) > 0 && (
        <p className={css.note}>{translate('imagine.cmtLikesRefused')}</p>
      )}

      {shown.length === 0
        ? (
          <div className={css.empty}>
            {!loaded
              ? translate('imagine.cmtMoment')
              : onClearFilter === undefined
                ? translate('imagine.cmtNoneYet')
                : translate('imagine.cmtEmpty')}
          </div>
        )
        : (
          <>
            <p className={css.summary}>
              {waiting === 0 ? translate('imagine.cmtAllDone') : translate('imagine.cmtWaiting', { count: waiting })}
              {flagged > 0 ? translate('imagine.cmtFlagged', { count: flagged }) : ''}
            </p>
            <div className={css.list}>
              {shown.map(c => <CommentRow key={c.id} comment={c} onChanged={replace} />)}
            </div>
          </>
        )}
    </section>
  )
}
