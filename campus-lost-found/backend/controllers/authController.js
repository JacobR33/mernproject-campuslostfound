
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// REGISTER API
async function register(req, res) {
    try {
        const { firstName, lastName, email, password } = req.body;

        // Validate incoming JSON
        if (
            typeof firstName !== 'string' ||
            !firstName.trim() ||
            typeof lastName !== 'string' ||
            !lastName.trim() ||
            typeof email !== 'string' ||
            typeof password !== 'string' ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
            password.length < 8
        ) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Valid name, email, and password of at least 8 characters are required.'
                }
            });
        }

        const normalizedEmail = email.trim().toLowerCase();

        // Check if user already exists
        const existingUser = await User.findOne({
            email: normalizedEmail
        });

        if (existingUser) {
            return res.status(409).json({
                success: false,
                error: {
                    code: 'EMAIL_ALREADY_EXISTS',
                    message: 'An account with this email already exists.'
                }
            });
        }

        // Hash password before saving
        const passwordHash = await bcrypt.hash(password, 10);

        // Insert user into MongoDB
        const newUser = await User.create({
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            email: normalizedEmail,
            passwordHash
        });

        return res.status(201).json({
            success: true,
            message: 'Account created successfully',
            user: {
                id: newUser._id.toString(),
                firstName: newUser.firstName,
                lastName: newUser.lastName,
                email: newUser.email,
                isEmailVerified: newUser.isEmailVerified
            }
        });

    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({
                success: false,
                error: {
                    code: 'EMAIL_ALREADY_EXISTS',
                    message: 'An account with this email already exists.'
                }
            });
        }

        console.error('Registration error:', error);
        return res.status(500).json({
            success: false,
            error: {
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Registration failed.'
            }
        });
    }
}

// LOGIN API
async function login(req, res) {
    try {
        const { email, password } = req.body;

        if (
            typeof email !== 'string' ||
            typeof password !== 'string' ||
            !email.trim() ||
            !password
        ) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Email and password are required.'
                }
            });
        }

        // Find user in MongoDB
        const user = await User.findOne({
            email: email.trim().toLowerCase()
        });

        // Check credentials
        const validPassword = user
            ? await bcrypt.compare(password, user.passwordHash)
            : false;

        if (!user || !validPassword) {
            return res.status(401).json({
                success: false,
                error: {
                    code: 'INVALID_CREDENTIALS',
                    message: 'Invalid email or password.'
                }
            });
        }

        // Enable this requirement when email verification is implemented
        if (
            process.env.REQUIRE_EMAIL_VERIFICATION === 'true' &&
            !user.isEmailVerified
        ) {
            return res.status(403).json({
                success: false,
                error: {
                    code: 'EMAIL_NOT_VERIFIED',
                    message: 'Please verify your email before logging in.'
                }
            });
        }

        if (!process.env.JWT_SECRET) {
            throw new Error('JWT_SECRET is not configured');
        }

        // Generate authentication token
        const accessToken = jwt.sign(
            { userId: user._id.toString() },
            process.env.JWT_SECRET,
            { expiresIn: '1h' }
        );

        return res.status(200).json({
            success: true,
            message: 'Login successful',
            accessToken,
            user: {
                id: user._id.toString(),
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                isEmailVerified: user.isEmailVerified
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({
            success: false,
            error: {
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Login failed.'
            }
        });
    }
}

module.exports = { register, login };
