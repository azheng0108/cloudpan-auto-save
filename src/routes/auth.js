const express = require('express');
const path = require('path');
const ConfigService = require('../services/ConfigService');

const authenticateSession = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    const configApiKey = ConfigService.getConfigValue('system.apiKey');
    if (apiKey && configApiKey && apiKey === configApiKey) {
        return next();
    }

    if (req.session && req.session.authenticated) {
        return next();
    }

    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ success: false, error: '未登录' });
    }
    res.redirect('/login');
};

const registerAuthRoutes = (app, publicDir, assetVersion) => {
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

    app.post('/api/auth/logout', (req, res) => {
        if (req.session) {
            req.session.destroy(() => {
                res.clearCookie('connect.sid');
                res.json({ success: true });
            });
        } else {
            res.json({ success: true });
        }
    });

    app.get('/logout', (req, res) => {
        if (req.session) {
            req.session.destroy(() => {
                res.clearCookie('connect.sid');
                res.redirect('/login');
            });
        } else {
            res.redirect('/login');
        }
    });

    app.get('/api/auth/session', (req, res) => {
        res.json({
            success: true,
            authenticated: Boolean(req.session && req.session.authenticated),
            username: req.session ? req.session.username : null,
        });
    });

    app.get('/api/auth/wall-posters', async (req, res) => {
        try {
            const { TMDBService } = require('../services/tmdb');
            const tmdb = new TMDBService();
            const posters = await tmdb.getTrendingWallPosters();
            res.json({ success: true, data: posters || [] });
        } catch (_) {
            res.json({ success: true, data: [] });
        }
    });

    // 静态资源与免鉴权接口放行
    app.use((req, res, next) => {
        if (
            req.path === '/' ||
            req.path === '/login' ||
            req.path === '/logout' ||
            req.path === '/api/health' ||
            req.path === '/api/auth/login' ||
            req.path === '/api/auth/logout' ||
            req.path === '/api/auth/session' ||
            req.path === '/api/auth/wall-posters' ||
            req.path === '/api/webhook/emby' ||
            req.path.startsWith('/api/strm/stream') ||
            req.path.startsWith('/assets/') ||
            req.path.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|webmanifest|woff2?|ttf|map)$/i)
        ) {
            return next();
        }
        authenticateSession(req, res, next);
    });

    // 托管前端静态资源
    app.use(express.static(publicDir, {
        index: false,
        etag: true,
        lastModified: true,
        maxAge: '1d',
        setHeaders: (res, filePath) => {
            if (/\.(html)$/i.test(filePath)) {
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');
                res.setHeader('Surrogate-Control', 'no-store');
            }
        },
    }));
};

module.exports = {
    registerAuthRoutes,
    authenticateSession,
};
