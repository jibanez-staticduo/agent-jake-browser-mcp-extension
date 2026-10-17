/**
 * Tools the copilot agent may call, in OpenAI function-calling format.
 * Every name maps 1:1 to a handler in tools/handlers — the same code the MCP
 * WebSocket path runs. Descriptions follow agent-jake-browser-mcp-server.
 */

export interface FunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

type Props = Record<string, Record<string, unknown>>;

function tool(name: string, description: string, properties: Props = {}, required: string[] = []): FunctionTool {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
    },
  };
}

const ref = { type: 'string', description: 'Element ref from browser_state ([n]) or browser_snapshot' };

export const AGENT_TOOLS: FunctionTool[] = [
  tool('browser_state',
    'Compact page state of the connected tab: url, title, VISIBLE interactive elements with [n] refs and a text digest. The DEFAULT way to see the page before acting; [n] refs work with browser_click, browser_type, browser_select_option.',
    { max: { type: 'number', description: 'Maximum elements to list (default 150)' } }),
  tool('browser_find',
    'Find elements whose text/label/placeholder contains the given text, with refs. Cheaper than browser_state on large pages.',
    { text: { type: 'string' } }, ['text']),
  tool('browser_snapshot',
    'Full ARIA snapshot of the page (all frames). Expensive: use only when browser_state is not enough.'),
  tool('browser_get_text', 'Text content of an element.', { ref }, ['ref']),
  tool('browser_click', 'Click an element.', { ref }, ['ref']),
  tool('browser_type', 'Type text into an input. Works in a BACKGROUND tab: do not switch to it first. Typing APPENDS to what is already there: pass clear:true to replace the current value. If the keys do not land, the value is set from inside the page and the answer says fallback:"native-setter".',
    { ref, text: { type: 'string' }, clear: { type: 'boolean', description: 'Clear the field first (use it unless you mean to append)' } },
    ['ref', 'text']),
  tool('browser_press_key', 'Press a key on the focused element ("Enter", "Tab", "Escape", "ArrowDown", "a").',
    { key: { type: 'string' } }, ['key']),
  tool('browser_hover', 'Hover an element.', { ref }, ['ref']),
  tool('browser_select_option', 'Select an option in a <select>.',
    { ref, value: { type: 'string' }, label: { type: 'string', description: 'Visible option text' }, index: { type: 'number' } },
    ['ref']),
  tool('browser_fill_form',
    'Fill several form fields in one call. type is inferred when missing; checkbox/radio take true/false, combobox takes the option label or value.',
    {
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string' },
            value: { type: ['string', 'number', 'boolean'] },
            type: { type: 'string', enum: ['textbox', 'checkbox', 'radio', 'combobox', 'slider'] },
          },
          required: ['ref', 'value'],
        },
      },
    }, ['fields']),
  tool('browser_navigate', 'Navigate to a URL. Never drives the tab the user is looking at: with no tab connected, or only the user\'s tab auto-attached, it opens a NEW background tab, connects to it and returns its tabId. A tab you opened or switched to navigates in place.', { url: { type: 'string' } }, ['url']),
  tool('browser_go_back', 'Navigate back in history.'),
  tool('browser_go_forward', 'Navigate forward in history.'),
  tool('browser_reload', 'Reload the page.'),
  tool('browser_wait', 'Wait a number of seconds (max 30).', { time: { type: 'number' } }, ['time']),
  tool('browser_wait_for_element', 'Wait until an element exists.',
    { ref, timeout: { type: 'number', description: 'ms, default 10000' } }, ['ref']),
  tool('browser_list_tabs', 'List open tabs with id, url, title, active and connected flags.'),
  tool('browser_find_tab', 'Find open tabs whose title or URL contains a query (case-insensitive), by id. It reads every tab and touches none: nothing is attached or brought to the front.',
    { query: { type: 'string' }, limit: { type: 'number', description: 'matches to return, 10 by default' } }, ['query']),
  tool('browser_switch_tab', 'Connect to another tab: later tools act on it. It also BRINGS the tab to the front: not needed to type or click in a background tab, so use it only when the user must see that tab.', { tabId: { type: 'number' } }, ['tabId']),
  tool('browser_new_tab', 'Open a URL in a new background tab and connect to it.',
    { url: { type: 'string' }, switchTo: { type: 'boolean', description: 'Bring it to the front' } }, ['url']),
  tool('browser_close_tab', 'Close the connected tab.'),
  tool('browser_evaluate', 'Run JavaScript in the page and return the result (last resort; prefer the tools above).',
    { code: { type: 'string' } }, ['code']),
  tool('browser_get_console_logs', 'Recent console messages of the connected tab.'),
];

