# Используем официальный образ Node.js
FROM node:18-alpine

# Устанавливаем рабочую директорию
WORKDIR /app

# Копируем package.json и package-lock.json (если есть)
COPY package*.json ./

# Устанавливаем зависимости
RUN npm ci --only=production

# Копируем остальные файлы приложения
COPY . .

# Создаем директорию для статических файлов
RUN mkdir -p public

# Открываем порт
EXPOSE 3000

# Запускаем приложение
CMD ["node", "server.js"]

