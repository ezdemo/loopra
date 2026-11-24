import { nextui } from '@nextui-org/react'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

// pnpm's isolated layout does not expose React's transitive theme at the root.
const requireNextUI = createRequire(createRequire(import.meta.url).resolve('@nextui-org/react'))
const nextuiTheme = dirname(requireNextUI.resolve('@nextui-org/theme')).replaceAll('\\', '/')

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}', `${nextuiTheme}/**/*.{js,ts,jsx,tsx}`],
  darkMode: 'class',
  plugins: [nextui({
    layout: { radius: { small: '0.375rem', medium: '0.5rem', large: '0.75rem' }, borderWidth: { small: '1px', medium: '1px', large: '1px' } },
    themes: {
      light: { colors: {
        background: '#ffffff', foreground: '#171717', divider: '#e5e5e5', focus: '#4f5bd5',
        content1: '#ffffff', content2: '#f4f4f4', content3: '#efefef', content4: '#e8e8e8',
        default: { DEFAULT: '#e8e8e8', foreground: '#171717' },
        primary: { DEFAULT: '#4f5bd5', foreground: '#fff' },
        success: { DEFAULT: '#1f9d55', foreground: '#fff' }, warning: { DEFAULT: '#b87903', foreground: '#fff' }, danger: { DEFAULT: '#d6453d', foreground: '#fff' },
      } },
      dark: { colors: {
        background: '#0a0a0a', foreground: '#ededed', divider: '#262626', focus: '#8794ff',
        content1: '#0a0a0a', content2: '#151515', content3: '#1a1a1a', content4: '#212121',
        default: { DEFAULT: '#212121', foreground: '#ededed' },
        primary: { DEFAULT: '#8794ff', foreground: '#111' },
        success: { DEFAULT: '#3ecf8e', foreground: '#111' }, warning: { DEFAULT: '#e5a93d', foreground: '#111' }, danger: { DEFAULT: '#f2685f', foreground: '#111' },
      } },
    },
  })],
}
