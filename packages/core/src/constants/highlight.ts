/**
 * Highlight overlay styling constants.
 * Used when highlighting elements on the page.
 */

export const HIGHLIGHT_STYLES = {
  /** Border color for highlight overlay */
  BORDER_COLOR: '#ff4444',

  /** Border width in pixels */
  BORDER_WIDTH: 3,

  /** Background color with opacity */
  BACKGROUND_COLOR: 'rgba(255, 68, 68, 0.2)',

  /** Z-index to ensure overlay is on top */
  Z_INDEX: 2147483647,

  /** Transition duration for animations */
  TRANSITION: '0.2s ease',
} as const;

/**
 * Generate CSS for highlight overlay at given rect position.
 */
export function getHighlightCSS(rect: { top: number; left: number; width: number; height: number }): string {
  return `
    position: fixed;
    top: ${rect.top}px;
    left: ${rect.left}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
    border: ${HIGHLIGHT_STYLES.BORDER_WIDTH}px solid ${HIGHLIGHT_STYLES.BORDER_COLOR};
    background: ${HIGHLIGHT_STYLES.BACKGROUND_COLOR};
    pointer-events: none;
    z-index: ${HIGHLIGHT_STYLES.Z_INDEX};
    transition: all ${HIGHLIGHT_STYLES.TRANSITION};
  `.trim();
}
