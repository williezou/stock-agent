# 基础镜像默认取自 AWS ECR 公共镜像（国内可直接拉取）；它没有IPv6，纯IPv6主机改用 Docker Hub（见 compose.gcp.yaml）
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:20-bookworm-slim
FROM ${NODE_IMAGE}

ENV NODE_ENV=production
WORKDIR /app

# 中文字体：龙虎榜图表需要渲染中文股票名称与上榜原因。
# 官方源在国内访问很慢，改用国内镜像（可用 --build-arg APT_MIRROR=... 更换）；镜像源直连，不走构建代理
ARG APT_MIRROR=mirrors.ustc.edu.cn
RUN sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::http::Proxy=false update \
    && apt-get -o Acquire::http::Proxy=false install -y --no-install-recommends fonts-wqy-microhei \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .
USER node

CMD ["npm", "run", "bot:poll"]
