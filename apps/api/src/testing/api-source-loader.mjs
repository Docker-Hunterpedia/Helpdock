import { existsSync, readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

// Execute current API source in a disposable OS process. Workspace dependencies
// use their normal dist exports, built by the integration job before this suite.
const sourceRoot = new URL('../', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.startsWith(sourceRoot) &&
      specifier.startsWith('.') &&
      specifier.endsWith('.js')
    ) {
      const source = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      if (source.href.startsWith(sourceRoot) && existsSync(source))
        return nextResolve(source.href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts'))
      return {
        format: 'module',
        shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), {
          mode: 'transform',
          sourceUrl: url,
        }),
      };
    return nextLoad(url, context);
  },
});
