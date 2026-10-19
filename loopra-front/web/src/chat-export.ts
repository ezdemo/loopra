import type { Message } from './chat';

// Plain-text transcript, matching the legacy Chat.vue exportChat() output
// (reasoning / content / tool_call blocks joined with a --- separator).
export function chatExportText(messages: Message[]) {
  return messages.map(message => {
    let text = `[${message.time || ''}] ${message.role === 'user' ? '用户' : '助手'}:\n`;
    const blocks = message.blocks || [];
    if (blocks.length) {
      for (const block of blocks) {
        if (block.type === 'reasoning') text += `\n思考: ${block.content}\n`;
        else if (block.type === 'content') text += `${block.content}\n`;
        else if (block.type === 'tool_call') text += `工具 ${block.name}: ${JSON.stringify(block.args)}\n`;
      }
    } else if (message.text) {
      text += `${message.text}\n`;
    }
    return text;
  }).join('\n---\n\n');
}

export function downloadText(name: string, text: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
