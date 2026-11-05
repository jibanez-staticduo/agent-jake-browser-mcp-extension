import { describe, expect, it } from 'vitest';
import type { SelfUpdateStatus } from '@/background/self-update';
import { NOT_RELOADED_TEXT, RELOAD_TIMEOUT_MS, RELOAD_WARNING, isReloading, lastAutoLine, lastAutoText, manualResultText } from '@/sidepanel/self-update-text';

const STATUSES: SelfUpdateStatus[] = ['applied', 'up-to-date', 'locked', 'busy', 'not-eligible', 'rejected', 'failed'];

describe('manualResultText', () => {
  it.each(STATUSES)('has a non-empty Spanish text for %s', (status) => {
    expect(manualResultText({ status }).length).toBeGreaterThan(5);
  });
  it('says the extension reloads on applied, and only then is it reloading', () => {
    expect(manualResultText({ status: 'applied' })).toBe('Actualizando… la extensión se recarga');
    expect(STATUSES.filter((status) => isReloading({ status }))).toEqual(['applied']);
  });
  it('explains locked, up-to-date and rejected', () => {
    expect(manualResultText({ status: 'locked' })).toMatch(/en marcha/);
    expect(manualResultText({ status: 'up-to-date' })).toMatch(/última versión/);
    expect(manualResultText({ status: 'rejected' })).toMatch(/paquete o firma no válidos/);
  });
  it.each(['not-in-downloads', 'download-prompt', 'probe-failed', 'unsupported-browser'])('not-eligible/%s gets a human reason', (reason) => {
    const t = manualResultText({ status: 'not-eligible', reason });
    expect(t).toMatch(/^No se puede actualizar sola: /);
    expect(t).not.toContain(reason);
  });
  it('failed shows its reason, translated when known and verbatim otherwise', () => {
    expect(manualResultText({ status: 'failed', reason: 'no-check' })).toMatch(/versión publicada/);
    expect(manualResultText({ status: 'failed', reason: 'not-applied' })).toMatch(/modo desarrollador/);
    expect(manualResultText({ status: 'failed', reason: 'disk full' })).toBe('La actualización falló: disk full');
    expect(manualResultText({ status: 'failed' })).toBe('La actualización falló');
  });
});

describe('lastAutoText', () => {
  const at = new Date(2026, 10, 2, 14, 5).getTime();
  it('busy: names the 5-minute rule and the time', () => {
    expect(lastAutoText({ status: 'busy', at })).toBe('último intento automático: ocupada (actividad del agente en los últimos 5 min) · 14:05');
  });
  it.each(STATUSES)('covers %s', (status) => {
    expect(lastAutoText({ status, at })).toMatch(/^último intento automático: .+ · 14:05$/);
  });
  it('appends the human reason of not-eligible', () => {
    expect(lastAutoText({ status: 'not-eligible', reason: 'download-prompt', at })).toContain('Preguntar dónde guardar');
  });
});

describe('lastAutoLine', () => {
  const at = new Date(2026, 10, 2, 14, 5).getTime();
  it('shows a skipped run when it was about the build the banner offers', () => {
    expect(lastAutoLine({ status: 'busy', build: 142, at }, 142)).toBe(lastAutoText({ status: 'busy', build: 142, at }));
    expect(lastAutoLine({ status: 'not-eligible', reason: 'download-prompt', build: 142, at }, 142)).toContain('Preguntar dónde guardar');
  });
  it('hides a run recorded for another build (stale excuse for a different update)', () => {
    expect(lastAutoLine({ status: 'busy', build: 141, at }, 142)).toBe('');
    expect(lastAutoLine({ status: 'busy', build: 143, at }, 142)).toBe('');
  });
  it('hides a run with no recorded build, and any run when no build is offered', () => {
    expect(lastAutoLine({ status: 'busy', at }, 142)).toBe('');
    expect(lastAutoLine({ status: 'busy', build: 142, at }, undefined)).toBe('');
    expect(lastAutoLine(null, 142)).toBe('');
  });
  it.each(['applied', 'up-to-date'] as const)('never shows %s: the banner already says it', (status) => {
    expect(lastAutoLine({ status, build: 142, at }, 142)).toBe('');
  });
  it.each(STATUSES.filter((s) => s !== 'applied' && s !== 'up-to-date'))('shows %s for the matching build', (status) => {
    expect(lastAutoLine({ status, build: 142, at }, 142)).toMatch(/^último intento automático: /);
  });
});

describe('reload warning and fallback texts', () => {
  it('warns that the update reloads the extension and cuts the agent', () => {
    expect(RELOAD_WARNING).toBe('Recarga la extensión: corta lo que esté haciendo el agente');
  });
  it('unblocks the button after 60 s with a retry hint that names chrome://extensions', () => {
    expect(RELOAD_TIMEOUT_MS).toBe(60_000);
    expect(NOT_RELOADED_TEXT).toMatch(/no se ha recargado.*vuelve a intentarlo.*chrome:\/\/extensions/);
  });
});
