import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { get } from 'node:http';

// The fixture qa points a real Chrome at (INFRA-699): /hang and /hang-img must stay open,
// /dcl and /ok must finish.
describe('slow-page-server fixture', () => {
  let child: ChildProcess;
  let base: string;

  beforeAll(async () => {
    child = spawn('node', ['tests/fixtures/slow-page-server.mjs', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
    base = await new Promise<string>((resolve, reject) => {
      child.once('error', reject);
      child.stdout!.once('data', (chunk) => resolve(String(chunk).trim().split(' ').pop()!));
    });
  });

  afterAll(() => { child.kill(); });

  /** What a path does within `ms`: its status, whether it sent any body, and whether it ended. */
  function probe(path: string, ms = 400) {
    return new Promise<{ status: number | null; body: string; ended: boolean }>((resolve) => {
      const out = { status: null as number | null, body: '', ended: false };
      const req = get(base + path, (res) => {
        out.status = res.statusCode ?? null;
        res.on('data', (d) => { out.body += d; });
        res.on('end', () => { out.ended = true; });
      });
      req.on('error', () => undefined);
      setTimeout(() => { req.destroy(); resolve(out); }, ms);
    });
  }

  it('/ok finishes', async () => {
    expect(await probe('/ok')).toMatchObject({ status: 200, ended: true });
  });

  it('/dcl finishes and asks for an image that never comes', async () => {
    const dcl = await probe('/dcl');
    expect(dcl).toMatchObject({ status: 200, ended: true });
    expect(dcl.body).toContain('<img src="/hang-img"');
    expect(await probe('/hang-img')).toMatchObject({ status: null, ended: false });
  });

  it('/hang sends a piece of the page and never ends it', async () => {
    const hang = await probe('/hang');
    expect(hang).toMatchObject({ status: 200, ended: false });
    expect(hang.body).toContain('<h1>hang</h1>');
  });
});
