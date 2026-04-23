import http.server
import os

PORT = int(os.environ.get("PORT", 3000))
PREFIX = "/apps/usage"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
VIEWS = {"tools", "teams", "users", ""}

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def translate_path(self, path):
        if path.startswith(PREFIX):
            path = path[len(PREFIX):] or "/"
        # Route /tools, /teams, /users to index.html (SPA routing)
        clean = path.split("?")[0].strip("/")
        if clean in VIEWS:
            path = "/index.html"
        return super().translate_path(path)

if __name__ == "__main__":
    with http.server.HTTPServer(("0.0.0.0", PORT), Handler) as httpd:
        print(f"Serving on port {PORT}")
        httpd.serve_forever()
