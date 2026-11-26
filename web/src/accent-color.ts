export const defaultAccentSwatch = '#4f5bd5';

export function normalizeAccentColor(value: unknown): string {
  if (typeof value !== 'string') return '';
  const color = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : '';
}

type RGB = [number, number, number];

function luminance(rgb: RGB): number {
  const [r, g, b] = rgb.map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function hsl(rgb: RGB): string {
  const [r, g, b] = rgb.map(channel => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const light = (max + min) / 2;
  if (!delta) return `0 0% ${light * 100}%`;
  const saturation = delta / (1 - Math.abs(2 * light - 1));
  const hue = max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return `${(hue * 60 + 360) % 360} ${saturation * 100}% ${light * 100}%`;
}

export function resolveAccentColor(value: unknown, dark: boolean) {
  const hex = normalizeAccentColor(value);
  if (!hex) return null;
  const rgb: RGB = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16)) as RGB;
  // Keep accent text readable even on selected neutral rows in either theme.
  const neutral = dark ? 33 : 232;
  const surface = luminance([neutral, neutral, neutral]) + 0.05;
  const readable = (color: RGB) => {
    const tone = luminance(color) + 0.05;
    return (dark ? tone / surface : surface / tone) >= 4.5;
  };
  let tone = rgb;
  if (!readable(rgb)) {
    const target = dark ? 255 : 0;
    let low = 0;
    let high = 255;
    while (low < high) {
      const mid = (low + high) >> 1;
      const mix = rgb.map(channel => Math.round(channel + (target - channel) * mid / 255)) as RGB;
      if (readable(mix)) high = mid;
      else low = mid + 1;
    }
    tone = rgb.map(channel => Math.round(channel + (target - channel) * low / 255)) as RGB;
  }
  return {
    hex: `#${tone.map(channel => channel.toString(16).padStart(2, '0')).join('')}`,
    hsl: hsl(tone),
    foreground: dark ? '#000' : '#fff',
    foregroundHsl: dark ? '0 0% 0%' : '0 0% 100%',
  };
}
