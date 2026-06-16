require "base64"
require "json"

module Oauth
  module Providers
    # Granola MCP uses OAuth 2.1 with Dynamic Client Registration. The MCP
    # resource indicator is required on both authorization and token requests.
    class Granola
      KEY = "granola"
      AUTHORIZATION_ENDPOINT = "https://mcp-auth.granola.ai/oauth2/authorize"
      TOKEN_ENDPOINT = "https://mcp-auth.granola.ai/oauth2/token"
      REGISTRATION_ENDPOINT = "https://mcp-auth.granola.ai/oauth2/register"
      RESOURCE = "https://mcp.granola.ai/mcp"
      IDENTITY_SCOPES = %w[openid email profile offline_access].freeze
      API_HOSTS = %w[mcp.granola.ai].freeze
      VALID_ISSUERS = %w[https://mcp-auth.granola.ai].freeze

      def key = KEY
      def authorization_endpoint = AUTHORIZATION_ENDPOINT
      def token_endpoint = TOKEN_ENDPOINT
      def registration_endpoint = REGISTRATION_ENDPOINT
      def identity_scopes = IDENTITY_SCOPES
      def api_hosts = API_HOSTS
      def resource = RESOURCE
      def dynamic_client_registration? = true
      def client_id_required? = false
      def client_secret_required? = false

      def extra_authorization_params = { "resource" => RESOURCE }

      def registration_metadata(app:, redirect_uri:)
        scopes = (Array(app.allowed_scopes) | identity_scopes).join(" ")
        {
          "client_name" => app.description.presence || "iron-control #{app.slug}",
          "redirect_uris" => [ redirect_uri ],
          "grant_types" => %w[authorization_code refresh_token],
          "response_types" => %w[code],
          "token_endpoint_auth_method" => "none",
          "scope" => scopes
        }
      end

      def identity_from(result, client_id:)
        if result.id_token.blank?
          raise Broker::ExchangeError.new("token response carried no id_token",
                                          stage: "oauth", code: "missing_id_token")
        end

        claims = decode_id_token_claims(result.id_token)
        unless claims["aud"] == client_id
          raise Broker::ExchangeError.new("id_token aud did not match client_id",
                                          stage: "oauth", code: "id_token_aud_mismatch")
        end
        unless VALID_ISSUERS.include?(claims["iss"])
          raise Broker::ExchangeError.new("id_token iss was not Granola MCP auth",
                                          stage: "oauth", code: "id_token_iss_invalid")
        end

        subject = claims["sub"]
        if subject.blank?
          raise Broker::ExchangeError.new("id_token carried no sub",
                                          stage: "oauth", code: "id_token_missing_sub")
        end

        { subject: subject, email: claims["email"] }
      end

      private

      def decode_id_token_claims(id_token)
        seg = id_token.split(".")[1].to_s
        seg += "=" * ((4 - seg.length % 4) % 4)
        JSON.parse(Base64.urlsafe_decode64(seg))
      rescue ArgumentError, JSON::ParserError
        raise Broker::ExchangeError.new("id_token payload did not decode", stage: "parse")
      end
    end
  end
end
