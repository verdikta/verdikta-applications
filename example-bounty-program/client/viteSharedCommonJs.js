// ../shared holds plain CommonJS modules (no dependencies, no require calls) that the bounty
// server requires as they are. This Vite plugin serves them to the browser as ES modules:
// module.exports becomes the default export, and each of its keys a named export.
// Every Vite server for this client registers it: vite.config.js and the Playwright fixture
// server (tests/e2e/start-buyer-server.mjs), which does not load vite.config.js.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sharedDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../shared') + path.sep;
const requireShared = createRequire(import.meta.url);

export function sharedCommonJs() {
  return {
    name: 'verdikta-shared-commonjs',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0];
      if (!file.startsWith(sharedDir) || !file.endsWith('.js')) return null;
      delete requireShared.cache[file];
      const names = Object.keys(requireShared(file));
      return {
        // A function scope keeps the module's own top-level names apart from the exports.
        code: `const __shared = (() => {\nconst module = { exports: {} };\nconst exports = module.exports;\n${code}\nreturn module.exports;\n})();\nexport default __shared;\nexport const { ${names.join(', ')} } = __shared;\n`,
        map: null,
      };
    },
  };
}
