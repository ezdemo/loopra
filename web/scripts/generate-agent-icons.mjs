// 重新生成 src/agent-icons.ts 的内置智能体头像。
// 用法：cd web && node scripts/generate-agent-icons.mjs
// 依赖 devDependencies 中的 @dicebear/core 与 @dicebear/styles。

import { Style, Avatar } from '@dicebear/core';
import voxelBot from '@dicebear/styles/voxel-bot.json' with { type: 'json' };
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Voxel Bot © DiceBear（https://www.dicebear.com），CC0 1.0 公共领域。
// 每个条目由固定 seed 确定性生成；backgroundColor 为不带 '#' 的十六进制。
const PRESETS = [
  { key: 'peach', label: '粉桃', seed: 'alpha', bg: '3b82f6' },
  { key: 'visor', label: '面罩', seed: 'beta', bg: '0ea5e9' },
  { key: 'porcelain', label: '白瓷', seed: 'gamma', bg: '06b6d4' },
  { key: 'screen', label: '青屏', seed: 'delta', bg: '14b8a6' },
  { key: 'sprout', label: '嫩芽', seed: 'zeta', bg: '65a30d' },
  { key: 'tangerine', label: '小橙', seed: 'lambda', bg: 'f97316' },
  { key: 'dish', label: '小碟', seed: 'sigma', bg: 'ea580c' },
  { key: 'siren', label: '警灯', seed: 'omega', bg: 'ef4444' },
  { key: 'jade', label: '翡翠', seed: 'nova', bg: 'dc2626' },
  { key: 'happy', label: '开心', seed: 'atlas', bg: 'db2777' },
  { key: 'violet', label: '小紫', seed: 'orbit', bg: 'd946ef' },
  { key: 'ash', label: '小灰', seed: 'pixel', bg: 'a855f7' },
  { key: 'cloud', label: '云白', seed: 'volt', bg: '8b5cf6' },
  { key: 'steel', label: '小钢', seed: 'flux', bg: '64748b' },
  { key: 'night', label: '夜视', seed: 'iris', bg: '475569' },
  { key: 'lemon', label: '小黄', seed: 'juno', bg: '0f766e' },
  { key: 'nugget', label: '金豆', seed: 'rune', bg: 'f59e0b' },
  { key: 'blue', label: '蓝豆', seed: 'prism', bg: '84cc16' },
  { key: 'mint', label: '薄荷', seed: 'onyx', bg: '10b981' },
  { key: 'grape', label: '葡萄', seed: 'quark', bg: 'a3e635' },
];

const style = new Style(voxelBot);

/** 剥掉版权 metadata / 注释等多余字节，并校验可安全进入 <img> 与 btoa。 */
function iconSvg({ seed, bg }) {
  // scale 0.9：机器人略小于画布，图标四周留白，20-40px 下仍可辨认。
  const svg = new Avatar(style, { seed, backgroundColor: bg, borderRadius: 24, scale: 0.9 })
    .toString()
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<metadata[\s\S]*?<\/metadata>/, '')
    .replace(/\s*aria-hidden="true"/, '');
  if (!/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 128 128"[\s\S]+<\/svg>$/.test(svg)) {
    throw new Error(`${seed}: 非预期 SVG 结构`);
  }
  if (/[^\x20-\x7e]/.test(svg)) throw new Error(`${seed}: 含非 ASCII 字符，无法 btoa`);
  return svg;
}

const entries = PRESETS.map(preset => `  { key: '${preset.key}', label: '${preset.label}', svg: '${iconSvg(preset)}' },`);

const source = `// 内置智能体头像：由 scripts/generate-agent-icons.mjs 用 DiceBear Voxel Bot 风格生成的预置机器人头像，请勿手改。
// Voxel Bot © DiceBear（https://www.dicebear.com），CC0 1.0 公共领域。
// svg 仅含 ASCII，仅引用内部 #id、不加载外部资源，可安全放入 <img> 或经 agentIconDataUrl 存入 agents.json。

export interface AgentBuiltinIcon {
  /** 稳定的 kebab-case 标识 */
  key: string;
  /** 中文短名，用于 tooltip/无障碍 */
  label: string;
  /** 完整 SVG 字符串 */
  svg: string;
}

export const agentBuiltinIcons: AgentBuiltinIcon[] = [
${entries.join('\n')}
];

/** 转为可存入 agents.json / <img src> 的 data URL（SVG 内容仅限 ASCII，可直接 btoa） */
export const agentIconDataUrl = (svg: string): string =>
  \`data:image/svg+xml;base64,\${btoa(svg)}\`;
`;

const target = fileURLToPath(new URL('../src/agent-icons.ts', import.meta.url));
writeFileSync(target, source, 'utf8');
console.log(`wrote ${PRESETS.length} icons to ${target}`);
