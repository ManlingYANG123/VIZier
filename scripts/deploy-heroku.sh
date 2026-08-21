#!/usr/bin/env bash
set -euo pipefail
unset GIT_INDEX_FILE

APP_NAME="${HEROKU_APP:-vizier}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(git -C "$APP_DIR" rev-parse --show-toplevel)"
APP_REL="${APP_DIR#"$REPO_ROOT"/}"
HEROKU_GIT_URL="https://git.heroku.com/${APP_NAME}.git"

# Only these runtime files are packaged. Secrets, tests, docs, backups, and the
# rest of the monorepo never enter the deployment commit.
RUNTIME_PATHS=(
  "index.html"
  "package.json"
  "package-lock.json"
  "vite.config.js"
  "public"
  "re_api/src"
  "src/api-client.js"
  "src/app.js"
  "src/category-color-system.js"
  "src/context-box.js"
  "src/context-workflow.js"
  "src/critique-merge.js"
  "src/intake-client.js"
  "src/interaction-journal.js"
  "src/panel-resize.js"
  "src/recommendation-engine.js"
  "src/revision-preview.js"
  "src/styles.css"
  "src/vega-dashboard-adapter.js"
)

fail() {
  printf 'deploy-heroku: %s\n' "$*" >&2
  exit 1
}

for command_name in git npm heroku; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command not found: $command_name"
done

SCOPED_PATHS=()
for path in "${RUNTIME_PATHS[@]}"; do
  SCOPED_PATHS+=("${APP_REL}/${path}")
done

DIRTY="$(git -C "$REPO_ROOT" status --porcelain -- "${SCOPED_PATHS[@]}")"
if [[ -n "$DIRTY" ]]; then
  printf '%s\n' "$DIRTY" >&2
  fail "runtime files have uncommitted changes; commit them to GitHub first"
fi

UPSTREAM="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" \
  || fail "current branch has no upstream; push it to GitHub first"
read -r BEHIND AHEAD < <(
  git -C "$REPO_ROOT" rev-list --left-right --count "${UPSTREAM}...HEAD"
)
if [[ "$BEHIND" != "0" || "$AHEAD" != "0" ]]; then
  fail "HEAD differs from ${UPSTREAM}; pull or push GitHub before deploying"
fi

printf 'Running frontend tests...\n'
npm --prefix "$APP_DIR" test
printf 'Running backend tests...\n'
npm --prefix "$APP_DIR/re_api" test
printf 'Building production frontend...\n'
npm --prefix "$APP_DIR" run build

heroku auth:whoami >/dev/null
heroku apps:info --app "$APP_NAME" >/dev/null

PARENT_ARGS=()
if git -C "$REPO_ROOT" fetch --quiet "$HEROKU_GIT_URL" main; then
  PARENT_ARGS=(-p "$(git -C "$REPO_ROOT" rev-parse FETCH_HEAD)")
fi

DEPLOY_INDEX="$(mktemp "${TMPDIR:-/tmp}/vizier-heroku-index.XXXXXX")"
rm -f "$DEPLOY_INDEX"
cleanup() {
  rm -f "$DEPLOY_INDEX"
}
trap cleanup EXIT
export GIT_INDEX_FILE="$DEPLOY_INDEX"

GIT_DIR="$REPO_ROOT/.git"
git --git-dir="$GIT_DIR" read-tree --empty
git --git-dir="$GIT_DIR" --work-tree="$APP_DIR" add -- "${RUNTIME_PATHS[@]}"
TREE="$(git --git-dir="$GIT_DIR" write-tree)"
SOURCE_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
DEPLOY_MESSAGE="$(cat <<EOF
Deploy VIZier from GitHub source ${SOURCE_SHA}.
EOF
)"
DEPLOY_COMMIT="$(
  GIT_AUTHOR_NAME="VIZier Deployment" \
  GIT_AUTHOR_EMAIL="yangmanlingdd@gmail.com" \
  GIT_COMMITTER_NAME="VIZier Deployment" \
  GIT_COMMITTER_EMAIL="yangmanlingdd@gmail.com" \
  git --git-dir="$GIT_DIR" commit-tree "$TREE" "${PARENT_ARGS[@]}" -m "$DEPLOY_MESSAGE"
)"

printf 'Deploying source %s to Heroku app %s...\n' "${SOURCE_SHA:0:12}" "$APP_NAME"
git -C "$REPO_ROOT" push "$HEROKU_GIT_URL" \
  "${DEPLOY_COMMIT}:refs/heads/main"
heroku ps --app "$APP_NAME"
printf 'Deployment complete: https://%s.herokuapp.com/\n' "$APP_NAME"
