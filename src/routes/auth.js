const express = require('express');
const fs = require('fs').promises;
const path = require('path');
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

const renderHtmlWithVersion = async (res, filePath, assetVersion) => {
    let html = await fs.readFile(filePath, 'utf8');
    html = html.replace(/__ASSET_VERSION__/g, String(assetVersion || 'dev'));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
};

const registerAuthRoutes = (app, publicDir, assetVersion) => {
    app.get('/', async (req, res) => {
        if (!req.session.authenticated) {
            return res.redirect('/login');
        }
        try {
            await renderHtmlWithVersion(res, path.join(publicDir, 'index.html'), assetVersion);
        } catch (error) {
            res.status(500).send('页面加载失败');
        }
    });

    app.get('/login', async (req, res) => {
        try {
            await renderHtmlWithVersion(res, path.join(publicDir, 'login.html'), assetVersion);
        } catch (error) {
            res.status(500).send('页面加载失败');
        }
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
