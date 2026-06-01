mod support;

use test_case::test_case;

#[test_case("agent-k8s"; "agent_k8s")]
#[tokio::test]
#[ignore = "requires sandbox e2e infrastructure; run `just e2e-kind`"]
async fn env_secret_proxy_rewrites_https_request_before_receiver(
    implementation_name: &'static str,
) {
    if let Some(implementation) =
        support::proxy_implementation_if_requested(implementation_name).await
    {
        support::env_secret_proxy_rewrites_https_request_before_receiver(&implementation).await;
    }
}
