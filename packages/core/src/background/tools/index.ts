/**
 * Tool handlers module index.
 * Re-exports schemas and provides the main handler creation function.
 */

export { schemas, type ToolName, type ToolPayload } from './schemas';
export { isNavigationError, createToolContext, type ToolContext } from './utils';

// The main createToolHandlers function is still in tool-handlers.ts
// It will be migrated to use these extracted modules incrementally
