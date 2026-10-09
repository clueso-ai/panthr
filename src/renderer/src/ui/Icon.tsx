// Panthr's icons: Lucide's (ISC), drawn at a 1.5 pt stroke so they sit
// lightly beside 13 px text. One name per thing the app shows, mapped to
// Lucide's drawing for it, so call sites never name a Lucide icon.

import {
  ArrowLeft, ArrowUp, Check, ChevronDown, ChevronRight, Cloud, Ellipsis, Folder, History, Laptop, Layers, LibraryBig,
  MapPin, MessageSquarePlus, MousePointer2, Network, Pause, PenLine, Play, Plus, Search, Settings, SlidersHorizontal,
  Sparkle, Square, Image, Film, SquareTerminal, StickyNote, Trash2, Undo2, Upload, X, type LucideIcon
} from 'lucide-react'

export type IconName =
  | 'plus' | 'pen' | 'pin' | 'library' | 'up' | 'chevron' | 'chevron-right' | 'check' | 'spark' | 'prompt'
  | 'laptop' | 'cloud' | 'sliders' | 'layers' | 'back' | 'new-chat' | 'cursor' | 'history' | 'close'
  | 'agents' | 'play' | 'pause' | 'stop' | 'export' | 'settings' | 'search' | 'trash' | 'folder' | 'note' | 'undo' | 'dots' | 'image' | 'film'

const ICONS: Record<IconName, LucideIcon> = {
  plus: Plus, pen: PenLine, pin: MapPin, library: LibraryBig, up: ArrowUp, chevron: ChevronDown, 'chevron-right': ChevronRight,
  check: Check, spark: Sparkle, prompt: SquareTerminal, laptop: Laptop, cloud: Cloud, sliders: SlidersHorizontal, layers: Layers,
  back: ArrowLeft, 'new-chat': MessageSquarePlus, cursor: MousePointer2, history: History, close: X, agents: Network,
  play: Play, pause: Pause, stop: Square, export: Upload, settings: Settings, search: Search, trash: Trash2, folder: Folder,
  note: StickyNote, undo: Undo2, dots: Ellipsis, image: Image, film: Film
}

/** Transport glyphs read better solid. */
const FILLED = new Set<IconName>(['play', 'pause', 'stop'])

export function Icon({ name, size = 16, className, style }: { name: IconName; size?: number; className?: string; style?: React.CSSProperties }) {
  const L = ICONS[name]
  return (
    <L
      size={size}
      strokeWidth={1.5}
      fill={FILLED.has(name) ? 'currentColor' : 'none'}
      className={className}
      style={{ flex: 'none', display: 'block', ...style }}
      aria-hidden
    />
  )
}
