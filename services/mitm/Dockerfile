FROM mitmproxy/mitmproxy:11

USER root
RUN apk add --no-cache curl jq bash
USER mitmproxy

COPY addon.py /app/addon.py
COPY --chmod=755 entrypoint.sh /entrypoint.sh

EXPOSE 8080 8081

ENTRYPOINT ["/entrypoint.sh"]
