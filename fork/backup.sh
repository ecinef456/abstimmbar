#!/bin/sh
# Back up the live instance: database + uploaded images, into
# ~/abstimmbar-backups (the newest 30 of each are kept).
set -eu

main() {
  dir="$HOME/abstimmbar-backups"
  mkdir -p "$dir"
  stamp=$(date +%Y-%m-%d_%H%M%S)
  sudo docker exec abstimmbar_db pg_dump -U abstimmbar --clean --if-exists abstimmbar \
    | gzip > "$dir/db-$stamp.sql.gz"
  sudo docker exec abstimmbar_app tar czf - -C /app/media . > "$dir/media-$stamp.tar.gz"
  for kind in db media; do
    ls -1t "$dir"/$kind-*.gz | tail -n +31 | xargs -r rm --
  done
  echo "Backup written: $dir/db-$stamp.sql.gz and media-$stamp.tar.gz"
}

main "$@"
