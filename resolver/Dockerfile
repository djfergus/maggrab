# Build cfsolve (Cloudflare Turnstile solver) from a pinned commit
FROM rust:1-bookworm AS cfsolve

ARG CFSOLVE_REPO=https://github.com/chris124567/cfsolve
# Pinned: cfsolve follows Cloudflare changes, so update deliberately and re-test
ARG CFSOLVE_COMMIT=98240dd

RUN apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends cmake clang libclang-dev git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --quiet "$CFSOLVE_REPO" . && git checkout --quiet "$CFSOLVE_COMMIT"
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --bin challenge \
    && cp target/release/challenge /challenge

# Runtime: the solver binary plus a small Python HTTP service
FROM debian:bookworm-slim

RUN apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 1001 resolver

COPY --from=cfsolve /challenge /opt/cfsolve/challenge
COPY --from=cfsolve /src/profiles /opt/cfsolve/profiles
COPY server.py /opt/resolver/server.py

USER resolver
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health', timeout=4)"

CMD ["python3", "-u", "/opt/resolver/server.py"]
