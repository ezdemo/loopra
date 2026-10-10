import {nextui} from '@nextui-org/react'
import {createRequire} from 'node:module'
import {dirname} from 'node:path'

// pnpm's isolated layout does not expose React's transitive theme at the root.
const requireNextUI = createRequire(createRequire(import.meta.url).resolve('@nextui-org/react'))
const nextuiTheme = dirname(requireNextUI.resolve('@nextui-org/theme')).replaceAll('\\', '/')

export default {
  content: ['./index.html', './web/src/**/*.{ts,tsx}', `${nextuiTheme}/**/*.{js,ts,jsx,tsx}`],
  darkMode: 'class',
  theme: {extend: {colors: {primary: '#2083ff'}}},
  plugins: [nextui({themes: {light: {colors: {primary: '#2083ff'}}, dark: {colors: {primary: '#2083ff'}}}})]
}
