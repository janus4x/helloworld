const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://mongodb:27017/helloworld';

// Middleware
app.use(express.json());
app.use(express.static('public'));

// MongoDB Connection
let dbStatus = {
  connected: false,
  error: null,
  connectionTime: null
};

const connectDB = async (retries = 5, delay = 2000) => {
  for (let i = 0; i < retries; i++) {
    try {
      await mongoose.connect(MONGODB_URI, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      });
      dbStatus.connected = true;
      dbStatus.error = null;
      dbStatus.connectionTime = new Date().toISOString();
      console.log('✅ MongoDB подключена успешно');
      return;
    } catch (error) {
      dbStatus.connected = false;
      dbStatus.error = error.message;
      console.error(`❌ Попытка ${i + 1}/${retries} подключения к MongoDB не удалась:`, error.message);
      
      if (i < retries - 1) {
        console.log(`⏳ Повторная попытка через ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.error('❌ Не удалось подключиться к MongoDB после всех попыток');
      }
    }
  }
};

// Обработка событий подключения
mongoose.connection.on('connected', () => {
  dbStatus.connected = true;
  dbStatus.error = null;
  dbStatus.connectionTime = new Date().toISOString();
  console.log('✅ MongoDB подключена (событие)');
});

mongoose.connection.on('error', (err) => {
  dbStatus.connected = false;
  dbStatus.error = err.message;
  console.error('❌ Ошибка MongoDB:', err.message);
});

mongoose.connection.on('disconnected', () => {
  dbStatus.connected = false;
  console.log('⚠️ MongoDB отключена');
});

// Модель для хранения статистики
const VisitSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  ip: String,
  userAgent: String
});

const Visit = mongoose.model('Visit', VisitSchema);

// Статистика приложения
const appStats = {
  startTime: new Date(),
  totalRequests: 0,
  healthChecks: 0,
  apiCalls: 0
};

// Middleware для подсчета запросов
app.use((req, res, next) => {
  appStats.totalRequests++;
  if (req.path === '/api/health') {
    appStats.healthChecks++;
  } else if (req.path.startsWith('/api/')) {
    appStats.apiCalls++;
  }
  next();
});

// Главная страница
app.get('/', async (req, res) => {
  try {
    // Сохраняем визит в БД
    if (dbStatus.connected) {
      const visit = new Visit({
        ip: req.ip || req.connection.remoteAddress,
        userAgent: req.get('user-agent')
      });
      await visit.save().catch(err => console.error('Ошибка сохранения визита:', err));
    }
    
    res.sendFile(__dirname + '/public/index.html');
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API для получения информации о системе
app.get('/api/system', (req, res) => {
  const uptime = process.uptime();
  const memory = process.memoryUsage();
  
  res.json({
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    uptime: {
      seconds: Math.floor(uptime),
      formatted: formatUptime(uptime)
    },
    memory: {
      rss: formatBytes(memory.rss),
      heapTotal: formatBytes(memory.heapTotal),
      heapUsed: formatBytes(memory.heapUsed),
      external: formatBytes(memory.external)
    },
    pid: process.pid,
    env: process.env.NODE_ENV || 'development'
  });
});

// API для получения статуса MongoDB
app.get('/api/mongodb', async (req, res) => {
  let dbInfo = null;
  
  if (dbStatus.connected && mongoose.connection.readyState === 1) {
    try {
      const db = mongoose.connection.db;
      const adminDb = db.admin();
      const serverStatus = await adminDb.serverStatus();
      const collections = await db.listCollections().toArray();
      
      // Подсчет визитов
      const visitCount = await Visit.countDocuments();
      
      dbInfo = {
        status: 'connected',
        host: mongoose.connection.host,
        port: mongoose.connection.port,
        database: mongoose.connection.name,
        collections: collections.map(c => c.name),
        visitCount: visitCount,
        serverVersion: serverStatus.version,
        uptime: serverStatus.uptime,
        connections: serverStatus.connections
      };
    } catch (error) {
      dbInfo = {
        status: 'connected',
        error: error.message
      };
    }
  } else {
    dbInfo = {
      status: 'disconnected',
      error: dbStatus.error || 'Не подключено'
    };
  }
  
  res.json({
    ...dbStatus,
    info: dbInfo
  });
});

// API для получения статистики приложения
app.get('/api/stats', async (req, res) => {
  let visitCount = 0;
  let lastVisits = [];
  
  if (dbStatus.connected) {
    try {
      visitCount = await Visit.countDocuments();
      lastVisits = await Visit.find()
        .sort({ timestamp: -1 })
        .limit(10)
        .select('timestamp ip userAgent')
        .lean();
    } catch (error) {
      console.error('Ошибка получения статистики:', error);
    }
  }
  
  res.json({
    ...appStats,
    visitCount: visitCount,
    lastVisits: lastVisits,
    currentTime: new Date().toISOString()
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    checks: {
      database: dbStatus.connected ? 'ok' : 'error',
      server: 'ok'
    }
  };
  
  const statusCode = health.checks.database === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

// Вспомогательные функции
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (days > 0) {
    return `${days}д ${hours}ч ${minutes}м ${secs}с`;
  } else if (hours > 0) {
    return `${hours}ч ${minutes}м ${secs}с`;
  } else if (minutes > 0) {
    return `${minutes}м ${secs}с`;
  } else {
    return `${secs}с`;
  }
}

// Запуск сервера
app.listen(PORT, async () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📊 Откройте http://localhost:${PORT} для просмотра`);
  await connectDB();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM получен, закрываем соединения...');
  await mongoose.connection.close();
  process.exit(0);
});

