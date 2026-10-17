/**
 * Adjuntos del composer (INFRA-857): lo que Dani enseña al copiloto.
 * Dos clases y nada más — imagen (viaja al modelo como parte `image_url`, el mismo camino
 * que las capturas del agente) y texto (se vuelca en el mensaje con su nombre). Un PDF o un .zip
 * no tienen dónde caer: se rechazan con su nombre, no se envían a medias.
 */

export const TEXT_MAX_CHARS = 40_000;
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Alias de LiteLLM que sirve el Whisper de casa (los demás son de chat). */
export const STT_MODEL = 'stt-turbo';

export interface Attachment {
  name: string;
  kind: 'image' | 'text';
  /** image: data URL. text: contenido, recortado a TEXT_MAX_CHARS. */
  data: string;
  truncated?: boolean;
}

const TEXT_EXT =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|ndjson|ya?ml|toml|ini|cfg|conf|env|log|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|php|pl|lua|r|sql|sh|bash|zsh|fish|ps1|tex|srt|vtt|gitignore|editorconfig|dockerfile|makefile|lock)$/i;

/** Por el mime o, si viene vacío (típico en .md o .ts), por la extensión. */
export function isTextFile(file: { name: string; type: string }): boolean {
  return file.type.startsWith('text/') || /json|xml|yaml|javascript|csv|x-sh|shellscript/.test(file.type) || TEXT_EXT.test(file.name);
}

function isImage(file: { type: string }): boolean {
  return file.type.startsWith('image/');
}

function dataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`No se pudo leer ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/** Lee un fichero elegido, o dice por qué no vale. */
export async function readAttachment(file: File): Promise<Attachment | { error: string }> {
  if (isImage(file)) {
    if (file.size > IMAGE_MAX_BYTES) return { error: `${file.name}: las imágenes no pasan de 5 MB` };
    return { name: file.name, kind: 'image', data: await dataUrl(file) };
  }
  if (isTextFile(file)) {
    const raw = await file.text();
    const truncated = raw.length > TEXT_MAX_CHARS;
    return { name: file.name, kind: 'text', data: truncated ? raw.slice(0, TEXT_MAX_CHARS) : raw, truncated };
  }
  return { error: `${file.name}: solo imágenes y ficheros de texto` };
}

/** El texto del mensaje: lo escrito más cada fichero volcado con su nombre. */
export function promptWithFiles(prompt: string, attachments: Attachment[]): string {
  const files = attachments.filter((a) => a.kind === 'text');
  if (!files.length) return prompt;
  const blocks = files.map((f) => `Attached file «${f.name}»${f.truncated ? ' (recortado)' : ''}:\n\n\`\`\`\n${f.data}\n\`\`\``);
  return [prompt, ...blocks].filter(Boolean).join('\n\n');
}

export function imageParts(attachments: Attachment[]): string[] {
  return attachments.filter((a) => a.kind === 'image').map((a) => a.data);
}

/**
 * Transcripción con el Whisper de casa: `/audio/transcriptions` en el mismo endpoint OpenAI-compatible
 * del copiloto. Falla con el mensaje del servidor, que es lo que el panel enseña.
 */
export async function transcribe(
  audio: Blob,
  settings: { baseUrl: string; apiKey: string },
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const base = settings.baseUrl.trim().replace(/\/+$/, '');
  const form = new FormData();
  form.append('model', STT_MODEL);
  form.append('file', audio, `dictado.${audio.type.includes('ogg') ? 'ogg' : 'webm'}`);
  const res = await fetchFn(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {},
    body: form,
  });
  if (!res.ok) throw new Error(`Transcripción ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = (await res.json()) as { text?: string };
  if (!data.text?.trim()) throw new Error('No se ha entendido nada del audio.');
  return data.text.trim();
}
