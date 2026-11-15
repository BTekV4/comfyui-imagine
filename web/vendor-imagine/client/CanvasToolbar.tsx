/**
 * The canvas bar, as Grok Imagine's (measured on its page 2026-11-15): the
 * zoom in its own pill at the bottom left — minus, the percentage that fits
 * the board to the view, plus — and the tools in one pill in the middle:
 * Select and Hand, a rule, Generate image, Generate video, Text, Upload. The
 * studio's own «Arrange in a grid» closes the row after a second rule. Every
 * tool has its shortcut in the tooltip.
 */
import { translate } from './locale-store.ts'
import { useRef, type ReactNode } from 'react'
import { Glyph, IconGrid, IconHand, IconImage, IconText, IconUpload, IconVideo } from './canvas-icons.tsx'
import { IconPointer, Tooltip } from '../../shims/primitives/index.ts'
import type { ImagineCanvasTool } from './gallery-store.ts'
import css from './CanvasToolbar.module.css'

/** Ctrl on Windows and Linux, ⌘ on a Mac, as Grok's shortcut labels. */
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'

/*
 * Grok's glyphs (canvas-icons.tsx): the hand is the four-way move mark, the
 * video a camera, the text a bare T, the upload an arrow out of a tray. The
 * bar draws them at 18 px with a slightly lighter line than the tiles.
 */
const TOOL_GLYPH = { size: 18, strokeWidth: 1.7 } as const

function Tool({ label, shortcut, on, onClick, children }: { label: string; shortcut?: string; on?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip label={shortcut === undefined ? label : `${label}  ${shortcut}`} side="top" delayMs={150} portal>
      <button type="button" className={css.tool} aria-label={label} aria-pressed={on} data-on={on || undefined} onClick={onClick}>
        {children}
      </button>
    </Tooltip>
  )
}

export interface CanvasToolbarProps {
  readonly tool: ImagineCanvasTool
  readonly onTool: (tool: ImagineCanvasTool) => void
  readonly zoom: number
  readonly canZoomIn: boolean
  readonly canZoomOut: boolean
  readonly onZoomIn: () => void
  readonly onZoomOut: () => void
  readonly onFit: () => void
  readonly onGenerateImage: () => void
  readonly onGenerateVideo: () => void
  /** Armed: the next click on the board places a text box there. */
  readonly textArmed: boolean
  readonly onText: () => void
  readonly onUpload: (files: readonly File[]) => void
  /** The studio's own extra: lay the board back out in rows. */
  readonly onRegrid: () => void
  /** Notes and generation are for a project's own board, not the History. */
  readonly ownBoard: boolean
}

export function CanvasToolbar(props: CanvasToolbarProps) {
  const { tool, onTool, zoom, textArmed, ownBoard } = props
  const picker = useRef<HTMLInputElement>(null)

  return (
    /*
     * One row along the board's foot: the zoom at the start, the tools in the
     * middle of what is left. As two pills placed on their own, a narrow
     * window put the centred tools on top of the zoom (2026-10-17); in a row
     * they push each other aside instead, and wrap when there is no room.
     */
    <div className={css.dock}>
      <div className={css.pill} role="group" aria-label={translate('imagine.canvasTools')} data-imagine-tools>
        <Tooltip label={translate('imagine.zoomOut')} side="top" delayMs={150} portal>
          <button type="button" className={css.tool} aria-label={translate('imagine.zoomOut')} disabled={!props.canZoomOut} onClick={props.onZoomOut}>
            <Glyph {...TOOL_GLYPH}><path d="M5 12h14" /></Glyph>
          </button>
        </Tooltip>
        <Tooltip label={translate('imagine.fitToView')} side="top" delayMs={150} portal>
          <button type="button" className={css.zoomValue} aria-label={`${String(Math.round(zoom * 100))}%, ${translate('imagine.fitToView')}`} onClick={props.onFit}>
            {`${String(Math.round(zoom * 100))}%`}
          </button>
        </Tooltip>
        <Tooltip label={translate('imagine.zoomIn')} side="top" delayMs={150} portal>
          <button type="button" className={css.tool} aria-label={translate('imagine.zoomIn')} disabled={!props.canZoomIn} onClick={props.onZoomIn}>
            <Glyph {...TOOL_GLYPH}><path d="M5 12h14M12 5v14" /></Glyph>
          </button>
        </Tooltip>
      </div>
      <div className={css.pill} role="toolbar" aria-label={translate('imagine.canvasToolbar')} data-imagine-tools>
        <Tool label={translate('imagine.toolSelect')} shortcut={`${MOD}S`} on={!textArmed && tool === 'select'} onClick={() => { onTool('select') }}>
          <IconPointer size={18} />
        </Tool>
        <Tool label={translate('imagine.toolHand')} shortcut={`${MOD}P`} on={!textArmed && tool === 'hand'} onClick={() => { onTool('hand') }}>
          <IconHand {...TOOL_GLYPH} />
        </Tool>
        {ownBoard && (
          <>
            <span className={css.rule} role="separator" aria-orientation="vertical" />
            <Tool label={translate('imagine.genImage')} shortcut={`${MOD}I`} onClick={props.onGenerateImage}><IconImage {...TOOL_GLYPH} /></Tool>
            <Tool label={translate('imagine.genVideo')} shortcut={`${MOD}U`} onClick={props.onGenerateVideo}><IconVideo {...TOOL_GLYPH} /></Tool>
            <Tool label={translate('imagine.toolText')} shortcut={`${MOD}E`} on={textArmed} onClick={props.onText}><IconText {...TOOL_GLYPH} /></Tool>
            <Tool label={translate('imagine.toolUpload')} onClick={() => { picker.current?.click() }}><IconUpload {...TOOL_GLYPH} /></Tool>
            <input
              ref={picker}
              type="file"
              accept="image/*,video/*,audio/*"
              multiple
              hidden
              onChange={(event) => {
                const files = [...event.target.files ?? []]
                event.target.value = ''
                if (files.length > 0) props.onUpload(files)
              }}
            />
          </>
        )}
        <span className={css.rule} role="separator" aria-orientation="vertical" />
        <Tool label={translate('imagine.arrangeGrid')} onClick={props.onRegrid}><IconGrid {...TOOL_GLYPH} /></Tool>
      </div>
      {/* The zoom's twin on the far side, so the tools sit in the middle. */}
      <span className={css.balance} aria-hidden="true" />
    </div>
  )
}
