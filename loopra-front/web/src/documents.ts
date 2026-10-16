// Parses uploaded documents into plain text for the composer.
// Kept separate from Composer.tsx so the pure parts stay testable and the
// heavy parsers (pdf.js, mammoth, sheetjs) load lazily on first use.

export const MAX_TEXT_FILE_SIZE = 512 * 1024;
export const MAX_DOC_FILE_SIZE = 30 * 1024 * 1024;
export const MAX_IMAGE_COUNT = 10;
export const MAX_UPLOAD_FILES = 10;
export const MAX_EXTRACT_CHARS = 500000;
export const MAX_PDF_PAGES = 50;
export const LARGE_PASTE_THRESHOLD_CHARS = 8000;

export const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp',
  'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bat', 'ps1', 'sql', 'html', 'htm', 'css', 'scss', 'less',
  'xml', 'yaml', 'yml', 'csv', 'log', 'properties', 'ini', 'toml', 'cfg', 'conf', 'env',
  'gitignore', 'dockerfile', 'vue', 'svelte',
]);

export type FileKind = 'image' | 'text' | 'pdf' | 'docx' | 'xlsx' | 'unsupported';

export function fileKind(name: string, type = ''): FileKind {
  const lower = String(name || '');
  const ext = lower.includes('.') ? lower.split('.').pop()!.toLowerCase() : '';
  const mime = String(type || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('text/') || TEXT_EXTENSIONS.has(ext)) return 'text';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (ext === 'docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (ext === 'xlsx' || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  return 'unsupported';
}

/**
 * Legacy ChatInput keeps request bodies small by capping pasted images at 10
 * and parsed documents at 10. Returns true when another file of this kind
 * would exceed its cap.
 */
export function attachmentLimitReached(imageCount: number, docCount: number, kind: FileKind) {
  return kind === 'image' ? imageCount >= MAX_IMAGE_COUNT : docCount >= MAX_UPLOAD_FILES;
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function truncateText(text: string, max = MAX_EXTRACT_CHARS) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[内容过长，已截断，共 ${text.length} 字符]`;
}

async function extractPdf(file: File) {
  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerPort) {
    const { default: PdfWorker } = await import('pdfjs-dist/build/pdf.worker.min.mjs?worker');
    pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
  }
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  try {
    const maxPages = Math.min(doc.numPages, MAX_PDF_PAGES);
    let text = '';
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      text += content.items.map(item => ('str' in item ? item.str : '')).join(' ') + '\n';
      if (text.length > MAX_EXTRACT_CHARS) break;
    }
    if (doc.numPages > maxPages) text += `\n...[仅提取前 ${maxPages} 页，共 ${doc.numPages} 页]`;
    return text;
  } finally {
    void (doc as { destroy?: () => Promise<void> }).destroy?.();
  }
}

async function extractDocx(file: File) {
  const mammoth = await import('mammoth/mammoth.browser');
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return String(result?.value || '');
}

async function extractXlsx(file: File) {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const parts: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    parts.push(`[工作表: ${sheetName}]\n${XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName])}`);
  }
  return parts.join('\n\n');
}

export async function extractDocumentText(file: File): Promise<string> {
  const kind = fileKind(file.name, file.type);
  if (kind === 'text') return truncateText(await file.text());
  if (kind === 'pdf') return truncateText(await extractPdf(file));
  if (kind === 'docx') return truncateText(await extractDocx(file));
  if (kind === 'xlsx') return truncateText(await extractXlsx(file));
  throw new Error('不支持的文件类型');
}
