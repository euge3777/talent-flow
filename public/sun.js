// The sun arc: where a time falls in someone's day. Sunrise at 06:00 on the
// left horizon, noon at the top, sunset at 20:00 on the right. Outside that,
// a small moon sits below the horizon. Used next to every interview time.

const SUN = '#f5c84c';
const INK = '#13294b';
const LINE = '#c9d1dc';

/** Local hour (fractional) of an ISO instant in a time zone. */
export function localHour(iso, tz) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso))) p[x.type] = x.value;
  return (+p.hour % 24) + (+p.minute) / 60;
}

function describe(hour) {
  if (hour < 6 || hour >= 20) return 'night';
  if (hour < 9) return 'early morning';
  if (hour < 12) return 'morning';
  if (hour < 14) return 'midday';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

/**
 * @param {number} hour 0–24 local
 * @param {{ size?: number, rise?: boolean }} opts  rise = animate from the horizon
 */
export function sunArc(hour, { size = 30, rise = false } = {}) {
  const w = size;
  const h = Math.round(size * 0.6);
  const cx = w / 2;
  const cy = h - 2;
  const r = w / 2 - 4;
  const day = hour >= 6 && hour < 20;
  const label = `${describe(hour)} for them`;
  if (!day) {
    return `<svg class="sun-arc" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label}">
      <title>${label}</title>
      <path d="M${cx - r} ${cy} A${r} ${r} 0 0 1 ${cx + r} ${cy}" fill="none" stroke="${LINE}" stroke-width="1.2" stroke-dasharray="2 2.5"/>
      <line x1="1" x2="${w - 1}" y1="${cy}" y2="${cy}" stroke="${LINE}" stroke-width="1.2"/>
      <circle cx="${cx}" cy="${cy - r * 0.45}" r="${Math.max(3, size / 9)}" fill="${INK}"/>
      <circle cx="${cx + size / 22}" cy="${cy - r * 0.45 - size / 30}" r="${Math.max(2.6, size / 10.5)}" fill="#fff"/>
    </svg>`;
  }
  const angle = 180 - ((hour - 6) / 14) * 180; // 180° = left horizon, 0° = right
  const dot = Math.max(3.2, size / 8);
  const sun = `<circle cx="${cx + r}" cy="${cy}" r="${dot}" fill="${SUN}" stroke="${INK}" stroke-width="${size > 60 ? 1.5 : 1}"/>`;
  const style = rise
    ? ` style="--a:${-angle}deg; transform-origin:${cx}px ${cy}px"`
    : ` transform="rotate(${-angle} ${cx} ${cy})"`;
  return `<svg class="sun-arc${rise ? ' rising' : ''}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label}">
    <title>${label}</title>
    <path d="M${cx - r} ${cy} A${r} ${r} 0 0 1 ${cx + r} ${cy}" fill="none" stroke="${LINE}" stroke-width="${size > 60 ? 1.5 : 1.2}"/>
    <line x1="1" x2="${w - 1}" y1="${cy}" y2="${cy}" stroke="${INK}" stroke-width="${size > 60 ? 1.5 : 1.2}"/>
    <g class="sun-body"${style}>${sun}</g>
  </svg>`;
}
