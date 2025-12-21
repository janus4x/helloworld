# Используем официальный образ Node.js
FROM node:18-alpine

# Устанавливаем рабочую директорию
WORKDIR /app

# Копируем package.json и package-lock.json (если есть)
COPY package*.json ./

# Устанавливаем зависимости
RUN npm ci --only=production && npm cache clean --force

# Копируем остальные файлы приложения
COPY . .

# Создаем директорию для статических файлов
RUN mkdir -p public

# Создаем непривилегированного пользователя для безопасности
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# Открываем порт (Coolify может использовать любой порт)
EXPOSE 3000

# Health check для Coolify
# Coolify автоматически использует healthcheck из docker-compose или настраивает свой
# Этот healthcheck работает с портом 3000 (по умолчанию)
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

# Запускаем приложение
CMD ["node", "server.js"]

