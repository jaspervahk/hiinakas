#!/bin/bash
# Local deploy script — always includes the current model so it doesn't get wiped.
# Use `npm run deploy` instead of running `firebase deploy` directly.
#
# Every firebase command below pins --project explicitly. `firebase deploy` on
# its own uses whatever the CLI's active alias happens to be (`firebase use`),
# which silently overrides .firebaserc — so a machine that was last pointed at
# another project will deploy this app on top of that one. That has happened.
set -e

PROJECT=hiinakas-355

npm run build
mkdir -p dist/models

# Validate that a downloaded file is a real OFCW model binary, not an HTML redirect.
is_valid_model() {
  local path="$1"
  [ -f "$path" ] && [ "$(head -c 4 "$path")" = "OFCW" ]
}

# 1. Try to fetch the real model from the live site.
TMPMODEL=$(mktemp)
if curl -sf "https://${PROJECT}.web.app/models/policy.bin" -o "$TMPMODEL" && is_valid_model "$TMPMODEL"; then
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

# Preserve royalty model in the same way.
TMPROYALTY=$(mktemp)
if curl -sf "https://${PROJECT}.web.app/models/royalty_nn.bin" -o "$TMPROYALTY" && is_valid_model "$TMPROYALTY"; then
  cp "$TMPROYALTY" dist/models/royalty_nn.bin
  RSIZE=$(wc -c < dist/models/royalty_nn.bin)
  echo "Royalty model fetched from live site ($(( RSIZE / 1024 )) KB)"
elif is_valid_model models/royalty_nn.bin; then
  cp models/royalty_nn.bin dist/models/royalty_nn.bin
  RSIZE=$(wc -c < dist/models/royalty_nn.bin)
  echo "Royalty model copied from local models/ ($(( RSIZE / 1024 )) KB)"
else
  echo "No royalty model yet — deploying without it."
fi

rm -f "$TMPMODEL" "$TMPROYALTY"

# Refuse to deploy without the models rather than silently shipping a build
# that 404s them: the training workflows bootstrap from the live copy, so a
# modelless deploy also resets the next training run to scratch.
for m in policy royalty_nn; do
  if ! is_valid_model "dist/models/$m.bin"; then
    echo "ERROR: dist/models/$m.bin missing or invalid — refusing to deploy." >&2
    echo "       Deploying without it would 404 the model and reset CI training." >&2
    exit 1
  fi
done

firebase deploy --only hosting --project "$PROJECT"
