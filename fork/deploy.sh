#!/bin/sh
# Put what was tested on the test instance (branch next) live: back up,
# fast-forward `custom` to `next`, rebuild production, push to GitHub.
set -eu

main() {
  prod=/opt/abstimmbar
  here=$(cd "$(dirname "$0")" && pwd)
  "$here/backup.sh"
  cd "$prod"
  if ! git merge --ff-only next; then
    echo "custom has commits that next lacks - merge them into next first."
    exit 1
  fi
  sudo docker compose -f docker-compose.prod.yml -f docker-compose.funnel.yml up -d --build
  git push origin custom
  echo "Deployed $(git rev-parse --short HEAD)."
}

main "$@"
