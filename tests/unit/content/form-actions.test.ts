import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findElement } from '@/content/selector';
import { handleClearField, handleFieldLength, handleFillField, handleSetFieldText } from '@/content/form-actions';

vi.mock('@/content/selector', () => ({ findElement: vi.fn() }));

class FakeElement {
  focus = vi.fn();
  click = vi.fn();
  getAttribute(name: string): string | null { return name === 'type' ? 'radio' : null; }
}

class FakeInput extends FakeElement {
  checked = true;
}

beforeEach(() => {
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('HTMLInputElement', FakeInput);
  vi.stubGlobal('HTMLSelectElement', class {});
});

afterEach(() => vi.unstubAllGlobals());

describe('radio fill', () => {
  it('rejects unchecking a selected radio instead of reporting success', async () => {
    const radio = new FakeInput();
    vi.mocked(findElement).mockResolvedValue(radio as unknown as Element);

    await expect(handleFillField({ selector: '#selected', value: false })).rejects.toThrow('cannot be unchecked');
    expect(radio.click).not.toHaveBeenCalled();
    expect(radio.checked).toBe(true);
  });

  it('accepts false when the radio is already unselected', async () => {
    const radio = new FakeInput();
    radio.checked = false;
    vi.mocked(findElement).mockResolvedValue(radio as unknown as Element);

    await expect(handleFillField({ selector: '#other', value: false })).resolves.toEqual({ kind: 'radio' });
    expect(radio.click).not.toHaveBeenCalled();
  });
});

describe('clearField / fieldLength', () => {
  class FakeTextInput {
    _value = '1234';
    events: string[] = [];
    get value() { return this._value; }
    set value(v: string) { this._value = `framework:${v}`; } // a framework setter that would swallow a plain assignment
    dispatchEvent(e: Event) { this.events.push(e.type); return true; }
  }

  it('empties through the native setter and fires input + change, reporting only lengths', async () => {
    const native = { set(this: FakeTextInput, v: string) { this._value = v; }, configurable: true };
    class Input extends FakeTextInput {}
    Object.defineProperty(Input.prototype, 'value', { get(this: FakeTextInput) { return this._value; }, ...native });
    vi.stubGlobal('HTMLInputElement', Input);
    vi.stubGlobal('HTMLTextAreaElement', class {});
    const field = new Input();
    Object.defineProperty(field, 'value', { get() { return this._value; }, set(v: string) { this._value = `framework:${v}`; }, configurable: true });
    vi.mocked(findElement).mockResolvedValue(field as unknown as Element);

    await expect(handleFieldLength({ selector: '#otp' })).resolves.toEqual({ length: 4 });
    await expect(handleClearField({ selector: '#otp' })).resolves.toEqual({ length: 0 });
    expect(field.events).toEqual(['input', 'change']);
  });
});

describe('setFieldText (browser_type fallback)', () => {
  class Input {
    _value = '';
    maxLength = -1;
    events: string[] = [];
    get value() { return this._value; }
    set value(v: string) { this._value = v; }
    dispatchEvent(e: Event) { this.events.push(e.type); return true; }
  }

  function field(initial: string, maxLength = -1) {
    vi.stubGlobal('HTMLInputElement', Input);
    vi.stubGlobal('HTMLTextAreaElement', class {});
    const el = new Input();
    el._value = initial;
    el.maxLength = maxLength;
    vi.mocked(findElement).mockResolvedValue(el as unknown as Element);
    return el;
  }

  it('keeps the leading characters, appends the text, fires input + change and answers lengths only', async () => {
    const el = field('abXY');

    const answer = await handleSetFieldText({ selector: '#f', text: 'cd', kept: 2 });

    expect(el.value).toBe('abcd');
    expect(el.events).toEqual(['input', 'change']);
    expect(answer).toEqual({ applied: true, length: 4 });
  });

  it('counts code points, not UTF-16 units', async () => {
    const el = field('😀😀x');

    await handleSetFieldText({ selector: '#f', text: 'y', kept: 1 });

    expect(el.value).toBe('😀y');
  });

  it('refuses when the result would exceed maxlength, and touches nothing', async () => {
    const el = field('', 3);

    const answer = await handleSetFieldText({ selector: '#f', text: 'abcd', kept: 0 });

    expect(answer).toEqual({ applied: false, length: 0 });
    expect(el.events).toEqual([]);
  });
});
