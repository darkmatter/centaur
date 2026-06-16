require "test_helper"

module Oauth
  module Providers
    class GranolaTest < ActiveSupport::TestCase
      CLIENT_ID = "client_123".freeze

      def provider = Granola.new

      def id_token(claims)
        "h.#{Base64.urlsafe_encode64(claims.to_json, padding: false)}.s"
      end

      test "registration metadata requests a public MCP client" do
        app = oauth_apps(:acme_granola)
        metadata = provider.registration_metadata(
          app: app,
          redirect_uri: "https://control.example/oauth/granola/callback"
        )

        assert_equal [ "https://control.example/oauth/granola/callback" ], metadata["redirect_uris"]
        assert_equal %w[authorization_code refresh_token], metadata["grant_types"]
        assert_equal %w[code], metadata["response_types"]
        assert_equal "none", metadata["token_endpoint_auth_method"]
        scopes = metadata["scope"].split
        assert_includes scopes, "mcp"
        assert_includes scopes, "offline_access"
        assert_includes scopes, "openid"
      end

      test "identity_from accepts Granola issuer and returns subject and email" do
        result = Broker::AuthorizationCodeClient::Result.new(
          access_token: "AT",
          refresh_token: "RT",
          expires_in: 3600,
          scope: "mcp openid email offline_access",
          id_token: id_token({
            "aud" => CLIENT_ID,
            "iss" => "https://mcp-auth.granola.ai",
            "sub" => "granola-sub-1",
            "email" => "user@example.com"
          })
        )

        identity = provider.identity_from(result, client_id: CLIENT_ID)
        assert_equal "granola-sub-1", identity[:subject]
        assert_equal "user@example.com", identity[:email]
      end

      test "identity_from rejects another audience" do
        result = Broker::AuthorizationCodeClient::Result.new(
          access_token: "AT",
          refresh_token: "RT",
          expires_in: 3600,
          scope: "mcp",
          id_token: id_token({
            "aud" => "other-client",
            "iss" => "https://mcp-auth.granola.ai",
            "sub" => "granola-sub-1"
          })
        )

        err = assert_raises(Broker::ExchangeError) { provider.identity_from(result, client_id: CLIENT_ID) }
        assert_equal "id_token_aud_mismatch", err.code
      end
    end
  end
end
