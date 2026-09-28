import type { PostBlock, PostBlockMark, PostImageBlock, PostParagraphBlock } from '../vendor/clack-types/models/channel.js';
import { channelBlocksSchema } from '../schemas/channel.js';
import { parse } from './domain.js';

export type MarkdownOptions = { resolveImage(source: string, alt: string): Promise<Omit<PostImageBlock, 'type'>> };

/** 인라인 서식을 평문 범위로 바꾸어 앱과 같은 marks 계약으로 보낸다. */
export function inlineMarkdown(input: string): PostParagraphBlock {
  let text = ''; const marks: PostBlockMark[] = [];
  function append(source: string): void {
    let index = 0;
    while (index < source.length) {
      if (source[index] === '\\' && index + 1 < source.length) { text += source[index + 1]; index += 2; continue; }
      const rest = source.slice(index);
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.exec(rest);
      if (link) { const start = text.length; append(link[1]); marks.push({ range: [start, text.length], style: 'link', href: link[2] }); index += link[0].length; continue; }
      const marker = rest.startsWith('**') ? '**' : rest.startsWith('*') ? '*' : null;
      if (marker) {
        const end = source.indexOf(marker, index + marker.length);
        if (end > index + marker.length) { const start = text.length; append(source.slice(index + marker.length, end)); marks.push({ range: [start, text.length], style: marker === '**' ? 'bold' : 'italic' }); index = end + marker.length; continue; }
      }
      text += source[index++];
    }
  }
  append(input);
  return { type: 'paragraph', text, ...(marks.length ? { marks } : {}) };
}

export async function markdownToBlocks(markdown: string, options: MarkdownOptions): Promise<{ blocks: PostBlock[]; warnings: string[] }> {
  const blocks: PostBlock[] = []; const warnings = new Set<string>(); let paragraph: string[] = []; let code: string[] | null = null;
  const flush = () => { if (paragraph.length) blocks.push(inlineMarkdown(paragraph.join('\n'))); paragraph = []; };
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { flush(); warnings.add('코드 블록을 일반 문단으로 변환했습니다.'); if (code) { blocks.push({ type: 'paragraph', text: code.join('\n') }); code = null; } else code = []; continue; }
    if (code) { code.push(line); continue; }
    if (!line.trim()) { flush(); continue; }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); blocks.push({ type: 'divider' }); continue; }
    const image = /^\s*!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)\s*$/.exec(line);
    if (image) { flush(); blocks.push({ type: 'image', ...await options.resolveImage(image[2] ?? image[3], image[1]) }); continue; }
    if (/^\s*(#{1,6}\s|>\s?|[-+*]\s|\d+[.)]\s)/.test(line)) { flush(); warnings.add('제목·목록·인용을 일반 문단으로 변환했습니다.'); blocks.push(inlineMarkdown(line.replace(/^\s*(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/, ''))); continue; }
    if (line.includes('![')) warnings.add('문단 안 이미지 문법은 일반 텍스트로 남습니다. 이미지를 별도 줄에 작성하세요.');
    paragraph.push(line);
  }
  if (code) blocks.push({ type: 'paragraph', text: code.join('\n') });
  flush();
  return { blocks: parse(channelBlocksSchema, blocks) as PostBlock[], warnings: [...warnings] };
}
