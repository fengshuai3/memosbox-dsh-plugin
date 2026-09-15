import { readFileSync } from 'node:fs'

// Resolves the installed package from both src/ and dist/; status cannot drift
// from package.json when a release number changes.
export const PACKAGE_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
