import shared from '../web/tailwind.config.js';
export default {
  ...shared,
  content: [...shared.content.map(pattern => pattern.startsWith('./') ? `../web/${pattern.slice(2)}` : pattern), './src/**/*.{ts,tsx}'],
};
