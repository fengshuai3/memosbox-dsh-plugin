/** DSH merges explicit env over its scrubbed parent. Undefined entries are
 * deliberate tombstones, not merely an incomplete allowlist. */
export function workerEnvironment(workDirectory: string, ambient: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(ambient).map(name => [name, undefined]))
  // Proxy service can add these even if they were absent from process.env.
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY']) env[name] = undefined
  return {
    ...env,
    PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
    TMPDIR: workDirectory, XDG_CACHE_HOME: workDirectory,
    OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1',
    VECLIB_MAXIMUM_THREADS: '1', NUMEXPR_NUM_THREADS: '1',
  }
}
