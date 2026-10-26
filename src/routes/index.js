const path = require('path');
const { registerAuthRoutes } = require('./auth');
const { registerApiRoutes } = require('./api');

const registerRoutes = (app, deps) => {
    registerAuthRoutes(app, deps.publicDir, deps.assetVersion || deps.currentVersion);
    registerApiRoutes(app, deps);

    // SPA 路由兜底：非 API 请求且非静态文件，未认证重定向至 /login，已认证统一返回 Vue SPA 的 index.html
    app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api/')) {
            return next();
        }
        if (!req.session || !req.session.authenticated) {
            if (req.path !== '/login') {
                return res.redirect('/login');
            }
        }
        const indexPath = path.join(deps.publicDir, 'index.html');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.sendFile(indexPath, (err) => {
            if (err) {
                res.status(500).send('页面加载失败，请确保前端已构建 (npm run build)');
            }
        });
    });
};

module.exports = {
    registerRoutes,
};
