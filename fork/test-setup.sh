#!/bin/sh
# One-time setup of the test instance: a git worktree /opt/abstimmbar-test on
# branch `next` (starting from `custom`) and its own .env.test.
set -eu

main() {
  prod=/opt/abstimmbar
  test=/opt/abstimmbar-test
  if [ -e "$test" ]; then
    echo "$test already exists - nothing to do."
    exit 1
  fi
  sudo mkdir -p "$test"
  sudo chown "$(id -u):$(id -g)" "$test"
  git -C "$prod" worktree add -b next "$test" custom
  cp "$prod/Caddyfile.funnel" "$test/Caddyfile.funnel"
  # Same secrets as production, but served on https://<tailscale host>:8443.
  host=$(sudo sed -n 's#^PUBLIC_BASE_URL=https://##p' "$prod/.env")
  sudo cat "$prod/.env" \
    | sed -e "s#^PUBLIC_BASE_URL=.*#PUBLIC_BASE_URL=https://$host:8443#" \
          -e "s#^DJANGO_ALLOWED_HOSTS=.*#DJANGO_ALLOWED_HOSTS=$host,localhost,127.0.0.1#" \
          -e "s#^CSRF_TRUSTED_ORIGINS=.*#CSRF_TRUSTED_ORIGINS=https://$host:8443#" \
    > "$test/.env.test"
  chmod 600 "$test/.env.test"
  # Tailnet-only HTTPS for the test instance (not Funnel: not public).
  sudo tailscale serve --bg --https=8443 http://127.0.0.1:8090
  echo "Test worktree ready in $test (branch next). Start it with fork/test-up.sh."
}

main "$@"
