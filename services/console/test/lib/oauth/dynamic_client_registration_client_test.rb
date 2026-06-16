require "test_helper"

module Oauth
  class DynamicClientRegistrationClientTest < ActiveSupport::TestCase
    class StubHTTP
      attr_reader :captured

      def initialize(status:, body:)
        @status = status
        @body = body
      end

      def call(url:, metadata:, headers:, timeout:)
        @captured = { url: url, metadata: metadata, headers: headers, timeout: timeout }
        DynamicClientRegistrationClient::Response.new(status: @status, body: @body)
      end
    end

    def client_with(status:, body:)
      http = StubHTTP.new(status: status, body: body)
      [ DynamicClientRegistrationClient.new(http: http), http ]
    end

    test "happy path parses registered public client metadata" do
      client, http = client_with(status: 201, body: {
        client_id: "client_123",
        token_endpoint_auth_method: "none"
      }.to_json)

      result = client.register(
        registration_endpoint: "https://mcp-auth.example/oauth2/register",
        metadata: { "redirect_uris" => [ "https://control.example/oauth/granola/callback" ] }
      )

      assert_equal "client_123", result.client_id
      assert_nil result.client_secret
      assert_equal "none", result.token_endpoint_auth_method
      assert_equal "https://mcp-auth.example/oauth2/register", http.captured[:url]
    end

    test "OAuth error body raises an ExchangeError with the code" do
      client, _ = client_with(status: 400, body: { error: "invalid_redirect_uri" }.to_json)
      err = assert_raises(Broker::ExchangeError) do
        client.register(registration_endpoint: "https://idp.example/register", metadata: {})
      end
      assert_equal "oauth", err.stage
      assert_equal "invalid_redirect_uri", err.code
    end

    test "missing client_id is a parse error" do
      client, _ = client_with(status: 201, body: {}.to_json)
      err = assert_raises(Broker::ExchangeError) do
        client.register(registration_endpoint: "https://idp.example/register", metadata: {})
      end
      assert_equal "parse", err.stage
    end
  end
end
