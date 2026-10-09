// Clueso's mark (the pink puzzle square), and the "by Clueso" line that
// sits beside Panthr's wordmark.

import { useId } from 'react'

const MARK = 'M97 0C98.6569 0 100 1.34315 100 3V29.0697C100 30.8515 97.8457 31.7438 96.5858 30.4839L69.5161 3.41421C68.2562 2.15428 69.1485 0 70.9303 0H97ZM35.575 3.41421C34.315 2.15428 35.2074 0 36.9892 0H53.9598C54.4902 0 54.9989 0.210712 55.374 0.585784L99.4142 44.626C99.7893 45.0011 100 45.5098 100 46.0402V63.0108C100 64.7926 97.8457 65.685 96.5858 64.425L35.575 3.41421ZM21.4328 0.585786C21.0578 0.210714 20.5491 0 20.0186 0H3C1.34315 0 0 1.34315 0 3V30C0 31.1046 0.89543 32 2 32H6C15.9411 32 24 40.0589 24 50C24 59.9411 15.9411 68 6 68H2C0.895431 68 0 68.8954 0 70V97C0 98.6569 1.34315 100 3 100H30C31.1046 100 32 99.1046 32 98V94C32 84.0589 40.0589 76 50 76C59.9411 76 68 84.0589 68 94V98C68 99.1046 68.8954 100 70 100H97C98.6569 100 100 98.6569 100 97V79.9814C100 79.4509 99.7893 78.9422 99.4142 78.5672L21.4328 0.585786Z'

export function CluesoMark({ size = 14 }: { size?: number }) {
  const g = useId()
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden style={{ flex: 'none', display: 'block' }}>
      <path fillRule="evenodd" clipRule="evenodd" d={MARK} fill={`url(#${g})`} />
      <defs>
        <linearGradient id={g} x1="108" y1="-8" x2="-14.5" y2="114.5" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FE89EB" />
          <stop offset="1" stopColor="#C12EAF" />
        </linearGradient>
      </defs>
    </svg>
  )
}

/** "by ◆ Clueso", quiet, for after the Panthr wordmark. */
export function ByClueso({ size = 12 }: { size?: number }) {
  return (
    <span className="by-clueso">
      by <CluesoMark size={size} /> <b>Clueso</b>
    </span>
  )
}
