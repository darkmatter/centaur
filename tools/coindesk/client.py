"""CoinDesk RSS client."""

import feedparser


class CoinDeskClient:
    """Client for CoinDesk RSS feed."""

    RSS_URL = "https://www.coindesk.com/arc/outboundfeeds/rss/"
    USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

    def __init__(self, timeout: float = 30.0):
        self.timeout = timeout

    def _fetch_feed(self) -> list[dict]:
        """Fetch and parse RSS feed using httpx with browser-like headers."""
        import httpx

        headers = {
            "User-Agent": self.USER_AGENT,
            "Accept": "application/rss+xml, application/xml, text/xml, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            "Referer": "https://www.coindesk.com/",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "same-origin",
        }
        try:
            with httpx.Client(timeout=self.timeout, follow_redirects=True) as client:
                response = client.get(self.RSS_URL, headers=headers)
                response.raise_for_status()
                content = response.text
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"Failed to fetch feed: HTTP {e.response.status_code}")
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}")

        feed = feedparser.parse(content)
        if feed.bozo and not feed.entries:
            raise RuntimeError("Failed to parse feed. CoinDesk may be blocking automated requests.")

        return self._parse_entries(feed.entries)

    def _parse_entries(self, entries: list) -> list[dict]:
        """Parse feed entries into article dicts."""
        articles = []
        for entry in entries:
            articles.append(
                {
                    "title": entry.get("title", ""),
                    "link": entry.get("link", ""),
                    "published": entry.get("published", ""),
                    "summary": entry.get("summary", ""),
                    "author": entry.get("author", ""),
                    "tags": [tag.term for tag in entry.get("tags", [])]
                    if entry.get("tags")
                    else [],
                }
            )
        return articles

    def news(self, limit: int = 20) -> list[dict]:
        """Get latest news articles."""
        articles = self._fetch_feed()
        return articles[:limit]

    def search(self, query: str, limit: int = 20) -> list[dict]:
        """Search news articles by keyword."""
        articles = self._fetch_feed()
        query_lower = query.lower()
        filtered = [
            article
            for article in articles
            if query_lower in article["title"].lower()
            or query_lower in article["summary"].lower()
            or any(query_lower in tag.lower() for tag in article["tags"])
        ]
        return filtered[:limit]


def _client() -> CoinDeskClient:
    return CoinDeskClient()
