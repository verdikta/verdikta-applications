# Inter

The site's typeface, served by the site itself: the Content-Security-Policy
(`deploy/nginx/verifiers.verdikta.org-headers.conf`) has `font-src 'self'` and names no other origin,
so no page asks a font service for anything.

- `inter-latin-wght-normal.woff2`: Inter, the variable font (weights 100 to 900), Latin subset. It is the
  file of that name in the npm package `@fontsource-variable/inter` 5.3.0, unchanged
  (sha256 `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62`).
- `OFL.txt`: its licence, the SIL Open Font License 1.1, as that package ships it.

`src/styles.css` declares the face; Vite puts the file under `/assets/` with a content hash in its name.
