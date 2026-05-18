"""The Block RSS client."""

import subprocess

import feedparser


class TheBlockClient:
    """Client for The Block RSS feed."""

    RSS_URL = "https://www.theblock.co/rss.xml"
    USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

    def __init__(self, timeout: float = 30.0):
        self.timeout = timeout

    def _fetch_feed(self) -> list[dict]:
        """Fetch and parse RSS feed using curl for better compatibility."""
        try:
            result = subprocess.run(
                [
                    "curl",
                    "-s",
                    "-A",
                    self.USER_AGENT,
                    "--compressed",
                    self.RSS_URL,
                ],
                capture_output=True,
                text=True,
                timeout=self.timeout,
            )
            if result.returncode != 0:
                raise RuntimeError(f"Failed to fetch feed: curl returned {result.returncode}")
            content = result.stdout
        except FileNotFoundError:
            feed = feedparser.parse(
                self.RSS_URL,
                request_headers={"User-Agent": self.USER_AGENT},
            )
            if feed.bozo and not feed.entries:
                raise RuntimeError(f"Failed to fetch feed: {feed.bozo_exception}")
            return self._parse_entries(feed.entries)
        except subprocess.TimeoutExpired:
            raise RuntimeError("Request timed out")

        feed = feedparser.parse(content)
        if feed.bozo and not feed.entries:
            raise RuntimeError(
                "Failed to parse feed. The Block may be blocking automated requests."
            )

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
            if query_lower in article["title"].lower() or query_lower in article["summary"].lower()
        ]
        return filtered[:limit]


def _client() -> TheBlockClient:
    return TheBlockClient()
