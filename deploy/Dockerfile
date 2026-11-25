# Build with the agent workspace as context: docker build -f deploy/Dockerfile .
FROM node:24-bookworm-slim

WORKDIR /app
# The qualified kit installs from local packages/*.tgz; copy those inputs too.
COPY --chown=node:node . .
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
RUN mkdir -p /app/.tendriller && chown node:node /app/.tendriller && chmod 700 /app/.tendriller
USER node
ENV NODE_ENV=production
# The workspace keeps its agent credential, signer and every page's device here.
VOLUME ["/app/.tendriller"]
STOPSIGNAL SIGTERM
# The one agent program for every page; SIGTERM closes each page owner, then the hub.
CMD ["node", "node_modules/@tendriller/tools/bin/tendril.mjs", "agent", "run"]
