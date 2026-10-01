/**
 * Keyboard key definitions for CDP Input.dispatchKeyEvent.
 * Maps key names to their key, code, and keyCode values.
 */

export interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
}

export const KEY_DEFINITIONS: Record<string, KeyDefinition> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32 },
} as const;

/**
 * Get key definition for a key name or character.
 * Falls back to generating definition for single characters.
 */
export function getKeyDefinition(key: string): KeyDefinition {
  if (KEY_DEFINITIONS[key]) {
    return KEY_DEFINITIONS[key];
  }

  // Single character
  if (key.length === 1) {
    const charCode = key.charCodeAt(0);
    const code = key.toUpperCase().match(/[A-Z]/)
      ? `Key${key.toUpperCase()}`
      : `Digit${key}`;

    return { key, code, keyCode: charCode };
  }

  // Unknown key - return as-is
  return { key, code: key, keyCode: 0 };
}
