#!/usr/bin/env sh
set -e

# Fetch secrets from the secret manager if URL is provided
if [ -n "$SECRET_MANAGER_URL" ]; then
  for key in SLACK_BOT_TOKEN SLACK_SIGNING_SECRET AI_V2_API_KEY; do
    val=$(curl -sf --max-time 5 "${SECRET_MANAGER_URL}/secrets/${key}" | node -e "
      let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
        try{process.stdout.write(JSON.parse(d).value||'')}catch{}
      })" 2>/dev/null || true)
    if [ -n "$val" ]; then
      export "$key=$val"
    fi
  done
fi

exec node server.js
