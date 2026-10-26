# syntax=docker/dockerfile:1
# The hosted console backend: supervisor, demo, runtime and gateway, built from this repository.
# Build from the repository root: docker build -f app/deploy/Dockerfile --build-arg VELON_REVISION=<commit> .
FROM ubuntu:24.04 AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl git nodejs npm pkg-config python3 unzip \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.97.1
ENV PATH=/root/.cargo/bin:$PATH
# Bun is pinned by checksum; the supervisor checks it again at every start.
RUN curl -fsSL -o /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64.zip \
  && unzip -q /tmp/bun.zip -d /tmp \
  && echo "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74  /tmp/bun-linux-x64/bun" | sha256sum -c - \
  && install -D /tmp/bun-linux-x64/bun /opt/velon/bin/bun
ENV PATH=/opt/velon/bin:$PATH
ARG VELON_REVISION
RUN test "${#VELON_REVISION}" -eq 40
WORKDIR /src
COPY . .
RUN cd runtime && VELON_REVISION=$VELON_REVISION cargo build --release --locked --bin authorization-api \
  && install -D target/release/authorization-api /opt/velon/bin/authorization-api
# The lockfile names a GitHub dependency over SSH; the image fetches it over HTTPS.
RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/ \
  && cd app && npm ci --omit=dev --ignore-scripts && bun run build
RUN cp -r app /opt/velon/app && cp app/deploy/supervisor.py /opt/velon/ \
  && cp -r runtime /opt/velon/cataloger && rm -rf /opt/velon/cataloger/target \
  && python3 - <<'PY'
import hashlib, json, os, pathlib
root = pathlib.Path("/opt/velon")
artifacts = [
    {"name": name, "size": (root / "bin" / name).stat().st_size,
     "sha256": hashlib.sha256((root / "bin" / name).read_bytes()).hexdigest()}
    for name in ("authorization-api", "bun")
]
manifest = {"revision": os.environ["VELON_REVISION"], "artifacts": artifacts}
(root / "artifacts.json").write_text(json.dumps(manifest, indent=2) + "\n")
PY

FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=ubuntu:ubuntu /opt/velon /opt/velon
USER ubuntu
# The gateway listens on VELON_PORT + 2. UPSTREAM_RPC_URL, PUBLIC_DEMO_ORIGIN and GATEWAY_TOKEN
# come from the host's secret settings.
ENV VELON_ROOT=/opt/velon VELON_NETWORK=mainnet VELON_PORT=7858 PORT=7860
EXPOSE 7860
CMD ["python3", "/opt/velon/supervisor.py"]
