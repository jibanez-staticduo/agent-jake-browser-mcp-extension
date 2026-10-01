/**
 * Unit tests for ARIA role constants.
 * Tests role arrays and tag-to-role mappings from extracted module.
 */

import { describe, it, expect } from 'vitest';
import {
  CHECKABLE_ROLES,
  DISABLEABLE_ROLES,
  EXPANDABLE_ROLES,
  LEVELED_ROLES,
  SELECTABLE_ROLES,
  TAG_TO_ROLE,
} from '@/content/aria/roles';

describe('CHECKABLE_ROLES', () => {
  it('includes checkbox', () => {
    expect(CHECKABLE_ROLES).toContain('checkbox');
  });

  it('includes radio', () => {
    expect(CHECKABLE_ROLES).toContain('radio');
  });

  it('includes switch', () => {
    expect(CHECKABLE_ROLES).toContain('switch');
  });

  it('does not include button', () => {
    expect(CHECKABLE_ROLES).not.toContain('button');
  });
});

describe('DISABLEABLE_ROLES', () => {
  it('includes button', () => {
    expect(DISABLEABLE_ROLES).toContain('button');
  });

  it('includes textbox', () => {
    expect(DISABLEABLE_ROLES).toContain('textbox');
  });

  it('includes combobox', () => {
    expect(DISABLEABLE_ROLES).toContain('combobox');
  });
});

describe('EXPANDABLE_ROLES', () => {
  it('includes combobox', () => {
    expect(EXPANDABLE_ROLES).toContain('combobox');
  });

  it('includes treeitem', () => {
    expect(EXPANDABLE_ROLES).toContain('treeitem');
  });
});

describe('LEVELED_ROLES', () => {
  it('includes heading', () => {
    expect(LEVELED_ROLES).toContain('heading');
  });

  it('includes treeitem', () => {
    expect(LEVELED_ROLES).toContain('treeitem');
  });
});

describe('SELECTABLE_ROLES', () => {
  it('includes option', () => {
    expect(SELECTABLE_ROLES).toContain('option');
  });

  it('includes tab', () => {
    expect(SELECTABLE_ROLES).toContain('tab');
  });
});

describe('TAG_TO_ROLE', () => {
  it('maps A to link', () => {
    expect(TAG_TO_ROLE.A).toBe('link');
  });

  it('maps BUTTON to button', () => {
    expect(TAG_TO_ROLE.BUTTON).toBe('button');
  });

  it('maps INPUT to textbox', () => {
    expect(TAG_TO_ROLE.INPUT).toBe('textbox');
  });

  it('maps SELECT to combobox', () => {
    expect(TAG_TO_ROLE.SELECT).toBe('combobox');
  });

  it('maps all heading tags to heading', () => {
    expect(TAG_TO_ROLE.H1).toBe('heading');
    expect(TAG_TO_ROLE.H2).toBe('heading');
    expect(TAG_TO_ROLE.H3).toBe('heading');
    expect(TAG_TO_ROLE.H4).toBe('heading');
    expect(TAG_TO_ROLE.H5).toBe('heading');
    expect(TAG_TO_ROLE.H6).toBe('heading');
  });

  it('maps semantic landmark elements', () => {
    expect(TAG_TO_ROLE.NAV).toBe('navigation');
    expect(TAG_TO_ROLE.MAIN).toBe('main');
    expect(TAG_TO_ROLE.ASIDE).toBe('complementary');
    expect(TAG_TO_ROLE.HEADER).toBe('banner');
    expect(TAG_TO_ROLE.FOOTER).toBe('contentinfo');
  });

  it('maps table elements', () => {
    expect(TAG_TO_ROLE.TABLE).toBe('table');
    expect(TAG_TO_ROLE.TR).toBe('row');
    expect(TAG_TO_ROLE.TH).toBe('columnheader');
    expect(TAG_TO_ROLE.TD).toBe('cell');
  });

  it('maps list elements', () => {
    expect(TAG_TO_ROLE.UL).toBe('list');
    expect(TAG_TO_ROLE.OL).toBe('list');
    expect(TAG_TO_ROLE.LI).toBe('listitem');
  });
});
