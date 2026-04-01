const express = require('express');
const ConfigService = require('../services/ConfigService');

const authenticateSession = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    const configApiKey = ConfigService.getConfigValue('system.apiKey');
    if (apiKey && configApiKey && apiKey === configApiKey) {
        return next();
    }

    if (req.session.authenticated) {
        return next();
    }

    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ success: false, error: '未登录' });
    }
    res.redirect('/login');
};

const registerAuthRoutes = (app, publicDir) => {
    app.get('/', (req, res) => {
        if (!req.session.authenticated) {
            return res.redirect('/login');
        }
        res.sendFile(`${publicDir}\\index.html`);
    });

    app.get('/login', (req, res) => {
        res.sendFile(`${publicDir}\\login.html`);
    });

    app.post('/api/auth/login', (req, res) => {
        const { username, password } = req.body;
        if (
            username === ConfigService.getConfigValue('system.username') &&
            password === ConfigService.getConfigValue('system.password')
        ) {
            req.session.authenticated = true;
            req.session.username = username;
            return res.json({ success: true });
        }
        res.json({ success: false, error: '用户名或密码错误' });
    });

    app.use(express.static(publicDir));

    app.use((req, res, next) => {
        if (
            req.path === '/' ||
            req.path === '/login' ||
            req.path === '/api/health' ||
            req.path === '/api/auth/login' ||
            req.path.match(/\.(css|js|png|jpg|jpeg|gif|ico)$/)
        ) {
            return next();
        }
        authenticateSession(req, res, next);
    });
};

module.exports = {
    registerAuthRoutes,
    authenticateSession,
};
