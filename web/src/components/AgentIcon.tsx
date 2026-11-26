import { Bot } from 'lucide-react';
import { lucideIcons } from './plugin-icons';
import { isAgentIconImage } from '../custom-agents';

/** 自定义智能体图标：data URL 图片 > 内置图标名 > Emoji 等短文本 > 默认 Bot。 */
export function PersonaIcon({ icon, className, size = '1rem' }: { icon?: string; className?: string; size?: number | string }) {
  const cls = `persona-icon${className ? ` ${className}` : ''}`;
  if (icon && isAgentIconImage(icon)) {
    return <img className={`${cls} persona-icon-image`} style={{ width: size, height: size }} src={icon} alt="" aria-hidden="true" draggable={false} />;
  }
  const Glyph = icon ? lucideIcons[icon] : undefined;
  if (Glyph) return <Glyph className={cls} size={size} strokeWidth={1.8} aria-hidden="true" />;
  // Emoji 用 <i> 而不是 <span>：.session-item > span 会给直接子级 span 加 flex:1 的标题布局。
  if (icon) return <i className={`${cls} persona-icon-emoji`} style={{ fontSize: size }} aria-hidden="true">{icon}</i>;
  return <Bot className={cls} size={size} aria-hidden="true" />;
}

export default function AgentIcon({ agentId = 'native' }: { agentId?: string }) {
  // SolonCode image: https://solon.noear.org/img/solon/favicon256.png
  const image = agentId === 'native' ? 'favicon.svg' : agentId === 'soloncode' ? 'soloncode.png' : undefined;
  if (image) {
    return <img className="composer-agent-icon" data-agent={agentId} src={`${import.meta.env?.BASE_URL ?? '/'}${image}`} width="16" height="16" alt="" aria-hidden="true" draggable={false} />;
  }
  const icon = (() => {
    switch (agentId) {
      case 'codex':
        // Vendored from @lobehub/icons-static-svg@1.97.0/icons/openai.svg.
        // License: src/assets/LOBE-ICONS-LICENSE.txt.
        return <path fill="currentColor" fillRule="evenodd" d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />;
      case 'claude-code':
        return <g stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          {Array.from({ length: 12 }, (_, index) => <path key={index} d="M12 2.5v6" transform={`rotate(${index * 30} 12 12)`} />)}
        </g>;
      case 'devin':
        // Vendored from devin.ai/favicon.svg (official Devin symbol).
        return <path fill="currentColor" d="M70 159.333V91.3471C70 88.3592 71.594 85.5983 74.1816 84.1044L133.043 50.1205C135.631 48.6265 138.819 48.6265 141.407 50.1205L200.269 84.1044C202.856 85.5983 204.45 88.3592 204.45 91.3471V126.068C204.708 137.606 210.806 148.734 221.531 154.926C232.256 161.117 244.942 160.834 255.063 155.289L285.132 137.929C287.719 136.435 290.907 136.435 293.495 137.929L352.357 171.913C354.944 173.406 356.538 176.167 356.538 179.155V247.123C356.538 250.111 354.944 252.872 352.357 254.366L293.495 288.35C290.907 289.844 287.719 289.844 285.132 288.35L255.306 271.13C245.146 265.456 232.344 265.117 221.534 271.358C210.809 277.55 204.711 288.678 204.453 300.215V334.926C204.453 337.914 202.859 340.675 200.271 342.169L141.41 376.153C138.822 377.647 135.634 377.647 133.046 376.153L74.1845 342.169C71.5969 340.675 70.0028 337.914 70.0028 334.926V266.959C70.0029 263.971 71.5969 261.21 74.1845 259.716L133.046 225.732C135.634 224.238 138.822 224.238 141.41 225.732L171.547 243.132C181.656 248.638 194.306 248.906 205.005 242.729C215.815 236.488 221.922 225.231 222.088 213.595C221.83 202.057 215.732 189.737 205.008 183.545C194.283 177.353 181.597 177.636 171.476 183.181L141.269 200.72C138.67 202.229 135.461 202.228 132.864 200.716L74.1576 166.562C71.5835 165.065 70 162.311 70 159.333Z" />;
      default:
        return <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="6" width="16" height="14" rx="4" />
          <path d="M12 3v3M8 11v2m8-2v2m-7 3h6" />
        </g>;
    }
  })();
  const viewBox = agentId === 'codex' ? '-1.5 -1.5 27 27' : agentId === 'devin' ? '0 0 425 425' : '0 0 24 24';
  return <svg className="composer-agent-icon" data-agent={agentId} viewBox={viewBox} width="1rem" height="1rem" aria-hidden="true" focusable="false">{icon}</svg>;
}
