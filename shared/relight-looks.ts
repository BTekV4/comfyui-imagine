/**
 * The seventeen light looks of the «relight» recipe, once, for both sides.
 *
 * The recipe is openjutsu's fourth useful one: a photo is re-lit with one of
 * the seventeen lights and comes back with the same person, pose, framing and
 * setting, only the light changed. The look list is a closed set — the graph
 * gets one sentence per look, and an invented look would be a different
 * picture — so it lives here, read by the page (the pills), by the host (which
 * writes the sentence) and by the chat (which reads the look out of a line).
 *
 * The `light` sentences are openjutsu's own, in English: they ARE the prompt
 * the graph receives, and translating them would change the picture. The names
 * the page shows are Italian (`name`), and `nameEn` is what the chat's reading
 * sees in the prompt it is given.
 * @module shared/relight-looks
 */

/** One light look of the relight recipe. */
export interface RelightLook {
  /** The slug: the thumbnail's name and the value the API and the job carry. */
  readonly id: string
  /** The name the page shows, in Italian. */
  readonly name: string
  /** The look's name as openjutsu wrote it, in English, for the reading. */
  readonly nameEn: string
  /** The look's light sentence, in English: it IS the prompt the graph gets. */
  readonly light: string
}

/**
 * The instruction every relight is given, from openjutsu's recipe: the look's
 * sentence fills the last slot. The graph may keep its own copy of this; the
 * host writes the whole instruction, so a graph whose text node holds only the
 * look's sentence works the same way.
 */
export const RELIGHT_PROMPT_PREFIX =
  'Relight this photograph. Keep the person, face, identity, expression, pose, hair, clothing, framing'
  + ' and setting exactly as they are; change only the lighting and the colour of the light.'

