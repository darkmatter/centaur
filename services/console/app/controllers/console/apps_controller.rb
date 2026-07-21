# Reverse proxy for app-plane workloads: /console/apps/:name/* relays the
# request to api-rs' /apps/{name}/* route. The console session cookie is the
# human auth gate; transcript exports additionally use the Threads surface's
# owner/public/admin visibility contract. The upstream hop authenticates with
# the console's internal API credential, so inbound cookies and Authorization
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
    return head :not_found unless params[:name].to_s.match?(APP_NAME_PATTERN)
    return head :not_found unless app_path_authorized?(params[:name], params[:path].to_s)

    upstream = api_client.proxy_app(
      method: request.request_method,
      name: params[:name],
      path: path,
      query: request.query_string.presence,
      body: request.raw_post.presence,
      content_type: request.content_type
    )
    response.headers["Content-Security-Policy"] = "sandbox allow-scripts" if transcript_export?(params[:name], params[:path].to_s)
    send_data upstream.body.to_s,
              type: upstream.content_type.presence || "application/octet-stream",
              disposition: "inline",
              status: upstream.status
  rescue CentaurApiClient::Error => e
    render json: { ok: false, error: e.message }, status: :bad_gateway
  end

  private

  def app_path_authorized?(name, decoded_path)
    return false if decoded_path.include?("\\")
    return false if decoded_path.split("/").any? { |segment| segment == "." || segment == ".." }

    return true unless name == "omp-stats"
    return acting_admin? unless transcript_export?(name, decoded_path)

    match = decoded_path.match(%r{\Aexport/([^/]+)/?\z})
    match && console_thread_readable?(match[1])
  end

  def transcript_export?(name, decoded_path)
    name == "omp-stats" && (decoded_path == "export" || decoded_path.start_with?("export/"))
  end

  # Preserve the raw path when forwarding so percent-encoded thread keys keep
  # their exact byte representation. Authorization and traversal checks use the
  # router-decoded params[:path] separately; using this raw value for either
  # would let encoded path syntax bypass those checks.
  def upstream_path
    request.path.sub(%r{\A/console/apps/[^/]+/?}, "")
  end

  def api_client
    @api_client ||= self.class.client_factory.call
  end
end
