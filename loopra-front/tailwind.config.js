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
  plugins: [nextui({
    layout: {radius: {small: '0.375rem', medium: '0.5rem', large: '0.75rem'}, borderWidth: {small: '1px', medium: '1px', large: '1px'}},
    themes: {
      light: {colors: {
        background: '#ffffff', foreground: '#1c1c1a', divider: '#e7e7e4', focus: '#3b6cf6',
        content1: '#ffffff', content2: '#f5f5f4', content3: '#f0f0ee', content4: '#ebebe8',
        default: {DEFAULT: '#ebebe8', foreground: '#1c1c1a'},
        primary: {DEFAULT: '#3b6cf6', foreground: '#fff'},
        success: {DEFAULT: '#1f9d55', foreground: '#fff'}, warning: {DEFAULT: '#c27803', foreground: '#fff'}, danger: {DEFAULT: '#d6453d', foreground: '#fff'},
      }},
      dark: {colors: {
        background: '#191919', foreground: '#ececea', divider: '#2f2f2d', focus: '#6c8cff',
        content1: '#1e1e1d', content2: '#242423', content3: '#2b2b29', content4: '#323230',
        default: {DEFAULT: '#323230', foreground: '#ececea'},
        primary: {DEFAULT: '#6c8cff', foreground: '#111'},
        success: {DEFAULT: '#3ec27a', foreground: '#111'}, warning: {DEFAULT: '#e0a030', foreground: '#111'}, danger: {DEFAULT: '#f06a62', foreground: '#111'},
      }},
    },
  })]
}
