import { useEffect, useState } from 'react';
import { Bell, BookOpen, Bot, Box, Braces, Calendar, Cat, CircleHelp, Clock, Cloud, Code, Compass, Database, File, Folder, Gift, Globe, Heart, House, Image, Inbox, Key, Layers, Library, Link, Mail, Map, MessageCircle, Moon, Music, Package, Palette, PawPrint, Pen, Phone, Plug, Puzzle, Rocket, Search, Server, Settings, Shield, Smile, Sparkles, Star, Sun, Terminal, User, Users, Video, Wand, Wrench, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { LoopraClient } from '../backend';

export type PluginIconRef = { name?: string; key?: string; hidden?: boolean; dataUrl?: string };
export type PluginMenuChild = { id: string; title: string; icon?: PluginIconRef };
export type PluginMenu = { id: string; title: string; category?: string; icon?: PluginIconRef; page?: boolean; children?: PluginMenuChild[] };

const pluginLucide: Record<string, LucideIcon> = {
  braces: Braces, bell: Bell, 'book-open': BookOpen, bot: Bot, box: Box, calendar: Calendar, cat: Cat, 'circle-help': CircleHelp,
  clock: Clock, cloud: Cloud, code: Code, compass: Compass, database: Database, file: File, folder: Folder,
  gift: Gift, globe: Globe, heart: Heart, house: House, image: Image, inbox: Inbox, key: Key, layers: Layers,
  library: Library, link: Link, mail: Mail, map: Map, 'message-circle': MessageCircle, moon: Moon, music: Music,
  package: Package, palette: Palette, 'paw-print': PawPrint, pen: Pen, phone: Phone, plug: Plug, puzzle: Puzzle,
  rocket: Rocket, search: Search, server: Server, settings: Settings, shield: Shield, smile: Smile, sparkles: Sparkles,
  star: Star, sun: Sun, terminal: Terminal, user: User, users: Users, video: Video, wand: Wand, wrench: Wrench, zap: Zap,
};

const pluginTones = ['#4f6ef7', '#7b6cf6', '#1f2937', '#1f9d55', '#e25b4a', '#0f766e', '#d97706', '#3b6cf6'];
export function pluginTone(id: string) {
  let n = 0;
  for (const ch of id) n = (n + ch.charCodeAt(0)) % pluginTones.length;
  return pluginTones[n];
}

export function selectedPluginMenu(tab: string, menus: PluginMenu[]) {
  const [kind, id, childId] = tab.split(':');
  if (kind !== 'plugin' || !id) return undefined;
  const menu = menus.find(item => item.id === id);
  if (!menu) return undefined;
  const child = menu.children?.find(item => item.id === childId);
  if (childId && !child) return undefined;
  return { menu, child, title: child?.title || menu.title };
}

export function PluginGlyph({ api, pluginId, icon, className, size = '1.125rem' }: {
  api: LoopraClient;
  pluginId: string;
  icon?: PluginIconRef;
  className?: string;
  size?: string;
}) {
  if (icon?.hidden) return null;
  const Lucide = icon?.name ? pluginLucide[icon.name] : undefined;
  if (Lucide) return <Lucide className={className} size={size} strokeWidth={1.8} aria-hidden="true" />;
  if (icon?.dataUrl?.startsWith('data:image/')) return <img className={className || 'plugin-file-icon'} src={icon.dataUrl} alt="" />;
  if (icon?.key) return <PluginFileIcon api={api} pluginId={pluginId} iconKey={icon.key} className={className || 'plugin-file-icon'} />;
  return null;
}

function PluginFileIcon({ api, pluginId, iconKey, className }: { api: LoopraClient; pluginId: string; iconKey: string; className?: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = '';
    void fetch(api.pluginIcon(pluginId, iconKey), { signal: controller.signal })
      .then(response => response.ok ? response.blob() : Promise.reject(new Error(String(response.status))))
      .then(blob => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => { if (!controller.signal.aborted) setUrl(''); });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, pluginId, iconKey]);
  if (!url) return <span className={className} aria-hidden="true" />;
  return <img className={className} src={url} alt="" />;
}
