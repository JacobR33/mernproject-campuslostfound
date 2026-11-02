
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    firstName: {
        type: String,
        required: true,
        trim: true
    },

    lastName: {
        type: String,
        required: true,
        trim: true
    },

    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },

    passwordHash: {
        type: String,
        required: true
    },

    role: {
        type: String,
        enum: ['user', 'admin'],
        default: 'user'
    },

    isEmailVerified: {
        type: Boolean,
        default: false
    },

    emailVerificationTokenHash: String,
    emailVerificationExpires: Date,

    resetPasswordTokenHash: String,
    resetPasswordExpires: Date

}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
