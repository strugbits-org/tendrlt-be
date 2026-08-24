const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const authRoutes          = require('./routes/auth');
const providersRoutes     = require('./routes/providers');
const servicesRoutes      = require('./routes/services');
const tendersRoutes       = require('./routes/tenders');
const adminRoutes         = require('./routes/admin');
const quotesRoutes        = require('./routes/quotes');
const notificationsRoutes = require('./routes/notifications');
const pushRoutes          = require('./routes/push');
const contactRoutes       = require('./routes/contact');
const feedbackRoutes      = require('./routes/feedback');
const feesRoutes          = require('./routes/fees');

const app = express();
const PORT = process.env.PORT || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
  const connectionString = process.env.DATABASE_URL;
// Middlewares
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Static files (if needed)
app.use(express.static(path.join(__dirname, 'public')));

// Mount routes
app.use('/api/auth',          authRoutes);
app.use('/api/providers',     providersRoutes);
app.use('/api/services',      servicesRoutes);
app.use('/api/tenders',       tendersRoutes);
app.use('/api/admin',         adminRoutes);
app.use('/api/quotes',        quotesRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/push',          pushRoutes);
app.use('/api/contact',       contactRoutes);
app.use('/api/feedback',      feedbackRoutes);
app.use('/api/fees',          feesRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

// Root route
app.get('/', (req, res) => {
  res.send(`TendrIt Backend API is running.`);
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err.stack);
  res.status(500).json({ success: false, message: 'Something went wrong on the server!' });
});

// Start Server
const { startFeeScheduler } = require('./lib/feeScheduler');

app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`  TendrIt Auth Backend Service started   `);
  console.log(`  Listening on port: ${PORT}             `);
  console.log(`  Allowed Origin: ${FRONTEND_URL}        `);
  console.log(`=========================================`);
  // Activate any due scheduled platform-fee change now, then daily at 00:05 Jamaica.
  startFeeScheduler();
});
