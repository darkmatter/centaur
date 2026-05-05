FROM ironsh/iron-proxy:0.20.0@sha256:3fe7717d88ed85b93dd5f49a7559180753473ff91a239c0b6dc8b88160904c72

USER root
RUN apk add --no-cache curl jq

COPY services/iron-proxy/iron-proxy.yaml /usr/local/share/iron-proxy/proxy.yaml.default
COPY --chmod=755 services/iron-proxy/entrypoint.sh /entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
