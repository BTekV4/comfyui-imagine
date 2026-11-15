# Instagram

Publishes the studio's gallery on Instagram: a publication queue (photos,
reels, carousels), one story a day, comment passes that like and answer, and
caption previews written by the studio's model. It is written against
`docs/plugin-api.md`.

The plugin does not talk to the Graph API itself. Publishing, stories and
comments go through **five Python scripts that are not part of this
repository** (see [External requirement](#external-requirement-the-python-scripts)).
Without them the plugin loads, shows its status and writes caption previews,
but cannot publish anything.

## Install

```sh
npm run build:plugins                 # builds plugins/instagram/index.mjs
mkdir -p <data>/plugins/instagram
cp manifest.json index.mjs <data>/plugins/instagram/
systemctl restart imagine             # or POST /comfy-plugins/instagram/refresh
```

`<data>` is the studio's data folder (`$IMAGINE_HOME`, else
`~/.imagine`). Then open **Settings → Studio → Plugins**, fill in the settings
below and paste the tokens with the card's buttons.

## Settings

| key | default | what it does |
|---|---|---|
| `scheduler` | off | Publishes the queued posts and stories at their time and runs the comment passes. Leave it off wherever another system publishes the same queue, or everything goes out twice. |
| `model` | empty | Model for captions and replies, written `provider/model`. Empty means the studio's own default model. |
| `storiesFrom` | empty | No story is scheduled before this day (`YYYY-MM-DD`): for an account whose stories another publisher was still putting out. Empty means no limit. |
| `commentHours` | `8, 14, 20` | Local hours (0-23) at which a comment pass runs, comma-separated. Empty or invalid means `8, 14, 20`. |
| `watermark` | on | Writes the mark in the bottom-right corner of every published file — photo, reel, carousel piece, story. The copy is made in a temporary folder and uploaded instead; the file in the gallery is untouched. |
| `watermarkText` | empty | What the mark says, usually the account's handle. Empty means no mark. |
| `fixedHashtags` | `#krea2` | The hashtags every post starts with, space-separated. The rest, up to five in all, come from the picture. |
| `reelHashtags` | `#minimaxh3` | Added after the fixed ones, on reels only. |
| `franchiseHashtags` | empty | `keyword: #First #Second` entries separated by `;`. When a keyword (case-insensitive) appears in the project title or description, the facts the vision pass saw, the prompt or the file name, its two tags are added first; the first match wins. Empty means no table: only the tags the model proposes. |
| `instagramDir` | `<data>/instagram` | The Instagram project folder: `config/` with the tokens, `media/normalized/` (the conformed clips the reel script leaves behind), `state/`. |
| `scriptsDir` | `<instagramDir>/scripts` | Where the five Python scripts are. |
| `stateDir` | `<data>/social` | The plugin's records: `posts.json`, `stories.json`, `comments.json`, the rings of captions and replies already written (`recent-captions.json`, `recent-replies.json`) and the caption style examples (`hermes-captions.json`, a JSON list of real captions of the account; the name is historical). Moving it means losing the queue. |

Settings are read at every use: a save applies at once, without a reload.

The caption templates and the prompts are still in `src/captions.ts`, in Italian.

### Tokens

`<instagramDir>/config/api_token.json` holds the Instagram-Login token that
publishes; `<instagramDir>/config/facebook_comments_token.json` the page and
user tokens the comment passes use. The plugin only rewrites the token fields
it is given and keeps every other key, because an external OAuth flow owns
those files. The page never gets a token back.

## Routes

All under `/plugin/instagram/social`:

| route | what |
|---|---|
| `POST /caption-preview` | `{ type?: "photo"\|"reel", filename?, prompt? }` → caption, hashtags and what the vision pass saw |
| `GET /status` | token, last publication, queue write errors |
| `GET\|POST /token` | the publishing token's state (masked) / paste a new token |
| `POST /facebook-token` | paste the comment tokens |
| `GET /facebook-token/check` | ask Meta whether the comment tokens still work |
| `/posts`, `/posts/<id>`, `/posts/<id>/<action>` | the publication queue (list, queue, edit, drop, publish now; see `handlePosts` in `src/posts.ts`) |
| `/stories`, `/stories/<id>`, `/stories/<id>/publish` | the story queue, one a day at 08:00 (`handleStories` in `src/stories.ts`) |
| `GET /comments`, `POST /comments/run`, `POST /comments/<id>/like\|reply` | the comment record and the passes |

The wire types of posts and stories are in `shared/social-types.ts`, shared
with the studio's page.

## External requirement: the Python scripts

The plugin runs each script as `python3 <scriptsDir>/<name> <args…>`, with no
timeout, and reads its answer from stdout. A script that refuses answers a
JSON object `{"ok": false, "error": "…"}` (or `"reason"`) on stdout, with any
exit code; that is recorded as the post's error and never retried. A script
that crashes (no JSON on stdout, non-zero exit) is reported with the tail of
both streams; a post whose failure looks transient is sent again, up to three
attempts, five minutes apart.
Progress lines on stderr (`Upload … Google Drive`, `Container figlio 3/10`,
`[poll] 4/24`, …) are shown in the queue while a post goes out.

| script | called as | expected answer |
|---|---|---|
| `instagram_photo_publish_api.py` | `<file> --caption <text> --allow-direct-publish [--ai-generated]` | exit 0; the post's URL (`https://www.instagram.com/p/…`) anywhere in stdout, or JSON with `instagram_url` |
| `instagram_reel_publish_api.py` | `<file> --caption <text> --allow-direct-publish --upscale [--ai-generated]` | exit 0; `MEDIA_RESULT={"instagram_url": …}` on stdout. Leaves the conformed clip as `<instagramDir>/media/normalized/<stem>_hermes_1080x1920_h264.mp4`, which the story of that reel reuses |
| | `--verify-media <shortcode>` | JSON `{"found": true, "media_id", "permalink", "timestamp"}`, or `{"found": false, "error"}` |
| `instagram_carousel_publish_api.py` | `<file1> <file2> … --caption <text> --allow-direct-publish [--ai-generated] [--dry-run]` | exit 0; `MEDIA_RESULT={"instagram_url": …}` on stdout |
| `instagram_story_publish_api.py` | `<file> --allow-direct-publish` | exit 0; `MEDIA_RESULT=[{"media_id", "permalink"}]` on stdout |
| `instagram_comment_manager.py` | `--readonly --json` | JSON `{"comments": [{ "id", "text", "username", "author_label", "timestamp", "media_id", "permalink", "media_caption", "classification" }]}` |
| | `--like <comment id> --json` | JSON `{"ok": true, "sent": bool, "seen": bool}` |
| | `--reply <comment id> <text> --json` | JSON `{"ok": true, "sent": true}`, or `{"ok": true, "sent": false, "reason"}` when a reply was already there |

`--ai-generated` sets Instagram's "Created with AI" label (`is_ai_generated`)
on the container; it is passed unless the post turns the label off. The
scripts read the tokens from `<instagramDir>/config/` themselves.

`<instagramDir>/state/PUBLISH_FREEZE.json`, when it says `"frozen": true` or
`"do_not_publish": true` without `"allow_stories": true`, keeps the stories
from going out.
