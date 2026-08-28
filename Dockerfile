FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

ARG HERDR_VERSION=0.8.0
ARG HERDR_SHA256_AMD64=b872ea7e40fa2cb17e857ac9b62b1bf26db7b403c622f5d2f3f5b35f6e9acd28
ARG HERDR_SHA256_ARM64=f647ac66468d9efbc642fe534fb284468f0aea60641606fc008dfc0d82a3ca87
ARG PI_VERSION=0.84.2
ARG CODEX_VERSION=0.150.1
ARG TARGETARCH

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client procps \
    && rm -rf /var/lib/apt/lists/* \
    && case "$TARGETARCH" in \
         amd64) herdr_arch=x86_64; herdr_sha="$HERDR_SHA256_AMD64" ;; \
         arm64) herdr_arch=aarch64; herdr_sha="$HERDR_SHA256_ARM64" ;; \
         *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-${herdr_arch}" -o /usr/local/bin/herdr \
    && echo "${herdr_sha}  /usr/local/bin/herdr" | sha256sum --check --strict - \
    && chmod 0755 /usr/local/bin/herdr \
    && npm install --global \
         "@earendil-works/pi-coding-agent@${PI_VERSION}" \
         "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force

RUN mkdir -p /app /opt/herdr-supervisor \
    && chown node:node /app

COPY --chown=node:node . /opt/herdr-supervisor
RUN chmod 0755 /opt/herdr-supervisor/container/bin/pi \
    && mv /usr/local/bin/pi /usr/local/bin/pi-agent \
    && ln -s /opt/herdr-supervisor/container/bin/pi /usr/local/bin/pi \
    && ln -s /opt/herdr-supervisor/bin/herdr-supervisor.js /usr/local/bin/herdr-supervisor

USER node
WORKDIR /app
ENV HERDR_SUPERVISOR_GOALS=/home/node/.local/state/herdr-supervisor/goals
ENV HERDR_SUPERVISOR_DIRECTORY=/app

ENTRYPOINT ["/opt/herdr-supervisor/bin/container-entrypoint.sh"]
CMD ["herdr", "server"]
