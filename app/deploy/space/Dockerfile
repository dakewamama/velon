# The mainnet console's backend as a container: supervisor, demo, runtime and gateway.
# Build context is the folder `deploy/space/build.sh` assembles.
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip python3 git \
  && rm -rf /var/lib/apt/lists/*
# Bun is checked against artifacts.json by the supervisor at every start.
RUN curl -fsSL -o /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64.zip \
  && unzip -q /tmp/bun.zip -d /tmp && mkdir -p /opt/velon/bin && mv /tmp/bun-linux-x64/bun /opt/velon/bin/bun \
  && rm -rf /tmp/bun.zip /tmp/bun-linux-x64
COPY --chown=1000:1000 . /opt/velon
RUN chmod +x /opt/velon/bin/* && chown -R 1000:1000 /opt/velon
USER 1000
ENV VELON_ROOT=/opt/velon VELON_NETWORK=mainnet VELON_PORT=7858
EXPOSE 7860
CMD ["python3", "/opt/velon/supervisor.py"]
