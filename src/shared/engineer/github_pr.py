from __future__ import annotations

import httpx


class GitHubPRError(RuntimeError):
    pass


async def create_pull_request(
    *,
    token: str,
    owner: str,
    repo: str,
    base_branch: str,
    head_branch: str,
    title: str,
    body: str,
) -> str:
    if not token:
        raise GitHubPRError("Missing GITHUB_TOKEN")

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    payload = {
        "title": title,
        "body": body,
        "base": base_branch,
        "head": head_branch,
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            f"https://api.github.com/repos/{owner}/{repo}/pulls",
            headers=headers,
            json=payload,
        )
    if response.status_code >= 300:
        raise GitHubPRError(f"GitHub PR creation failed: {response.status_code} {response.text}")

    data = response.json()
    if not isinstance(data, dict):
        raise GitHubPRError("GitHub PR creation response is not a JSON object")
    url_value = data.get("html_url", "")
    if not isinstance(url_value, str) or not url_value:
        raise GitHubPRError("GitHub PR creation response missing html_url")
    return url_value
