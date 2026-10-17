#!/usr/bin/env node
// Pages that load slowly or never, to try the extension's bounded load waits in a real Chrome
// (INFRA-699). No dependencies. Usage: node tests/fixtures/slow-page-server.mjs <port>
// (port 0 takes a free one; the address is printed on the first line).
//
//   /hang      headers and a piece of HTML, then the connection stays open: the tab is `loading` for good.
//   /dcl       a whole HTML page with an <img> that never answers: DOMContentLoaded fires, `load` does not.
//   /hang-img  the image of /dcl: never answers.
//   /ok        a minimal page that finishes.
import { createServer } from 'node:http';

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}`;
const htmlHead = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (pathname === '/hang') {
    res.writeHead(200, htmlHead);
    res.write(page('hang', '<h1>hang</h1><p>this page never finishes loading</p>')); // no res.end(): on purpose
  } else if (pathname === '/dcl') {
    res.writeHead(200, htmlHead);
    res.end(page('dcl', '<h1>dcl</h1><img src="/hang-img" alt=""></body></html>'));
  } else if (pathname === '/hang-img') {
    // no answer at all: the image stays pending and so does `load`
  } else if (pathname === '/ok') {
    res.writeHead(200, htmlHead);
    res.end(page('ok', '<h1>ok</h1></body></html>'));
  } else {
    res.writeHead(404).end();
  }
});

server.listen(Number(process.argv[2] ?? 0), '127.0.0.1', () => {
  console.log(`slow-page-server http://127.0.0.1:${server.address().port}`);
});
