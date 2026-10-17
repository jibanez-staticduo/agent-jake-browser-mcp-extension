# CLAUDE.md — agent-browser-extension

## Diseño: la plantilla por defecto, siempre

Toda UI nueva (control, tarjeta, panel) usa los controles compartidos de `src/popup/styles/base.css`
y los tokens de `variables.css`; ningún componente lleva color, borde o relleno propio
(contrast.test.ts vigila los pares). Un `<select>` es nativo y hereda de base.css: su ventana la
pinta el sistema, que sigue el tema gracias a `color-scheme` en el `:root`. Añadir un control sin
pasar por la plantilla es un bug, no un estilo.
