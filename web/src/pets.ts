import type { LoopraClient } from './backend';
import type { ChatBlock, Message } from './chat';

export type Pet = { name: string; displayName?: string; description?: string; hasSpritesheet: boolean };
export type ActivePet = {
  active: true; name: string; displayName?: string; description?: string;
  position?: { x: number; y: number }; sizeIndex?: number; scale?: number;
  /** Bottom-right of the desktop pet window, in screen coordinates. */
  desktop?: PetPoint;
};
export type PetSnapshot = { pets: Pet[]; active: ActivePet | null };
export type PetPoint = { x: number; y: number };
export type PetSize = { width: number; height: number };
export type PetReply = { id: string; text: string; activity?: PetAnimation };
export const petAnimations = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  'running-right': { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  'running-left': { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving: { row: 3, durations: [140, 140, 140, 280] },
  jumping: { row: 4, durations: [140, 140, 140, 140, 280] },
  failed: { row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, durations: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, durations: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, durations: [150, 150, 150, 150, 150, 280] },
} as const;
export type PetAnimation = keyof typeof petAnimations;
export const petSizes = [0.4, 0.55, 0.75, 1];
export const petIdleActions: PetAnimation[] = ['running-right', 'running-left', 'waving', 'jumping'];
export function petReplyPreview(message?: Pick<Message, 'text' | 'blocks'>) {
  if (!message) return '';
  function content(blocks: ChatBlock[]): string {
    return blocks.flatMap(block => block.type === 'content' ? [block.content] : block.type === 'sub_agent' ? [content(block.blocks)] : []).join(' ');
  }
  const text = (content(message.blocks || []) || message.text).replace(/\s+/g, ' ').trim();
  const characters = Array.from(text);
  return characters.slice(0, 150).join('') + (characters.length > 150 ? '…' : '');
}
export function clampPetOffset(position: PetPoint, origin: PetPoint, size: PetSize, viewport: PetSize): PetPoint {
  const minX = 8 - origin.x;
  const minY = Math.min(64, Math.max(8, viewport.height - size.height - 8)) - origin.y;
  return {
    x: Math.min(Math.max(minX, viewport.width - size.width - 8 - origin.x), Math.max(minX, Number.isFinite(position.x) ? position.x : 0)),
    y: Math.min(Math.max(minY, viewport.height - size.height - 8 - origin.y), Math.max(minY, Number.isFinite(position.y) ? position.y : 0)),
  };
}
export function placePetPanel(anchor: PetPoint & PetSize, panel: PetSize, viewport: PetSize): PetPoint {
  const above = anchor.y - panel.height - 8;
  const below = anchor.y + anchor.height + 8;
  const top = above >= 8 ? above : below + panel.height <= viewport.height - 8 ? below : above;
  return {
    x: Math.max(8, Math.min(viewport.width - panel.width - 8, anchor.x + (anchor.width - panel.width) / 2)),
    y: Math.max(8, Math.min(viewport.height - panel.height - 8, top)),
  };
}
export function petScale(pet: Pick<ActivePet, 'scale' | 'sizeIndex'>) {
  return typeof pet.scale === 'number' && Number.isFinite(pet.scale)
    ? Math.max(0.25, Math.min(1.25, pet.scale)) : petSizes[pet.sizeIndex ?? 1] ?? 0.55;
}
export function petSpriteSize(scale: number): PetSize {
  const safe = typeof scale === 'number' && Number.isFinite(scale) ? Math.max(0.25, Math.min(1.25, scale)) : 0.55;
  return { width: 192 * safe * 0.75, height: 208 * safe * 0.75 };
}
/** Page size of the desktop pet window. The sprite sits at the bottom-right; extra is the panel above it. */
export function petWindowSize(pet: PetSize, extra: PetSize): PetSize {
  return {
    width: Math.max(48, Math.ceil(Math.max(pet.width, extra.width))),
    height: Math.max(48, Math.ceil(pet.height + Math.max(0, extra.height))),
  };
}
/** Top-left of a window whose bottom-right stays on `anchor`. */
export function petWindowOrigin(anchor: PetPoint, frame: PetSize): PetPoint {
  return { x: Math.round(anchor.x - frame.width), y: Math.round(anchor.y - frame.height) };
}
export function petAnchor(bounds: PetPoint & PetSize): PetPoint {
  return { x: bounds.x + bounds.width, y: bounds.y + bounds.height };
}
export type PetWindowFrame = { x: number; y: number; width: number; height: number; hasPosition: boolean };
/** `anchor` is the pet's bottom-right. Without one, the desktop host chooses the default corner. */
export function petShowFrame(anchor: PetPoint | undefined, scale: number): PetWindowFrame {
  const size = petWindowSize(petSpriteSize(scale), { width: 0, height: 0 });
  if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return { x: 0, y: 0, width: size.width, height: size.height, hasPosition: false };
  const origin = petWindowOrigin(anchor, size);
  return { x: origin.x, y: origin.y, width: size.width, height: size.height, hasPosition: true };
}
export function petActivity(generating: boolean, blocks: ChatBlock[] = []): PetAnimation {
  if (blocks.some(block => block.type === 'choice' && !block.selected)) return 'waiting';
  if (!generating) return 'idle';
  if (blocks.some(block => (block.type === 'tool_call' || block.type === 'sub_agent') && block.status === '执行中')) return 'running';
  return 'review';
}
export function petFrame(animation: PetAnimation, elapsed: number) {
  const { durations } = petAnimations[animation];
  let time = Math.max(0, elapsed) % durations.reduce<number>((sum, duration) => sum + duration, 0);
  for (let frame = 0; frame < durations.length; frame++) {
    if (time < durations[frame]) return frame;
    time -= durations[frame];
  }
  return 0;
}
export function petImageUrl(api: LoopraClient, name: string, revision?: number) {
  return api.assetUrl(`/pets/${encodeURIComponent(name)}/spritesheet${revision ? `?v=${revision}` : ''}`);
}
export async function loadPets(api: LoopraClient, signal?: AbortSignal): Promise<PetSnapshot> {
  const [pets, active] = await Promise.all([
    api.request<Pet[]>('/pets', 'GET', undefined, signal),
    api.request<ActivePet | { active: false }>('/pets/active', 'GET', undefined, signal),
  ]);
  return { pets, active: active.active ? active : null };
}
