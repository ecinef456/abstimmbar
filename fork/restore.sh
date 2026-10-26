#!/bin/sh
# Restore the LIVE instance's database (and images) from a backup made by
# backup.sh. Usage: fork/restore.sh ~/abstimmbar-backups/db-<stamp>.sql.gz
# The matching media-<stamp>.tar.gz is restored too if it exists.
set -eu

main() {
  db=${1:?usage: fork/restore.sh <db-backup.sql.gz>}
  media=$(echo "$db" | sed 's#/db-\(.*\)\.sql\.gz$#/media-\1.tar.gz#')
  prod=/opt/abstimmbar
  printf "Replace the LIVE database with %s? Type yes: " "$db"
  read -r answer
  [ "$answer" = "yes" ] || { echo "Cancelled."; exit 1; }
  cd "$prod"
  dc() { sudo docker compose -f docker-compose.prod.yml -f docker-compose.funnel.yml "$@"; }
  dc stop app
  sudo docker exec abstimmbar_db psql -U abstimmbar -d postgres -q \
    -c "DROP DATABASE IF EXISTS abstimmbar WITH (FORCE)" \
    -c "CREATE DATABASE abstimmbar OWNER abstimmbar"
  gunzip -c "$db" | sudo docker exec -i abstimmbar_db psql -U abstimmbar -d abstimmbar -q > /dev/null
  dc up -d app
  if [ -f "$media" ]; then
    sudo docker exec -i abstimmbar_app tar xzf - -C /app/media < "$media"
  fi
  echo "Restored. If you also rolled back the code, rebuild: dc up -d --build"
}

main "$@"
