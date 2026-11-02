
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const authRoutes = require('./routes/authRoutes');

const app = express();

// Parse incoming JSON requests
app.use(express.json());

// Health endpoint
app.get('/api/health', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'Campus Lost & Found API is running'
    });
});

// Prevent database requests until MongoDB is connected
app.use('/api/auth', (req, res, next) => {
    if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({
            success: false,
            error: {
                code: 'DATABASE_UNAVAILABLE',
                message: 'Database connection is not available yet.'
            }
        });
    }

    next();
});

// Authentication routes
app.use('/api/auth', authRoutes);

// Connect to MongoDB when credentials are available
if (process.env.MONGO_URI) {
    connectDB();
} else {
    console.log('MongoDB connection not configured yet.');
}

// Start Express
const PORT = process.env.PORT || 5000;

app.listen(PORT, '127.0.0.1', () => {
    console.log(`Server running on port ${PORT}`);
});

