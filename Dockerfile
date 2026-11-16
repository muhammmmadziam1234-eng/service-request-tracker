FROM node:24-slim

# REQUEST_DB lives on the /data volume so requests survive a restart.
# The image does not seed the demo accounts: they share a published password and this server listens on every interface.
# compose.yaml turns them on for the local demo, where the port is published on loopback only.
ENV HOST=0.0.0.0 PORT=4180 REQUEST_DB=/data/requests.sqlite SEED_DEMO=0

WORKDIR /app
# Nothing is installed: the server uses only what Node 24 ships (TypeScript is stripped at load time),
# so the image is Node plus these files. package.json is needed for "type": "module".
COPY package.json openapi.json ./
COPY migrations ./migrations
COPY public ./public
COPY src ./src

# Create /data owned by the unprivileged user before declaring the volume, so a new volume inherits that ownership.
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4180

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4180)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "src/main.ts"]
