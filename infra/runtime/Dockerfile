# =============================================================
# PremDev user runtime image
# Multi-language base for user workspaces
# =============================================================
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    HOME=/home/premdev \
    SHELL=/bin/zsh \
    PATH=/home/premdev/.local/bin:/usr/local/go/bin:/home/premdev/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_WARN_SCRIPT_LOCATION=0 \
    NODE_PATH=/usr/lib/node_modules

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl wget ca-certificates gnupg lsb-release \
      bash zsh git make build-essential pkg-config \
      sudo tini openssh-client unzip zip jq tree \
      passwd login adduser \
      vim nano less htop procps net-tools iputils-ping \
      sqlite3 default-mysql-client postgresql-client \
      python3 python3-pip python3-venv python3-full python3-dev pipx python-is-python3 \
      php php-cli php-curl php-mbstring php-xml php-mysql php-zip composer \
      ruby ruby-dev \
      openjdk-21-jdk-headless maven \
      golang-go \
      libssl-dev libffi-dev libjpeg-dev zlib1g-dev libpq-dev default-libmysqlclient-dev \
    && rm -rf /var/lib/apt/lists/* \
    && find /usr/lib/python3* -name EXTERNALLY-MANAGED -delete 2>/dev/null || true

# Node.js 20 (NodeSource) + globally available frameworks so users don't
# need a per-workspace `npm install` for hello-world apps.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    npm install -g pnpm yarn tsx ts-node typescript nodemon \
                  express cors body-parser dotenv \
                  http-server serve vite && \
    rm -rf /var/lib/apt/lists/*

# Pre-install common Python web frameworks + DB drivers system-wide so
# `python3 main.py` Just Works without `pip install` in .premdev. The
# user's own pinned requirements.txt will still be installed on top
# inside the workspace if they have one.
RUN pip3 install --no-cache-dir \
      flask flask-cors gunicorn \
      fastapi "uvicorn[standard]" \
      requests httpx \
      python-dotenv \
      sqlalchemy alembic \
      mysql-connector-python pymysql psycopg2-binary \
      pillow pyyaml \
      django

# Rust (system-wide install via CARGO_HOME / RUSTUP_HOME)
ENV CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:$PATH
RUN mkdir -p /usr/local/cargo /usr/local/rustup && \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
      sh -s -- -y --default-toolchain stable --profile minimal --no-modify-path && \
    chmod -R a+rwX /usr/local/cargo /usr/local/rustup

# Create user (remove default ubuntu user that ships with ubuntu:24.04 holding UID 1000)
RUN /usr/sbin/userdel -r ubuntu 2>/dev/null || true; \
    /usr/sbin/groupdel ubuntu 2>/dev/null || true; \
    /usr/sbin/groupadd -g 1000 premdev && \
    /usr/sbin/useradd -m -d /home/premdev -s /bin/zsh -u 1000 -g 1000 premdev && \
    mkdir -p /home/premdev && \
    chown -R premdev:premdev /home/premdev && \
    chmod 755 /home/premdev && \
    echo "premdev ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers && \
    mkdir -p /workspace && chown premdev:premdev /workspace

# Smart shell setup: oh-my-zsh + autosuggestions + syntax highlighting + starship
USER premdev
WORKDIR /home/premdev
RUN sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended && \
    git clone --depth 1 https://github.com/zsh-users/zsh-autosuggestions ~/.oh-my-zsh/custom/plugins/zsh-autosuggestions && \
    git clone --depth 1 https://github.com/zsh-users/zsh-syntax-highlighting ~/.oh-my-zsh/custom/plugins/zsh-syntax-highlighting && \
    sed -i 's/^plugins=.*/plugins=(git zsh-autosuggestions zsh-syntax-highlighting docker)/' ~/.zshrc && \
    echo 'export PATH=$HOME/.local/bin:/usr/local/go/bin:$PATH' >> ~/.zshrc && \
    echo 'eval "$(starship init zsh)" 2>/dev/null || true' >> ~/.zshrc

# Starship prompt (precompiled binary)
USER root
RUN curl -sS https://starship.rs/install.sh | sh -s -- -y >/dev/null 2>&1 || true

USER premdev
WORKDIR /workspace
EXPOSE 3000 5000 5173 8000 8080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["zsh", "-l"]
