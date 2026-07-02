#!/bin/bash
# Local deploy script — always includes the current model so it doesn't get wiped.
# Use `npm run deploy` instead of running `firebase deploy` directly.
set -e

npm run build
mkdir -p dist/models

# Validate that a downloaded file is a real OFCW model binary, not an HTML redirect.
is_valid_model() {
  local path="$1"
  [ -f "$path" ] && [ "$(head -c 4 "$path")" = "OFCW" ]
}

# 1. Try to fetch the real model from the live site.
TMPMODEL=$(mktemp)
if curl -sf https://hiinakas-355.web.app/models/policy.bin -o "$TMPMODEL" && is_valid_model "$TMPMODEL"; then
  cp "$TMPMODEL" dist/models/policy.bin
  SIZE=$(wc -c < dist/models/policy.bin)
  echo "Model fetched from live site ($(( SIZE / 1024 )) KB)"

# 2. Fall back to a locally trained model.
elif is_valid_model models/policy.bin; then
  cp models/policy.bin dist/models/policy.bin
  SIZE=$(wc -c < dist/models/policy.bin)
  echo "Model copied from local models/ ($(( SIZE / 1024 )) KB)"

else
  echo "Warning: no valid model found — deploying without model. CI will restore it on the next run."
fi

rm -f "$TMPMODEL"
firebase deploy --only hosting
