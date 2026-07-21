require "test_helper"

class Console::AppsControllerTest < ActionDispatch::IntegrationTest
  class FakeClient
    attr_reader :calls
    attr_accessor :response

    def initialize
      @calls = []
      @response = CentaurApiClient::ProxyResponse.new(
        status: 200,
        content_type: "text/html; charset=utf-8",
        body: "<html>stats</html>"
      )
    end

    def proxy_app(**kwargs)
      @calls << kwargs
      raise @response if @response.is_a?(Exception)

      @response
    end
  end

  setup do
    @operator = users(:acme_admin)
    @client = FakeClient.new
    Console::AppsController.client_factory = -> { @client }
    post login_url, params: { email: @operator.email, password: "password123456" }
  end

  teardown do
    Console::AppsController.client_factory = -> { CentaurApiClient.new }
  end

  test "redirects to login when not signed in" do
    delete logout_url
    get "/console/apps/omp-stats/"
    assert_redirected_to login_path
    # The gate fires before the action, so the upstream is never touched.
    assert_empty @client.calls
  end

  test "relays an authenticated request through to the app upstream" do
    get "/console/apps/omp-stats/export/slack%3AC123%3A1700.42?theme=dark"

    assert_response :ok
    assert_equal "<html>stats</html>", response.body
    assert_equal "text/html", response.media_type

    call = @client.calls.fetch(0)
    assert_equal "GET", call[:method]
    assert_equal "omp-stats", call[:name]
    assert_equal "export/slack%3AC123%3A1700.42", call[:path]
    assert_equal "theme=dark", call[:query]
    assert_nil call[:body]
  end

  test "sandboxes inline transcript HTML away from the Console origin" do
    get "/console/apps/omp-stats/export/slack%3AC123%3A1700.42"

    assert_response :ok
    assert_equal "sandbox allow-scripts", response.headers["Content-Security-Policy"]
  end

  test "denies fleet-wide stats to non-admin users" do
    delete logout_url
    member = users(:member_user)
    post login_url, params: { email: member.email, password: "password123456" }

    get "/console/apps/omp-stats/api/stats/recent"

    assert_response :not_found
    assert_empty @client.calls
  end

  test "denies an OMP transcript export when the current user does not own the thread" do
    delete logout_url
    member = users(:member_user)
    post login_url, params: { email: member.email, password: "password123456" }
    checked_thread_keys = []
    Console::AppsController.define_method(:console_thread_readable?) do |thread_key|
      checked_thread_keys << thread_key
      false
    end

    get "/console/apps/omp-stats/export/slack%3AC123%3A1700.42"

    assert_response :not_found
    assert_equal [ "slack:C123:1700.42" ], checked_thread_keys
    assert_empty @client.calls
  ensure
    Console::AppsController.send(:remove_method, :console_thread_readable?)
  end

  test "denies a percent-encoded OMP export prefix for a non-owner" do
    delete logout_url
    member = users(:member_user)
    post login_url, params: { email: member.email, password: "password123456" }
    checked_thread_keys = []
    Console::AppsController.define_method(:console_thread_readable?) do |thread_key|
      checked_thread_keys << thread_key
      false
    end

    get "/console/apps/omp-stats/%65xport/slack%3AC123%3A1700.42"

    assert_response :not_found
    assert_equal [ "slack:C123:1700.42" ], checked_thread_keys
    assert_empty @client.calls
  ensure
    Console::AppsController.send(:remove_method, :console_thread_readable?)
  end

  test "rejects percent-encoded traversal segments before proxying" do
    get "/console/apps/omp-stats/api/%2e%2e/stats"

    assert_response :not_found
    assert_empty @client.calls
  end

  test "rejects percent-encoded backslashes before URL normalization" do
    get "/console/apps/omp-stats/foo%5C..%5Cexport%5Cslack%3AC123%3A1700.42"

    assert_response :not_found
    assert_empty @client.calls
  end

  test "forwards method body and content type" do
    post "/console/apps/omp-stats/api/query",
         params: '{"q":1}',
         headers: { "Content-Type" => "application/json" }

    assert_response :ok
    call = @client.calls.fetch(0)
    assert_equal "POST", call[:method]
    assert_equal "api/query", call[:path]
    assert_equal '{"q":1}', call[:body]
    assert_equal "application/json", call[:content_type]
  end

  test "inbound cookies and authorization never reach the upstream call" do
    get "/console/apps/omp-stats/",
        headers: { "Authorization" => "Bearer user-borne-token" }

    assert_response :ok
    call = @client.calls.fetch(0)
    # The proxy seam carries only these request facets; headers -- and with
    # them the session cookie and any inbound Authorization -- cannot pass.
    assert_equal %i[body content_type method name path query], call.keys.sort
    forwarded = call.values.compact.map(&:to_s)
    assert forwarded.none? { |value| value.include?("user-borne-token") }
    cookies.to_hash.each_value do |cookie_value|
      next if cookie_value.blank?

      assert forwarded.none? { |value| value.include?(cookie_value) }
    end
  end

  test "relays upstream non-2xx statuses instead of raising" do
    @client.response = CentaurApiClient::ProxyResponse.new(
      status: 404,
      content_type: "text/plain",
      body: "no transcript for that thread"
    )

    get "/console/apps/omp-stats/export/missing"
    assert_response :not_found
    assert_equal "no transcript for that thread", response.body
  end

  test "maps upstream connection failures to 502 JSON" do
    @client.response = CentaurApiClient::Error.new("connect refused")

    get "/console/apps/omp-stats/"
    assert_response :bad_gateway
    body = JSON.parse(response.body)
    assert_equal false, body["ok"]
    assert_match "connect refused", body["error"]
  end

  test "rejects app names outside the registry token shape" do
    get "/console/apps/Bad%2FName/"
    assert_response :not_found
    assert_empty @client.calls
  end
end
