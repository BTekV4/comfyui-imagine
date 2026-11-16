# Templates

The sixteen models of the home page live in `shared/imagine-templates.ts`: the
fields a form asks for (`photos`, `choice`, `aspect`, `text`), the runs of each
model, and the expansion that turns a form's answers into a list of runs. The
page imports the catalog directly, so the form and the server cannot disagree
about what a value means; the host reaches the same file through
`GET /comfy-imagine/templates` and `POST /comfy-imagine/template`, and the MCP
server exposes the two as the `imagine_templates` and `imagine_run_template`
tools.

A run is a job — `generate`, `remix`, `bg`, `video`, `loop` — with an English
prompt that holds placeholders: a choice stands for the `prompt` of the value
picked, `forEach` unrolls a run once per selected value (one picture per style,
one emoji per expression), a line whose placeholders are all empty is dropped,
and `then` hangs further steps on the output of the run before it (a cut-out,
a loop, a still put on another ratio). Every job is queued through the same
path as a run started by hand (`server/vendor/tool-comfy/job-start.ts`), so
the checks, the board project and the live tiles are the same. Every planned
body, chain steps included, and every gallery file a run reads are checked
before the first run is queued, so a refused form starts nothing; a run that
still stops half way answers 202 with what did start and an `error`. The
chains wait on the queue in the background for as long as a step is queued
(a step is given up on only after three hours *running*), log every early
stop with the template and the step, and live in memory only — an update
restarts the queue too, so a chain that had not queued its next step yet is
not resumed. From the home page a run lands in a project like a composer run:
the open one, the one named after the model, or a new one.

Two runs are not jobs at all: a collage (`grid`, `strip`) and a resize are
composed by ffmpeg in `server/vendor/tool-comfy/template-compose.ts`, and the
`text` layout writes the user's own words under the picture (a product card,
a poster) — no model in the middle, so the words come out exactly as typed.

Note on ratios: the `remix` graph takes its canvas from the photo it edits, so
a model that needs another ratio renders the edit and then puts the still on
that canvas with ffmpeg (`onCanvas` in the catalog). Nothing is redrawn by
that second step: the frame is cropped, or laid on the background colour the
run asks for.

Each model's card carries its own cover — a render of the studio's own,
`web/public/imagine/tpl-<id>.webp`, made with the graph itself from invented
subjects. To change one, replace that file (768 × 768 WebP) or name it in the
catalog's `cover` field; a model with no `cover` shows a plain card.

The home shows the models and the workflow cards (and the workflows you
uploaded) as one grid. Each card's filter group is written out in
`web/vendor-imagine/client/home-groups.ts`, which also fixes the order of
«All»: generate, edit, style and video first, then one card per group in turn.
Every card has its own address — `/tool/<card>`, `/model/<id>`,
`/workflow/<id>` — so a card can be linked or reloaded, and Back closes it.
