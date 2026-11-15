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
import { IconPointer, Tooltip } from '../../shims/primitives/index.ts'
import type { ImagineCanvasTool } from './gallery-store.ts'
import css from './CanvasToolbar.module.css'

/** Ctrl on Windows and Linux, ⌘ on a Mac, as Grok's shortcut labels. */
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'

const S = ({ children }: { children: ReactNode }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
// Grok's glyphs: the hand is the four-way move mark, the video a camera, the
// text a bare T, the upload an arrow out of a tray.
const IconHand = () => <S><path d="M12 3v18M3 12h18M12 3 9.5 5.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5" /></S>
const IconImage = () => <S><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><circle cx="9" cy="10" r="1.6" /><path d="m4 17 5-4.5 4 3.5 2.5-2 4.5 3.5" /></S>
const IconVideoTool = () => <S><rect x="3" y="6" width="13" height="12" rx="2.5" /><path d="m16 10.5 5-3v9l-5-3" /></S>
const IconText = () => <S><path d="M5 5h14M12 5v15" /></S>
const IconUpload = () => <S><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" /><path d="M4 14v3.5A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V14" /></S>
const IconGrid = () => <S><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></S>

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
            <S><path d="M5 12h14" /></S>
          </button>
        </Tooltip>
        <Tooltip label={translate('imagine.fitToView')} side="top" delayMs={150} portal>
          <button type="button" className={css.zoomValue} aria-label={`${String(Math.round(zoom * 100))}%, ${translate('imagine.fitToView')}`} onClick={props.onFit}>
            {`${String(Math.round(zoom * 100))}%`}
          </button>
        </Tooltip>
        <Tooltip label={translate('imagine.zoomIn')} side="top" delayMs={150} portal>
          <button type="button" className={css.tool} aria-label={translate('imagine.zoomIn')} disabled={!props.canZoomIn} onClick={props.onZoomIn}>
            <S><path d="M5 12h14M12 5v14" /></S>
          </button>
        </Tooltip>
      </div>
      <div className={css.pill} role="toolbar" aria-label={translate('imagine.canvasToolbar')} data-imagine-tools>
        <Tool label={translate('imagine.toolSelect')} shortcut={`${MOD}S`} on={!textArmed && tool === 'select'} onClick={() => { onTool('select') }}>
          <IconPointer size={18} />
        </Tool>
        <Tool label={translate('imagine.toolHand')} shortcut={`${MOD}P`} on={!textArmed && tool === 'hand'} onClick={() => { onTool('hand') }}>
          <IconHand />
        </Tool>
        {ownBoard && (
          <>
            <span className={css.rule} role="separator" aria-orientation="vertical" />
            <Tool label={translate('imagine.genImage')} shortcut={`${MOD}I`} onClick={props.onGenerateImage}><IconImage /></Tool>
            <Tool label={translate('imagine.genVideo')} shortcut={`${MOD}U`} onClick={props.onGenerateVideo}><IconVideoTool /></Tool>
            <Tool label={translate('imagine.toolText')} shortcut={`${MOD}E`} on={textArmed} onClick={props.onText}><IconText /></Tool>
            <Tool label={translate('imagine.toolUpload')} onClick={() => { picker.current?.click() }}><IconUpload /></Tool>
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
        <Tool label={translate('imagine.arrangeGrid')} onClick={props.onRegrid}><IconGrid /></Tool>
      </div>
      {/* The zoom's twin on the far side, so the tools sit in the middle. */}
      <span className={css.balance} aria-hidden="true" />
    </div>
  )
}
