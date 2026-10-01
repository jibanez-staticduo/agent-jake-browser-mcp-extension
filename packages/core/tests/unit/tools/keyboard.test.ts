/**
 * Unit tests for keyboard-related tool handlers.
 * Tests getKeyDefinition function from constants.
 */

import { describe, it, expect } from 'vitest';
import { getKeyDefinition, KEY_DEFINITIONS } from '@/constants/keys';

describe('KEY_DEFINITIONS', () => {
  it('includes Enter key', () => {
    expect(KEY_DEFINITIONS.Enter).toEqual({
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
    });
  });

  it('includes Tab key', () => {
    expect(KEY_DEFINITIONS.Tab).toEqual({
      key: 'Tab',
      code: 'Tab',
      keyCode: 9,
    });
  });

  it('includes Escape key', () => {
    expect(KEY_DEFINITIONS.Escape).toEqual({
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
    });
  });

  it('includes arrow keys', () => {
    expect(KEY_DEFINITIONS.ArrowUp.keyCode).toBe(38);
    expect(KEY_DEFINITIONS.ArrowDown.keyCode).toBe(40);
    expect(KEY_DEFINITIONS.ArrowLeft.keyCode).toBe(37);
    expect(KEY_DEFINITIONS.ArrowRight.keyCode).toBe(39);
  });

  it('includes Space key with correct key value', () => {
    expect(KEY_DEFINITIONS.Space).toEqual({
      key: ' ',
      code: 'Space',
      keyCode: 32,
    });
  });
});

describe('getKeyDefinition', () => {
  describe('known keys', () => {
    it('returns correct definition for Enter', () => {
      expect(getKeyDefinition('Enter')).toEqual({
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
      });
    });

    it('returns correct definition for Backspace', () => {
      expect(getKeyDefinition('Backspace')).toEqual({
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
      });
    });

    it('returns correct definition for Delete', () => {
      expect(getKeyDefinition('Delete')).toEqual({
        key: 'Delete',
        code: 'Delete',
        keyCode: 46,
      });
    });
  });

  describe('single character keys', () => {
    it('generates definition for lowercase letter', () => {
      expect(getKeyDefinition('a')).toEqual({
        key: 'a',
        code: 'KeyA',
        keyCode: 97, // ASCII code for 'a'
      });
    });

    it('generates definition for uppercase letter', () => {
      expect(getKeyDefinition('A')).toEqual({
        key: 'A',
        code: 'KeyA',
        keyCode: 65, // ASCII code for 'A'
      });
    });

    it('generates definition for digit', () => {
      expect(getKeyDefinition('5')).toEqual({
        key: '5',
        code: 'Digit5',
        keyCode: 53, // ASCII code for '5'
      });
    });

    it('handles special characters', () => {
      const result = getKeyDefinition('@');
      expect(result.key).toBe('@');
      expect(result.keyCode).toBe(64); // ASCII code for '@'
    });
  });

  describe('unknown keys', () => {
    it('returns fallback for multi-char unknown key', () => {
      expect(getKeyDefinition('F13')).toEqual({
        key: 'F13',
        code: 'F13',
        keyCode: 0,
      });
    });
  });
});
