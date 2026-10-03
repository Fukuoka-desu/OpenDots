# Add coding tools to each Dot's isolated computer image.
FROM opendots-computer:b6932d3

RUN apt-get update && apt-get install -y --no-install-recommends git python3 python3-pip python3-venv ripgrep curl ca-certificates less vim-tiny && rm -rf /var/lib/apt/lists/*
