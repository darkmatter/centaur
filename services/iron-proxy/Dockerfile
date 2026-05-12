FROM ironsh/iron-proxy:0.24.0@sha256:43758113a2164556c5c902dbf83e02f4195319f2a6c32a3117144120782ad353

USER root
RUN apk add --no-cache curl jq

COPY services/iron-proxy/iron-proxy.yaml /usr/local/share/iron-proxy/proxy.yaml.default
COPY --chmod=755 services/iron-proxy/entrypoint.sh /entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
