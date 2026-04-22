#!/bin/sh
set -eu

CONF_PATH="/etc/nginx/conf.d/default.conf"
ENABLED_SERVICES_RAW="${CENTAUR_NGINX_ENABLED_SERVICES:-slackbot}"
ENABLED_SERVICES=",$(printf '%s' "$ENABLED_SERVICES_RAW" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]'),"

is_enabled() {
  case "$ENABLED_SERVICES" in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

append_proxy_location() {
  modifier="$1"
  path="$2"
  upstream="$3"

  {
    if [ -n "$modifier" ]; then
      printf '    location %s %s {\n' "$modifier" "$path"
    else
      printf '    location %s {\n' "$path"
    fi
    printf '        proxy_pass %s;\n' "$upstream"
    cat <<'EOF'
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 300s;
EOF
    printf '    }\n\n'
  } >> "$CONF_PATH"
}

cat > "$CONF_PATH" <<EOF
map \$http_upgrade \$connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 80;
    server_name ${CENTAUR_NGINX_SERVER_NAME:-_};

    location = /healthz {
        access_log off;
        default_type text/plain;
        return 200 'ok';
    }

EOF

if is_enabled slackbot; then
  append_proxy_location "=" "/api/webhooks/slack" "${CENTAUR_NGINX_SLACKBOT_UPSTREAM:-http://slackbot:3001}"
  append_proxy_location "^~" "/api/slack/" "${CENTAUR_NGINX_SLACKBOT_UPSTREAM:-http://slackbot:3001}"
  append_proxy_location "^~" "/_next/" "${CENTAUR_NGINX_SLACKBOT_UPSTREAM:-http://slackbot:3001}"
fi

if is_enabled api; then
  # Proxy /agent/, /tools/, /workflows/ directly to the API (no prefix rewrite needed)
  append_proxy_location "^~" "/agent/" "${CENTAUR_NGINX_API_UPSTREAM:-http://api:8000}"
  append_proxy_location "^~" "/tools/" "${CENTAUR_NGINX_API_UPSTREAM:-http://api:8000}"
  append_proxy_location "^~" "/workflows/" "${CENTAUR_NGINX_API_UPSTREAM:-http://api:8000}"
  append_proxy_location "=" "/health" "${CENTAUR_NGINX_API_UPSTREAM:-http://api:8000}"
fi

if is_enabled apps; then
  append_proxy_location "^~" "/apps/" "${CENTAUR_NGINX_API_UPSTREAM:-http://api:8000}"
fi

if is_enabled admin; then
  append_proxy_location "^~" "/admin/" "${CENTAUR_NGINX_ADMIN_UPSTREAM:-http://api:8000}"
fi

if is_enabled grafana; then
  append_proxy_location "^~" "/grafana/" "${CENTAUR_NGINX_GRAFANA_UPSTREAM:-http://grafana:3000}"
fi

if is_enabled auth; then
  append_proxy_location "^~" "/auth/" "${CENTAUR_NGINX_AUTH_UPSTREAM:-http://auth:3000}"
fi

if is_enabled web; then
  append_proxy_location "^~" "/web/" "${CENTAUR_NGINX_WEB_UPSTREAM:-http://web:3000}"
fi

if is_enabled next; then
  append_proxy_location "^~" "/next/" "${CENTAUR_NGINX_NEXT_UPSTREAM:-http://next:3000}"
fi

if is_enabled slackbot; then
  append_proxy_location "" "/" "${CENTAUR_NGINX_SLACKBOT_UPSTREAM:-http://slackbot:3001}"
else
  cat >> "$CONF_PATH" <<'EOF'
    location / {
        default_type text/plain;
        return 404 'No public Centaur service is enabled for this route.';
    }
EOF
fi

printf '}\n' >> "$CONF_PATH"

# ── Wildcard subdomain server block for Centaur Apps ─────────────────────────
# Routes {app-name}.{base-domain} → API /app-proxy/{app-name}/{path}
# Only enabled when the "apps" service is active AND a base domain is set.
APPS_DOMAIN="${CENTAUR_NGINX_APPS_DOMAIN:-}"
if is_enabled apps && [ -n "$APPS_DOMAIN" ]; then
  ESCAPED_DOMAIN=$(printf '%s' "$APPS_DOMAIN" | sed 's/\./\\./g')
  API_UPSTREAM="${CENTAUR_NGINX_API_UPSTREAM:-http://api:8000}"
  cat >> "$CONF_PATH" <<EOF

server {
    listen 80;
    server_name ~^(?<appname>[a-z0-9][a-z0-9-]*)\.${ESCAPED_DOMAIN}\$;

    location / {
        rewrite ^(.*)\$ /app-proxy/\$appname\$1 break;
        proxy_pass ${API_UPSTREAM};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 300s;
    }
}
EOF
fi

nginx -t
exec nginx -g 'daemon off;'
