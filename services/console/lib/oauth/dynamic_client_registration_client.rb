require "json"
require "net/http"
require "uri"

module Oauth
  # Performs an RFC 7591 Dynamic Client Registration request for OAuth providers
  # that issue public client credentials on demand (for example MCP servers).
  #
  # SECURITY: this class never logs registration responses. Some providers may
  # return a client_secret even when the requested auth method is public.
  class DynamicClientRegistrationClient
    Result = Data.define(:client_id, :client_secret, :token_endpoint_auth_method)
    Response = Data.define(:status, :body)

    DEFAULT_TIMEOUT = 30
    MAX_BODY_BYTES = 64 * 1024

    def initialize(http: nil)
      @http = http
    end

    def register(registration_endpoint:, metadata:, timeout: DEFAULT_TIMEOUT)
      raise ArgumentError, "registration endpoint is required" if registration_endpoint.blank?
      raise ArgumentError, "metadata must be a hash" unless metadata.is_a?(Hash)

      response = perform(registration_endpoint, metadata, timeout)
      classify_error(response.status, response.body) if response.status / 100 != 2
      parse_success(response)
    end

    private

    def perform(url, metadata, timeout)
      if @http
        return @http.call(url: url, metadata: metadata, headers: {}, timeout: timeout)
      end

      uri = URI.parse(url)
      req = Net::HTTP::Post.new(uri)
      req["Content-Type"] = "application/json"
      req["Accept"] = "application/json"
      req.body = JSON.generate(metadata)

      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = uri.scheme == "https"
      http.open_timeout = timeout
      http.read_timeout = timeout

      res = http.request(req)
      Response.new(status: res.code.to_i, body: res.body.to_s.byteslice(0, MAX_BODY_BYTES))
    rescue StandardError => e
      raise Broker::ExchangeError.new("dynamic client registration request failed: #{e.class}",
                                      stage: "network")
    end

    def parse_success(response)
      parsed = JSON.parse(response.body)
      client_id = parsed["client_id"]
      if client_id.blank?
        raise Broker::ExchangeError.new("registration endpoint returned no client_id",
                                        stage: "parse", status: response.status)
      end

      Result.new(
        client_id: client_id,
        client_secret: parsed["client_secret"],
        token_endpoint_auth_method: parsed["token_endpoint_auth_method"]
      )
    rescue JSON::ParserError, TypeError
      raise Broker::ExchangeError.new("parsing registration response failed",
                                      stage: "parse", status: response.status)
    end

    def classify_error(status, body)
      oauth_error = begin
        JSON.parse(body.to_s)["error"]
      rescue JSON::ParserError, TypeError
        nil
      end

      raise Broker::ExchangeError.new("registration endpoint http #{status}",
                                      stage: oauth_error.present? ? "oauth" : "http",
                                      code: oauth_error.presence,
                                      status: status)
    end
  end
end