export const SCREENSHOT_TOOL: FunctionTool = tool(
  'browser_screenshot',
  'PNG screenshot of the connected tab. The image is attached to the next message.',
);

/** Tools that only look: they never need approval and are all plan mode may use. */
export const READ_ONLY_TOOLS = new Set([
  'browser_state',
  'browser_find',
  'browser_snapshot',
  'browser_get_text',
  'browser_list_tabs',
  'browser_find_tab',
  'browser_switch_tab',
  'browser_wait',
  'browser_wait_for_element',
  'browser_get_console_logs',
  'browser_screenshot',
]);

/** Tools answered by the loop and the user, not by the browser handlers. */
export const ASK_USER_TOOL = tool('ask_user',
  'Ask the user a question and wait for the answer. Use it when the request is ambiguous or a choice is theirs to make (which account, which product, confirm an irreversible step). Offer short options when you can.',
  {
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'string' }, description: 'Suggested answers; the user may also type their own' },
  }, ['question']);

export const UPDATE_PLAN_TOOL = tool('update_plan',
  'Publish or update your task checklist, shown pinned in the panel. Use it for any task with 3+ steps: send the full list every time, exactly one step in_progress while working.',
  {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
        },
        required: ['text', 'status'],
      },
    },
  }, ['steps']);

export const PRESENT_PLAN_TOOL = tool('present_plan',
  'PLAN MODE ONLY: present your plan to the user for approval once you have investigated enough. Nothing that changes the page runs until they approve.',
  {
    summary: { type: 'string', description: 'One or two sentences: what you will do and why' },
    steps: { type: 'array', items: { type: 'string' } },
  }, ['summary', 'steps']);

export const META_TOOLS = new Set(['ask_user', 'update_plan', 'present_plan']);

/**
 * Nombres que el panel ya ejecuta por su cuenta. Un servidor MCP anuncia los suyos (sus `browser_*`):
 * con estos fuera, del servidor solo entran los plugins.
 */
export const LOCAL_TOOL_NAMES = new Set(
  [...AGENT_TOOLS, SCREENSHOT_TOOL, ASK_USER_TOOL, UPDATE_PLAN_TOOL, PRESENT_PLAN_TOOL].map((t) => t.function.name),
);

/**
 * `plugins`: lo que anuncia el servidor MCP emparejado (INFRA-909). Solo en `auto`: en `ask` y `plan`
 * el panel solo lee la página, y un plugin puede escribir fuera de ella.
 */
export function agentTools(
  vision: boolean,
  mode: 'ask' | 'auto' | 'plan' = 'auto',
  plugins: FunctionTool[] = [],
): FunctionTool[] {
  const browser = vision ? [...AGENT_TOOLS, SCREENSHOT_TOOL] : AGENT_TOOLS;
  if (mode === 'plan') {
    return [...browser.filter((t) => READ_ONLY_TOOLS.has(t.function.name)), ASK_USER_TOOL, PRESENT_PLAN_TOOL];
  }
  if (mode === 'ask') return [...browser, ASK_USER_TOOL, UPDATE_PLAN_TOOL];
  return [...browser, ASK_USER_TOOL, UPDATE_PLAN_TOOL, ...plugins.filter((t) => !LOCAL_TOOL_NAMES.has(t.function.name))];
}
