/**
 * Utility tool handlers: wait, screenshot, console_logs, evaluate, get_html, resize_viewport, upload_file.
 */
import { log } from '@/utils/logger';
import { schemas } from '../schemas';
import type { HandlerContext, HandlerMap } from './types';

export function createUtilityHandlers(ctx: HandlerContext): HandlerMap {
  const { getSelector } = ctx;

  return {
    browser_wait: async (payload) => {
      const { time } = schemas.browser_wait.parse(payload);
      await new Promise(resolve => setTimeout(resolve, time * 1000));
      return { waited: time };
    },

    browser_screenshot: async () => {
      const result = await ctx.tabManager.sendDebuggerCommand<{ data: string }>(
        'Page.captureScreenshot',
        { format: 'png' }
      );

      return {
        image: `data:image/png;base64,${result.data}`,
      };
    },

    browser_get_console_logs: async () => {
      return [];
    },

    browser_evaluate: async (payload) => {
      const { code } = schemas.browser_evaluate.parse(payload);
      log.info('[browser_evaluate] Evaluating via CDP:', code.substring(0, 50));

      try {
        const result = await ctx.tabManager.sendDebuggerCommand<{
          result: { type: string; value?: unknown; description?: string };
          exceptionDetails?: { text: string; exception?: { description: string } };
        }>('Runtime.evaluate', {
          expression: code,
          returnByValue: true,
          awaitPromise: true,
        });

        if (result.exceptionDetails) {
          const errMsg = result.exceptionDetails.exception?.description ||
                         result.exceptionDetails.text ||
                         'Unknown evaluation error';
          throw new Error(`Evaluation failed: ${errMsg}`);
        }

        log.info('[browser_evaluate] Result type:', result.result?.type);
        return result.result?.value ?? null;
      } catch (error) {
        log.error('[browser_evaluate] CDP evaluation failed:', error);
        throw error;
      }
    },


    browser_iframe_eval: async (payload) => {
      const { iframeSelector, code } = schemas.browser_iframe_eval.parse(payload);
      log.info('[browser_iframe_eval] Evaluating in iframe:', iframeSelector);

      const expression = `(() => {
        let iframe = document.querySelector(${JSON.stringify(iframeSelector)});
        if (iframe && !('contentWindow' in iframe)) {
          iframe = iframe.querySelector('iframe, frame') || iframe;
        }
        if (!iframe || !('contentWindow' in iframe)) {
          throw new Error('Iframe not found or not frame-like: ${iframeSelector.replace(/'/g, "\\'")}');
        }
        const win = iframe.contentWindow;
        if (!win) {
          throw new Error('Iframe has no contentWindow: ${iframeSelector.replace(/'/g, "\\'")}');
        }
        return win.eval(${JSON.stringify(code)});
      })()`;

      const result = await ctx.tabManager.sendDebuggerCommand<{
        result: { type: string; value?: unknown; description?: string };
        exceptionDetails?: { text: string; exception?: { description: string } };
      }>('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });

      if (result.exceptionDetails) {
        const errMsg = result.exceptionDetails.exception?.description ||
                       result.exceptionDetails.text ||
                       'Unknown iframe evaluation error';
        throw new Error(`Iframe evaluation failed: ${errMsg}`);
      }

      return result.result?.value ?? null;
    },

    browser_iframe_click: async (payload) => {
      const { iframeSelector, targetSelector, waitForNavigation, timeout } = schemas.browser_iframe_click.parse(payload);
      log.info('[browser_iframe_click] Clicking in iframe:', iframeSelector, targetSelector);

      const expression = `async () => {
        let iframe = document.querySelector(${JSON.stringify(iframeSelector)});
        if (iframe && !('contentWindow' in iframe)) {
          iframe = iframe.querySelector('iframe, frame') || iframe;
        }
        if (!iframe || !('contentWindow' in iframe)) {
          throw new Error('Iframe not found or not frame-like: ${iframeSelector.replace(/'/g, "\\'")}');
        }
        const win = iframe.contentWindow;
        const doc = iframe.contentDocument || win?.document;
        if (!win || !doc) {
          throw new Error('Iframe document is not accessible: ${iframeSelector.replace(/'/g, "\\'")}');
        }
        const target = doc.querySelector(${JSON.stringify(targetSelector)});
        if (!target) {
          throw new Error('Target not found in iframe: ${targetSelector.replace(/'/g, "\\'")}');
        }

        const beforeUrl = win.location.href;
        const beforeReadyState = doc.readyState;
        const beforeText = (target.textContent || '').trim();

        target.scrollIntoView({ block: 'center', inline: 'center' });
        if (typeof target.focus === 'function') {
          target.focus({ preventScroll: true });
        }

        const rect = target.getBoundingClientRect();
        const clientX = Math.max(0, rect.left + rect.width / 2);
        const clientY = Math.max(0, rect.top + rect.height / 2);
        const eventInit = { bubbles: true, cancelable: true, view: win, clientX, clientY, button: 0 };
        target.dispatchEvent(new win.MouseEvent('mouseover', eventInit));
        target.dispatchEvent(new win.MouseEvent('mousemove', eventInit));
        target.dispatchEvent(new win.MouseEvent('mousedown', eventInit));
        target.dispatchEvent(new win.MouseEvent('mouseup', eventInit));
        target.dispatchEvent(new win.MouseEvent('click', eventInit));

        if (typeof target.click === 'function') {
          target.click();
        }

        if (${waitForNavigation ? 'true' : 'false'}) {
          const timeoutMs = ${timeout};
          const startedAt = Date.now();
          await new Promise((resolve) => {
            const check = () => {
              let currentDoc;
              try {
                currentDoc = iframe.contentDocument || iframe.contentWindow?.document;
                const changedUrl = iframe.contentWindow?.location.href !== beforeUrl;
                const changedDoc = currentDoc && currentDoc !== doc;
                const ready = !currentDoc || currentDoc.readyState === 'complete' || currentDoc.readyState === 'interactive';
                if ((changedUrl || changedDoc) && ready) {
                  resolve(undefined);
                  return;
                }
              } catch (_err) {
                resolve(undefined);
                return;
              }
              if (Date.now() - startedAt >= timeoutMs) {
                resolve(undefined);
                return;
              }
              setTimeout(check, 100);
            };
            setTimeout(check, 100);
          });
        }

        return {
          clicked: true,
          iframeSelector: ${JSON.stringify(iframeSelector)},
          targetSelector: ${JSON.stringify(targetSelector)},
          beforeUrl,
          afterUrl: win.location.href,
          beforeReadyState,
          afterReadyState: (iframe.contentDocument || win.document)?.readyState,
          targetText: beforeText,
        };
      }`;

      const result = await ctx.tabManager.sendDebuggerCommand<{
        result: { type: string; value?: unknown; description?: string };
        exceptionDetails?: { text: string; exception?: { description: string } };
      }>('Runtime.evaluate', {
        expression: `(${expression})()`,
        returnByValue: true,
        awaitPromise: true,
      });

      if (result.exceptionDetails) {
        const errMsg = result.exceptionDetails.exception?.description ||
                       result.exceptionDetails.text ||
                       'Unknown iframe click error';
        throw new Error(`Iframe click failed: ${errMsg}`);
      }

      return result.result?.value ?? { clicked: true };
    },

    browser_get_html: async () => {
      log.info('[browser_get_html] Getting HTML via CDP DOM.getOuterHTML');

      const { root } = await ctx.tabManager.sendDebuggerCommand<{ root: { nodeId: number } }>(
        'DOM.getDocument',
        { depth: 0 }
      );

      const { outerHTML } = await ctx.tabManager.sendDebuggerCommand<{ outerHTML: string }>(
        'DOM.getOuterHTML',
        { nodeId: root.nodeId }
      );

      log.info('[browser_get_html] Got HTML, length:', outerHTML.length);
      return { html: outerHTML };
    },

    browser_resize_viewport: async (payload) => {
      const { width, height } = schemas.browser_resize_viewport.parse(payload);

      await ctx.tabManager.sendDebuggerCommand('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });

      return { width, height };
    },

    browser_upload_file: async (payload) => {
      const { ref, selector, filePath } = schemas.browser_upload_file.parse(payload);

      let targetSelector = selector;
      if (!targetSelector && ref) {
        targetSelector = await getSelector(ref);
      }

      if (!targetSelector) {
        throw new Error('Either ref or selector must be provided');
      }

      const doc = await ctx.tabManager.sendDebuggerCommand<{ root: { nodeId: number } }>(
        'DOM.getDocument',
        {}
      );

      const node = await ctx.tabManager.sendDebuggerCommand<{ nodeId: number }>(
        'DOM.querySelector',
        {
          nodeId: doc.root.nodeId,
          selector: targetSelector,
        }
      );

      if (!node.nodeId) {
        throw new Error(`Element not found: ${targetSelector}`);
      }

      await ctx.tabManager.sendDebuggerCommand('DOM.setFileInputFiles', {
        nodeId: node.nodeId,
        files: [filePath],
      });

      return { uploaded: true, filePath };
    },
  };
}
