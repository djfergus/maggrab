# Builds cfsolve (Cloudflare Turnstile solver), whose commit comes from CFSOLVE_COMMIT.
# Upstream's code and its dependencies run only with networking off.
FROM rust:1-bookworm AS cfsolve

ARG CFSOLVE_REPO=https://github.com/chris124567/cfsolve
ARG CFSOLVE_COMMIT

RUN apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends cmake clang libclang-dev git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN test -n "$CFSOLVE_COMMIT" \
    && git clone --quiet "$CFSOLVE_REPO" . \
    && git checkout --quiet "$CFSOLVE_COMMIT"

# Upstream's Cargo and toolchain config could make this network-enabled step run its
# code, so only a plain version number is read from it and the files are removed
RUN channel="$(sed -n 's/^channel = "\([0-9]*\.[0-9]*\.[0-9]*\)"$/\1/p' rust-toolchain.toml)" \
    && test -n "$channel" \
    && rustup toolchain install "$channel" --profile minimal \
    && rustup default "$channel" \
    && rm -rf .cargo rust-toolchain rust-toolchain.toml \
    && cargo fetch --locked

RUN --network=none cargo build --release --offline --locked --bin challenge \
    && cp target/release/challenge /challenge

# Runtime: the solver binary plus a small Python HTTP service
FROM debian:bookworm-slim

LABEL app=link-resolver

RUN apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 1001 resolver

COPY --from=cfsolve /challenge /opt/cfsolve/challenge
COPY --from=cfsolve /src/profiles /opt/cfsolve/profiles
COPY server.py common.py /opt/resolver/
COPY sites/ /opt/resolver/sites/

USER resolver
ENV PORT=8080 PYTHONDONTWRITEBYTECODE=1
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health', timeout=4)"

CMD ["python3", "-u", "/opt/resolver/server.py"]
