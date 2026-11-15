FROM node:24-slim

# Demo-friendly defaults. REQUEST_DB lives on the /data volume so requests survive a restart.
# The demo accounts are seeded into an empty database; set SEED_DEMO=0 for anything real.
ENV HOST=0.0.0.0 PORT=4180 REQUEST_DB=/data/requests.sqlite

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
