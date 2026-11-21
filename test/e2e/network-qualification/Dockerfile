FROM mcr.microsoft.com/playwright:v1.65.0-noble@sha256:f6fe3cf9a493670b9a20f33597a807262abb25c40c31839ba4ac1dbc51fe7366
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 iptables iputils-ping && rm -rf /var/lib/apt/lists/*
ENV TENDRILLER_NETWORK_LAB=1
WORKDIR /workspace
