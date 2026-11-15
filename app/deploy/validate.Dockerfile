# Isolated Railway validation only: no production service, credentials or public port.
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl git pkg-config python3 unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*
RUN curl --retry 3 -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/v22.16.0/node-v22.16.0-linux-x64.tar.xz \
    && echo "f4cb75bb036f0d0eddf6b79d9596df1aaab9ddccd6a20bf489be5abe9467e84e  /tmp/node.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz --strip-components=1 -C /usr/local \
    && npm install -g npm@10.9.9
RUN curl --retry 3 -fsSL -o /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64.zip \
    && unzip -q /tmp/bun.zip -d /tmp \
    && echo "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74  /tmp/bun-linux-x64/bun" | sha256sum -c - \
    && install /tmp/bun-linux-x64/bun /usr/local/bin/bun
RUN curl --retry 3 -fsSL https://sh.rustup.rs -o /tmp/rustup.sh \
    && sh /tmp/rustup.sh -y --profile minimal --default-toolchain 1.97.1 \
    && /root/.cargo/bin/rustup component add rustfmt clippy
ENV PATH=/root/.cargo/bin:/usr/local/bin:$PATH
WORKDIR /workspace
COPY . .
RUN cd app && GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf \
    GIT_CONFIG_VALUE_0=ssh://git@github.com/ npm ci --ignore-scripts --no-audit --no-fund
RUN cd sdk && bun install --frozen-lockfile
RUN cd app && node_modules/.bin/playwright install --with-deps chromium --only-shell
ENV CARGO_TARGET_DIR=/workspace/.validation/target CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0 \
    CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 RUST_TEST_THREADS=2
CMD ["timeout", "--signal=TERM", "--kill-after=30s", "50m", "bash", "scripts/validate.sh"]
