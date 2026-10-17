#!/usr/bin/env node
// Page with fields to type into, to try browser_type in a BACKGROUND tab in a real Chrome.
// No dependencies. Usage: node tests/fixtures/typing-page-server.mjs <port> (0 = a free one, printed on line 1).
//   /form  #plain (an ordinary <input>), #ctl (a controlled input in the React way: the page keeps
//          the value in its own state and writes it back on every `input`, so a bare `el.value = x`
//          that skips the event is thrown away), #pw (type=password), #ta (<textarea>),
//          #eaten (swallows keydown and beforeinput with preventDefault: what CDP key events
//          cannot fill, to try the in-page fallback).
import { createServer } from 'node:http';

const head = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
const form = `<!doctype html><html><head><meta charset="utf-8"><title>form</title></head><body>
<h1>form</h1>
<input id="plain" type="text" aria-label="plain">
<input id="ctl" type="text" aria-label="controlled">
<input id="pw" type="password" aria-label="password">
<textarea id="ta" aria-label="area"></textarea>
<input id="eaten" type="text" aria-label="swallows keys">
<script>
  // Controlled input: the source of truth is \`state\`, and the DOM follows it after every event.
  const state = { ctl: '' };
  const ctl = document.getElementById('ctl');
  // React tracks the value through an instance-level descriptor; an assignment that bypasses the
  // prototype setter is not seen as a change, and the controlled value overwrites it.
  let tracked = '';
  Object.defineProperty(ctl, 'value', {
    configurable: true,
    get() { return Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').get.call(this); },
    set(v) { tracked = String(v); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(this, v); },
  });
  ctl.addEventListener('input', () => {
    const real = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').get.call(ctl);
    if (real === tracked) return; // React: no change seen, the event is dropped
    tracked = real;
    state.ctl = real;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(ctl, state.ctl); // controlled write-back
    window.__ctlEvents = (window.__ctlEvents || 0) + 1;
  });
  for (const type of ['keydown', 'beforeinput']) document.getElementById('eaten').addEventListener(type, (e) => e.preventDefault());
</script></body></html>`;

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (pathname === '/form') res.writeHead(200, head).end(form);
  else res.writeHead(404).end();
});
server.listen(Number(process.argv[2] ?? 0), '127.0.0.1', () => {
  console.log(`typing-page-server http://127.0.0.1:${server.address().port}`);
});
