// The Mac-side sidebar registrar keeps its tests next to its source under
// tools/sidebar-registrar/. Importing that module registers its node:test
// cases here so `npm test` (node --test tests/*.test.mjs) covers them too.
import "../tools/sidebar-registrar/registrar.test.mjs";
