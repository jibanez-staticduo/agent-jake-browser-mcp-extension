import { describe, expect, it } from 'vitest';
import { blocksOf, type Item } from '@/sidepanel/chats';

const tool = (id: string): Item => ({ kind: 'tool', id, text: 'browser_click' });
const narration = (text: string): Item => ({ kind: 'assistant', text, interim: true });

describe('blocksOf', () => {
  it('keeps a turn with narration between tool calls in a single steps block', () => {
    const blocks = blocksOf([
      { kind: 'user', text: 'arregla el MX' },
      { kind: 'assistant', text: '', reasoning: 'pienso', interim: true },
      tool('1'),
      narration('Voy a abrir el detalle.'),
      tool('2'),
      { kind: 'assistant', text: 'Los MX son estos.' },
    ]);
    expect(blocks).toHaveLength(3);
    expect('item' in blocks[0] && blocks[0].item.kind).toBe('user');
    expect('steps' in blocks[1] && blocks[1].steps).toHaveLength(4);
    expect('item' in blocks[2] && blocks[2].item.text).toBe('Los MX son estos.');
  });

  it('extended view (Opciones) puts visible narration back outside the blocks', () => {
    const blocks = blocksOf([
      { kind: 'assistant', text: '', reasoning: 'pienso', interim: true },
      tool('1'),
      narration('Voy a abrir el detalle.'),
      tool('2'),
    ], false);
    expect(blocks).toHaveLength(3);
    expect('steps' in blocks[0] && blocks[0].steps).toHaveLength(2);
    expect('item' in blocks[1] && blocks[1].item.text).toBe('Voy a abrir el detalle.');
    expect('steps' in blocks[2]).toBe(true);
  });

  it('a turn without tool calls stays visible as its own block', () => {
    const blocks = blocksOf([{ kind: 'assistant', text: 'hola' }]);
    expect(blocks).toHaveLength(1);
    expect('item' in blocks[0]).toBe(true);
  });
});
