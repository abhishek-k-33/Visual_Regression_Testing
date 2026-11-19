import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import apiRouter from './routes/api.js';
import viewRouter from './routes/views.js';
import { getDb } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static assets
app.use(express.static(path.join(__dirname, 'public')));

// Serve image storage directory directly at /storage, blocking database and non-image sensitive files
app.use('/storage', (req, res, next) => {
  // Prevent sensitive SQLite database leaks (.sqlite, .sqlite-wal, .sqlite-shm, .db, etc.)
  if (/\.(sqlite|db)(-.*)?$/i.test(req.path)) {
    return res.status(403).type('text/plain').send('Access denied');
  }
  next();
}, express.static(path.resolve(process.cwd(), 'storage')));

// Route mounting
app.use('/api', apiRouter);
app.use('/', viewRouter);

// Start server if executed directly
if (process.argv[1] && (process.argv[1].endsWith('app.js') || process.argv[1].endsWith('app'))) {
  getDb();
  app.listen(PORT, '0.0.0.0', () => {
    console.log('──────────────────────────────────────────────────────');
    console.log(`  Visual Regression Dashboard running at:`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  http://127.0.0.1:${PORT}`);
    console.log('──────────────────────────────────────────────────────');
  });
}

export default app;
