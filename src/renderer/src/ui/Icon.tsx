// Line icons on one 16-point grid (1.5 pt strokes), the same drawings as the
// first Panthr's, so every icon sits on one baseline and optical size.

type Pt = [number, number]
const TAU = Math.PI * 2

const circle = (cx: number, cy: number, r: number, n = 16): Pt[] =>
  Array.from({ length: n + 1 }, (_, k) => [cx + r * Math.cos((k / n) * TAU), cy + r * Math.sin((k / n) * TAU)])

const arc = (cx: number, cy: number, r: number, a0: number, a1: number, n: number): Pt[] =>
  Array.from({ length: n + 1 }, (_, k) => {
    const a = Math.PI * (a0 + ((a1 - a0) * k) / n)
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  })

function drawing(name: IconName): { lines: Pt[][]; fill: Pt[][] } {
  const lines: Pt[][] = []
  const fill: Pt[][] = []
  switch (name) {
    case 'plus': lines.push([[8, 3], [8, 13]], [[3, 8], [13, 8]]); break
    case 'pen': lines.push([[10.5, 2.8], [13.2, 5.5], [5.5, 13.2], [2.6, 13.4], [2.8, 10.5], [10.5, 2.8]], [[9, 4.3], [11.7, 7]]); break
    case 'pin': {
      const p = arc(8, 6.6, 4.6, 0.85, 2.15, 20)
      p.push([8, 14.2], p[0])
      lines.push(p)
      fill.push(circle(8, 6.6, 1.5))
      break
    }
    case 'library':
      lines.push([[3, 13], [3, 3.5], [5.6, 3.5], [5.6, 13]], [[7.4, 13], [7.4, 5], [9.8, 5], [9.8, 13]], [[11.2, 5.4], [13.6, 4.8], [15.2, 12.4], [12.8, 13]], [[2, 13], [14, 13]])
      break
    case 'up': lines.push([[8, 13], [8, 3.5]], [[3.8, 7.6], [8, 3.4], [12.2, 7.6]]); break
    case 'chevron': lines.push([[4.5, 6.5], [8, 10], [11.5, 6.5]]); break
    case 'chevron-right': lines.push([[6.5, 4.5], [10, 8], [6.5, 11.5]]); break
    case 'check': lines.push([[3.5, 8.3], [6.6, 11.4], [12.6, 4.8]]); break
    case 'spark':
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * TAU + 0.2
        const r1 = k % 2 === 0 ? 6.4 : 5
        lines.push([[8 + 1.6 * Math.cos(a), 8 + 1.6 * Math.sin(a)], [8 + r1 * Math.cos(a), 8 + r1 * Math.sin(a)]])
      }
      break
    case 'prompt': lines.push([[2.8, 4.6], [6.6, 8], [2.8, 11.4]], [[8.6, 11.6], [13.4, 11.6]]); break
    case 'laptop': lines.push([[3.5, 10.5], [3.5, 4], [12.5, 4], [12.5, 10.5], [3.5, 10.5]], [[1.8, 12.6], [14.2, 12.6]]); break
    case 'cloud': {
      const p: Pt[] = [[4.6, 12]]
      for (const [cx, cy, r, a0, a1] of [[4.6, 9.4, 2.6, 0.5, 1.5], [8.2, 7.2, 3.4, 1.15, 1.95], [11.6, 9.2, 2.8, 1.55, 2.5]]) p.push(...arc(cx, cy, r, a0, a1, 10))
      p.push([11.6, 12], [4.6, 12])
      lines.push(p)
      break
    }
    case 'sliders':
      for (const [y, k] of [[4.5, 10], [8, 5], [11.5, 8.5]]) {
        lines.push([[2.5, y], [13.5, y]])
        fill.push(circle(k, y, 1.9))
      }
      break
    case 'layers': lines.push([[8, 2.8], [14, 5.8], [8, 8.8], [2, 5.8], [8, 2.8]], [[2, 8.6], [8, 11.6], [14, 8.6]], [[2, 11.2], [8, 14.2], [14, 11.2]]); break
    case 'back': lines.push([[13, 8], [3.5, 8]], [[7.6, 3.8], [3.4, 8], [7.6, 12.2]]); break
    case 'new-chat':
      lines.push([[3.5, 3.2], [12.5, 3.2], [13.8, 4.5], [13.8, 10], [12.5, 11.3], [7, 11.3], [4, 13.8], [4, 11.3], [3.5, 11.3], [2.2, 10], [2.2, 4.5], [3.5, 3.2]], [[8, 5.2], [8, 9.3]], [[5.95, 7.25], [10.05, 7.25]])
      break
    case 'cursor': lines.push([[4, 2.5], [12, 8], [8.4, 8.8], [10.6, 13], [9, 13.8], [6.9, 9.6], [4, 12], [4, 2.5]]); break
    case 'history':
      lines.push(arc(8, 8, 5.4, 1.15, 2.75, 24), [[2.4, 3.2], [2.6, 6.2], [5.6, 6]], [[8, 5.2], [8, 8.3], [10, 9.6]])
      break
    case 'close': lines.push([[4, 4], [12, 12]], [[12, 4], [4, 12]]); break
    case 'agents':
      lines.push(circle(8, 4.2, 1.9), circle(3.9, 11.6, 1.9), circle(12.1, 11.6, 1.9), [[7, 5.9], [4.9, 9.9]], [[9, 5.9], [11.1, 9.9]])
      break
    case 'play': fill.push([[5, 3.2], [13, 8], [5, 12.8], [5, 3.2]]); break
    case 'pause': fill.push([[4.5, 3.5], [7, 3.5], [7, 12.5], [4.5, 12.5]], [[9, 3.5], [11.5, 3.5], [11.5, 12.5], [9, 12.5]]); break
    case 'stop': fill.push([[4, 4], [12, 4], [12, 12], [4, 12]]); break
    case 'export': lines.push([[8, 2.8], [8, 10]], [[4.8, 6], [8, 2.8], [11.2, 6]], [[3, 9.5], [3, 13], [13, 13], [13, 9.5]]); break
    case 'settings':
      lines.push(circle(8, 8, 2.2))
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * TAU
        lines.push([[8 + 4.4 * Math.cos(a), 8 + 4.4 * Math.sin(a)], [8 + 6 * Math.cos(a), 8 + 6 * Math.sin(a)]])
      }
      lines.push(circle(8, 8, 4.4, 24))
      break
    case 'search': lines.push(circle(7, 7, 4.2, 24), [[10.2, 10.2], [13.5, 13.5]]); break
    case 'trash': lines.push([[3, 4.5], [13, 4.5]], [[6.3, 4.5], [6.3, 2.8], [9.7, 2.8], [9.7, 4.5]], [[4.3, 4.5], [5, 13.2], [11, 13.2], [11.7, 4.5]]); break
    case 'folder': lines.push([[2.5, 4], [6.3, 4], [7.6, 5.5], [13.5, 5.5], [13.5, 12.5], [2.5, 12.5], [2.5, 4]]); break
    case 'note': lines.push([[3, 3], [13, 3], [13, 10], [10, 13], [3, 13], [3, 3]], [[10, 13], [10, 10], [13, 10]]); break
    case 'undo': lines.push([[5.5, 3.5], [2.8, 6.2], [5.5, 8.9]], [[2.8, 6.2], [10, 6.2]], arc(10, 9.4, 3.2, 1.5, 2.5, 10)); break
    case 'dots': fill.push(circle(3.5, 8, 1.2), circle(8, 8, 1.2), circle(12.5, 8, 1.2)); break
  }
  return { lines, fill }
}

export type IconName =
  | 'plus' | 'pen' | 'pin' | 'library' | 'up' | 'chevron' | 'chevron-right' | 'check' | 'spark' | 'prompt'
  | 'laptop' | 'cloud' | 'sliders' | 'layers' | 'back' | 'new-chat' | 'cursor' | 'history' | 'close'
  | 'agents' | 'play' | 'pause' | 'stop' | 'export' | 'settings' | 'search' | 'trash' | 'folder' | 'note' | 'undo' | 'dots'

const cache = new Map<IconName, { lines: string[]; fill: string[] }>()
const d = (p: Pt[]): string => p.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join('')

export function Icon({ name, size = 16, className, style }: { name: IconName; size?: number; className?: string; style?: React.CSSProperties }) {
  let g = cache.get(name)
  if (!g) {
    const r = drawing(name)
    g = { lines: r.lines.map(d), fill: r.fill.map((p) => d(p) + 'Z') }
    cache.set(name, g)
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} style={{ flex: 'none', display: 'block', ...style }} aria-hidden>
      {g.lines.map((p, i) => (
        <path key={i} d={p} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {g.fill.map((p, i) => (
        <path key={`f${i}`} d={p} fill="currentColor" />
      ))}
    </svg>
  )
}
