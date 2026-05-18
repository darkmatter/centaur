FROM ironsh/iron-proxy:0.32.0@sha256:d55ae000173e52abcea40d26d7906c41bfc4ed42da3cac86541651bf1c976b8e

USER root
RUN apk add --no-cache curl jq

COPY services/iron-proxy/iron-proxy.yaml /usr/local/share/iron-proxy/proxy.yaml.default
COPY --chmod=755 services/iron-proxy/entrypoint.sh /entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
