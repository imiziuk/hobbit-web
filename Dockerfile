# Hobbit Web in a container: the page + wasm (port 5190), your game folder read-only (5191) and the multiplayer
# relay (5192). The image holds code only: the game folder is mounted at /game, and wasi-sdk,
# the Python venv and the Synchrony assets live in volumes and the build in ./recomp/out, so the first start builds
# (~4 min) and later starts are instant.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . /app
ENV HOBBIT_GAME_DIR=/game HOBBIT_IN_DOCKER=1 PYTHONUNBUFFERED=1
EXPOSE 5190 5191 5192
CMD ["python", "start.py", "--mp", "--lan", "--no-browser", "--port", "5190"]
