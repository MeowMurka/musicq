FROM node:20-bookworm-slim

WORKDIR /app

# Системные зависимости
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Устанавливаем прод-зависимости (lock-файла нет — используем npm install)
COPY package.json ./
RUN npm install --omit=dev

# Prisma client
COPY prisma ./prisma
RUN npx prisma generate

# Исходники
COPY src ./src

ENV PORT=8080
EXPOSE 8080

# Директории под файлы
RUN mkdir -p /app/data/current /app/data/queue

# Для демо (без миграций): применяем схему перед стартом
CMD npx prisma db push && node src/index.js

