# Contributing

Use Node.js `^22.19.0 || >=24.0.0` and pnpm 11.7.0. Run `corepack pnpm install` and `corepack pnpm run verify` before opening a change. Behavior changes require tests and current README or architecture updates. Never commit runtime memory, Wiki data, `.env` files, credentials, health data, build output, dependency trees, or release tarballs.

Commit subjects use `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, or `chore:`. Keep dependency upgrades in isolated changes and attach the DSH version, Node version, packed-artifact smoke result, and migration result.
