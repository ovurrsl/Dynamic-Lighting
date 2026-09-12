# Provenance

`SKILL.md` is copied **verbatim** from the Next.js repository, so it is
first-party content and not edited here:

    https://raw.githubusercontent.com/vercel/next.js/v16.3.5/skills/next-dev-loop/SKILL.md

Pinned at tag **v16.3.5**, the exact Next.js version in this project's
`package.json`. Re-fetch from the matching tag when Next is upgraded — the skill
documents version-gated behaviour (`/_next/mcp`, `get_compilation_issues`,
Turbopack) and a mismatched copy would describe tools the running server does not
expose.

## Why fetched instead of installed

Next.js documents installing this with `npx skills add vercel/next.js --skill
next-dev-loop`. That works, but the `skills` npm CLI is published under personal
accounts (`rauchg`, `quuu`) rather than an `@vercel` scope, and it writes into the
repository. Fetching the file straight from the tagged Next.js release gets the
same content from an unambiguously first-party, version-pinned source with
nothing to audit.

Separately: the `next-devtools-mcp` README suggests `npx add-mcp`. Do **not** use
it — `add-mcp` is published by an individual (`andrelandgraf`), unrelated to
Vercel. The `.mcp.json` entry in this repo is written by hand instead.

## Prerequisites this skill assumes

It is guidance, not an installer, and is inert until used. Using it needs:

- a running `next dev` (it reads `/_next/mcp`, a localhost dev-only endpoint)
- Next.js 16.3+ **with Turbopack** — both true here
- `agent-browser` installed globally (`npm i -g agent-browser@latest`), which is
  not currently installed

Without a dev server its runtime tools return nothing useful. That is a property
of the tool, not a misconfiguration.
