import http.server
import os
import urllib.request

PORT = int(os.environ.get("PORT", 3000))
PREFIX = "/apps/usage"
API_URL = os.environ.get("CENTAUR_API_URL", "http://api:8000")
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
VIEWS = {"tools", "skills", "teams", "users", "workflows", "apps", ""}

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def translate_path(self, path):
        if path.startswith(PREFIX):
            path = path[len(PREFIX):] or "/"
        clean = path.split("?")[0].strip("/")
        if clean in VIEWS:
            path = "/index.html"
        return super().translate_path(path)

    def do_GET(self):
        stripped = self.path
        if stripped.startswith(PREFIX):
            stripped = stripped[len(PREFIX):]
        if stripped.rstrip("/") == "/api/stats":
            self._proxy_stats()
            return
        super().do_GET()

    def _proxy_stats(self):
        try:
            req = urllib.request.Request(f"{API_URL}/usage-stats")
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = resp.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "public, max-age=60")
                self.end_headers()
                self.wfile.write(data)
        except Exception:
            # Fallback to static data.json
            self.path = PREFIX + "/data.json"
            super().do_GET()

if __name__ == "__main__":
    with http.server.HTTPServer(("0.0.0.0", PORT), Handler) as httpd:
        print(f"Serving on port {PORT}")
        httpd.serve_forever()
