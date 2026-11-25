import { Button, Popover, PopoverContent, PopoverTrigger } from '@nextui-org/react';
import { ExternalLink } from 'lucide-react';
import type { WebSource } from '../web-sources';

export default function WebSources({ sources }: { sources: readonly WebSource[] }) {
  const domains = [...new Set(sources.map(({ hostname }) => hostname.replace(/^www\./, '')))].slice(0, 3);
  return <Popover placement="bottom-start" motionProps={{
    // Keep the fade on Framer's JS renderer so opacity cannot flash back to zero.
    onUpdate: () => undefined,
    variants: {
      initial: { opacity: 0, transform: 'none' },
      enter: { opacity: 1, transform: 'none', transition: { duration: 0.14, ease: 'easeOut' } },
      exit: { opacity: 0, transform: 'none', transition: { duration: 0.1 } },
    },
  }}>
    <PopoverTrigger>
      <Button size="sm" variant="light" disableAnimation disableRipple className="web-sources-trigger">
        <span className="web-sources-sites" aria-hidden="true">
          {domains.map(domain => <span key={domain}>{domain.charAt(0).toUpperCase()}</span>)}
        </span>
        {sources.length} 个网页来源
      </Button>
    </PopoverTrigger>
    <PopoverContent aria-label="网页来源" className="web-sources-popover">
      <ul className="web-sources-list">
        {sources.map(({ url, hostname, title }) => <li key={url}>
          <a className="web-source-link" href={url} target="_blank" rel="noopener noreferrer" title={title || url}>
            <span className="web-source-label">
              <span>{title || url.replace(/^https?:\/\//, '')}</span>
              {title && <small>{hostname}</small>}
            </span>
            <ExternalLink size="0.875rem" aria-hidden="true" />
          </a>
        </li>)}
      </ul>
    </PopoverContent>
  </Popover>;
}
