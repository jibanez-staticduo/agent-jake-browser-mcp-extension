import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('evaluates catastrophic backtracking patterns within an isolated process deadline', () => {
  // A child deadline still stops a future regression to native RegExp from hanging Vitest.
  const modulePath = fileURLToPath(new URL('../../../src/content/read-secret.ts', import.meta.url));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { transformSync } from 'esbuild';
    import { readFileSync } from 'node:fs';
    import { RE2JS } from 're2js';
    const source = readFileSync(${JSON.stringify(modulePath)}, 'utf8')
      .replace("import { RE2JS } from 're2js';", '')
      .replace("import { getElementByRef, getCurrentSnapshot } from './aria-tree';", '');
    const js = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
    const exports = {};
    const module = { exports };
    new Function('module', 'exports', 'RE2JS', js)(module, exports, RE2JS);
    const doc = { body: { innerText: 'a'.repeat(65535) + '!' } };
    for (const regex of ['(a+)+$', '(a|aa)+$', '(a*)*b$']) {
      const result = module.exports.readSecret({ regex }, doc);
      if (result.ok || result.code !== 'SECRET_REGEX_NO_MATCH') process.exit(2);
    }
  `], { timeout: 5000, encoding: 'utf8' });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
}, 7000);
