import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { checkSource } from './source-release-check.mjs'

export const REQUIRED_EVIDENCE = ['licenses', 'security', 'realDialogue', 'automaticCapture', 'humanApproval', 'migrationRollback']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export function validateEvidence(key, receipt, manifest, artifactHash) {
  const errors = []
  if (receipt?.schemaVersion !== 1 || receipt.kind !== key || receipt.version !== manifest.version) errors.push(`Evidence type/schema/version mismatch: ${key}`)
  if (!artifactHash || receipt?.artifactSha256 !== artifactHash) errors.push(`Evidence candidate mismatch: ${key}`)
  if (receipt?.passed !== true) errors.push(`Evidence did not pass: ${key}`)
  if (typeof receipt?.verifiedAt !== 'string' || !Number.isFinite(Date.parse(receipt.verifiedAt))) errors.push(`Evidence timestamp required: ${key}`)
  if (typeof receipt?.scope !== 'string' || !receipt.scope.trim()) errors.push(`Evidence scope required: ${key}`)
  if (key === 'licenses' && (receipt?.legalClearance !== true || !receipt?.rightsReviewer?.trim() || !Array.isArray(receipt?.officialSources) || !receipt.officialSources.length || receipt.blockers?.length)) errors.push('License clearance and named rights review required')
  if (key === 'humanApproval' && (receipt?.humanPerformed !== true || receipt?.uiTested !== true || !receipt?.reviewer?.trim())) errors.push('Simulation cannot substitute for human UI acceptance')
  if (!receipt?.checks || !Object.keys(receipt.checks).length || Object.values(receipt.checks).some(value => value !== true)) errors.push(`All scoped evidence checks must pass: ${key}`)
  return errors
}
export function validateApproval(manifest, approval, artifactHash) {
  const errors = []
  if (approval.publicationReady !== true) errors.push('publicationReady must be explicitly approved')
  if (approval.schemaVersion !== 1 || approval.version !== manifest.version) errors.push('Approval schema/version mismatch')
  if (!/^[a-f0-9]{64}$/.test(approval.artifactSha256 ?? '') || approval.artifactSha256 !== artifactHash) errors.push('Exact candidate SHA-256 approval required')
  if (typeof approval.reviewer !== 'string' || !approval.reviewer.trim()) errors.push('Named release reviewer required')
  const author = manifest.author
  if (!author || typeof author !== 'object' || !author.name?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(author.email ?? '') || /example\.(?:com|org|net)$/.test(author.email)) errors.push('Real maintainer name and email required')
  if (!/^https:\/\/[^\s]+$/.test(manifest.repository?.url ?? '') || !/^https:\/\/[^\s]+$/.test(manifest.bugs?.url ?? '')) errors.push('Public source repository and issue tracker required')
  for (const key of REQUIRED_EVIDENCE) {
    const item = approval.evidence?.[key]
    if (!item || item.passed !== true || !/^release\/evidence\/[a-zA-Z0-9._/-]+$/.test(item.path ?? '') || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')) errors.push(`Missing approved evidence: ${key}`)
  }
  return errors
}

export function checkRelease(root, artifact) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const approval = JSON.parse(readFileSync(resolve(root, 'release/approval.json'), 'utf8'))
  const hash = artifact ? digest(readFileSync(resolve(root, artifact))) : undefined
  const errors = validateApproval(manifest, approval, hash)
  const evidenceRoot = resolve(root, 'release/evidence') + sep
  for (const key of REQUIRED_EVIDENCE) {
    const item = approval.evidence?.[key]
    if (!item?.path) continue
    try {
      const path = realpathSync(resolve(root, item.path))
      if (!path.startsWith(evidenceRoot) || digest(readFileSync(path)) !== item.sha256) errors.push(`Invalid evidence integrity: ${key}`)
      else errors.push(...validateEvidence(key, JSON.parse(readFileSync(path, 'utf8')), manifest, hash))
    } catch { errors.push(`Evidence unavailable: ${key}`) }
  }
  const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  const head = git(['rev-parse', '--verify', 'HEAD'])
  if (head.status !== 0) errors.push('Committed Git HEAD required')
  const tag = git(['rev-parse', '--verify', `refs/tags/v${manifest.version}^{commit}`])
  if (tag.status !== 0 || tag.stdout.trim() !== head.stdout.trim()) errors.push('Release tag must resolve to HEAD')
  const status = git(['status', '--porcelain', '--untracked-files=normal'])
  if (status.status !== 0 || status.stdout.trim()) errors.push('Clean, reviewed source tree required')
  errors.push(...checkSource(root))
  return errors
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length && (args.length !== 2 || args[0] !== '--artifact')) throw new Error('Usage: release-check.mjs --artifact <candidate.tgz>')
    const errors = checkRelease(resolve(import.meta.dirname, '..'), args[1] ?? process.env.MEMOSBOX_RELEASE_ARTIFACT)
    if (errors.length) { console.error('Publication blocked:\n' + errors.join('\n')); process.exitCode = 1 }
    else console.log('Exact candidate passed configured release gates; registry publication was not performed.')
  } catch (error) { console.error('Publication blocked: ' + error.message); process.exitCode = 1 }
}
