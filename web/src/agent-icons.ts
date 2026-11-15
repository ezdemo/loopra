// 内置智能体头像：供自定义 agent 图标选择器使用的原创 SVG 图标集。
// 统一「彩色圆角方底 + 居中白色字形」的 app-icon 风格，在 20-40px、亮暗主题下均可辨认。
// svg 仅含 ASCII 且不引用外部资源，可安全放入 <img> 或经 agentIconDataUrl 存入 agents.json。

export interface AgentBuiltinIcon {
  /** 稳定的 kebab-case 标识 */
  key: string;
  /** 中文短名，用于 tooltip/无障碍 */
  label: string;
  /** 完整 SVG 字符串 */
  svg: string;
}

const SVG_HEAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">';

export const agentBuiltinIcons: AgentBuiltinIcon[] = [
  {
    key: 'robot',
    label: '机器人',
    svg: SVG_HEAD + '<rect width="64" height="64" rx="14" fill="#3b82f6"/><rect x="30.8" y="16" width="2.4" height="8" rx="1.2" fill="#fff"/><circle cx="32" cy="14" r="3" fill="#bfdbfe"/><rect x="13.5" y="30" width="4.5" height="8" rx="2.25" fill="#fff"/><rect x="46" y="30" width="4.5" height="8" rx="2.25" fill="#fff"/><rect x="18" y="24" width="28" height="21" rx="8" fill="#fff"/><circle cx="26" cy="33" r="2.6" fill="#3b82f6"/><circle cx="38" cy="33" r="2.6" fill="#3b82f6"/><path d="M27 39.5 Q32 42.5 37 39.5" fill="none" stroke="#3b82f6" stroke-width="2.2" stroke-linecap="round"/></svg>',
  },
  {
    key: 'fox',
    label: '狐狸',
    svg: SVG_HEAD + '<rect width="64" height="64" rx="14" fill="#ea580c"/><path d="M15 13 L26 21 Q32 19 38 21 L49 13 L45 30 Q44 41 32 48 Q20 41 19 30 Z" fill="#fff"/><circle cx="26" cy="31" r="2.4" fill="#ea580c"/><circle cx="38" cy="31" r="2.4" fill="#ea580c"/><path d="M28.5 39 L35.5 39 L32 44 Z" fill="#ea580c"/></svg>',
  },
  {
    key: 'owl',
    label: '猫头鹰',
    svg: SVG_HEAD + '<rect width="64" height="64" rx="14" fill="#92400e"/><path d="M20 16 L16 11 L26 14 Z" fill="#fff"/><path d="M44 16 L48 11 L38 14 Z" fill="#fff"/><path d="M32 15 Q45 15 45 31 Q45 46 32 48 Q19 46 19 31 Q19 15 32 15 Z" fill="#fff"/><circle cx="26.5" cy="29" r="5" fill="#fde68a"/><circle cx="37.5" cy="29" r="5" fill="#fde68a"/><circle cx="26.5" cy="29" r="2.2" fill="#92400e"/><circle cx="37.5" cy="29" r="2.2" fill="#92400e"/><path d="M29.5 36 L34.5 36 L32 40 Z" fill="#92400e"/></svg>',
  },
  {
    key: 'octopus',
    label: '章鱼',
    svg: SVG_HEAD + '<rect width="64" height="64" rx="14" fill="#db2777"/><path d="M22 37 Q20 43 23 47" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round"/><path d="M28 38 Q27 44 29 48" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round"/><path d="M36 38 Q37 44 35 48" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round"/><path d="M42 37 Q44 43 41 47" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round"/><path d="M19 36 A13 14 0 0 1 45 36 Z" fill="#fff"/><circle cx="27" cy="28" r="2.6" fill="#db2777"/><circle cx="37" cy="28" r="2.6" fill="#db2777"/></svg>',
  },
  {
    key: 'bee',
    label: '蜜蜂',
    svg: SVG_HEAD + '<rect width="64" height="64" rx="14" fill="#f59e0b"/><ellipse cx="31" cy="20" rx="7" ry="4" transform="rotate(-15 31 20)" fill="#fef3c7"/><ellipse cx="41" cy="19" rx="6" ry="3.6" transform="rotate(15 41 19)" fill="#fef3c7"/><circle cx="21" cy="33" r="5.5" fill="#fff"/><ellipse cx="35" cy="34" rx="12" ry="10" fill="#fff"/><path d="M30 25.5 Q32.5 34 30 42.5" fill="none" stroke="#f59e0b" stroke-width="3"/><path d="M38 25.5 Q40.5 34 38 42.5" fill="none" stroke="#f59e0b" stroke-width="3"/><path d="M46 31 L52 34 L46 37 Z" fill="#fff"/><circle cx="19.5" cy="32" r="1.6" fill="#f59e0b"/></svg>',
  },
  {
    key: 'rocket',
    label: '火箭',
    svg: SVG_HEAD + '<rect width="64" height="64" rx="14" fill="#dc2626"/><path d="M24 34 L16 45 L25 41 Z" fill="#fff"/><path d="M40 34 L48 45 L39 41 Z" fill="#fff"/><path d="M28 42 Q32 53 36 42 Z" fill="#fca5a5"/><path d="M32 13 Q41 22 41 33 L41 40 L23 40 L23 33 Q23 22 32 13 Z" fill="#fff"/><circle cx="32" cy="30" r="4" fill="#dc2626"/><circle cx="30.6" cy="28.6" r="1.3" fill="#fecaca"/></svg>',
  },
  {
    key: 'ghost',
    label: '幽灵',
    svg: SVG_HEAD + '<rect width="64" height="64" rx="14" fill="#64748b"/><path d="M19 46 L19 29 Q19 15 32 15 Q45 15 45 29 L45 46 Q42 41 39 46 Q35.7 41 32.5 46 Q29 41 25.5 46 Q22.2 41 19 46 Z" fill="#fff"/><circle cx="26.5" cy="29" r="3" fill="#64748b"/><circle cx="37.5" cy="29" r="3" fill="#64748b"/><ellipse cx="32" cy="37" rx="2.6" ry="3.2" fill="#64748b"/></svg>',
  },
  {
    key: 'crystal',
    label: '水晶',
    svg: SVG_HEAD + '<rect width="64" height="64" rx="14" fill="#0891b2"/><path d="M19 27 L23 33 L19 39 L15 33 Z" fill="#fff"/><path d="M45 27 L49 33 L45 39 L41 33 Z" fill="#fff"/><path d="M27 15 L37 15 L41 23 L32 47 L23 23 Z" fill="#fff"/><path d="M23.5 23 L40.5 23" stroke="#a5f3fc" stroke-width="1.6"/><path d="M32 23.5 L32 45" stroke="#a5f3fc" stroke-width="1.6"/></svg>',
  },
  {
    key: 'beetle',
    label: '甲虫',
    svg: SVG_HEAD + '<rect width="64" height="64" rx="14" fill="#65a30d"/><path d="M21 28 L14 25 M20 35 L13 35 M21 42 L14 45 M43 28 L50 25 M44 35 L51 35 M43 42 L50 45" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M29 16 Q25 11 21 12 M35 16 Q39 11 43 12" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><circle cx="32" cy="20.5" r="5" fill="#fff"/><ellipse cx="32" cy="35" rx="12" ry="14" fill="#fff"/><path d="M32 24 L32 48" stroke="#65a30d" stroke-width="2.4"/><circle cx="27" cy="32" r="2" fill="#d9f99d"/><circle cx="37" cy="32" r="2" fill="#d9f99d"/></svg>',
  },
  {
    key: 'turtle',
    label: '海龟',
    svg: SVG_HEAD + '<rect width="64" height="64" rx="14" fill="#0d9488"/><circle cx="50" cy="31" r="4.5" fill="#fff"/><rect x="20" y="38" width="6" height="6" rx="3" fill="#fff"/><rect x="38" y="38" width="6" height="6" rx="3" fill="#fff"/><path d="M14 38 A18 13 0 0 1 50 38 Z" fill="#fff"/><path d="M23 30 Q24.5 34 23.5 38 M41 30 Q39.5 34 40.5 38 M32 25.5 L32 38" fill="none" stroke="#0d9488" stroke-width="2"/><circle cx="51.5" cy="30" r="1.4" fill="#0d9488"/></svg>',
  },
  {
    key: 'whale',
    label: '鲸鱼',
    svg: SVG_HEAD + '<rect width="64" height="64" rx="14" fill="#0284c7"/><path d="M44 29 L47 20 L50.5 25 L54 20 L52.5 31 Z" fill="#fff"/><path d="M13 38 Q12 27 25 25 Q38 23 45 30 Q50 35 47 41 Q43 46 32 46 L26 45.5 Q15 44 13 38 Z" fill="#fff"/><circle cx="24" cy="33" r="2.2" fill="#0284c7"/><path d="M19 39 Q27 43 37 41.5" fill="none" stroke="#7dd3fc" stroke-width="2" stroke-linecap="round"/><circle cx="18" cy="17" r="2" fill="#bae6fd"/><circle cx="25" cy="14.5" r="2" fill="#bae6fd"/><circle cx="32" cy="16.5" r="2" fill="#bae6fd"/></svg>',
  },
  {
    key: 'cactus',
    label: '仙人掌',
    svg: SVG_HEAD + '<rect width="64" height="64" rx="14" fill="#16a34a"/><rect x="15" y="19" width="8" height="15" rx="4" fill="#fff"/><rect x="41" y="25" width="8" height="13" rx="4" fill="#fff"/><rect x="19" y="27" width="10" height="7" rx="3.5" fill="#fff"/><rect x="35" y="31" width="10" height="7" rx="3.5" fill="#fff"/><rect x="27" y="14" width="10" height="33" rx="5" fill="#fff"/><circle cx="30" cy="28" r="1.4" fill="#16a34a"/><circle cx="34" cy="28" r="1.4" fill="#16a34a"/><path d="M30 32.5 Q32 34 34 32.5" fill="none" stroke="#16a34a" stroke-width="1.6" stroke-linecap="round"/></svg>',
  },
  {
    key: 'knight',
    label: '骑士盔',
    svg: SVG_HEAD + '<rect width="64" height="64" rx="14" fill="#475569"/><path d="M33 15 Q40 8 48 11.5 Q41 13 37 18 Z" fill="#cbd5e1"/><path d="M21 45 L21 29 Q21 15 32 15 Q43 15 43 29 L43 45 Z" fill="#fff"/><rect x="24" y="30" width="16" height="4.5" rx="2.25" fill="#475569"/><rect x="30.5" y="36.5" width="3" height="6" rx="1.5" fill="#475569"/></svg>',
  },
  {
    key: 'planet',
    label: '行星',
    svg: SVG_HEAD + '<rect width="64" height="64" rx="14" fill="#8b5cf6"/><circle cx="47" cy="16" r="3" fill="#ddd6fe"/><ellipse cx="32" cy="34" rx="20" ry="6.5" transform="rotate(-18 32 34)" fill="none" stroke="#ddd6fe" stroke-width="3.2"/><circle cx="32" cy="34" r="12" fill="#fff"/><path d="M13 40.2 A20 6.5 -18 0 1 51 27.8" fill="none" stroke="#ddd6fe" stroke-width="3.2"/><circle cx="28" cy="36" r="2.4" fill="#ddd6fe"/><circle cx="37" cy="31" r="1.8" fill="#ddd6fe"/></svg>',
  },
  {
    key: 'storm',
    label: '雷云',
    svg: SVG_HEAD + '<rect width="64" height="64" rx="14" fill="#1d4ed8"/><path d="M17 40 Q11 40 11 33 Q11 27 17 26 Q18 18 27 18 Q34 15.5 40 20 Q48 19 49 27 Q54 29 52.5 35 Q51 40 45 40 Z" fill="#fff"/><path d="M33 41 L28 48 L32 48 L29.5 55 L37 46.5 L33 46.5 L36 41 Z" fill="#93c5fd"/></svg>',
  },
  {
    key: 'panda',
    label: '熊猫',
    svg: SVG_HEAD + '<rect width="64" height="64" rx="14" fill="#1e293b"/><circle cx="22" cy="20" r="5.5" fill="#fff"/><circle cx="42" cy="20" r="5.5" fill="#fff"/><circle cx="32" cy="34" r="15" fill="#fff"/><ellipse cx="26" cy="32" rx="3.4" ry="4.2" transform="rotate(-18 26 32)" fill="#1e293b"/><ellipse cx="38" cy="32" rx="3.4" ry="4.2" transform="rotate(18 38 32)" fill="#1e293b"/><circle cx="26" cy="31" r="1.1" fill="#fff"/><circle cx="38" cy="31" r="1.1" fill="#fff"/><ellipse cx="32" cy="40" rx="2" ry="1.5" fill="#1e293b"/><path d="M30 43 Q32 44.5 34 43" fill="none" stroke="#1e293b" stroke-width="1.6" stroke-linecap="round"/></svg>',
  },
  {
    key: 'mushroom',
    label: '蘑菇',
    svg: SVG_HEAD + '<rect width="64" height="64" rx="14" fill="#e11d48"/><path d="M27 33 L25.5 46 Q25.5 49.5 29 49.5 L35 49.5 Q38.5 49.5 38.5 46 L37 33 Z" fill="#fff"/><path d="M14 34 A18 15 0 0 1 50 34 Q32 29 14 34 Z" fill="#fff"/><circle cx="24" cy="24.5" r="2.5" fill="#e11d48"/><circle cx="32" cy="21" r="2.2" fill="#e11d48"/><circle cx="40" cy="24.5" r="2.5" fill="#e11d48"/><circle cx="30" cy="40" r="1.3" fill="#e11d48"/><circle cx="34" cy="40" r="1.3" fill="#e11d48"/></svg>',
  },
  {
    key: 'dragon',
    label: '小龙',
    svg: SVG_HEAD + '<rect width="64" height="64" rx="14" fill="#059669"/><path d="M22 26 L18 14 L30 22 Z" fill="#fff"/><path d="M42 26 L46 14 L34 22 Z" fill="#fff"/><ellipse cx="32" cy="36" rx="14" ry="12" fill="#fff"/><circle cx="26.5" cy="34" r="2.4" fill="#059669"/><circle cx="37.5" cy="34" r="2.4" fill="#059669"/><circle cx="29" cy="42" r="1.3" fill="#059669"/><circle cx="35" cy="42" r="1.3" fill="#059669"/><path d="M30 45.5 Q32 47 34 45.5" fill="none" stroke="#059669" stroke-width="1.6" stroke-linecap="round"/></svg>',
  },
  {
    key: 'brain',
    label: '智脑',
    svg: SVG_HEAD + '<rect width="64" height="64" rx="14" fill="#c026d3"/><path d="M32 15 Q23 13.5 19.5 20 Q13.5 21.5 14.5 29 Q12 35.5 17.5 39.5 Q18.5 47.5 26.5 47.5 Q30 48.5 32 46.5 Q34 48.5 37.5 47.5 Q45.5 47.5 46.5 39.5 Q52 35.5 49.5 29 Q50.5 21.5 44.5 20 Q41 13.5 32 15 Z" fill="#fff"/><path d="M32 17 L32 45" stroke="#c026d3" stroke-width="2.2"/><path d="M22 28 Q26 30 24 34 M42 28 Q38 30 40 34" fill="none" stroke="#c026d3" stroke-width="2" stroke-linecap="round"/></svg>',
  },
  {
    key: 'cat',
    label: '猫咪',
    svg: SVG_HEAD + '<rect width="64" height="64" rx="14" fill="#9333ea"/><path d="M18 14 L27 22 Q32 20.5 37 22 L46 14 L45.5 30 Q48 33.5 46.5 38.5 Q44 47 32 47 Q20 47 17.5 38.5 Q16 33.5 18.5 30 Z" fill="#fff"/><circle cx="26" cy="34" r="2.4" fill="#9333ea"/><circle cx="38" cy="34" r="2.4" fill="#9333ea"/><path d="M29.5 38.5 L34.5 38.5 L32 41.5 Z" fill="#9333ea"/><path d="M12 34 L19 35 M12 40 L19 38.8" fill="none" stroke="#e9d5ff" stroke-width="1.8" stroke-linecap="round"/><path d="M52 34 L45 35 M52 40 L45 38.8" fill="none" stroke="#e9d5ff" stroke-width="1.8" stroke-linecap="round"/></svg>',
  },
];

/** 转为可存入 agents.json / <img src> 的 data URL（SVG 内容仅限 ASCII，可直接 btoa） */
export const agentIconDataUrl = (svg: string): string =>
  `data:image/svg+xml;base64,${btoa(svg)}`;
