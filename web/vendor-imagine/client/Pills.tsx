/**
 * A labelled row of single-choice pills: the home composer's options and the
 * workflow panels draw the same control with their own classes.
 */

/** The classes each place styles the row with. */
export interface PillClasses {
  readonly row: string | undefined
  readonly label: string | undefined
  readonly group: string | undefined
  readonly pill: string | undefined
}

/**
 * The bare single-choice group, with no label beside it: the social page's
 * tabs and month/week switch and the publish panel's type and timing were
 * each a hand-unrolled copy of it. The chosen button carries `data-on`.
 * @param props.label - what the group is called, for screen readers.
 * @param props.disabled - every button off at once (a publish in flight).
 */
export function Segmented<T extends string | number>({ label, values, value, onPick, format, group, pill, disabled }: {
  label: string
  values: readonly T[]
  value: T
  onPick: (value: T) => void
  format?: (value: T) => string
  group: string | undefined
  pill: string | undefined
  disabled?: boolean
}) {
  return (
    <div className={group} role="radiogroup" aria-label={label}>
      {values.map(entry => (
        <button
          key={String(entry)}
          type="button"
          role="radio"
          aria-checked={entry === value}
          className={pill}
          data-on={entry === value || undefined}
          disabled={disabled}
          onClick={() => { onPick(entry) }}
        >
          {format === undefined ? String(entry) : format(entry)}
        </button>
      ))}
    </div>
  )
}

export function Pills<T extends string | number>({ label, values, value, onPick, format, classes }: {
  label: string
  values: readonly T[]
  value: T
  onPick: (value: T) => void
  format?: (value: T) => string
  classes: PillClasses
}) {
  return (
    <div className={classes.row}>
      <span className={classes.label}>{label}</span>
      <Segmented
        label={label}
        values={values}
        value={value}
        onPick={onPick}
        {...(format === undefined ? {} : { format })}
        group={classes.group}
        pill={classes.pill}
      />
    </div>
  )
}
