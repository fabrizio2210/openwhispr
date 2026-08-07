#!/usr/bin/env bash

set -euo pipefail

readonly REQUIRED_BRANCH="personal/kde-meeting-detection"
readonly UPSTREAM_REMOTE="origin"
readonly FORK_REMOTE="fork"
readonly UPSTREAM_BRANCH="main"
readonly SAFETY_BRANCH_PREFIX="safety/kde-meeting-detection"
readonly UPSTREAM_REPOSITORY="OpenWhispr/openwhispr"
readonly FORK_REPOSITORY="fabrizio2210/openwhispr"

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

normalize_github_repository() {
  local url="${1%.git}"
  local repository

  case "$url" in
    https://github.com/*)
      repository="${url#https://github.com/}"
      ;;
    git@github.com:*)
      repository="${url#git@github.com:}"
      ;;
    ssh://git@github.com/*)
      repository="${url#ssh://git@github.com/}"
      ;;
    *)
      return 1
      ;;
  esac

  printf '%s\n' "${repository,,}"
}

validate_remote_urls() {
  local remote="$1"
  local expected_repository="${2,,}"
  local direction url actual_repository
  local -a urls

  for direction in fetch push; do
    if [[ "$direction" == "fetch" ]]; then
      mapfile -t urls < <(git -C "$REPO_ROOT" remote get-url --all "$remote")
    else
      mapfile -t urls < <(git -C "$REPO_ROOT" remote get-url --push --all "$remote")
    fi

    ((${#urls[@]} > 0)) || fail "Remote '$remote' has no effective $direction URL."
    for url in "${urls[@]}"; do
      actual_repository="$(normalize_github_repository "$url")" ||
        fail "Remote '$remote' has an unsupported $direction URL: $url"
      [[ "$actual_repository" == "$expected_repository" ]] ||
        fail "Remote '$remote' $direction URL targets $actual_repository, expected $expected_repository."
    done
  done
}

command -v git >/dev/null 2>&1 || fail "git is required but was not found in PATH."
command -v codex >/dev/null 2>&1 || fail "Codex CLI is required but was not found in PATH."

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

[[ "$(git -C "$REPO_ROOT" rev-parse --is-inside-work-tree 2>/dev/null)" == "true" ]] ||
  fail "$REPO_ROOT is not a Git worktree."

GIT_TOP_LEVEL="$(git -C "$REPO_ROOT" rev-parse --show-toplevel)"
[[ "$GIT_TOP_LEVEL" == "$REPO_ROOT" ]] ||
  fail "Expected the repository root at $REPO_ROOT, but Git reported $GIT_TOP_LEVEL."

GIT_DIR="$(git -C "$REPO_ROOT" rev-parse --absolute-git-dir)"
for marker in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_START; do
  [[ ! -e "$GIT_DIR/$marker" ]] ||
    fail "A Git operation is already active ($marker). Finish or abort it before syncing."
done

CURRENT_BRANCH="$(git -C "$REPO_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null)" ||
  fail "The checkout has a detached HEAD; switch to $REQUIRED_BRANCH first."
[[ "$CURRENT_BRANCH" == "$REQUIRED_BRANCH" ]] ||
  fail "Expected branch $REQUIRED_BRANCH, but the current branch is $CURRENT_BRANCH."

[[ -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)" ]] ||
  fail "The worktree is not clean. Commit, stash, or remove local changes before syncing."

git -C "$REPO_ROOT" remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1 ||
  fail "Required upstream remote '$UPSTREAM_REMOTE' is missing."
git -C "$REPO_ROOT" remote get-url "$FORK_REMOTE" >/dev/null 2>&1 ||
  fail "Required fork remote '$FORK_REMOTE' is missing."
validate_remote_urls "$UPSTREAM_REMOTE" "$UPSTREAM_REPOSITORY"
validate_remote_urls "$FORK_REMOTE" "$FORK_REPOSITORY"

PROMPT="$(cat <<'EOF'
Integrate the latest official OpenWhispr upstream into my private KDE meeting-detection branch. Execute the work autonomously; do not stop after proposing a plan. Follow all applicable AGENTS.md instructions, including mandatory independent post-change review.

Repository contract:
- Work only in this repository and remain on `__REQUIRED_BRANCH__`.
- `__UPSTREAM_REMOTE__` must be the official `__UPSTREAM_REPOSITORY__` repository.
- `__FORK_REMOTE__` must be my `__FORK_REPOSITORY__` fork.
- Preserve the private KDE/Zoom meeting detection and Outlook notification-title behavior while incorporating upstream behavior. Resolve conflicts semantically; never resolve them wholesale by choosing "ours" or "theirs".

Perform this workflow:
1. Inspect the current branch, remotes, applicable instructions, build definitions, and working tree. Refuse to continue if the remotes do not match the repository contract or if a Git operation/dirty tree appeared after the launcher checks.
2. Fetch both `__UPSTREAM_REMOTE__` and `__FORK_REMOTE__` using networked Git outside the sandbox when required. Read the authoritative fork tip for `__REQUIRED_BRANCH__` and record its full hash for a later explicit force-with-lease. If it differs from local HEAD, stop without changing history and explain the divergence.
3. If the current branch already contains the latest `__UPSTREAM_REMOTE__/__UPSTREAM_BRANCH__`, report that there is nothing to integrate and finish without creating a safety branch, running the full suite, rebuilding artifacts, or pushing.
4. Before a real rebase, create a unique branch named `__SAFETY_BRANCH_PREFIX__-YYYY-MM-DD-HHMMSS` at the current HEAD, push it to `__FORK_REMOTE__`, verify its remote hash, and then return to `__REQUIRED_BRANCH__`.
5. Rebase the private commits onto the fetched `__UPSTREAM_REMOTE__/__UPSTREAM_BRANCH__`. Preserve upstream architecture and behavior along with the private feature. Inspect both sides and their tests when resolving every conflict. Keep rerere enabled. Preserve coherent feature and documentation commits; fold integration corrections into the appropriate private commit with fixup/autosquash instead of leaving maintenance debris.
6. Inspect the complete final diff against `__UPSTREAM_REMOTE__/__UPSTREAM_BRANCH__`. Verify that no upstream changes were accidentally reverted and that meeting detection, notification preference synchronization, KDE Outlook title selection, cross-platform audio detection, and native-helper packaging contracts remain correct.
7. Determine the current repository-defined complete verification commands from package.json and project documentation. Run the full test suite, typecheck, lint, renderer build, Linux native prebuild, and Linux packaging. Rebuild Electron native dependencies for the packaged Electron version when necessary, smoke-test the packaged better-sqlite3 module, and restore the workspace module for the configured Node version afterward. Rebuild both the unpacked Linux executable and AppImage. Do not claim a check passed unless it actually ran.
8. After deterministic checks pass, spawn the required read-only `maintainability_reviewer` with the original maintenance objective, exact upstream base revision, and complete final diff. Address every actionable finding, rerun affected and full checks as appropriate, then obtain one clean confirmation review before committing, pushing, or finishing.
9. If conflicts remain, any required check fails, packaging fails, or review is not clean, do not update the personal branch on `__FORK_REMOTE__`. Preserve the pushed safety branch and report the exact blocker and repository state.
10. When everything is clean, show me the safety branch, old authoritative fork hash, upstream base, final private commits, verification results, artifact paths/hashes, and the exact proposed lease-protected push. Then stop and explicitly ask for my approval before running the final push.
11. Only after I approve in this interactive session, push with an explicit `--force-with-lease=refs/heads/__REQUIRED_BRANCH__:<recorded-old-hash>` to `__FORK_REMOTE__`. Verify the authoritative remote hash afterward and report the completed result.

Do not update local `__UPSTREAM_BRANCH__`, delete safety branches, open a pull request, or publish releases.
EOF
)"
PROMPT="${PROMPT//__REQUIRED_BRANCH__/$REQUIRED_BRANCH}"
PROMPT="${PROMPT//__UPSTREAM_REMOTE__/$UPSTREAM_REMOTE}"
PROMPT="${PROMPT//__FORK_REMOTE__/$FORK_REMOTE}"
PROMPT="${PROMPT//__UPSTREAM_BRANCH__/$UPSTREAM_BRANCH}"
PROMPT="${PROMPT//__SAFETY_BRANCH_PREFIX__/$SAFETY_BRANCH_PREFIX}"
PROMPT="${PROMPT//__UPSTREAM_REPOSITORY__/$UPSTREAM_REPOSITORY}"
PROMPT="${PROMPT//__FORK_REPOSITORY__/$FORK_REPOSITORY}"

printf 'Starting Codex upstream-sync session in %s\n' "$REPO_ROOT"
exec codex \
  --cd "$REPO_ROOT" \
  --sandbox workspace-write \
  --ask-for-approval on-request \
  --no-alt-screen \
  "$PROMPT"
