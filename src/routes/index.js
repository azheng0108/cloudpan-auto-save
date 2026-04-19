const { registerAuthRoutes } = require('./auth');
const { registerApiRoutes } = require('./api');

const registerRoutes = (app, deps) => {
    registerAuthRoutes(app, deps.publicDir, deps.assetVersion || deps.currentVersion);
    registerApiRoutes(app, deps);
};

module.exports = {
    registerRoutes,
};
