// `vitest --changed` follows imports only. Suites that read fixtures, schemas and stubs with readFileSync
// would otherwise pass with no tests when just those files change. Vitest reruns the whole project when a
// changed path matches one of these globs. The globs start with `**/` because the changed paths are absolute.
// The first two are Vitest's own defaults; setting the option replaces them.
export const FORCE_RERUN_TRIGGERS = [
  '**/package.json',
  '**/{vitest,vite}.config.*',
  '**/fixtures/**',
  '**/contract/**',
  '**/packages/*/test*/fixtures/**',
  '**/packages/*/tests/**/fixtures/**',
  '**/tests/support/**',
];
