"""Template for a new site. Copy to sites/<name>.py; files starting with _ aren't loaded.

See docs/link-resolver.md for the other steps.
"""

from common import ResolveError, Session, solve_turnstile  # noqa: F401

# Links this site accepts (subdomains included)
HOSTS = ("example.com",)
# Hosts a returned direct link may be on. https only; anything else is rejected.
LINK_HOSTS = ("cdn.example.com",)
# Solved every 6 hours to detect breakage, or None if the site has no Turnstile
SELF_TEST = {"page": "https://example.com/", "sitekey": "SITEKEY"}


def resolve(url):
    """Return a result like the one below, or raise ResolveError.

    ResolveError("not_found", "..."), ResolveError("error", "..."), or
    ResolveError("cooldown", "...", waitSeconds=600).
    Never download the file: getting the link is enough.
    """
    return {"status": "ok", "directUrl": "https://cdn.example.com/file.pdf",
            "filename": "file.pdf", "size": None}
