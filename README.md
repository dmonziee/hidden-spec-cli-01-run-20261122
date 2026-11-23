# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dmonziee/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dmonziee/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit an AI model wrote to a tree of text files. Models write edits in four
shapes — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch
format, and text-editor tool calls as JSON — and mend reads whichever one it is given, finds
the lines each edit names even when the whitespace has drifted, and writes every change or
none at all.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

The working directory is the root of the tree. `PATCH` is the path of the patch file, relative
to the working directory; when it is absent or `-`, the patch is read from standard input.
`--format` picks one of `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default,
which detects the format). `--check` does everything but write. `--strict` matches lines
exactly, with no whitespace forgiveness.

On success mend prints one line per changed file (`A` added, `D` deleted, `M` modified,
`R old -> new` moved) and a final `ok: N files` line. On failure it prints one
`error: <code> <path>` line per failed edit and a `failed: k of n edits` line, and writes
nothing. Exit codes: 0 applied, 1 some edit failed, 2 usage, unreadable patch, unknown
format, or unparsable patch.

## Matching

An edit's old lines are looked up at the first of three tiers where they occur: exact,
then ignoring trailing spaces and tabs, then ignoring leading and trailing spaces and tabs.
A unified hunk takes the occurrence nearest its stated line number; a SEARCH/REPLACE block
needs exactly one occurrence; a V4A chunk takes the first at or after its cursor, after its
anchor. Context lines are always written back as the file's own lines, and at the loosest
tier the new lines are re-indented to the file's indentation.

Node 22, standard library only. `runner.ts` is the kit's trial runner, kept as shipped.
