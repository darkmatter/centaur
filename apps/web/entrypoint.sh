#!/usr/bin/env sh
set -e

# Fetch secrets from the secret manager if URL is provided
if [ -n "$SECRET_MANAGER_URL" ]; then
  MAX_RETRIES=30
  RETRY=0
  while [ $RETRY -lt $MAX_RETRIES ]; do
    ALL_OK=true
    for key in SLACK_BOT_TOKEN SLACK_SIGNING_SECRET API_SECRET_KEY; do
      # Skip if already set
      eval current=\$$key
      if [ -n "$current" ]; then continue; fi

      val=$(curl -sf --max-time 5 "${SECRET_MANAGER_URL}/secrets/${key}" | node -e "
        let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
          try{process.stdout.write(JSON.parse(d).value||'')}catch{}
        })" 2>/dev/null || true)
      if [ -n "$val" ]; then
        export "$key=$val"
      else
        ALL_OK=false
      fi
    done
    if [ "$ALL_OK" = true ]; then break; fi
    RETRY=$((RETRY + 1))
    echo "Waiting for secrets... (attempt $RETRY/$MAX_RETRIES)"
    sleep 2
  done
  # Slackbot code expects AI_V2_API_KEY
  if [ -n "$API_SECRET_KEY" ] && [ -z "$AI_V2_API_KEY" ]; then
    export AI_V2_API_KEY="$API_SECRET_KEY"
  fi

  MISSING_KEYS=""
  for required in SLACK_BOT_TOKEN SLACK_SIGNING_SECRET API_SECRET_KEY; do
    eval current=\$$required
    if [ -z "$current" ]; then
      MISSING_KEYS="${MISSING_KEYS} ${required}"
    fi
  done
  if [ -n "$MISSING_KEYS" ]; then
    echo "Missing required secrets after bootstrap retries:${MISSING_KEYS}" >&2
    exit 1
  fi
fi

exec node server.js
