/**
 * The brush both mask dialogs paint with: "Precise edit" (a zone to
 * change) and "Remove object" (what IOPaint should fill in). A canvas over
 * the photo at its ratio, a round stroke whose width is a share of the photo,
 * an eraser, and the painting read back as a black-and-white mask.
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'

export interface MaskPainterOptions {
  /** The long side the strokes are drawn at. */
  readonly side: number
  /** The stroke colour shown over the photo. */
  readonly color: string
  /** Brush width as a percentage of the photo's width. */
  readonly brush: number
  /** True while the eraser is on. */
  readonly erase: boolean
  /** Called on every stroke, e.g. to clear an error under the canvas. */
  readonly onStroke?: () => void
}

export interface MaskPainter {
  readonly ref: RefObject<HTMLCanvasElement | null>
  /** Whether anything has been painted since the last clear. */
  readonly painted: boolean
  readonly setPainted: (painted: boolean) => void
  /** Size the canvas to the photo once it has loaded. */
  readonly sizePaint: (image: HTMLImageElement) => void
  /** The pointer handlers for the canvas; `enabled` false ignores the pointer. */
  readonly handlers: (enabled: boolean) => {
    onPointerDown: (event: ReactPointerEvent<HTMLCanvasElement>) => void
    onPointerMove: (event: ReactPointerEvent<HTMLCanvasElement>) => void
    onPointerUp: () => void
  }
  /** Whether at least one pixel is still painted (erased back to nothing is no mask). */
  readonly hasPaint: () => boolean
  /**
   * White where painted, black elsewhere, as a PNG data URL.
   * @param size - the output size; the canvas's own when omitted.
   */
  readonly maskOf: (size?: { w: number; h: number }) => string | undefined
  readonly clear: () => void
}

export function useMaskPainter({ side, color, brush, erase, onStroke }: MaskPainterOptions): MaskPainter {
  const ref = useRef<HTMLCanvasElement>(null)
  const last = useRef<{ x: number; y: number } | undefined>(undefined)
  const [painted, setPainted] = useState(false)

  const sizePaint = (image: HTMLImageElement): void => {
    const node = ref.current
    if (node === null || image.naturalWidth === 0) return
    const scale = side / Math.max(image.naturalWidth, image.naturalHeight)
    node.width = Math.round(image.naturalWidth * scale)
    node.height = Math.round(image.naturalHeight * scale)
  }

  const strokeTo = (event: ReactPointerEvent<HTMLCanvasElement>, start: boolean): void => {
    const node = ref.current
    const ctx = node?.getContext('2d')
    if (node === null || ctx === null || ctx === undefined) return
    const box = node.getBoundingClientRect()
    const x = (event.clientX - box.left) / box.width * node.width
    const y = (event.clientY - box.top) / box.height * node.height
    const from = start || last.current === undefined ? { x, y } : last.current
    // A percentage of the photo's width, so it looks the same at any size.
    ctx.lineWidth = brush / 100 * node.width
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = color
    ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over'
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(x + (start ? 0.01 : 0), y)
    ctx.stroke()
    last.current = { x, y }
    if (!erase) setPainted(true)
    onStroke?.()
  }

  const handlers = (enabled: boolean) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLCanvasElement>): void => {
      if (!enabled || event.button !== 0) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      strokeTo(event, true)
    },
    onPointerMove: (event: ReactPointerEvent<HTMLCanvasElement>): void => {
      if (enabled && event.buttons === 1) strokeTo(event, false)
    },
    onPointerUp: (): void => { last.current = undefined },
  })

  const hasPaint = (): boolean => {
    const node = ref.current
    const pixels = node?.getContext('2d')?.getImageData(0, 0, node.width, node.height).data
    return pixels !== undefined && pixels.some((value, index) => index % 4 === 3 && value > 0)
  }

  const maskOf = (size?: { w: number; h: number }): string | undefined => {
    const node = ref.current
    if (node === null) return undefined
    const out = document.createElement('canvas')
    out.width = size?.w ?? node.width
    out.height = size?.h ?? node.height
    const ctx = out.getContext('2d')
    if (ctx === null) return undefined
    ctx.drawImage(node, 0, 0, out.width, out.height)
    // Every painted pixel to white, whatever its alpha, over black.
    ctx.globalCompositeOperation = 'source-in'
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.globalCompositeOperation = 'destination-over'
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, out.width, out.height)
    return out.toDataURL('image/png')
  }

  const clear = (): void => {
    const node = ref.current
    node?.getContext('2d')?.clearRect(0, 0, node.width, node.height)
    setPainted(false)
  }

  return { ref, painted, setPainted, sizePaint, handlers, hasPaint, maskOf, clear }
}
