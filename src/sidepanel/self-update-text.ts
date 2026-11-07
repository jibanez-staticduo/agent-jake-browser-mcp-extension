/** Spanish texts for the side panel's «Actualizar ahora» button and the last automatic result. Pure, so it is unit-tested. */
import type { LastAuto, SelfUpdateResult, SelfUpdateStatus } from '@/background/self-update';

export const UPDATING_TEXT = 'Actualizando…';
/** Shown next to the button: the update reloads the extension, which drops whatever the agent is doing. */
export const RELOAD_WARNING = 'Recarga la extensión: corta lo que esté haciendo el agente';
/** After `applied` the extension reloads within ~300 ms; if the panel is still alive after this, the reload did not happen. */
export const RELOAD_TIMEOUT_MS = 60_000;
export const NOT_RELOADED_TEXT = 'La extensión no se ha recargado; vuelve a intentarlo o revisa chrome://extensions';

const NOT_ELIGIBLE: Record<string, string> = {
  'not-in-downloads': 'instálala desde Descargas/agent-jake-browser',
  'download-prompt': 'desactiva "Preguntar dónde guardar cada archivo" en los ajustes de Chrome',
  'probe-failed': 'no pudo comprobar su carpeta de instalación',
  'unsupported-browser': 'este Chrome no soporta Ed25519; actualízalo',
  'invalid-install-config': 'la configuración de instalación no es válida; no se escribió ningún archivo',
};

const FAILED: Record<string, string> = {
  'no-check': 'no se pudo consultar la versión publicada (sin red o sin publicación)',
  'not-applied': 'la versión nueva no arrancó tras actualizarse; revisa el modo desarrollador en chrome://extensions',
};

const withReason = (head: string, reason: string | undefined, table: Record<string, string>) =>
  reason ? `${head}: ${table[reason] ?? reason}` : head;

/** What the panel shows once the click has been answered. `applied` is the last thing seen before the reload. */
export function manualResultText(r: SelfUpdateResult): string {
  switch (r.status) {
    case 'applied': return 'Actualizando… la extensión se recarga';
    case 'up-to-date': return 'Ya tienes la última versión';
    case 'locked': return 'Ya hay una actualización en marcha';
    case 'busy': return 'El agente está usando el navegador; vuelve a intentarlo';
    case 'not-eligible': return withReason('No se puede actualizar sola', r.reason, NOT_ELIGIBLE);
    case 'rejected': return 'Actualización rechazada: paquete o firma no válidos';
    case 'failed': return withReason('La actualización falló', r.reason, FAILED);
  }
}

/** Whether the panel should keep the button disabled: the extension is about to reload. */
export const isReloading = (r: SelfUpdateResult): boolean => r.status === 'applied';

const AUTO_LABEL: Record<SelfUpdateStatus, string> = {
  applied: 'aplicada',
  'up-to-date': 'al día',
  locked: 'ya había una en marcha',
  busy: 'ocupada (actividad del agente en los últimos 5 min)',
  'not-eligible': 'no elegible',
  rejected: 'paquete o firma no válidos',
  failed: 'falló',
};

const hhmm = (at: number) => new Date(at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

/** «último intento automático: ocupada (…) · 14:05» */
export function lastAutoText(a: LastAuto): string {
  const reason = a.reason ? ` (${NOT_ELIGIBLE[a.reason] ?? FAILED[a.reason] ?? a.reason})` : '';
  return `último intento automático: ${AUTO_LABEL[a.status]}${a.status === 'busy' ? '' : reason} · ${hhmm(a.at)}`;
}

/**
 * The «último intento automático» line for the banner, or '' when there is nothing useful to say.
 * Shown only for a skipped run (applied/up-to-date say nothing the banner does not) AND only when
 * that run was about the build the banner offers now: a run recorded for an older build, or one
 * with no recorded build, would be a stale excuse for a different update.
 */
export function lastAutoLine(a: LastAuto | null, offeredBuild: number | undefined): string {
  if (!a || a.status === 'applied' || a.status === 'up-to-date') return '';
  if (a.build === undefined || offeredBuild === undefined || a.build !== offeredBuild) return '';
  return lastAutoText(a);
}
