# Reverse proxy for app-plane workloads: /console/apps/:name/* relays the
# request to api-rs' /apps/{name}/* route. The console session cookie is the
# human auth gate (require_login/require_active_account from
# ApplicationController); the upstream hop authenticates with the console's
# internal API credential instead, so inbound cookies and Authorization
# headers never leave this process. Only status, body, and content type are
# relayed back -- hop-by-hop headers are dropped by construction.
class Console::AppsController < ApplicationController
  # Injectable for tests, mirroring Console::EtlsController.
  class_attribute :client_factory, default: -> { CentaurApiClient.new }

  # Proxied apps serve their own pages and XHR; their non-GET requests carry
  # no Rails CSRF token. The session gates above still apply to every request.
  skip_forgery_protection

  # App names in the registry are plain DNS-ish tokens; anything else is a
  # routing mistake (or a traversal attempt), not a proxyable app.
  APP_NAME_PATTERN = /\A[a-z0-9][a-z0-9_-]*\z/i

  def proxy
    path = upstream_path
    return head :not_found unless params[:name].to_s.match?(APP_NAME_PATTERN) && path

    upstream = api_client.proxy_app(
      method: request.request_method,
      name: params[:name],
      path: path,
      query: request.query_string.presence,
      body: request.raw_post.presence,
      content_type: request.content_type
    )
    send_data upstream.body.to_s,
              type: upstream.content_type.presence || "application/octet-stream",
              disposition: "inline",
              status: upstream.status
  rescue CentaurApiClient::Error => e
    render json: { ok: false, error: e.message }, status: :bad_gateway
  end

  private

  # The remainder of the request path after /console/apps/<name>/, taken from
  # request.path rather than params[:path]: the router URL-decodes glob params,
  # and re-forwarding the decoded form would corrupt path segments that
  # legitimately carry encoded bytes (the transcript export path embeds a
  # percent-encoded thread key). Traversal segments yield nil (a 404) -- the
  # upstream route is a proxy, not a filesystem, and a legitimate app path
  # never contains them.
  def upstream_path
    raw = request.path.sub(%r{\A/console/apps/[^/]+/?}, "")
    return nil if raw.split("/").include?("..")

    raw
  end

  def api_client
    @api_client ||= self.class.client_factory.call
  end
end
