'use strict';
// Stand-in verifier for tests: prints a failing report and exits 1 (violations found).
process.stdout.write(JSON.stringify({ passed: false, pairs_tested: 396, violations: 3, matrix: {} }));
process.exit(1);
