# Hobbit Web in a container: one single-origin server on port 5190 (page /, your game folder read-only at /data/,
# multiplayer relay at /relay; start.py --single is the default when HOBBIT_IN_DOCKER is set), plus the old separate
# data (5191) and relay (5192) ports for the Tailscale serve ports 8443 / 10000. The image holds code only: the game folder is mounted at /game, and wasi-sdk,
# the Python venv and the Synchrony assets live in volumes and the build in ./recomp/out, so the first start builds
# (~4 min) and later starts are instant.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . /app
ENV HOBBIT_GAME_DIR=/game HOBBIT_IN_DOCKER=1 PYTHONUNBUFFERED=1
EXPOSE 5190 5191 5192
CMD ["python", "start.py", "--mp", "--lan", "--no-browser", "--port", "5190"]
