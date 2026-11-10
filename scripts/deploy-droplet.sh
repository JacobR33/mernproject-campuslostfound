#!/usr/bin/env bash
set -euo pipefail

export PATH="/home/gianni/.nvm/versions/node/v22.23.4/bin:$PATH"
app=/home/gianni/mernproject-campuslostfound
stage=/home/gianni/.campus-deploy-staging
web=/var/www/campus-lost-found

test -d "$app/server/src"
test -f "$stage/client/dist/index.html"
test -w "$web"
command -v npm >/dev/null
command -v rsync >/dev/null
sudo -n -l /usr/bin/systemctl restart campus-lost-found-demo.service >/dev/null

# Install before modifying the running application. Keep runtime files on the server.
cd "$stage"
npm ci --omit=dev --workspace server --include-workspace-root

rsync -a --delete --exclude='.env*' --exclude='node_modules/' --exclude='uploads/' \
  "$stage/server/" "$app/server/"
cp "$stage/package.json" "$stage/package-lock.json" "$app/"
cp "$stage/client/package.json" "$app/client/package.json"
# npm may hoist dependencies to either the root or the server workspace.
rsync -a --delete "$stage/node_modules/" "$app/node_modules/"
if [ -d "$stage/server/node_modules" ]; then
  mkdir -p "$app/server/node_modules"
  rsync -a --delete "$stage/server/node_modules/" "$app/server/node_modules/"
elif [ -d "$app/server/node_modules" ]; then
  empty_dir=$(mktemp -d "$stage/empty-dependencies.XXXXXX")
  rsync -a --delete "$empty_dir/" "$app/server/node_modules/"
  rmdir "$empty_dir"
fi

sudo -n /usr/bin/systemctl restart campus-lost-found-demo.service
healthy=false
for attempt in {1..20}; do
  if curl --fail --silent --show-error --max-time 3 http://127.0.0.1:4000/api/health; then
    healthy=true
    break
  fi
  sleep 2
done
if [ "$healthy" != true ]; then
  echo 'Backend health check failed; frontend was not updated.' >&2
  exit 1
fi

# Copy new assets before index.html; retain old assets for open browser tabs.
rsync -a --exclude=index.html "$stage/client/dist/" "$web/"
install -m 644 "$stage/client/dist/index.html" "$web/.index.html.new"
mv "$web/.index.html.new" "$web/index.html"
echo 'Deployment complete.'
