# ComfyUI Imagine, in a container.
#
# The studio is only the Node process: ComfyUI stays where it is (the host, or
# another machine) because it needs the GPU and the weights, and the page talks
# to it over HTTP. Build from a clone of this repository — the tarball on the
# releases page is already built and needs no Docker:
#
#   docker compose up -d --build
#
# A configuration file is required; `install.sh` writes one, or copy
# config.example.yaml and edit the three values (port aside, ComfyUI's address,
# the text model).

# --- build -----------------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# --- runtime ---------------------------------------------------------------
FROM node:24-bookworm-slim
# ffmpeg and ffprobe: thumbnails, crops, and every video step shell out to them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    IMAGINE_CONFIG=/app/config.yaml \
    IMAGINE_HOME=/data
COPY --from=build /app/package.json /app/node_modules ./ 
COPY --from=build /app/dist ./dist
COPY --from=build /app/plugins ./plugins
COPY --from=build /app/workflows ./workflows
COPY --from=build /app/locales ./locales
COPY --from=build /app/persona ./persona
COPY --from=build /app/comfyui-nodes ./comfyui-nodes
COPY --from=build /app/config.example.yaml ./
EXPOSE 3090
VOLUME ["/data"]
CMD ["node", "dist/server.mjs"]
