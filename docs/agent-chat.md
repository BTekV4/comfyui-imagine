# The agent chat

Status: design for review (F0, 2026-11-18). Nothing in this document is built
yet, and nothing below changes the classic lane until the switch exists.

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
| `agentConfirmSeconds` | 10 | A requested clip longer than this is confirmed first. Story, music, montage, custom cards and upscale-to-4K are always confirmed: their GPU cost is a chain, not a clip. |
| `agentWaitSeconds` | 300 | How long one turn waits for a run before answering "it is still running". |
| `agentTurnSeconds` | 900 | Hard ceiling of a turn; past it the loop stops and answers with what it queued. |

Before a long job the loop ends its step with a `pending` frame (tool, a
human-readable preview built by the client, and a token) and the page shows
"Yes / No". The confirmation is a new POST that resumes the same session; a
reload asks again, because a pending action is not worth persisting. The GPU is
serial: a question is cheaper than a chain nobody wanted.

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

`make_video`, `extend_video`, `make_story`, `make_music`, `add_audio`,
`speak`, `change_voice`, `upscale`, `run_card` (personal cards with their own
inputs), `redo_shot`, `resume_music_video`, plus `cancel_job` as a proposal.
The long ones go through the confirmation gate above.

### Parity

The model must not be weaker in agent mode than the fields were. Every action
the studio can run gets a tool eventually; until it has one, F2 adds a single
`run_action` tool with the studio's own fields (`IMAGINE_ACTIONS` plus the
validated extras the MCP's `imagine_run_action` already takes), so object swap,
character swap, recreate, relight, compose, loop, background removal and the
remaining host edits are reachable. F1 covers the tools listed above and says
so in its reply when a line asks for one of the others; it never invents an
action. The parity gap is a phase boundary, not a design choice.

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

Measured on this deployment (2026-11-18, through the gateway, same tools,
Italian request, streamed):

| Model | tools | vision | first tool call | second turn (tool result → text) | price /M in-out |
|---|---|---|---|---|---|
| `opencode-go/deepseek-v4.1-flash` (default) | yes | yes | 4.1 s | yes, sensible | 0.30 / 1.20 |
| `opencode-go/qwen3.8-flash` | yes | yes | 2.6 s | yes | 0.15 / 0.47 |
| `opencode-go/deepseek-v4-pro` | yes | no | 2.3 s | yes | 1.32 / 3.96 |
| `opencode-go/glm-5.3` | yes | no | not probed | — | 1.40 / 4.40 |
| `opencode-go/kimi-k3` | yes | yes | not probed | — | 3 / 15 |

**Choice.** The default model stays the one the user picked: today
`opencode-go/deepseek-v4.1-flash`, which has tools, vision, a 1M context and a
price that makes a ten-step turn cheap. No new provider and no second model
setting: the composer's chip still names one model and every pass uses it. When
the chosen model declares no tools — or a local endpoint that does not publish
capabilities — the server makes one cached probe (a trivial tool, one short
call, remembered per provider/model for the life of the process). If the probe
does not produce a tool call, the chat uses the classic lane and the settings
page says why, instead of pretending to be an agent.

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
- **F2** — video, extend, story, music, audio, voice, upscale, personal cards,
  the confirmation gate and the wait/ceiling rules. Branch
  `agent-chat-media-20261118`.
- **F3** — streamed reply, the step UI in the column, long memory and the
  rolling summary, retries and polish. Branch `agent-chat-ui-20261118`.

If F1 grows past what one review can hold, it splits into "loop and tools" and
"switch and wiring"; the loop is what the rest depends on.

## Open questions for the owner

1. Confirmation threshold: is "any clip over 10 s, and every story, music,
   montage, custom card and 4K upscale" the right line, or should a 10-15 s
   clip run without asking?
2. May the agent cancel a running job by itself (to redo it), or only propose
   the cancel and wait for the user? The proposal is the safer default.
3. When a clip is still rendering past the wait ceiling, should the chat answer
   "it is running, ask me again" (cheap, honest) or keep the turn open up to
   the turn ceiling (fewer messages, a longer spinner)?
