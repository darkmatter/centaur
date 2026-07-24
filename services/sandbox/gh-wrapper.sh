#!/bin/sh
# gh wrapper (installed at /usr/local/bin/gh, shadowing /usr/bin/gh on PATH).
#
# GitHub App installation tokens live 60 minutes, fixed by GitHub. The
# entrypoint mints one at boot and a background loop re-mints it on an
# interval (see entrypoint.sh "GitHub App installation token"), writing the
# current token to $HOME/.centaur/github-token. Environment variables frozen
# into long-running processes (harness, warm-pool sandboxes idle >1h) go
# stale and gh prefers GH_TOKEN/GITHUB_TOKEN over every other source — so a
# stale or placeholder env token silently 401s every GitHub call.
#
# This wrapper re-reads the refreshed token file on EVERY gh invocation and
# overrides the env, guaranteeing gh always authenticates with a live token.
# Without the file (mint never succeeded / not a darkmatter deployment) it
# execs the real gh untouched.
_tok_file="${CENTAUR_GITHUB_TOKEN_FILE:-${HOME:-/home/agent}/.centaur/github-token}"
if [ -r "$_tok_file" ]; then
    _tok="$(cat "$_tok_file" 2>/dev/null)"
    if [ -n "$_tok" ]; then
        GH_TOKEN="$_tok" GITHUB_TOKEN="$_tok" exec /usr/bin/gh "$@"
    fi
fi
exec /usr/bin/gh "$@"
