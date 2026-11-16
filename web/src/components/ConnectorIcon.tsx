import type { ReactNode } from 'react';
import { Cable, FolderTree, Globe, type LucideIcon } from 'lucide-react';
import icon12306 from '../assets/connectors/12306.svg';
import iconAirtable from '../assets/connectors/airtable.svg';
import iconAmap from '../assets/connectors/amap.svg';
import iconAtlassian from '../assets/connectors/atlassian.svg';
import iconBaiduMap from '../assets/connectors/baidu-map.svg';
import iconCanva from '../assets/connectors/canva.svg';
import iconClickup from '../assets/connectors/clickup.svg';
import iconContext7 from '../assets/connectors/context7.png';
import iconDchub from '../assets/connectors/dchub.svg';
import iconDida365 from '../assets/connectors/dida365.svg';
import iconDidi from '../assets/connectors/didi.svg';
import iconDingtalk from '../assets/connectors/dingtalk.svg';
import iconFeishu from '../assets/connectors/feishu.png';
import iconFlomo from '../assets/connectors/flomo.svg';
import iconGithub from '../assets/connectors/github.svg';
import iconGmail from '../assets/connectors/gmail.svg';
import iconGoogleCalendar from '../assets/connectors/google-calendar.svg';
import iconGoogleDrive from '../assets/connectors/google-drive.svg';
import iconLinear from '../assets/connectors/linear.svg';
import iconLkcoffee from '../assets/connectors/lkcoffee.ico';
import iconMastergo from '../assets/connectors/mastergo.ico';
import iconMcd from '../assets/connectors/mcd.svg';
import iconMetaso from '../assets/connectors/metaso.png';
import iconMonday from '../assets/connectors/monday.svg';
import iconNotion from '../assets/connectors/notion.svg';
import iconPixso from '../assets/connectors/pixso.png';
import iconPlaywright from '../assets/connectors/playwright.svg';
import iconSentry from '../assets/connectors/sentry.svg';
import iconSqlite from '../assets/connectors/sqlite.svg';
import iconTencentDocs from '../assets/connectors/tencent-docs.ico';
import iconTencentMap from '../assets/connectors/tencent-map.png';
import iconTencentMeeting from '../assets/connectors/tencent-meeting.svg';
import iconTencentWeiyun from '../assets/connectors/tencent-weiyun.svg';
import iconTuniu from '../assets/connectors/tuniu.ico';
import iconVariflight from '../assets/connectors/variflight.png';
import iconWeibo from '../assets/connectors/weibo.svg';
import iconWeread from '../assets/connectors/weread.svg';
import iconYinxiang from '../assets/connectors/yinxiang.ico';
import iconYuque from '../assets/connectors/yuque.svg';

// 连接器图标键 → 打包资源。bg 用于纯白 logo：在品牌色底板上渲染，
// 保证亮暗主题下都可辨认；glyph 用于无品牌标识的通用连接器。
type IconSpec = { src?: string; bg?: string; glyph?: LucideIcon };

const icons: Record<string, IconSpec> = {
  '12306': { src: icon12306 },
  airtable: { src: iconAirtable },
  amap: { src: iconAmap },
  atlassian: { src: iconAtlassian },
  'baidu-map': { src: iconBaiduMap },
  canva: { src: iconCanva },
  clickup: { src: iconClickup },
  context7: { src: iconContext7 },
  dchub: { src: iconDchub },
  dida365: { src: iconDida365 },
  didi: { src: iconDidi },
  dingtalk: { src: iconDingtalk },
  feishu: { src: iconFeishu },
  fetch: { glyph: Globe },
  filesystem: { glyph: FolderTree },
  flomo: { src: iconFlomo },
  github: { src: iconGithub, bg: '#181717' },
  gmail: { src: iconGmail },
  'google-calendar': { src: iconGoogleCalendar },
  'google-drive': { src: iconGoogleDrive },
  linear: { src: iconLinear },
  lkcoffee: { src: iconLkcoffee },
  mastergo: { src: iconMastergo },
  mcd: { src: iconMcd },
  metaso: { src: iconMetaso },
  monday: { src: iconMonday },
  notion: { src: iconNotion, bg: '#000000' },
  pixso: { src: iconPixso },
  playwright: { src: iconPlaywright },
  sentry: { src: iconSentry },
  sqlite: { src: iconSqlite },
  'tencent-docs': { src: iconTencentDocs },
  'tencent-map': { src: iconTencentMap },
  'tencent-meeting': { src: iconTencentMeeting },
  'tencent-weiyun': { src: iconTencentWeiyun },
  tuniu: { src: iconTuniu },
  variflight: { src: iconVariflight },
  weibo: { src: iconWeibo },
  weread: { src: iconWeread },
  yinxiang: { src: iconYinxiang },
  yuque: { src: iconYuque },
};

// ConnectorIcon 渲染连接器图标；icon 无对应资源时回退 fallback
// （通常是名称首字母），size 仅作用于 Lucide 图标。
export function ConnectorIcon({ icon, fallback, size = 20 }: {
  icon?: string;
  fallback?: ReactNode;
  size?: number;
}) {
  const spec = icon ? icons[icon] : undefined;
  if (!spec) return <>{fallback ?? <Cable size={size} />}</>;
  if (spec.glyph) {
    const Glyph = spec.glyph;
    return <Glyph size={size} aria-hidden="true" />;
  }
  const img = <img className="connector-icon-img" src={spec.src} alt="" draggable={false} />;
  return spec.bg
    ? <span className="connector-icon-tile" style={{ background: spec.bg }}>{img}</span>
    : img;
}
