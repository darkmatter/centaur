# syntax=docker/dockerfile:1.7

FROM ironsh/iron-proxy:0.45.0@sha256:fffd1d72f9631fa3a0e54afea1b9ee8c125de94559134acabe97b6e12077865d

USER root
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked \
    apk add --update-cache --cache-dir /var/cache/apk curl jq

COPY iron-proxy.yaml /usr/local/share/iron-proxy/proxy.yaml.default
COPY --chmod=755 entrypoint.sh /entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
