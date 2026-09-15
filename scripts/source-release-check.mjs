import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function sourceFileProblems(path, content) {
  const errors = []
  if (/(?:^|\/)(?:reports|artifacts|\.runtime|\.test-runtime|node_modules|\.env(?:\..*)?|\.credentials[^/]*)(?:\/|$)/i.test(path)
    || /\.(?:db|sqlite(?:3)?|whl|tgz|log|key|pem)$/i.test(path)) errors.push('private/generated file')
  if (/\/Users\/[^/\s]+\/|[A-Z]:\\Users\\|\/home\/[^/\s]+\//.test(content)) errors.push('local user path')
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}/.test(content)) errors.push('credential-like content')
  return errors
}

export function checkSource(root) {
  const result = spawnSync('git', ['ls-files', '-z', '--cached'], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) return ['A Git repository is required']
  const paths = result.stdout.split('\0').filter(Boolean)
  if (!paths.length) return ['No tracked source: select and review public files before staging']
  const errors = []
  for (const path of paths) {
    try {
      for (const problem of sourceFileProblems(path, readFileSync(resolve(root, path), 'utf8'))) errors.push(`${path}: ${problem}`)
    } catch { errors.push(`${path}: cannot inspect tracked file`) }
  }
  return errors
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = checkSource(resolve(import.meta.dirname, '..'))
  if (errors.length) { console.error('Source publication blocked:\n' + errors.join('\n')); process.exitCode = 1 }
  else console.log('Tracked source passed the baseline privacy scan; manual review is still required.')
}
