# vendor

`htm-preact.umd.js` is `htm/preact/standalone.umd.js` from npm, unchanged: Preact 10.29.8 with
its hooks and htm 3.1.1 in one 13 KB file, exposing `window.htmPreact` (`html`, `render`,
`useState`, `useEffect`, …). It is kept here because the hub serves the page under a
`script-src 'self'` policy: no CDN. A classic script rather than a module, so the page also runs
where modules do not (jsdom, in the page's tests).

Licences: Preact is MIT (© Jason Miller), htm is Apache-2.0 (© Google). To update:
`npm pack htm preact` and copy `htm/preact/standalone.umd.js` here.
