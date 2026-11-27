# Coding Standards

Review criteria for changes in this repository. They add to the organization's
`repos/constitution/CODING_STANDARDS.md` (included by `REVIEW.md`) and take local precedence,
except that they cannot loosen anything `REVIEW.md` rates P0. Each rule names what enforces it,
or says that review does.

## Architecture rules

1. Public asynchronous operations return `Effect` or `Stream`, not a naked `Promise`. Enforced by review.
2. Expected failures stay typed in `E`; requirements stay visible in `R`. `pnpm typecheck`
   (`effect-tsrs`) rejects `any`/`unknown` in either channel; review enforces the rest.
3. Effect `Schema` is the canonical source for persisted, transported, and boundary values. Enforced by review.
4. Every acquired resource belongs to `Scope`. Do not create daemon fibers. Enforced by review.
5. `packages/effect-webtransport` stays platform-generic and free of Cloudflare types. Enforced by review.
6. `@cloudflare/workers-types` is loaded only through `compilerOptions.types` in `packages/effect-cf`; it never appears in published source or emitted declarations. Enforced by review.
7. Keep workerd, Workers types, and the recommended `compatibility_date` in lockstep through the root catalog and override. Enforced by review.

## Change discipline

- Both publishable packages stay on the `0.x` line: `minor` for breaking changes and public additions, `patch` for compatible fixes. A `major` changeset moves a package to `1.0.0`; never do that without an explicit instruction to release `1.0.0`. Enforced by review.
- Write changesets as one or two imperative sentences naming the consumer-visible change. Enforced by review.
- Keep committed documentation focused on maintained usage, APIs, setup, troubleshooting and migrations; keep one-off investigations and generated results in pull requests. Enforced by review.
