/**
 * Which stills "Crop" is offered on (the crop itself is a new PNG made
 * by /api/crop-copy).
 */

/**
 * Whether a gallery file is a still the crop can read.
 * @param name - the gallery basename.
 * @returns true for PNG, JPEG and WebP.
 */
export function isCroppable(name: string): boolean {
  return /\.(png|jpe?g|webp)$/i.test(name)
}
