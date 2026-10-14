import {nextui} from '@nextui-org/react'
import {createRequire} from 'node:module'
import {dirname} from 'node:path'

// pnpm's isolated layout does not expose React's transitive theme at the root.
const requireNextUI = createRequire(createRequire(import.meta.url).resolve('@nextui-org/react'))
const nextuiTheme = dirname(requireNextUI.resolve('@nextui-org/theme')).replaceAll('\\', '/')

export default {
  content: ['./index.html', './web/src/**/*.{ts,tsx}', `${nextuiTheme}/**/*.{js,ts,jsx,tsx}`],
  darkMode: 'class',
  // Keep NextUI's full primary palette, including the foreground utility.
  // A scalar Tailwind override drops text-primary-foreground entirely.
  plugins: [nextui({themes: {
    light: {colors: {primary: {DEFAULT: '#2083ff', foreground: '#fff'}}},
    dark: {colors: {primary: {DEFAULT: '#2083ff', foreground: '#fff'}}},
  }})]
}