/** The seventeen looks, in the recipe's order. */
export const RELIGHT_LOOKS: readonly RelightLook[] = [
  {
    id: "cold_beam",
    name: "Fascio freddo",
    nameEn: "Cold beam",
    light: "Light the new photo as a dark horror scene: a single narrow cold white spotlight shines straight down from directly above, with a visible beam of light cutting through dusty air above the head; it lights the top of the hair, forehead, cheekbones, nose and shoulders, leaves deep shadows in the eye sockets and under the nose and chin, and the background falls to black. Cold, desaturated blue-grey colour grade.",
  },
  {
    id: "golden_halo",
    name: "Alone dorato",
    nameEn: "Golden halo",
    light: "Light the new photo with a warm golden glow: a strong amber backlight behind the head turns the background into glowing orange-gold haze and puts a bright golden rim on the hair and shoulders, while soft warm gold light falls on the face from the front. Rich honey and orange tones, glowing highlights, warm shadows, like sunset in a cathedral.",
  },
  {
    id: "red_blue_gels",
    name: "Gel rosso e blu",
    nameEn: "Red and blue gels",
    light: "Light the new photo with two coloured gel lights in a dark room: saturated red light from the left and deep electric blue light from the right, each colour wrapping around its side of the face, hair and body, purple where they meet, and a dark red-blue background. High-contrast cinematic colour.",
  },
  {
    id: "magenta_club",
    name: "Club magenta",
    nameEn: "Magenta club \u00b7 mostly the background",
    light: "Light the new photo as a night club scene: the face, hair, skin and clothes are washed in hot magenta and purple stage light from above and the left, with pink highlights and deep violet shadows on the person, pink haze in the air and a blurry purple background with sparkling lights.",
  },
  {
    id: "teal_lasers",
    name: "Laser turchesi",
    nameEn: "Teal lasers \u00b7 mostly the background",
    light: "Light the new photo as a dark club scene in teal and blue: the face, hair, skin and clothes are lit by cold cyan light from the side, with blue-tinted skin, cyan highlights and deep navy shadows on the person; thin bright cyan laser beams cut diagonally through the haze behind, and the background is dark blue-black.",
  },
  {
    id: "toxic_green",
    name: "Verde tossico",
    nameEn: "Toxic green",
    light: "Light the new photo with eerie toxic green light: a vivid green light from below and the side lights the face, hair and clothes, green laser beams shine through dark haze behind, deep green-black shadows, the whole scene tinted acid green.",
  },
  {
    id: "lime_purple",
    name: "Lime e viola",
    nameEn: "Lime and purple",
    light: "Light the new photo with two bold gel colours: acid yellow-lime light from the front left floods the face and hair, deep purple light fills the shadows on the right and the background, high saturation and strong contrast, like a music video.",
  },
  {
    id: "cyan_orb",
    name: "Sfera ciano",
    nameEn: "Cyan orb",
    light: "Light the new photo as a dark, moody scene lit only by a small glowing cold-blue light orb floating close to the face on the right side of the frame; the person is in darkness except where the orb's cool cyan-white light falls on the near side of the face, falling off quickly into blue-black shadow, with blue highlights in the eyes. No other light in the scene.",
  },
  {
    id: "red_room",
    name: "Stanza rossa",
    nameEn: "Red room",
    light: "Light the new photo with deep crimson red light filling the whole scene, dark red shadows and a red-black background, and one small bright white light at the left edge of the frame that puts a cold white highlight on the near cheek and in the eyes.",
  },
  {
    id: "blinds",
    name: "Persiane veneziane",
    nameEn: "Venetian blinds",
    light: "Light the new photo as a film noir scene: hard low afternoon sunlight comes through venetian blinds from the left and casts sharp parallel diagonal stripes of bright light and black shadow across the face, hair, neck, clothes and the wall behind; thin rays of light are visible in the smoky air, the rest of the room is dark. Warm amber highlights, deep black shadows, high contrast.",
  },
  {
    id: "phone_glow",
    name: "Luce del telefono",
    nameEn: "Phone glow",
    light: "Light the new photo as a dark room at night lit only by a phone screen held just below the face; its cold blue-white light falls on the chin, lips, nose and cheeks from below, reflects as small bright squares in the eyes, and fades to black on the hair, shoulders and body, with a pitch-black background. Cold blue tones, everything outside the screen light in darkness.",
  },
  {
    id: "firelight",
    name: "Luce del fuoco",
    nameEn: "Firelight",
    light: "Light the new photo as a night scene beside a campfire just outside the frame at the bottom left; flickering orange-red firelight lights the face, hair and clothes from below and the left, glowing embers and sparks float up through the dark air, the far side of the face falls into deep shadow and the background is black night. Hot orange and red tones against darkness.",
  },
  {
    id: "sunset_window",
    name: "Finestra al tramonto",
    nameEn: "Sunset window",
    light: "Light the new photo as a dim room at golden hour: low orange sunlight through a window on the left falls as a hard warm patch across one side of the face, hair and shoulder, with the window-frame shadow cutting across the body; the other side of the face is in deep brown shadow and the room behind is dark. Rich orange highlights, dark warm shadows.",
  },
  {
    id: "evening_lamp",
    name: "Lampada della sera",
    nameEn: "Evening lamp",
    light: "Light the new photo as a room in the evening lit only by a table lamp just out of frame on the right at shoulder height: soft warm orange light falls on that side of the face, hair and body, the other side fades into dim brown shadow, and the room behind is dark and cosy with no daylight. Warm amber tones, low brightness, intimate night-time mood.",
  },
  {
    id: "rim_backlight",
    name: "Controluce sul bordo",
    nameEn: "Rim backlight",
    light: "Light the new photo with one hard light directly behind the person and slightly above: it draws a thin bright white rim along the hair, the edges of the face, the shoulders and the arms, light glows through loose strands of hair, the front of the face and body stay in deep shadow with only a faint fill, and the background is dark. High-contrast cinematic silhouette lighting.",
  },
  {
    id: "blue_night",
    name: "Notte blu",
    nameEn: "Blue night",
    light: "Light the new photo as a room at night lit by soft cool light from the left side: dim blue-violet light falls on the near side of the face, hair and clothes, the other side sinks into deep blue-black shadow, and the background is dark navy. Low brightness, quiet futuristic night mood, cool blue and purple tones.",
  },
  {
    id: "camera_flash",
    name: "Flash della macchina",
    nameEn: "Camera flash",
    light: "Light the new photo with a direct on-camera flash at night: hard flat white light straight from the camera hits the face and body brightly, gives the skin a slight glossy shine, small bright catchlights in the eyes, a hard dark shadow just behind the person on the wall, and the background falls off quickly into darkness. Candid party-photo look, high contrast.",
  },
]

/**
 * The look a run with nothing chosen is given: the recipe's first, so the card
 * always starts from a real light instead of an empty prompt.
 */
export const DEFAULT_RELIGHT_LOOK = RELIGHT_LOOKS[0]!

/**
 * The look a value names, by slug or by name in either language, or undefined.
 *
 * The chat reads a line and hands back what it understood; the API validates a
 * slug. Both arrive here, so both are accepted, case-insensitively — an
 * invented look is not matched and is refused by the caller.
 * @param value - the slug, or the look's name.
 * @returns the look, or undefined.
 */
export function relightLookOf(value: string | undefined): RelightLook | undefined {
  const wanted = value?.trim().toLowerCase() ?? ''
  if (wanted.length === 0) return undefined
  return RELIGHT_LOOKS.find(look => look.id === wanted
    || look.name.toLowerCase() === wanted
    || look.nameEn.toLowerCase() === wanted)
}

/**
 * The prompt one look hands the graph: the recipe's instruction and the look's
 * own sentence, which the model reads as the light to paint.
 * @param look - the look the run asked for.
 * @returns the English prompt.
 */
export function relightPromptOf(look: RelightLook): string {
  return `${RELIGHT_PROMPT_PREFIX} ${look.light}`
}

/**
 * The look's thumbnail, as the page loads it: the seventeen are served from the
 * repository's own `/imagine/relight/`.
 * @param look - the look.
 * @returns the path from the site's root.
 */
export function relightThumbOf(look: RelightLook): string {
  return `/imagine/relight/${look.id}.webp`
}
