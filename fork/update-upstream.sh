#!/bin/sh
# Bring virtUOS/abstimmbar's latest main into the test branch `next`
# (a merge, so this fork's own commits stay as they are). Then test with
# fork/test-up.sh and go live with fork/deploy.sh.
set -eu

main() {
  test=/opt/abstimmbar-test
  cd "$test"
  git fetch upstream
  if ! git merge --no-edit upstream/main; then
    git merge --abort
    echo "The upstream changes conflict with this fork's changes - nothing was changed."
    echo "Ask for help with the conflicting files listed above."
    exit 1
  fi
  echo "Merged upstream into next. Now run fork/test-up.sh and try it."
}

main "$@"
