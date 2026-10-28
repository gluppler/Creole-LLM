// Records fs calls on matching paths, for tests that must prove the wiki is never read or written.
// syncBuiltinESMExports carries the swap into the named imports lib/creole-core.mjs holds.

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

// Every call of these functions on a path match(path) accepts, until the test t ends.
export function spyFs(t, match) {
  const seen = [];
  for (const name of ['openSync', 'readFileSync', 'writeFileSync', 'renameSync', 'realpathSync', 'readdirSync', 'statSync', 'rmSync', 'mkdirSync', 'existsSync', 'rmdirSync']) {
    const real = fs[name];
    fs[name] = Object.assign(function (p, ...rest) {
      if (typeof p === 'string' && match(p)) seen.push(`${name} ${p}`);
      return real.call(this, p, ...rest);
    }, real);
    t.after(() => { fs[name] = real; syncBuiltinESMExports(); });
  }
  syncBuiltinESMExports();
  return seen;
}
