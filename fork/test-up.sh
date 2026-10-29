#!/bin/sh
# (Re)build and start the test instance from /opt/abstimmbar-test (branch
# next). By default it first takes a fresh backup of the live instance and
# loads it, so new migrations are tried on real data. --keep-data skips that.
# The translation settings (DeepL key / LibreTranslate) are always copied
# from the live .env, so "Translate" works the same on the test site.
set -eu

# Copy the live instance's translation settings into .env.test (replacing
# older copies of those lines; the rest of .env.test stays as it is).
sync_translation() {
  keys='COMPOSE_PROFILES|QUIZBAR_DEEPL_KEY|QUIZBAR_LIBRETRANSLATE_URL|QUIZBAR_LIBRETRANSLATE_KEY'
  tmp=$(mktemp)
  sudo grep -Ev "^($keys)=" "$1" > "$tmp" || true
  sudo grep -E "^($keys)=" /opt/abstimmbar/.env >> "$tmp" || true
  sudo tee "$1" < "$tmp" > /dev/null
  rm -f "$tmp"
}

main() {
  test=/opt/abstimmbar-test
  here=$(cd "$(dirname "$0")" && pwd)
  dc() {
    sudo docker compose -p abstimmbar-test --env-file "$test/.env.test" \
      -f "$test/docker-compose.prod.yml" -f "$test/docker-compose.test.yml" "$@"
  }
  cd "$test"
  sync_translation "$test/.env.test"
  if [ "${1:-}" != "--keep-data" ]; then
    "$here/backup.sh"
    db=$(ls -1t "$HOME"/abstimmbar-backups/db-*.sql.gz | head -1)
    media=$(ls -1t "$HOME"/abstimmbar-backups/media-*.tar.gz | head -1)
    dc stop app 2>/dev/null || true
    dc up -d --wait db
    sudo docker exec abstimmbar_test_db psql -U abstimmbar -d postgres -q \
      -c "DROP DATABASE IF EXISTS abstimmbar WITH (FORCE)" \
      -c "CREATE DATABASE abstimmbar OWNER abstimmbar"
    gunzip -c "$db" | sudo docker exec -i abstimmbar_test_db psql -U abstimmbar -d abstimmbar -q > /dev/null
  fi
  dc up -d --build
  if [ "${1:-}" != "--keep-data" ]; then
    sudo docker exec -i abstimmbar_test_app tar xzf - -C /app/media < "$media"
  fi
  echo
  echo "Test instance running at $(sed -n 's#^PUBLIC_BASE_URL=##p' "$test/.env.test")/"
  echo "(only reachable from devices in your tailnet; log in under /admin/)."
}

main "$@"
