// The codebase map (lib/creole-core.mjs's scanProject) for hooks/creole-module.mjs, whose environment
// has no Node: argv[2] is the project root; prints { map } as JSON. It only reads.

import { scanProject } from '../lib/creole-core.mjs';

if (!process.argv[2]) process.exit(1);
process.stdout.write(JSON.stringify(scanProject(process.argv[2])));
