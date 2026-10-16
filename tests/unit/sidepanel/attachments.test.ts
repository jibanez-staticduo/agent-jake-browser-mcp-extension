import { describe, expect, it, vi } from 'vitest';
import {
  IMAGE_MAX_BYTES,
  TEXT_MAX_CHARS,
  imageParts,
  isTextFile,
  promptWithFiles,
  readAttachment,
  transcribe,
  type Attachment,
} from '@/sidepanel/attachments';

/** Lo que readAttachment pide a un File: nombre, mime, tamaño y lectura como texto. */
function fakeFile(name: string, type: string, content = ''): File {
  return { name, type, size: content.length, text: async () => content } as unknown as File;
}

const text: Attachment = { name: 'notas.md', kind: 'text', data: 'hola' };
const img: Attachment = { name: 'foto.png', kind: 'image', data: 'data:image/png;base64,AAA' };

describe('isTextFile', () => {
  it('acepta texto por mime y por extensión cuando el mime viene vacío', () => {
    expect(isTextFile({ name: 'a.txt', type: 'text/plain' })).toBe(true);
    expect(isTextFile({ name: 'package-lock.json', type: '' })).toBe(true);
    expect(isTextFile({ name: 'main.ts', type: 'application/octet-stream' })).toBe(true);
  });

  it('rechaza lo que no es texto', () => {
    expect(isTextFile({ name: 'foto.png', type: 'image/png' })).toBe(false);
    expect(isTextFile({ name: 'instalador.exe', type: 'application/octet-stream' })).toBe(false);
  });
});

describe('readAttachment', () => {
  it('vuelca un fichero de texto y avisa cuando lo recorta', async () => {
    const read = await readAttachment(fakeFile('grande.log', 'text/plain', 'x'.repeat(TEXT_MAX_CHARS + 10)));
    expect(read).toMatchObject({ name: 'grande.log', kind: 'text', truncated: true });
    expect((read as Attachment).data).toHaveLength(TEXT_MAX_CHARS);
  });

  it('rechaza una imagen enorme y un binario, diciendo cuál es', async () => {
    const big = { name: 'gigante.png', type: 'image/png', size: IMAGE_MAX_BYTES + 1 } as unknown as File;
    expect(await readAttachment(big)).toEqual({ error: 'gigante.png: las imágenes no pasan de 5 MB' });
    expect(await readAttachment(fakeFile('datos.bin', 'application/octet-stream'))).toEqual({
      error: 'datos.bin: solo imágenes y ficheros de texto',
    });
  });
});

describe('promptWithFiles', () => {
  it('deja el mensaje tal cual si no hay ficheros', () => {
    expect(promptWithFiles('resume esto', [img])).toBe('resume esto');
  });

  it('vuelca cada fichero con su nombre, y lo marca si venía recortado', () => {
    const prompt = promptWithFiles('resume esto', [text, { ...text, name: 'corto.csv', truncated: true }]);
    expect(prompt).toContain('resume esto');
    expect(prompt).toContain('Attached file «notas.md»:\n\n```\nhola\n```');
    expect(prompt).toContain('Attached file «corto.csv» (recortado):');
  });
});

it('imageParts saca solo las imágenes, en orden', () => {
  expect(imageParts([text, img])).toEqual(['data:image/png;base64,AAA']);
});

describe('transcribe', () => {
  const settings = { baseUrl: 'https://litellm.lan.e-dani.com/v1/', apiKey: 'sk-test' };

  it('llama a /audio/transcriptions con el modelo de casa y la key', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ text: '  abre una pestaña  ' }) })) as unknown as typeof fetch;
    const said = await transcribe(new Blob(['audio'], { type: 'audio/webm' }), settings, fetchFn);
    expect(said).toBe('abre una pestaña');
    const [url, init] = (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(url).toBe('https://litellm.lan.e-dani.com/v1/audio/transcriptions');
    expect((init as RequestInit).headers).toEqual({ Authorization: 'Bearer sk-test' });
    const form = (init as RequestInit).body as FormData;
    expect(form.get('model')).toBe('stt-turbo');
    expect((form.get('file') as Blob).type).toBe('audio/webm');
  });

  it('sin key no manda Authorization, y un error del servidor sale con su código', async () => {
    const ok = vi.fn(async () => ({ ok: true, json: async () => ({ text: 'vale' }) })) as unknown as typeof fetch;
    await transcribe(new Blob(['a']), { baseUrl: 'http://127.0.0.1:4000/v1', apiKey: '' }, ok);
    const initNoKey = (ok as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as RequestInit;
    expect(initNoKey.headers).toEqual({});

    const fail = vi.fn(async () => ({ ok: false, status: 403, text: async () => 'model not allowed' })) as unknown as typeof fetch;
    await expect(transcribe(new Blob(['a']), settings, fail)).rejects.toThrow('Transcripción 403: model not allowed');
  });

  it('un audio vacío no es un error silencioso', async () => {
    const empty = vi.fn(async () => ({ ok: true, json: async () => ({ text: '  ' }) })) as unknown as typeof fetch;
    await expect(transcribe(new Blob(['a']), settings, empty)).rejects.toThrow('No se ha entendido nada');
  });
});
