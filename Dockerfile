FROM node:20-slim

# Ambil binary telegram-bot-api yang udah di-compile dari image resmi,
# biar gak perlu compile dari source sendiri (lama & berat prosesnya).
COPY --from=aiogram/telegram-bot-api:latest /usr/local/bin/telegram-bot-api /usr/local/bin/telegram-bot-api

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

CMD ["node", "bot.js"]
