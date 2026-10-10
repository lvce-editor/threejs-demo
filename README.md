# Three.js demo

Edit an npm Three.js scene in TypeScript with Lvce Editor. The GitHub Pages site
opens `src/main.ts` beside a live preview. Saving rebuilds `dist/main.js` with
esbuild-wasm in the browser. TypeScript and ESLint diagnostics run through the
editor's extensions.

The starting scene is a rotating cube. Change `cubeColor` in `src/main.ts` and
save to see the new color. A compilation error keeps the last successful preview;
correct the source and save to recover.

```sh
npm ci
npm run build
npm test
npm run type-check
npm run lint
npx playwright install chromium
npm run e2e:headless
```

The build exports `.tmp/static` under the `/threejs-demo` URL prefix. GitHub
Actions validates pull requests and publishes merged `main` to GitHub Pages.
The scene compiles entirely in the browser; it needs no development server.

To run the same acceptance tests against a deployed site:

```sh
THREEJS_DEMO_URL=https://lvce-editor.github.io/threejs-demo/ npm run e2e:headless --workspace=packages/e2e
```
