FROM ironsh/iron-proxy:0.27.0@sha256:02467ab5762bbedf51779ddc2b68925cea258f5f81aac4edc45eec0f47715f65

USER root
RUN apk add --no-cache curl jq

COPY services/iron-proxy/iron-proxy.yaml /usr/local/share/iron-proxy/proxy.yaml.default
COPY --chmod=755 services/iron-proxy/entrypoint.sh /entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
