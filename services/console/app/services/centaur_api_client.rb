require "cgi"
require "json"
require "net/http"
require "uri"

class CentaurApiClient
  Response = Struct.new(:status, :body, keyword_init: true)
  Error = Class.new(StandardError)

  DEFAULT_TIMEOUT_SECONDS = 20

  # App-plane proxy timeouts: connecting to api-rs should be near-instant, but
  # apps may render on demand (transcript export shells out), so reads get a
  # generous ceiling independent of the JSON helpers' single timeout.
  PROXY_OPEN_TIMEOUT_SECONDS = 5
  PROXY_READ_TIMEOUT_SECONDS = 60

  ProxyResponse = Struct.new(:status, :content_type, :body, keyword_init: true)

  attr_reader :base_url

  def initialize(base_url: nil, api_key: nil, app_proxy_api_key: nil, http: nil, net_http_factory: nil, timeout: DEFAULT_TIMEOUT_SECONDS)
    @base_url = (base_url.presence || ConsoleEnv["CENTAUR_API_URL"].presence || "http://localhost:8080").delete_suffix("/")
    @api_key = api_key.presence || ConsoleEnv["CENTAUR_API_KEY"].presence
    @app_proxy_api_key = app_proxy_api_key.presence ||
      ConsoleEnv["APP_PROXY_API_KEY"].presence ||
      @api_key
    @http = http || method(:net_http_request)
    @net_http_factory = net_http_factory || ->(host, port) { Net::HTTP.new(host, port) }
    @timeout = timeout
  end

  def list_slack_archive_imports(limit: 100)
    get("/api/admin/slack/archive-imports", limit: limit)
  end

  def create_slack_archive_import(filename:, content_type:, created_by:, metadata: {})
    post(
      "/api/admin/slack/archive-imports",
      {
        filename: filename,
        content_type: content_type,
        created_by: created_by,
        metadata: metadata
      }
    )
  end

  def start_slack_archive_import(import_id)
    post("/api/admin/slack/archive-imports/#{escape_path(import_id)}/start", {})
  end

  def retry_slack_archive_import(import_id)
    post("/api/admin/slack/archive-imports/#{escape_path(import_id)}/retry", {})
  end

  def delete_slack_archive_import(import_id)
    request(:delete, "/api/admin/slack/archive-imports/#{escape_path(import_id)}")
  end

  def list_slack_dm_sync_checkpoints(broker_credential_id:, home_team_id: nil)
    get(
      "/api/admin/slack/dm-sync/checkpoints",
      broker_credential_id: broker_credential_id,
      home_team_id: home_team_id
    )
  end

  def ingest_slack_dm_sync_batch(payload)
    post("/api/admin/slack/dm-sync/batch", payload)
  end

  def get_google_docs_sync_checkpoint(broker_credential_id:)
    get(
      "/api/admin/google/docs-sync/checkpoint",
      broker_credential_id: broker_credential_id
    )
  end

  def ingest_google_docs_sync_batch(payload)
    post("/api/admin/google/docs-sync/batch", payload)
  end

  def get_granola_sync_checkpoint(scope_id:)
    get("/api/admin/granola/sync/checkpoint", scope_id: scope_id)
  end

  def ingest_granola_sync_batch(payload)
    post("/api/admin/granola/sync/batch", payload)
  end

  def create_session(thread_key:, harness_type:, metadata: {}, persona_id: nil,
                     on_harness_conflict: "reject")
    payload = {
      harness_type: harness_type,
      metadata: metadata,
      on_harness_conflict: on_harness_conflict
    }
    payload[:persona_id] = persona_id if persona_id.present?

    post("/api/session/#{escape_path(thread_key)}", payload)
  end

  def append_session_messages(thread_key:, messages:)
    post("/api/session/#{escape_path(thread_key)}/messages", { messages: messages })
  end

  def execute_session(thread_key:, input_lines:, idempotency_key: nil, metadata: {})
    payload = {
      input_lines: input_lines,
      metadata: metadata
    }
    payload[:idempotency_key] = idempotency_key if idempotency_key.present?

    post("/api/session/#{escape_path(thread_key)}/execute", payload)
  end

  def list_workflow_schedules
    get("/api/workflows/schedules")
  end

  def get_workflow_run(run_id)
    get("/api/workflows/runs/#{escape_path(run_id)}")
  end

  def create_workflow_run(workflow_name:, input: nil)
    payload = { workflow_name: workflow_name }
    payload[:input] = input unless input.nil?

    post("/api/workflows/runs", payload)
  end

  # Raw pass-through to the api-rs app plane (ANY /apps/{name}/*). Unlike the
  # JSON helpers above, the upstream response is relayed verbatim -- status,
  # body, and content type -- because apps serve HTML pages and assets, not
  # API JSON; non-2xx statuses are part of that relay, so only transport
  # failures raise Error. `path` and `query` must arrive still
  # percent-encoded: they are spliced into the URL untouched so encoded bytes
  # in app paths (e.g. a thread key) survive the hop. Callers pass no headers;
  # the only credential on the request is the console's configured app-proxy
  # API key, so inbound cookies/authorization are guaranteed to stay out.
  def proxy_app(method:, name:, path: "", query: nil, body: nil, content_type: nil)
    target = +"#{@base_url}/apps/#{escape_path(name)}/#{path}"
    target << "?#{query}" if query.present?
    uri = URI.parse(target)

    request = Net::HTTPGenericRequest.new(method.to_s.upcase, true, true, uri)
    request["Authorization"] = "Bearer #{@app_proxy_api_key}" if @app_proxy_api_key.present?
    if body
      request["Content-Type"] = content_type.presence || "application/octet-stream"
      request.body = body
    end

    http = @net_http_factory.call(uri.host, uri.port)
    http.use_ssl = uri.scheme == "https"
    http.open_timeout = PROXY_OPEN_TIMEOUT_SECONDS
    http.read_timeout = PROXY_READ_TIMEOUT_SECONDS
    response = http.request(request)
    ProxyResponse.new(
      status: response.code.to_i,
      content_type: response["Content-Type"],
      body: response.body.to_s
    )
  rescue Timeout::Error, SystemCallError, SocketError, IOError, OpenSSL::SSL::SSLError, Net::HTTPBadResponse => e
    raise Error, "App proxy request failed: #{e.class}: #{e.message}"
  end

  private

  def get(path, params = {})
    query = params.compact.to_query
    request(:get, query.present? ? "#{path}?#{query}" : path)
  end

  def post(path, payload)
    request(:post, path, payload)
  end

  def request(method, path, payload = nil)
    response = @http.call(
      method: method,
      url: URI.join("#{@base_url}/", path.delete_prefix("/")).to_s,
      body: payload&.to_json,
      headers: request_headers,
      timeout: @timeout
    )
    parsed = parse_body(response.body)
    return parsed if response.status.between?(200, 299)

    message = parsed.is_a?(Hash) ? parsed["error"] || parsed["message"] || parsed["detail"] : nil
    raise Error, message.presence || "Centaur API returned HTTP #{response.status}"
  end

  def request_headers
    headers = { "Accept" => "application/json" }
    headers["Content-Type"] = "application/json"
    headers["Authorization"] = "Bearer #{@api_key}" if @api_key.present?
    headers
  end

  def parse_body(body)
    return {} if body.blank?

    JSON.parse(body)
  rescue JSON::ParserError
    { "raw" => body.to_s }
  end

  def net_http_request(method:, url:, body:, headers:, timeout:)
    uri = URI.parse(url)
    request_class = {
      get: Net::HTTP::Get,
      post: Net::HTTP::Post,
      delete: Net::HTTP::Delete
    }.fetch(method)
    request = request_class.new(uri)
    headers.each { |key, value| request[key] = value }
    request.body = body if body

    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = uri.scheme == "https"
    http.open_timeout = timeout
    http.read_timeout = timeout
    response = http.request(request)
    Response.new(status: response.code.to_i, body: response.body.to_s)
  end

  def escape_path(value)
    CGI.escape(value.to_s)
  end
end
