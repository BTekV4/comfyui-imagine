/**
 * The Instagram plugin's wire types: the queued posts and stories, and the
 * comments it handled, as the plugin stores them and serves them under `/plugin/instagram/social/…`, and
 * as the page reads them.
 *
 * Until 2026-11-07 the plugin (`posts.ts`, `stories.ts`, `captions.ts`) and
 * the page (`gallery-api.ts`, `PublishPanel.tsx`) each declared these, and the
 * two copies had already drifted. Types only; read by both sides.
 * @module shared/social-types
 */

/** Photo or reel: the two kinds a caption is written for. */
export type PostType = 'photo' | 'reel'

/** What a queued post sends: one photo, one reel, or a carousel of photos. */
export type SocialPostKind = 'photo' | 'reel' | 'carousel'

/** What a queued post is doing. */
export type SocialPostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'error'

/** One post in the publication queue (`posts.json`). */
export interface SocialPost {
  readonly id: string
  readonly kind: SocialPostKind
  readonly files: readonly string[]
  readonly caption: string
  readonly hashtags: string
  /**
   * Whether the post declares Instagram's "Created with AI" label. Absent on
   * records written before the field existed, which publish with the label.
   */
  readonly aiLabel?: boolean
  readonly status: SocialPostStatus
  readonly createdAt: string
  readonly updatedAt: string
  /** When it should go out; absent on a draft. */
  readonly scheduledAt?: string
  readonly publishedAt?: string
  readonly instagramUrl?: string
  readonly error?: string
  /**
   * How many times the publisher has tried, counted only once a try has failed.
   *
   * The scheduler sends a post again when the failure looks transient, and
   * without these two fields the queue showed the same bare `error` for a post
   * due back in five minutes and for one nothing will touch again.
   */
  readonly attempts?: number
  /** When the scheduler will try again; absent once it has given up. */
  readonly nextAttemptAt?: string
  /** While publishing, the step the script is on (kept in memory only). */
  readonly progress?: string
}

/** What a queued story is doing. */
export type SocialStoryStatus = 'scheduled' | 'publishing' | 'published' | 'error'

/** One clip waiting to run as a story (`stories.json`), one a day. */
export interface SocialStory {
  readonly id: string
  /** The post whose reel this is, when it was queued automatically. */
  readonly postId?: string
  /** Absolute path to the clip that goes out. */
  readonly file: string
  /** What it is, in words: the reel's own first line. */
  readonly source: string
  readonly publishAt: string
  readonly status: SocialStoryStatus
  readonly createdAt: string
  readonly publishedAt?: string
  readonly error?: string
  /** The published story's Graph id, as the publish script reported it. */
  readonly mediaId?: string
  readonly permalink?: string
}

/** One comment the plugin has read from Instagram and handled (`comments.json`). */
export interface SocialComment {
  readonly id: string
  /** When the plugin first read it. */
  readonly seenAt: string
  /** The comment text, as it was written. */
  readonly text?: string
  /** `@username`, or a stand-in when Meta withholds the name. */
  readonly author?: string
  readonly username?: string
  /** When the comment was left, from Instagram. */
  readonly timestamp?: string
  /** The post it sits under, so the page can group by post. */
  readonly mediaId?: string
  readonly permalink?: string
  readonly mediaCaption?: string
  /** How the reader classified it: positive, question, neutral, offensive, spam. */
  readonly classification?: string
  /** Recorded for a comment that is offensive; nothing is hidden or removed. */
  readonly flagged?: boolean
  readonly liked?: boolean
  readonly likedAt?: string
  readonly likeError?: string
  /**
   * A like Meta refused the same way on every comment: the condition, not this
   * comment. Shown once for the page instead of as an error on each row.
   */
  readonly likePending?: boolean
  /** Whether the like can be read back: kept, never acted on (Meta answers success either way). */
  readonly likeSeen?: boolean
  readonly replied?: boolean
  readonly replyText?: string
  readonly repliedAt?: string
  readonly replyError?: string
  /** A reply worked out but not sent, from a rehearsal pass. */
  readonly proposedReply?: string
  /** Why no reply went out. */
  readonly skipReason?: string
  /** Already put in front of the owner by a Telegram notice (never twice). */
  readonly toldOwner?: boolean
}

/** What one pass over the comments did. */
export interface SocialCommentPass {
  readonly read: number
  readonly liked: number
  readonly replied: number
  readonly flagged: number
  readonly skipped: number
  /** Posts whose permalink the pass filled in. */
  readonly linked: number
  readonly errors: number
  /** Likes Meta refused this pass, waiting for the next one. */
  readonly likePending: number
  readonly dryRun: boolean
}
