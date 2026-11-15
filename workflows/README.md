# The graphs

Every file here is a ComfyUI graph in **API format**: the JSON you get from
"Save (API format)". They are examples from one machine: the `class_type` of
each node and the names of the checkpoints, VAEs, LoRAs and text encoders they
load are the ones installed there. **Before using a graph elsewhere, open it in
ComfyUI, point every loader at the models you have installed (and install the
custom nodes it uses), then export it again in API format.** The sample file
names in the `LoadImage` / `LoadVideo` / `LoadAudio` nodes (`input.png`,
`input.mp4`, …) are placeholders: the studio uploads the real input and writes
its name there on every run.

`config.yaml` does not read a graph as a whole: it pins the **node ids** that
change on every run — where the prompt goes, the seed, the canvas, the input
image or clip. A different graph works for an action as long as you pin the
nodes that play those roles; `config.example.yaml` wires every graph marked
"default" below with ids that match these files.

A **personal** graph does not belong here: it lives in
`<data>/custom-workflows/<id>/graph.json` and the config names it with
`path: custom:<id>`.

**Graphs are read once, at startup.** After editing one, restart the process,
or it keeps using the copy in memory.

## Images

| File | Config key(s) | What it does |
|---|---|---|
| `comfyui_generazione_krea2_API.json` | `generateImage`, `recreateFrame` (default) | Text to image (Krea 2). |
| `comfyui_edit_krea2_API.json` | `editImage` (default) | Image to image: an anchored Krea 2 edit of a photo. |
| `comfyui_edit_krea2_region_API.json` | `editImageRegion` (default) | The same edit confined to a masked zone; the rest of the photo keeps its own pixels. |
| `qwen_compose_refs_API.json` | `composeRefs` (default) | Two photos into one (Qwen-Image 2.1): a person plus a reference (outfit, setting). |
| `comfyui_edit_flux3_relight_API.json` | `relight` (default) | Relights a photo (FLUX.3 Klein) with the chosen lighting look; identity, pose and framing stay. |
| `SeedVR2_4K_image_upscale.json` | `upscaleImage` (default) | Image upscale to 4K (SeedVR2). |
| `utility_birefnet_remove_background.json` | `removeBackground` (default) | Background removal (BiRefNet), transparent WebP out. |

## Video

The clip graphs are MiniMax H3, in two recipes per action with the same pins,
so they are interchangeable in `path` / `pathHigh`:

- **Pika fast** — base H3 weights plus the Pika turbo LoRA, 4 steps. The
  default `path`.
- **Pika quality** — base H3 weights plus the Pika LoRA, 6 steps. The default
  `pathHigh` (used for "Quality: high" / "Speed: slow").

| File | Config key(s) | What it does |
|---|---|---|
| `comfyui_video_i2v_pika_fast_API.json` | `createVideo`, `recreateVideo` (default `path`) | Image to video, with an optional end frame. |
| `comfyui_video_i2v_pika_quality_API.json` | `createVideo`, `recreateVideo` (default `pathHigh`) | Same, quality recipe. |
| `comfyui_video_loop_pika_fast_API.json` | `loopVideo` (default `path`) | Animated loop: the latent's end wraps onto its start (`MiniMaxH3Loop`), the photo is a reference. |
| `comfyui_video_loop_pika_quality_API.json` | `loopVideo` (default `pathHigh`) | Same, quality recipe. |
| `comfyui_video_extend_pika_fast_API.json` | `extendVideo` (default `path`) | Continues an existing clip from its tail. |
| `comfyui_video_extend_pika_quality_API.json` | `extendVideo` (default `pathHigh`) | Same, quality recipe. |
| `comfyui_video_song_pika_fast_API.json` | `videoOnSong` (default `path`) | A clip that sings a given track: the song slice is anchored at a frame, so the mouth follows it; shots chain into each other. |
| `comfyui_video_song_pika_quality_API.json` | `videoOnSong` (default `pathHigh`) | Same, quality recipe. |
| `comfyui_video_object_swap_API.json` | `objectSwap` (default) | "Edit object", mode *change*: the tracked object is replaced, optionally from a photo. |
| `comfyui_video_object_swap_remove_API.json` | `objectSwapRemove` (default) | Mode *remove*: the masked object is regenerated as the surrounding scene. |
| `comfyui_video_object_swap_background_API.json` | `objectSwapBackground` (default) | Mode *background*: the mask is inverted, the surroundings are redrawn and the subject stays. No photo. |
| `comfyui_video_object_swap_add_API.json` | `objectSwapAdd` (default) | Mode *add*, from a description: the object is drawn inside the box the user placed. |
| `comfyui_video_object_swap_add_photo_API.json` | `objectSwapAddPhoto` (default) | Mode *add* from a photo of the object; chosen when the request carries a photo. |
| `comfyui_video_regenerate_detail_API.json` | `regenerateDetail` (default) | "Regenerate detail" (Open-H3 refiner): lifts the clip's latent with a 3D convolution and redraws it in a few steps. |
| `SeedVR2_HD_video_upscale_native.json` | `upscaleVideo` (default) | Video upscale to HD (SeedVR2), for short clips. |
| `SeedVR2_HD_video_upscale_native_batched.json` | `upscaleVideoLong` (default) | The same for long clips, as a VHS meta-batch chain ComfyUI requeues per block. |

The object-swap graphs use SAM 3 to track the object named in `subjectText`
and several custom H3 nodes (`H3GreyMannequins`, `H3ObjectPlacementMask`,
`H3PeopleMask`, `MiniMaxH3FantasticVideoEditLatent`); install those node packs
before loading them.

## Audio

| File | Config key(s) | What it does |
|---|---|---|
| `audio_minimax_music_3.json` | `generateMusic` (default) | Text to music (MiniMax Music 3), with lyrics and length. |
| `audio_voice_rvc_parlato_API.json` | `changeVoice` (default) | Voice changer: RVC over a spoken or sung track. List the RVC models you have in `voices`. |
| `audio_vocals_API.json` | `extractVocals` (default) | Isolates a track's vocal (an internal step of the singing clip). |
