FROM node:20-alpine

# Ambil binary telegram-bot-api yang udah di-compile dari image resmi.
# PENTING: base image di sini HARUS Alpine (bukan Debian/slim), soalnya
# binary telegram-bot-api dikompilasi buat Alpine (pakai musl libc) --
# kalau base image-nya Debian, binary ini gak akan bisa dieksekusi
# (errornya keliatan kayak "ENOENT" padahal file-nya ada, itu penyebabnya).
COPY --from=aiogram/telegram-bot-api:latest /usr/local/bin/telegram-bot-api /usr/local/bin/telegram-bot-api

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

CMD ["node", "bot.js"]
