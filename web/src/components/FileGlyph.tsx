import { Coffee, Container, Database, FileArchive, FileCode, FileImage, FileJson, FileText, GitBranch, ListTree, Package, Palette, Settings, Terminal, type LucideIcon } from 'lucide-react';
import { fileIconFor } from '../file-icons';

const FILE_GLYPHS: Record<string, LucideIcon> = {
  default: FileText, vue: FileCode, javascript: FileCode, react: FileCode, typescript: FileCode,
  java: Coffee, kotlin: FileCode, json: FileJson, markdown: FileText, css: Palette, sass: Palette,
  html: FileCode, xml: FileCode, yaml: ListTree, python: FileCode, go: FileCode, rust: Settings,
  php: FileCode, shell: Terminal, powershell: Terminal, database: Database, image: FileImage,
  svg: Palette, pdf: FileText, archive: FileArchive, config: Settings, git: GitBranch,
  npm: Package, docker: Container, maven: Package, gradle: Package,
};

export default function FileGlyph({ name, size = 14, className = 'tree-file' }: { name: string; size?: number | string; className?: string }) {
  const { kind, color } = fileIconFor(name.split(/[\\/]/).pop());
  const Glyph = FILE_GLYPHS[kind] || FileText;
  return <Glyph size={size} className={className} data-icon={kind} style={{ color }} aria-hidden="true" />;
}
