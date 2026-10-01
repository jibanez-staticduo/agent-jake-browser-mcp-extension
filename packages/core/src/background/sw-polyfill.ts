/**
 * Service Worker Polyfill
 *
 * Provides a `window` shim for libraries (like pusher-js) that expect
 * to run in a browser context. Service workers use `self` instead of `window`.
 *
 * This IIFE runs immediately when the module loads, before any imports.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// IIFE to ensure this runs immediately
(function() {
  // Polyfill window for service worker context
  if (typeof window === 'undefined') {
    (globalThis as any).window = self;
  }

  // Polyfill document if needed (some libs check for it)
  if (typeof document === 'undefined') {
    (globalThis as any).document = {
      createElement: () => ({}),
      createEvent: () => ({
        initEvent: () => {},
      }),
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
      documentElement: { style: {} },
      body: { style: {} },
    };
  }

  // Polyfill localStorage (some libs check for it)
  if (typeof localStorage === 'undefined') {
    const storage: Record<string, string> = {};
    (globalThis as any).localStorage = {
      getItem: (key: string) => storage[key] || null,
      setItem: (key: string, value: string) => { storage[key] = value; },
      removeItem: (key: string) => { delete storage[key]; },
      clear: () => { Object.keys(storage).forEach(k => delete storage[k]); },
    };
  }

  // Polyfill XMLHttpRequest if needed (pusher uses it for auth)
  if (typeof XMLHttpRequest === 'undefined') {
    // Use fetch-based polyfill
    (globalThis as any).XMLHttpRequest = class {
      private _method = 'GET';
      private _url = '';
      private _headers: Record<string, string> = {};
      private _response: any = null;
      public status = 0;
      public responseText = '';
      public readyState = 0;
      public onreadystatechange: (() => void) | null = null;

      open(method: string, url: string) {
        this._method = method;
        this._url = url;
        this.readyState = 1;
      }

      setRequestHeader(name: string, value: string) {
        this._headers[name] = value;
      }

      send(body?: string) {
        fetch(this._url, {
          method: this._method,
          headers: this._headers,
          body: body,
        })
          .then(async (response) => {
            this.status = response.status;
            this.responseText = await response.text();
            this._response = this.responseText;
            this.readyState = 4;
            if (this.onreadystatechange) this.onreadystatechange();
          })
          .catch(() => {
            this.status = 0;
            this.readyState = 4;
            if (this.onreadystatechange) this.onreadystatechange();
          });
      }

      get response() {
        return this._response;
      }
    };
  }
})();

/* eslint-enable @typescript-eslint/no-explicit-any */

export {};
