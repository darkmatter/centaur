#!/usr/bin/env sh
set -e

# Fetch secrets from the secret manager if URL is provided
if [ -n "$SECRET_MANAGER_URL" ]; then
  MAX_RETRIES=30
  RETRY=0
  while [ $RETRY -lt $MAX_RETRIES ]; do
    ALL_OK=true
    for key in WEB_API_KEY DATABASE_URL; do
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
  # Web code expects AI_V2_API_KEY — use scoped service key
  if [ -n "$WEB_API_KEY" ] && [ -z "$AI_V2_API_KEY" ]; then
    export AI_V2_API_KEY="$WEB_API_KEY"
  fi
fi

exec node server.js
