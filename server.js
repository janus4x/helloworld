const express = require('express');
const mongoose = require('mongoose');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
// Поддержка динамического порта для Coolify и других PaaS
const PORT = process.env.PORT || 3000;
// MONGODB_URI должен быть установлен через переменные окружения в Coolify
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://mongodb:27017/helloworld';
// PostgreSQL connection string через переменную окружения
const POSTGRES_URI = process.env.POSTGRES_URI || process.env.DATABASE_URL;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// MongoDB Connection
let dbStatus = {
  connected: false,
  error: null,
  connectionTime: null
};

// PostgreSQL Connection
let pgStatus = {
  connected: false,
  error: null,
  connectionTime: null
};

let pgPool = null;

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

// PostgreSQL Connection
const connectPostgreSQL = async () => {
  if (!POSTGRES_URI) {
    pgStatus.connected = false;
    pgStatus.error = 'POSTGRES_URI не установлен';
    console.log('⚠️ PostgreSQL URI не установлен, пропускаем подключение');
    return;
  }

  try {
    pgPool = new Pool({
      connectionString: POSTGRES_URI,
      // Настройки пула подключений
      max: 10, // максимальное количество клиентов в пуле
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    // Тестируем подключение
    const client = await pgPool.connect();
    await client.query('SELECT NOW()');
    client.release();

    pgStatus.connected = true;
    pgStatus.error = null;
    pgStatus.connectionTime = new Date().toISOString();
    console.log('✅ PostgreSQL подключена успешно');

    // Обработка ошибок пула
    pgPool.on('error', (err) => {
      pgStatus.connected = false;
      pgStatus.error = err.message;
      console.error('❌ Ошибка PostgreSQL пула:', err.message);
    });
  } catch (error) {
    pgStatus.connected = false;
    pgStatus.error = error.message;
    console.error('❌ Ошибка подключения к PostgreSQL:', error.message);
    // Закрываем пул при ошибке
    if (pgPool) {
      try {
        await pgPool.end();
        pgPool = null;
      } catch (err) {
        console.error('Ошибка закрытия пула PostgreSQL:', err);
      }
    }
  }
};

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

// Функция для сохранения визита (асинхронная, не блокирует ответ)
const saveVisit = async (req) => {
  // Проверяем готовность БД более надежно
  // readyState: 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
  const isDbReady = dbStatus.connected && mongoose.connection.readyState === 1;
  
  if (!isDbReady) {
    // Если БД не готова, пытаемся подключиться только если соединение не установлено и не в процессе
    if (mongoose.connection.readyState === 0) {
      // Соединение не установлено, пытаемся подключиться (быстрая попытка)
      try {
        await mongoose.connect(MONGODB_URI, {
          serverSelectionTimeoutMS: 2000,
          socketTimeoutMS: 45000,
        });
        // Если подключение успешно, продолжаем сохранение
      } catch (error) {
        // БД недоступна, пропускаем сохранение визита
        return;
      }
    } else {
      // БД в процессе подключения или отключения, пропускаем сохранение
      return;
    }
  }

  // Проверяем еще раз после возможного подключения
  if (mongoose.connection.readyState !== 1) {
    return;
  }

  try {
    const clientIp = req.ip || 
                     req.connection.remoteAddress || 
                     req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                     'unknown';
    
    const visit = new Visit({
      ip: clientIp,
      userAgent: req.get('user-agent') || 'unknown'
    });
    await visit.save();
    console.log('✅ Визит сохранен:', visit.ip, new Date(visit.timestamp).toLocaleString('ru-RU'));
  } catch (error) {
    console.error('❌ Ошибка сохранения визита:', error.message);
  }
};

// Главная страница
app.get('/', async (req, res) => {
  try {
    // Сохраняем визит в БД (асинхронно, не блокируя ответ)
    saveVisit(req).catch(err => console.error('Ошибка в saveVisit:', err));
    
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

// API для получения статуса PostgreSQL
app.get('/api/postgresql', async (req, res) => {
  let pgInfo = null;
  
  if (!POSTGRES_URI) {
    pgInfo = {
      status: 'not_configured',
      error: 'POSTGRES_URI не установлен в переменных окружения'
    };
    res.json({
      ...pgStatus,
      info: pgInfo
    });
    return;
  }

  if (pgStatus.connected && pgPool) {
    try {
      const client = await pgPool.connect();
      
      // Получаем информацию о версии PostgreSQL
      const versionResult = await client.query('SELECT version()');
      const version = versionResult.rows[0].version;
      
      // Получаем текущую базу данных
      const dbResult = await client.query('SELECT current_database()');
      const database = dbResult.rows[0].current_database;
      
      // Получаем количество активных подключений
      const connectionsResult = await client.query(
        'SELECT count(*) as count FROM pg_stat_activity WHERE state = $1',
        ['active']
      );
      const activeConnections = parseInt(connectionsResult.rows[0].count);
      
      // Получаем размер базы данных
      const sizeResult = await client.query(
        'SELECT pg_size_pretty(pg_database_size($1)) as size',
        [database]
      );
      const dbSize = sizeResult.rows[0].size;
      
      // Получаем список таблиц
      const tablesResult = await client.query(
        `SELECT table_name FROM information_schema.tables 
         WHERE table_schema = 'public' 
         ORDER BY table_name`
      );
      const tables = tablesResult.rows.map(row => row.table_name);
      
      client.release();
      
      pgInfo = {
        status: 'connected',
        database: database,
        version: version,
        activeConnections: activeConnections,
        dbSize: dbSize,
        tables: tables,
        tableCount: tables.length
      };
    } catch (error) {
      pgInfo = {
        status: 'error',
        error: error.message
      };
      pgStatus.connected = false;
      pgStatus.error = error.message;
    }
  } else {
    pgInfo = {
      status: 'disconnected',
      error: pgStatus.error || 'Не подключено'
    };
  }
  
  res.json({
    ...pgStatus,
    info: pgInfo
  });
});

// API для получения статистики приложения
app.get('/api/stats', async (req, res) => {
  let visitCount = 0;
  let lastVisits = [];
  
  // Проверяем готовность БД более надежно
  if (dbStatus.connected && mongoose.connection.readyState === 1) {
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
      mongodb: dbStatus.connected ? 'ok' : 'error',
      postgresql: POSTGRES_URI ? (pgStatus.connected ? 'ok' : 'error') : 'not_configured',
      server: 'ok'
    }
  };
  
  // Определяем общий статус: ok если все настроенные БД подключены
  const allConfiguredDBsOk = health.checks.mongodb === 'ok' && 
    (health.checks.postgresql === 'ok' || health.checks.postgresql === 'not_configured');
  
  const statusCode = allConfiguredDBsOk ? 200 : 503;
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
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📊 Приложение доступно на порту ${PORT}`);
  console.log(`🔗 MongoDB URI: ${MONGODB_URI.replace(/\/\/.*@/, '//***:***@')}`); // Скрываем пароль в логах
  if (POSTGRES_URI) {
    console.log(`🐘 PostgreSQL URI: ${POSTGRES_URI.replace(/\/\/.*@/, '//***:***@')}`); // Скрываем пароль в логах
  } else {
    console.log(`⚠️ PostgreSQL URI не установлен (POSTGRES_URI или DATABASE_URL)`);
  }
  console.log(`🌍 NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
  await connectDB();
  await connectPostgreSQL();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM получен, закрываем соединения...');
  await mongoose.connection.close();
  if (pgPool) {
    await pgPool.end();
  }
  process.exit(0);
});

