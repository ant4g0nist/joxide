# joxide

Jump to projects by description, powered by zoxide and TypeSafe’s Jev.

Zoxide maintains the directory index; Jev ranks known directories when a name match is not enough.

```zsh
j auth backend
j cloudflare experiment
j yesterday
j the frontend I worked on yesterday
```

This is a small zsh integration, with no Oh My Zsh, plugin manager, fzf, or background daemon required. Existing `z` commands continue to work.

## Setup

Requires zsh, Node 22.18+ with native TypeScript support (or a current Node LTS), and zoxide. Development checks also use Python 3.9+.

```zsh
cd /path/to/joxide
npm ci --ignore-scripts
# If zoxide is missing: brew install zoxide
source ./joxide.plugin.zsh

# Seed the index with a projects folder and its immediate subdirectories.
jctl index ~/projects
jctl doctor
```

Set `TYPESAFE_API_KEY` in your shell for semantic queries. Exact paths, directory-name matching, and bare date queries work locally without a key. Semantic requests use the TypeSafe API and its account quota.

For future terminals, add this line to `~/.zshrc` after your other shell integrations:

```zsh
source /path/to/joxide/joxide.plugin.zsh
```

## Everyday use

| Command | Behavior |
| --- | --- |
| `j api` | Match known directory names locally |
| `j auth backend` | Fall back to semantic matching when names do not match |
| `j --semantic auth backend` | Force semantic ranking even if a name matches |
| `j yesterday` | Choose from directories visited yesterday |
| `j frontend yesterday` | Rank projects visited yesterday by description |
| `j --local api` | Use only local matching |
| `j --list auth backend` | Show matches without changing directories |
| `j --json auth backend` | Show scores, model, elapsed time, and token usage |
| `j --dry-run auth backend` | Inspect the semantic request without sending it |
| `j /path/with\ spaces` | Change directly to an existing directory |
| `j -` / `j` | Previous directory / home |
| `jctl add /path/to/project` | Add a single known directory |
| `jctl index ~/projects` | Add a root and up to 500 immediate visible subdirectories |
| `jctl describe "OAuth authentication backend"` | Set a description for the current directory |
| `jctl list` / `jctl doctor` | Inspect the index / configuration |

Normal `cd` calls also record visits while the integration is loaded. Indexing is shallow: it skips hidden directories, `node_modules`, and `vendor`. It does not recursively scan your home. Repeating `jctl index` adds zoxide visits and can affect its rankings.

Descriptions help when a project has an opaque name or little documentation:

```zsh
cd ~/projects/my-project
jctl describe "Cloudflare Workers chat experiment"
cd ~
j cloudflare chat experiment
```

A strong semantic match changes directories. Close or weaker matches show a numbered picker; Enter cancels. No match or an API error leaves the current directory alone. Ordinary shell input and Enter behavior are unchanged.

Date filters support `today`, `yesterday`, and `last week` (the previous seven complete days), using local calendar boundaries. Tracking starts when this integration is loaded. Existing zoxide entries have no imported per-visit timestamps, and indexing a project does not count as visiting it in the date log.

## How ranking works

1. Resolve existing paths and zoxide name matches locally.
2. Apply any visit-date filter in code.
3. Read bounded metadata for up to 500 indexed directories; shortlist up to 64 using keyword overlap and zoxide rank.
4. Send one batched Jev request with a typed `noul` relevance question per candidate.
5. Jump automatically when the top score is at least 0.80 and leads by at least 0.18. Otherwise offer up to five candidates scoring at least 0.35, or report no match.

These thresholds are initial policy choices, not calibrated accuracy guarantees. A project outside the index or shortlist cannot be selected. Jev returns scores; destinations come exclusively from existing local paths. No generated shell command is evaluated.

The design follows the retrieval, per-candidate scoring, and code-owned decision patterns in [awesome-jev-by-typesafe](https://github.com/Anil-matcha/awesome-jev-by-typesafe#6-semantic-search-and-re-ranking), using the [official TypeSafe API](https://docs.typesafe.ai/) and [zoxide](https://github.com/ajeetdsouza/zoxide).

## Data and configuration

Semantic requests send the query, current directory, candidate paths (home replaced with `~`), project names, descriptions, and technology labels. Descriptions come from your `jctl describe` note, then `package.json`, then a bounded README prose excerpt. Technology labels use filenames and dependency names. Source files, shell history, `.env` files, and package scripts are not included. Project metadata and directory names can still be private; `--dry-run` shows the request before any API call.

Visits and descriptions are appended to private local TSV files under `~/.local/share/joxide` (or `$XDG_DATA_HOME/joxide`). Readers use the last 2 MiB of each log; older visits or descriptions may fall outside that window. Logs are not automatically deleted or compacted. Zoxide keeps its own index.

| Variable | Default / purpose |
| --- | --- |
| `TYPESAFE_API_KEY` | Required only for semantic queries |
| `JOXIDE_MODEL` | `jev-latest` |
| `JOXIDE_NODE` | `node` executable |
| `JOXIDE_ZOXIDE` | `zoxide` executable |
| `JOXIDE_DATA_DIR` | Override the visit/description data directory |
| `_ZO_DATA_DIR` | Zoxide's own index location |
| `_ZO_EXCLUDE_DIRS` | Colon-separated zsh patterns excluded from automatic visit tracking; home is excluded by default |

Set configuration before sourcing. Export variables used by the CLI, such as `JOXIDE_MODEL` and `_ZO_DATA_DIR`. Excluding a directory from tracking does not remove an existing index entry or visit record. If zoxide already has its standard shell hook, this integration avoids adding a second zoxide visit.

## Dependencies and checks

The only direct npm runtime dependency is the pinned official `@typesafe-ai/sdk`. TypeScript and Node types are development dependencies. Installation scripts are disabled in `.npmrc`. Zoxide is a separate native executable.

```zsh
npm run check  # Type checking, unit tests, actual zsh/zoxide/Node integration
npm run vet    # /opt/homebrew/bin/vet; npm lockfile and installed zoxide package
```

The integration tests use isolated indexes and a deterministic mock API response through the real SDK. They verify navigation and failure handling, but do not establish live Jev ranking accuracy. Vet reports go into `reports/`; missing provenance or malware coverage is not evidence of safety.
