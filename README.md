# idyicyanere
## Start the container
docker run --name=idyicyanere --gpus all -it -v $PWD//:/idyicyanere debian:latest
docker exec -it idyicyanere /bin/bash

## Install dependencies
apt update -y
apt upgrade -y
apt install -y --no-install-recommends curl
apt install -y --no-install-recommends texlive texlive-latex-extra texlive-lang-spanish latexmk
apt install -y --no-install-recommends build-essential
apt install -y --no-install-recommends libncurses5-dev
apt install -y --no-install-recommends libcurl4-openssl-dev
apt install -y --no-install-recommends libjansson-dev
apt install -y --no-install-recommends openssh-client

# Env
export OPENAI_API_KEY="sk-..."

# Optional overrides
export OPENAI_BASE_URL="https://api.openai.com/v1"
export OPENAI_MODEL="gpt-4o-mini"

# Start with a TeX file
./idyicyanere main.tex