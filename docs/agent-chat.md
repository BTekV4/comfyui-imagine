# The agent chat

Status: F2 built on two branches (2026-11-18), on top of the F1 lane merged
into `main` (PR #11): `agent-chat-media-20261118` holds the media tools and
the confirmation gate, and `agent-chat-parity-20261118` (on top of it) adds
`run_action`. F0 was approved and its three open questions are decided below. The classic lane is still there, and it is what
reads a line when the model cannot call tools or the switch is off.

The chat inside a project reads one written line with one JSON call and answers
with a fixed shape: an action, a prompt, a handful of fields. That shape was
right when the chat was a toolbar without buttons. It is what makes the chat
feel like a set of scripts today:

- the model never sees what its own runs produced, so it cannot say whether the
  result matches the sentence, and "that is not what I asked" is answered by
  another guess;
- it cannot chain steps ("make the photo, then animate it, then lay the track
  over it"), because a turn is one reading;
- a nuance that does not fit the fields is dropped or flattened, and the prompt
  is rewritten in the house words the instruction teaches (`"foto realistica,
  luce naturale morbida"` is the stock phrasing, not the user's);
- memory is the last eight messages (`use-runner.ts` slices the history to
  eight), so "darker, like before" points at nothing.

The goal is an **agent mode**: the model chooses the steps, real tools do the
work, the model sees each result, and the reply is written at the end. The
current lane stays as the reserve, chosen by a setting, and is the default for
a model that does not call tools.

## What stays true

- No second engine for generation. Tools call the same code the page and the
  MCP server already call: `startFromBody` (`job-start.ts`) for a run,
  `getImagineJob` (`job-queue.ts`) for its state, the gallery and notes for the
  files, `lookWith`/`lookSoon` (`imagine-models.ts`, `imagine-sight.ts`) for vision.
- The graphs are the deployment's, and the agent never writes them. LoRA files,
  workflow files, pins and card definitions are read-only for tools; a personal
  card runs with validated inputs, as the MCP's `custom` action does.
- A tool argument is validated, not rewritten. Measures, durations, the closed
  lists of workflows and "the prompt is the user's words" become checks that
  refuse with a reason the model can correct, never a server-side restyle.
- The classic lane (`/comfy-imagine/chat`) keeps working exactly as it does
  today, with its own tests, so switching back is a settings change.

## Shape

```
page (ChatColumn / use-runner)
   │  POST /comfy-imagine/agent   (SSE: steps, text, done)
   ▼
agent loop (server)  ── decide ──▶ llm.chat(messages, tools)
   │                                   │ tool_calls
   │  ◀────────────────────────────────┘
   ├─ tool: start a run ──▶ startFromBody ──▶ job queue ──▶ ComfyUI
   ├─ tool: job state  ──▶ getImagineJob (polled, progress sent as a step)
   ├─ tool: look       ──▶ analyzeImage / lookSoon (still or one frame)
   ├─ tool: files/history ──▶ gallery + notes
   └─ tool: host edit  ──▶ host's own route (loopback), e.g. IOPaint erase
   │
   └─ done: { reply, jobIds, pending? }
```

Why the loop lives on the server:

- the queue, the jobs, the media folder, the notes, the vision client and the
  workflow inventory are server state; the page is a view of them;
- a turn can last minutes (a still takes seconds, a clip minutes), and the
  model has to be woken when a run finishes; a closed tab must not lose it;
- the budgets (steps, jobs, GPU work) and the confirmations belong in one
  place, not in a component.

### New modules

| Path | What it is |
|---|---|
| `shared/agent-chat.ts` | Types shared by both sides: request, stream events, pending confirmation, the answer. |
| `server/vendor/tool-comfy/agent-loop.ts` | The loop: build context, call the model, dispatch tool calls, wait, stop, confirm. |
| `server/vendor/tool-comfy/agent-tools.ts` | The tool catalogue: JSON schema, argument checks, executor per tool. |
| `server/vendor/tool-comfy/agent-prompt.ts` | The system instruction: who the studio is, how a prompt is written, what the tools do not do. Thin, not a schema manual. |
| `server/src/llm.ts` | Tool calling on the OpenAI-compatible client (see below). |
| `server/vendor/tool-comfy/imagine-routes.ts` | `POST /comfy-imagine/agent` and the confirm route, reusing the SSE keep-alive and the abort wiring of the classic stream. |
| `web/vendor-imagine/client/use-runner.ts`, `ChatColumn.tsx`, `reading-trace.ts` | Submit to the agent when it is on, render tool steps, streamed reply, the confirmation card, stop. |

### Tool calling in the model client

`ctx.llm.stream` today takes `{ provider, model, messages, signal }` and yields
`text-delta`/`reasoning-delta` only. Agent mode needs three additions, all
inside the same client (`server/src/llm.ts`):

1. `tools` and `tool_choice` on the request body (`parallel_tool_calls: false`
   while the trace is one line per action; the queue is serial anyway);
2. `tool_calls` in the streamed deltas — the client's chunk union grows a
   `tool-call` kind with index, id, name and argument fragments, accumulated
   into whole calls;
3. the two message shapes a tool turn needs: `assistant` with `tool_calls`, and
   `tool` with `tool_call_id` and the result text. A result is a small JSON
   object, never an image: what a run produced is described by the note and the
   sight, so the model reads a sentence, not bytes.

The existing callers keep the old shape and are untouched by the change.

### The turn

1. The page sends the line, the project, the files in the composer, the board's
   recent files, the model the chip shows and the project's conversation.
2. The server assembles: the system instruction, the project digest (files with
   their origin note and their sight, newest first), the available actions and
   personal cards, the voices, the running jobs, and the conversation.
3. `llm.chat` returns either a tool call or the reply. Each tool call is
   validated, executed, and its outcome appended as a `tool` message; a step
   event goes to the page (`thinking`, `tool`, `queued`, `waiting`, `looked`,
   `confirm`, `error`).
4. After a run is queued, the loop polls the job (1 s), sends `waiting` with
   percent/stage, and gives up waiting at the turn's ceiling (the job keeps
   going; the reply says so).
5. When the model stops calling tools, its text is the reply, streamed to the
   page as it arrives (F3) and stored as the assistant message with the job ids
   the turn queued.
6. The page adopts the queued jobs into the project (`jobIds` on the message),
   exactly as it does for the classic intents.

### Budgets and confirmations

Configured in the settings page (`host-settings.json`), with defaults that a
normal user never has to touch:

| Knob | Default | What it bounds |
|---|---|---|
| `agentChat` | `auto` | `auto` = agent when the model declares tool calling, `off` = classic lane always, `on` = agent even if the model's declaration is missing (a probe decides). |
| `agentMaxSteps` | 8 | Model calls in one turn (a turn with 3 tools is typically 4-5 calls). |
| `agentMaxJobs` | 6 | Runs one turn may queue. |
| `agentConfirmSeconds` | 15 | A requested clip longer than this is confirmed first. Story, music, montage, custom cards and upscale-to-4K are always confirmed: their GPU cost is a chain, not a clip. F2 enforces this. |
| `agentWaitSeconds` | 300 | How long one turn waits for a run before answering "it is still running". |
| `agentTurnSeconds` | 900 | Hard ceiling of a turn; past it the loop stops and answers with what it queued. |

Before a long job the loop ends its step with a `pending` frame (the tool,
the studio action, a one-line summary in the interface's language, and a
token) and the page shows "Yes / No". The answer is a new POST to the same
route, carrying the token and the yes; it resumes the same turn with the rest
of its step and its step budget, and the model reads the tool result as if
nothing had paused. A no appends a refusal the model can act on. A reload asks
again, because a pending action is not worth persisting: the token lives in
memory and expires after ten minutes. The GPU is serial: a question is cheaper
than a chain nobody wanted.

There is no reliable per-graph GPU-time estimate in the studio, so the GPU cost
of a turn is bounded by what can be counted: the number of runs, the requested
duration of the long ones, and the confirmation on anything that is a chain.
A step ceiling also bounds the model bill, which for the default model is
pennies per turn.

The stop button (`ReadingTrace`) aborts the SSE request, which aborts the
model call and the polling; queued jobs are not cancelled by stopping a turn.
Cancelling a job is a tool that only ever proposes, never does (see Open
questions).

## Tools

Names are the studio's words, in English; arguments are typed, not free-form
JSON blobs. Every tool returns `ok` with a short fact (`queued job …`, the
files, the state), or `error` with a sentence the model can act on — the same
way a person would be told what is wrong.

### F1 — the loop and its core

| Tool | Arguments (checked) | What it does |
|---|---|---|
| `generate_image` | `prompt`, `aspect?`, `resolution?`, `count?` | Queues `generate`; the prompt is the user's words. |
| `edit_image` | `prompt`, `source`, `target?`, `region?` | Queues `remix` (whole photo, a grounded thing, or a marked zone). The fixed "keep the rest" sentence is not an argument: it is applied where it belongs today, in `run-job.ts`. |
| `erase` | `source`, `target?`, `region?` | Masked removal: grounds the thing, builds a feather-edged mask server-side, calls the host's IOPaint route. |
| `look` | `file`, `frame?`, `question?` | Describes a still (or one frame of a clip) through the vision client; the result is cached as the file's sight. |
| `project_files` | `kind?`, `limit?` | The project's files with their origin note and sight. The model uses this instead of remembering names. |
| `job_status` | `job?` | One job or the queue: state, percent, error, produced files. |

### F2 — everything that renders

| Tool | Arguments (checked) | What it does |
|---|---|---|
| `make_video` | `source`, `prompt?`, `seconds?`, `aspect?`, `resolution?`, `speed?`, `last_frame?` | Queues `video`; the source is a still, the length is the user's. |
| `extend_video` | `source`, `prompt?`, `seconds?` | Queues `extend` on a clip. |
| `loop_video` | `source`, `seconds?` | Queues `loop`: an animated background that repeats. |
| `make_story` | `prompt`, `source?`, `sources?`, `seconds?`, `song?`, `lyrics?`, `hard_cuts?` | Queues `story`: a chain of shots, over a song or across photos. Always confirmed. |
| `make_music` | `prompt`, `lyrics?`, `seconds?` | Queues `music`. Always confirmed. |
| `add_audio` | `video`, `track` | Lays a track over a clip on the host route; no run, no question. |
| `speak` | `text` | Queues `speak`. |
| `change_voice` | `source`, `voice?`, `pitch?` | Queues `voice` on a track or a clip. |
| `upscale` | `source`, `upscaleTo?` | Queues `upscale`; 4K on a still is always confirmed. |
| `run_card` | `customWorkflowId`, `prompt?`, `customFields?`, `customFiles?` | Queues `custom`; the card's id and inputs are checked against the inventory. Always confirmed. |
| `run_action` | `action`, `prompt?`, `source?`, `reference?`, `extras?` | Any other studio action with its own fields: object swap, character swap, recreate, relight, compose, bg, redo, resume, scanFrame, regenerate, custom. The fields are whitelisted and validated; the same confirmation gate applies. |
| `cancel_job` | `job` | Only ever proposes: the user's yes cancels the run. |

`redo_shot` and `resume_music_video` are not separate tools: they are
`run_action` with `redo`/`resume`, the studio's own actions.

### Parity

The model must not be weaker in agent mode than the fields were. `run_action`
takes the studio's own fields (`IMAGINE_ACTIONS` plus a whitelist of the
request fields the MCP's `imagine_run_action` already carries), so object
swap, character swap, recreate, relight, compose, redo, resume, background
removal and the rest are reachable. Every named file is checked against the
gallery, every closed choice against the studio's own lists, and the action
runs through the same `startFromBody` and the same confirmation gate as a
dedicated tool. A body field the studio does not know is refused, not dropped.

### F3 — the surface

Streamed reply text, a compact step line per tool (with the prompt actually
sent, one click to see it), long memory, retries and polish.

## Prompt, not template

The instruction says three things, and the code enforces them:

1. **The prompt is what the user said.** If the sentence already describes the
   picture, it is copied; missing choices are left to the studio's defaults,
   not filled with stock phrases. No "photorealistic, soft light, detailed" a
   user did not ask for.
2. **One change per edit.** A local change is one imperative sentence naming
   only what changes; the fixed "keep everything else the same" sentence stays
   where it is today, in `run-job.ts` (`localEditPrompt`), because it is a
   requirement of a full-redraw graph, not a style.
3. **Say what happened.** After a run, look at the result and compare it with
   the request; after two failures on the same thing, stop and name the better
   tool (the masked removal for something that has to disappear). The reply is
   written in the interface's language (`x-app-language`), whatever language
   the line was written in, as every other pass does today.

The server does not rewrite the prompt. It checks it and says why when it
cannot run: a ratio off the ladder, a duration past the graph, a name that is
not in the gallery, a LoRA or card input that does not exist. Those checks
already live in `shared/imagine-media.ts`, `shared/imagine-sizing.ts`,
`workflow-fields.ts` and `job-start.ts`; the tools reuse them instead of
duplicating them.

Measured while choosing the model (see below): all three models probed rewrote
an Italian request into a prompt with house phrasing. The instruction above and
the visible step (the prompt actually sent) are the fix; a test with a fake
model asserts that what the tool sends is what was returned, unchanged.

## Which model, and how the switch decides

The gateway already publishes what a model can do: `GET /v1/models` carries
`capabilities.tool_calling` per entry, and `server/src/llm.ts` already reads
that answer (for `effort_tiers`) and caches it for a minute. That is the switch:
`agentChat: auto` means agent when `defaultModel` declares `tool_calling: true`.

Measured on this deployment (2026-11-18, real probes, same tools, Italian
request, streamed). **The route in production is `strata/qwen3.8-flash-next`
through OmniRoute** (the deployment's `host-settings.json`); the earlier F0 table named
an `opencode-go` model that this deployment does not chat with, and it was
wrong for this studio.

| Route | tools | vision | first tool call | loop end (tool results → text) |
|---|---|---|---|---|
| `strata/qwen3.8-flash-next`, OmniRoute (default) | yes, declared | yes | 2.8–8.9 s, 3/3 runs | text after 4 calls, 3/3 runs |
| `qwen3.8-flash-next`, direct `:8080` (no capabilities) | yes, by probe | yes | 4.7 s | text after 4 calls |
| `opencode-go/deepseek-v4.1-flash` (F0's probe only) | yes | yes | 4.1 s | yes |

What the probes actually showed on Strata:

- The streamed shape is OpenAI's: `delta.tool_calls` fragments with `index`,
  `id` on the first piece, `function.name` once and `function.arguments` in
  pieces; `finish_reason: "tool_calls"`; the accumulated arguments parse as
  JSON. The second turn reads the assistant `tool_calls` and the `tool`
  result and keeps going.
- Three coherent runs (generate → job status → look → reply) ended with text
  in 4 calls each, 2.7–17.2 s per call. A loop with *incoherent* fake results
  (a blue square when the request was a red cup) keeps retrying: the model is
  judging the result, not just filling a schema, which is the point. The step
  ceiling and the forced final reply (one call without tools) bound it.
- One follow-up call in three streamed an `</parameter>` artefact into the
  arguments; the loop refuses malformed JSON as a tool result and the model
  corrects, so it is a wasted step, not a failed turn.
- Prompt fidelity: the model dropped the leading "Fai una foto di" and kept
  the description ("una tazza rossa su un tavolo di legno, con la luce del
  mattino dalla finestra"), with no house phrases added. The server passes
  what the tool receives through untouched; a fake-model test asserts that,
  and the step line shows the prompt actually sent so a rewrite is visible.
- Vision: asked about a neutral blue frame with a yellow square, both the
  OmniRoute route and direct Strata answered "The background is blue and the
  shape in the centre is a yellow square." (12.3 s through the gateway, 3.6 s
  direct).

**Capabilities.** OmniRoute publishes `capabilities.tool_calling: true` for
`strata/qwen3.8-flash-next`, so `auto` turns the agent on without a probe.
Strata's own `/v1/models` publishes no capabilities at all (only the
architecture and `n_ctx`): a studio pointed straight at `:8080` gets the
cached probe, which sends one trivial tool with `tool_choice: "required"`,
bounded at 40 s, and remembers the answer for the life of the process. That is
the path the test instance ran on.

**Choice.** The default model stays the one the user picked: on this
deployment `strata/qwen3.8-flash-next` through OmniRoute, which has tools,
vision and a 256k context and costs nothing on the local GPU. No second model
setting: the composer's chip still names one model and every pass uses it.
`auto` = agent when the route declares tool calling, or when the probe finds
it; `off` = classic always; `on` = agent whatever the route declares. A route
with neither a declaration nor a successful probe sends the line to the
classic lane, and the answer says so (`skipped: "no-tools"`), instead of
pretending to be an agent.

Vision does not depend on the chat model: `look` uses the configured vision
route, as every sight pass does today. A chat model without image input still
gets the agent, it just cannot look at the picture in the same call.

## Memory

The project's messages are already the memory; today the page sends the last
eight. Agent mode:

- sends the whole conversation up to a character budget (default 24k), oldest
  turns dropped only when the budget is full, and says in the instruction what
  was dropped;
- carries the project digest (files with notes and sights), which is what makes
  "like before, but darker" work: the previous result is a file with its prompt
  and its sight, so the model can point at it by name;
- does not persist a second transcript: the project file wins, so a restart
  loses no memory and adds none;
- F3 adds a rolling summary of the dropped turns, written once and kept in
  memory beside the project, never replacing the messages.

## Risks

| Risk | Why it matters | What holds it |
|---|---|---|
| Runaway loop | A thinking model in a loop writes until the context closes; the GPU queue can fill | Step, job, turn and wait ceilings; no new token deadline (the silence clock of `llm.ts` is the only one); the stop button aborts the request; the trace shows every step as it happens |
| Duplicate or wrong work | A tool called twice queues two runs; a name guessed from memory queues the wrong file | Jobs are adopted with their `projectId`; tool results carry the ids; file names are checked against the gallery; a failed run's reason goes back to the model; two failures on the same thing stop the loop |
| Prompt drift | Measured in the probe: models add house phrasing and lose the request's nuance | Instruction rule, a fake-model test that the prompt is passed verbatim, and the sent prompt visible in the step |
| Waiting on a clip | A 30 s video is minutes of GPU; an SSE connection can die in front of a proxy | Confirmation before long work; `agentWaitSeconds`/`agentTurnSeconds`; keep-alive every 15 s (already there); after the ceiling the reply says the run is still going and `job_status` can answer later |
| Tool calling diverges by provider | The gateway is OpenAI-shaped, a local Ollama/llama.cpp may not stream `tool_calls` | Capability field first, one cached probe second, classic lane third; a test file covers the delta shapes |
| Page state and server state | Jobs are queued by the server; the project file is written by the page | Jobs are adopted server-side (`adoptJobsInto`) and the page re-syncs, the path the MCP already uses |
| Memory and cost | A full conversation plus files on every step | Character budget, digest instead of file lists repeated, cheap default model, step ceiling |
| Host edits behind a plugin | The eraser is the IOPaint plugin's route; the agent runs in the server | The mask is built server-side (the mask code of `mcp/masks.ts` moves to `shared/`), and the plugin route is called over loopback, which skips the login check (`auth.ts`) |
| Privacy | A "look" sends the file to the cloud model, as today's sights do | Same route and same setting as today; the agent adds no new data destination |
| The classic lane | It must not regress while the agent is built | It keeps its route, its tests (`imagine-chat.test.ts`) and its fallback; the switch is the only new entry point |
| Phase parity | With the switch on, an action that has no tool yet would be lost | F1 answers "not in this version yet" instead of inventing; F2 closes the gap with `run_action`, and the switch is the user's to turn off meanwhile |

## Phases

Each phase is its own branch and PR, not merged by the worker.

- **F0** — this document. Branch `agent-chat-f0-20261118`.
- **F1** — tool calling in the model client, the loop, `generate_image`,
  `edit_image`, `erase`, `look`, `project_files`, `job_status`, the settings
  switch (default `auto`), the route and its steps, tests with a fake model,
  and a real run on a test instance with neutral data (a 480p still, few
  steps). Branch `agent-chat-core-20261118`.
- **F2** — video, extend, loop, story, music, audio, voice, upscale, personal
  cards, the confirmation gate and the wait/ceiling rules. Branch
  `agent-chat-media-20261118`; the parity tool (`run_action`) is
  `agent-chat-parity-20261118`, on top of it.
- **F3** — streamed reply, the step UI in the column, long memory and the
  rolling summary, retries and polish. Branch `agent-chat-ui-20261118`.

If F1 grows past what one review can hold, it splits into "loop and tools" and
"switch and wiring"; the loop is what the rest depends on.

## Decisions (owner, 2026-11-18)

1. **Confirmation** only for a clip longer than 15 s, and always for a story,
   music, montage, a personal card and an upscale to 4K. A 10–15 s clip runs
   without asking.
2. **The agent never cancels a job by itself.** It proposes the cancel and
   waits for the user's yes; the same rule as a confirmation, and the reason
   `cancel_job` is a proposal in F2 rather than a tool.
3. **A long wait closes the turn** with "it is still running", and the result
   appears in the chat by itself when the run settles — the reply line carries
   the job ids, and the page folds each finished run's files under it (and
   posts its result line) without the user asking again.

## F1 — what is built

- `server/src/llm.ts`: `chat` (tool calls, reasoning, text, finish reason on
  one streamed call), and `modelCapabilities` from `/v1/models`. The classic
  `stream` is untouched.
- `agent-loop.ts`: the lane choice, the cached probe, the loop, the wait, the
  step ceiling and the forced final reply.
- `agent-tools.ts`: `generate_image`, `edit_image`, `erase`, `look`,
  `project_files`, `job_status`, with the studio's own checks.
- `agent-prompt.ts`: the instruction and the project digest.
- `POST /comfy-imagine/agent`: one route for both lanes. The answer says
  `mode: "agent"` with `jobIds`, or `mode: "classic"` with the intents the page
  has always run, so the page does not need to know which switch is on.
- The settings switch (`agentChat`: auto/off/on) and the budgets, saved in
  `host-settings.json` and applied from the next turn.
- The page: the chat submits to the agent route, shows the tool steps and the
  prompt actually sent, attaches the queued ids to the reply line, and puts a
  file the eraser made on the board.
- Tests with a fake model (`test/agent-chat.test.ts`,
  `test/llm-agent.test.ts`): the prompt passes through unchanged, a refusal
  goes back to the model, the step ceiling ends with a reply, the probe is
  cached, the switch picks the lane, and the tool-turn wire shapes.

### F2 — what is built

- `agent-tools.ts`: the ten media tools of the table above, plus the
  confirmation gate (`confirmationFor`) and `numbersInLine`, the recovery of a
  count and a length the model drops.
- `agent-loop.ts`: the turn is a state machine now. A confirmed call stops
  before it runs; the session (messages, runs, files, step budget, deadline)
  waits in memory by token, and the answer resumes it with the rest of the
  step. A no is a tool result the model reads. A pending turn survives neither
  a restart nor a reload, by design.
- `imagine-routes.ts`: the agent route accepts the confirmation body and
  resumes the same turn, streaming its steps as before.
- `ChatColumn.tsx` / `use-runner.ts`: the confirmation card (Yes/No, in the
  interface's language) and the resumed turn; a host edit the agent makes
  (the track laid over a clip) joins the board as the eraser already did.
- `agent-prompt.ts`: the tools, the confirmation rule, the cancel rule, the
  personal cards, and the rule that the reply stays in the interface's
  language when the line is written in another one.

Not in F1, by the phase plan: clips, story, music, audio, voice, upscale,
cards, the confirmation gate, cancel and the long-memory summary. F2 adds the
first ten; the long-memory summary stays in F3. F1's own leftovers were fixed
with F2: a count the user named ("tre foto") and a length ("16 secondi") are
recovered from their line when the model drops them, and the instruction now
says that a reply stays in the interface's language even when the user writes
in another one (the prompt keeps their words).

### Proved on a trial instance (2026-11-18)

The branch, on port 3091 with its own data folder, a real ComfyUI on the
user's PC and a real IOPaint, Qwen3.8 through Strata's own `/v1` (which
publishes no capabilities, so every turn went through the cached probe), the
Italian pack, neutral images only. No user data.

- **A still**: "Fai una foto di un faro bianco su una scogliera al tramonto"
  queued one `generate` job, streamed the wait with its percentages, looked at
  the file and answered with what it saw (lighthouse, rocks, orange-to-blue
  sky, lamp lit), 45 s. The job's prompt was the user's description; the tool
  step showed it in the column.
- **An edit**: "Rendi il cielo più viola, tieni il resto com'è" grounded "il
  cielo", sent a remix with that zone, waited, looked, and reported a darker
  band at the top it offered to redo, 71 s.
- **The eraser**: a yellow square on blue, "Togli il quadrato giallo" →
  grounding, mask, IOPaint, a new file; the model looked at both and said the
  fill was a shade darker than the rest, 36 s.
- **The read tools**: "Che fine ha fatto la foto del gatto? E quali file ci
  sono in questo progetto?" read `project_files` and `job_status` and listed
  the four files with how each was made, correctly saying the cat was not in
  that project, 12 s.
- **The switch**: `off` answered `mode: "classic"`, `skipped: "off"` with the
  classic intents; `auto` turned the agent back on without a restart.
- **A long wait**: with `agentWaitSeconds: 5`, the reply said the generation
  was still running and the result would appear by itself; when the job
  finished the column posted its result line and drew the file under the
  reply, with no further request from the user.
- **A named choice the model drops**: asked "quadrata, a 480p", Strata called
  the tool with `1:1` and no resolution. The tool recovers a ratio or a
  resolution the user named from their line (`choicesInLine`, unit-tested),
  so the run and the file were 480×480, and the reply said so. The prompt
  itself is never rewritten.

Not proved: a turn that waits out a naturally slow clip (F1 has no clip
tools; the wait was forced with the 5-second setting — F2 proves the real one
below), and anything on Windows.

### Proved on a trial instance (F2, 2026-11-18)

The media branch, on port 3091, with its own `IMAGINE_HOME`, the Italian
pack, `strata/qwen3.8-flash-next` through Strata's own `/v1` (no
capabilities, so the cached probe decided the lane) and the real ComfyUI on
the user's PC. A neutral blue 768×768 picture, no user data. `agentWaitSeconds`
was 60 on the trial so a real clip would outlive the wait.

- **The confirmation, in the page**: "Crea un video di 16 secondi da
  photo.png: la camera si avvicina lentamente alla scena, a 480p" produced the
  card "Un video di 16 secondi: vuoi che parta?" and nothing was queued before
  the yes (screenshot `1-confirm.png`).
- **The natural wait and the asynchronous result**: after the yes the turn
  queued one `video` job, waited its 60 seconds, and closed with "La
  generazione è in corso: il risultato comparirà nella chat quando sarà
  pronto." The real chain finished after 7m50s (`create_video-9942b232.mp4`,
  15.79 s, H.264 + AAC) and the page folded it under the reply line by
  itself, with no further request (`4-result.png`). The job's request carried
  `seconds: 16`, `megapixels: 0.4`; the deployment's chain graph rendered
  720×1280 anyway, which is the graph's own canvas, not a value the agent
  chose.
- **The language retry**: with the interface in Italian, "Which files are in
  this project? Name them in one sentence, in your own words." answered "Nel
  progetto c'è un solo file, `photo.png`, ed è un'immagine tutta di un unico
  colore blu uniforme…": an English line, an Italian reply, the user's words
  untouched in the prompt.
- **The cancel proposal, on a real run**: a `generate` job was queued through
  the studio's own route, then "Annulla il lavoro che è appena partito."
  produced a `cancel` offer naming that job's id, with the run untouched.
  The no left it alone (it finished normally). The first real reply said
  "ancora in coda" when the job had already finished; the declined answer now
  carries the run's own state, so the model has the fact instead of guessing.
- **Tests**: `test/agent-chat.test.ts` covers the gate (clip over the limit,
  story, music, card, 4K), the resume and the no, the cancel proposal that
  only stops on a yes, the count/length recovery, `add_audio` against a fake
  host route, and the card inputs. The full suite is green (665 tests on the
  media branch, 669 on the parity branch).

Proved with fakes only: story, music, speak, change_voice, upscale and the
personal cards (their tools are unit-tested, not rendered); a cancel accepted
(only its proposal and its refusal ran against a real job); and everything on
Windows.

## Open questions for the owner

None left from the design. The next ones belong to F2 and F3: the wording of
the confirmation card, and how a dropped long conversation is summarised.
