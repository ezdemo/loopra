export default function AgentIcon({ agentId = 'native' }: { agentId?: string }) {
  const icon = (() => {
    switch (agentId) {
      case 'native':
        return <>
          <rect x="4" y="4" width="16" height="16" rx="5.25" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M10.25 8.75v5a1.75 1.75 0 0 0 1.75 1.75h2.75" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>;
      case 'codex':
        // Vendored from @lobehub/icons-static-svg@1.97.0/icons/openai.svg.
        // License: src/assets/LOBE-ICONS-LICENSE.txt.
        return <path fill="currentColor" fillRule="evenodd" d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />;
      case 'claude-code':
        return <g stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          {Array.from({ length: 12 }, (_, index) => <path key={index} d="M12 2.5v6" transform={`rotate(${index * 30} 12 12)`} />)}
        </g>;
      case 'pi':
        return <path d="M3 6.5h18M7 6.5v6c0 4-1 5.5-2.5 6.5M16 6.5v10c0 2.5 2 3 4 1.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />;
      case 'dsh':
        return <>
          <path d="M2 10c1.5-3 5-4 8-2 2 1.5 3.5 4.5 6 5 2 .5 3-1 3.5-3 0-1 1-2 2.5-2-1 2 1 2.5 1 2.5-1 2-2.5 2.5-4 2.5-1.5 5-6 7-10.5 5C4 16.5 2 14 2 10Z" fill="currentColor" />
          <path d="M4 11c1.5 3 4 5 7 5" fill="none" stroke="var(--soft)" strokeWidth="1.2" strokeLinecap="round" />
          <circle cx="10" cy="10.5" r=".8" fill="var(--soft)" />
        </>;
      default:
        return <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="6" width="16" height="14" rx="4" />
          <path d="M12 3v3M8 11v2m8-2v2m-7 3h6" />
        </g>;
    }
  })();
  const viewBox = agentId === 'codex' || agentId === 'pi' ? '-1.5 -1.5 27 27' : '0 0 24 24';
  return <svg className="composer-agent-icon" data-agent={agentId} viewBox={viewBox} width="1rem" height="1rem" aria-hidden="true" focusable="false">{icon}</svg>;
}
