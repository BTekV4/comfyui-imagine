# imagine-mcp — Imagine as an MCP server

Imagine's tools for LLM clients (Claude Code, other agents, any MCP client):
projects, files and jobs, as typed tools instead of a prompt that has to
remember routes and request bodies.

It is a separate process that talks to Imagine only through Imagine's own HTTP
API (the routes the page uses). It never touches the studio's state directly,
and restarting it does not stop any job.

- Endpoint: `http://<host>:3097/mcp` — MCP **Streamable HTTP**, stateless
- Auth: `Authorization: Bearer <token>`; the token is read from the file named
  by `MCP_TOKEN_FILE` (default `./mcp-token`)
- Build: `npm run build:mcp` → `dist/imagine-mcp.mjs` (one file, run with `node`)
- Service: see `deploy/imagine-mcp.service.example`

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `IMAGINE_URL` | `http://127.0.0.1:3090` | Where Imagine answers |
| `IMAGINE_PUBLIC_URL` | `IMAGINE_URL` | Base of the file links handed to the model: an address the client can open |
| `MCP_PORT` | `3097` | Port to listen on |
| `MCP_TOKEN_FILE` | `./mcp-token` | File holding the bearer token (`openssl rand -hex 24 > mcp-token`) |
| `IMAGINE_LANGUAGE` | `en` | Language Imagine writes its own notices in |

## Connecting a client

Claude Code:

```sh
claude mcp add --scope user --transport http imagine http://<host>:3097/mcp \
  --header "Authorization: Bearer $(cat /path/to/mcp-token)"
```

Other clients: add a `streamable-http` (or `http`) MCP server with that URL and
header.

## Tools

| Tool | What it does |
|---|---|
| `imagine_list_projects` | Projects, with how many files and jobs each holds |
| `imagine_create_project` | Create a project holding some files |
| `imagine_project_files` | A project's files, with URLs |
| `imagine_recent_media` | The library, newest first; `query` searches the words of the files |
| `imagine_upload` | Upload a file (from a URL or base64), optionally into a project |
| `imagine_view` | Return the picture (or a video frame) so the model can look at it |
| `imagine_generate_image` | Text to image: prompt, aspect, resolution, quality |
| `imagine_edit_image` | Edit a picture with an instruction; with `segments` or `region` only that zone changes (Precise edit), with `reference` a second picture to take something from |
| `imagine_segments` | Find the objects in a photo (Segments: vision model + SAM 3): index, label, box, share of the photo, cut-out and mask links |
| `imagine_remove_object` | Erase segments or a rectangle and fill from around them (LaMa, via the IOPaint plugin) |
| `imagine_crop` | Keep a rectangle of a photo as a new file |
| `imagine_make_video` | Picture to video (length, aspect, speed, last frame) |
| `imagine_run_action` | Any other studio action (upscale, background, music, voice, loop, …) |
| `imagine_custom_workflows` | The user's uploaded workflows, run with `imagine_run_action` `custom` |
| `imagine_job` | A job's state, waiting up to 50 s per call; finished jobs return their files |
| `imagine_list_jobs` | Queued and running jobs |
| `imagine_cancel_job` | Stop a job |

Zones go from the model to the studio in two ways: as **segments** (call
`imagine_segments` on the photo, then pass the indexes — "the jacket", "the
person in the back") or as a **region**, a rectangle in fractions of the photo
(`{"x":0.1,"y":0.2,"w":0.3,"h":0.4}`). The masks are joined in the MCP process
itself (`mcp/masks.ts`); Remove object grows them by 2% of the short side, so
LaMa fills from the background around the object instead of redrawing its edge.

**Projects.** Every job can name a `project` (id or title). A title that does
not exist creates that project *with the job already in it* — an empty project
created from outside is removed by the page on its next sync. The files a job
starts from (its `source`, `reference`, …) are put into the project too.

Sizes, video aspect labels and allowed durations come from
the same helpers the page uses, so a tool call and a click produce the same
request.
