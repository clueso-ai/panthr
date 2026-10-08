// Controls helpers used on both sides: which set belongs to a picked
// element, how a value is written, and the editor-tool request for it.

import type { Control, ControlSet } from './types'

export function keyFor(all: Record<string, ControlSet>, file: string, ids: string[], at: number): string | null {
  const keys = Object.keys(all).sort()
  for (const id of ids) {
    const exact = `${file}#${id}`
    if (exact in all) return exact
    const prefix = `${file}#${id}@`
    for (const k of keys) {
      if (!k.startsWith(prefix)) continue
      const range = k.slice(prefix.length)
      const i = range.indexOf('-')
      if (i < 0) continue
      const a = num(range.slice(0, i))
      const b = num(range.slice(i + 1))
      if (a != null && b != null && at >= a && at < b) return k
    }
  }
  return null
}

/** A strict float parse (Rust's `parse::<f64>`): "x" and "" are not numbers. */
function num(s: string): number | null {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s.trim()) || s.trim() !== s) return null
  return Number(s)
}

export function fmtNum(n: number): string {
  const s = n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  // A tiny negative rounds to "-0.000": write plain 0.
  return s === '-0' ? '0' : s
}

/** The value a control writes, as the file needs it (a number gets its
 *  unit for CSS, none for an attribute). */
export function written(c: Control, v: unknown): unknown {
  if (c.type === 'number' && typeof v === 'number') {
    let n = v
    if (c.min != null && c.max != null) n = Math.min(Math.max(n, c.min), c.max)
    return c.write.startsWith('style:') ? `${fmtNum(n)}${c.unit ?? ''}` : fmtNum(n)
  }
  return v
}

export function setRequest(set: ControlSet, c: Control, v: unknown): Record<string, unknown> {
  const targets = c.targets?.length ? c.targets : [set.element]
  return { op: 'set', file: set.file, target: targets[0], targets, write: c.write, value: written(c, v) }
}
