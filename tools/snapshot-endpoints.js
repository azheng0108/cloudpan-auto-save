#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ROUTES_DIR = path.join(ROOT, 'src', 'routes');
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch']);
const SNAPSHOT_VERSION = 1;
const LINE_LIMIT = 1500;

function fail(message) {
    console.error(`[snapshot-endpoints] 错误: ${message}`);
    process.exit(2);
}

function toPosix(filePath) {
    return filePath.split(path.sep).join('/');
}

function relFromRoot(filePath) {
    return toPosix(path.relative(ROOT, filePath));
}

function classifyDomain(urlPath) {
    if (urlPath === '*' || urlPath === '/*' || urlPath === '(.*)') {
        return 'spa';
    }
    if (urlPath === '/logout' || urlPath.startsWith('/api/auth/')) {
        return 'auth';
    }
    if (!urlPath.startsWith('/api/')) {
        return null;
    }
    if (urlPath.startsWith('/api/accounts/:id/files')) {
        return 'files';
    }
    if (urlPath.startsWith('/api/channel-monitors') || urlPath.startsWith('/api/channel/')) {
        return 'channel';
    }
    if (urlPath.startsWith('/api/cloud139/')) {
        return 'files';
    }
    if (urlPath.startsWith('/api/jinja2/')) {
        return 'tasks';
    }
    if (urlPath.startsWith('/api/custom-push/')) {
        return 'settings';
    }
    if (urlPath.startsWith('/api/share/folders/')) {
        return 'files';
    }
    if (urlPath.startsWith('/api/saveFavorites') || urlPath.startsWith('/api/favorites') || urlPath.startsWith('/api/share/')) {
        return 'favorites';
    }
    const firstSegment = urlPath.slice('/api/'.length).split('/')[0];
    const segmentToDomain = {
        accounts: 'accounts',
        tasks: 'tasks',
        folders: 'files',
        folder: 'files',
        files: 'files',
        health: 'system',
        version: 'system',
        system: 'system',
        settings: 'settings',
        webhook: 'webhook',
        maintenance: 'maintenance',
        scrape: 'scrape',
        'tmdb-organize': 'tmdbOrganize',
        strm: 'strm',
        ai: 'ai',
        sync: 'sync',
        pansou: 'pansou',
    };
    return segmentToDomain[firstSegment] || null;
}

function skipWhitespace(content, index) {
    while (index < content.length && /\s/.test(content[index])) {
        index += 1;
    }
    return index;
}

function extractQuotedString(content, startIndex) {
    const quote = content[startIndex];
    if (quote !== '\'' && quote !== '"') {
        return null;
    }
    let index = startIndex + 1;
    let value = '';
    while (index < content.length) {
        const ch = content[index];
        if (ch === '\\') {
            value += ch + (content[index + 1] || '');
            index += 2;
            continue;
        }
        if (ch === quote) {
            return { value, endIndex: index + 1 };
        }
        value += ch;
        index += 1;
    }
    return null;
}

function extractBalancedArray(content, startIndex) {
    if (content[startIndex] !== '[') {
        return null;
    }
    let depth = 0;
    let index = startIndex;
    let inString = null;
    while (index < content.length) {
        const ch = content[index];
        if (inString) {
            if (ch === '\\') {
                index += 2;
                continue;
            }
            if (ch === inString) {
                inString = null;
            }
            index += 1;
            continue;
        }
        if (ch === '\'' || ch === '"') {
            inString = ch;
        } else if (ch === '[') {
            depth += 1;
        } else if (ch === ']') {
            depth -= 1;
            if (depth === 0) {
                return { text: content.slice(startIndex, index + 1), endIndex: index + 1 };
            }
        }
        index += 1;
    }
    return null;
}

function extractFirstPathArg(content, callStartIndex) {
    let index = skipWhitespace(content, callStartIndex);
    if (index >= content.length) {
        return null;
    }
    if (content[index] === '[') {
        const arrayMatch = extractBalancedArray(content, index);
        if (!arrayMatch) {
            return null;
        }
        const paths = [];
        const stringRegex = /['"]([^'"]*)['"]/g;
        let match;
        while ((match = stringRegex.exec(arrayMatch.text)) !== null) {
            paths.push(match[1]);
        }
        return paths.length > 0 ? paths : null;
    }
    const stringMatch = extractQuotedString(content, index);
    if (!stringMatch) {
        return null;
    }
    return [stringMatch.value];
}

function scanEndpointsInContent(content, sourceFile, state) {
    const methodCallRegex = /\bapp\.([a-zA-Z]+)\s*\(/g;
    let match;
    while ((match = methodCallRegex.exec(content)) !== null) {
        const method = match[1].toLowerCase();
        if (!HTTP_METHODS.has(method)) {
            continue;
        }
        const argStart = match.index + match[0].length;
        const paths = extractFirstPathArg(content, argStart);
        if (!paths) {
            fail(`无法解析路径参数 (${sourceFile}, 偏移 ${argStart}): ${content.slice(match.index, match.index + 80)}`);
        }
        for (const urlPath of paths) {
            const domain = classifyDomain(urlPath);
            if (!domain) {
                fail(`未知域归属: ${method.toUpperCase()} ${urlPath} (${sourceFile})`);
            }
            state.order += 1;
            state.endpoints.push({
                method: method.toUpperCase(),
                path: urlPath,
                domain,
                sourceFile,
                order: state.order,
            });
        }
    }
}

function collectDomainRegisterMap(content) {
    const requireRegex = /const\s*\{([^}]+)\}\s*=\s*require\('\.\/api\/([A-Za-z0-9_-]+)'\)/g;
    const registerToFile = new Map();
    let match;
    while ((match = requireRegex.exec(content)) !== null) {
        const names = match[1].split(',').map((s) => s.trim()).filter(Boolean);
        for (const name of names) {
            registerToFile.set(name, path.join(ROUTES_DIR, 'api', `${match[2]}.js`));
        }
    }
    return registerToFile;
}

function scanApiJsContent(content, sourceFile, state) {
    const registerToFile = collectDomainRegisterMap(content);
    const tokenRegex = /\bapp\.(get|post|put|delete|patch)\s*\(|\b(register[A-Za-z0-9]+Routes)\s*\(/g;
    let token;
    while ((token = tokenRegex.exec(content)) !== null) {
        if (token[1]) {
            const method = token[1];
            const argStart = token.index + token[0].length;
            const paths = extractFirstPathArg(content, argStart);
            if (!paths) {
                fail(`无法解析路径参数 (${sourceFile}, 偏移 ${argStart}): ${content.slice(token.index, token.index + 80)}`);
            }
            for (const urlPath of paths) {
                const domain = classifyDomain(urlPath);
                if (!domain) {
                    fail(`未知域归属: ${method.toUpperCase()} ${urlPath} (${sourceFile})`);
                }
                state.order += 1;
                state.endpoints.push({
                    method: method.toUpperCase(),
                    path: urlPath,
                    domain,
                    sourceFile,
                    order: state.order,
                });
            }
        } else if (token[2]) {
            const domainFile = registerToFile.get(token[2]);
            if (domainFile) {
                if (!fs.existsSync(domainFile)) {
                    fail(`域路由文件不存在: ${relFromRoot(domainFile)} (由 ${sourceFile} 的 ${token[2]} 引用)`);
                }
                const domainContent = fs.readFileSync(domainFile, 'utf8');
                scanEndpointsInContent(domainContent, relFromRoot(domainFile), state);
            }
        }
    }
}

function scanRouteFile(filePath, state) {
    if (!fs.existsSync(filePath)) {
        fail(`路由文件不存在: ${relFromRoot(filePath)}`);
    }
    const content = fs.readFileSync(filePath, 'utf8');
    scanEndpointsInContent(content, relFromRoot(filePath), state);
}

function generateSnapshot() {
    const state = { order: 0, endpoints: [] };
    scanRouteFile(path.join(ROUTES_DIR, 'auth.js'), state);
    const apiJsPath = path.join(ROUTES_DIR, 'api.js');
    if (!fs.existsSync(apiJsPath)) {
        fail('路由文件不存在: src/routes/api.js');
    }
    scanApiJsContent(fs.readFileSync(apiJsPath, 'utf8'), 'src/routes/api.js', state);
    scanRouteFile(path.join(ROUTES_DIR, 'index.js'), state);
    return {
        version: SNAPSHOT_VERSION,
        generatedAt: new Date().toISOString(),
        lineLimit: LINE_LIMIT,
        endpoints: state.endpoints,
    };
}

function validateSnapshotShape(snapshot, label) {
    if (!snapshot || typeof snapshot !== 'object') {
        fail(`${label} 不是合法 JSON 对象`);
    }
    if (!Number.isInteger(snapshot.version) || snapshot.version <= 0) {
        fail(`${label} 缺少合法 version 字段`);
    }
    if (!Array.isArray(snapshot.endpoints)) {
        fail(`${label} 缺少 endpoints 数组`);
    }
    for (const endpoint of snapshot.endpoints) {
        if (!endpoint || typeof endpoint !== 'object') {
            fail(`${label} 存在非法端点条目`);
        }
        if (typeof endpoint.method !== 'string' || !/^(GET|POST|PUT|DELETE|PATCH)$/.test(endpoint.method)) {
            fail(`${label} 存在非法 method 字段: ${JSON.stringify(endpoint.method)}`);
        }
        if (typeof endpoint.path !== 'string' || endpoint.path.length === 0) {
            fail(`${label} 存在非法 path 字段`);
        }
        if (typeof endpoint.domain !== 'string' || endpoint.domain.length === 0) {
            fail(`${label} 存在非法 domain 字段`);
        }
        if (!Number.isInteger(endpoint.order) || endpoint.order <= 0) {
            fail(`${label} 存在非法 order 字段: ${JSON.stringify(endpoint.order)}`);
        }
    }
}

function keyOf(endpoint) {
    return `${endpoint.method} ${endpoint.path}`;
}

function compareSnapshots(baseline, current) {
    const diffs = [];
    const baselineKeys = new Set(baseline.endpoints.map(keyOf));
    const currentKeys = new Set(current.endpoints.map(keyOf));

    for (const key of baselineKeys) {
        if (!currentKeys.has(key)) {
            diffs.push(`端点缺失: ${key}`);
        }
    }
    for (const key of currentKeys) {
        if (!baselineKeys.has(key)) {
            diffs.push(`端点新增: ${key}`);
        }
    }

    const baselineBykey = new Map(baseline.endpoints.map((e) => [keyOf(e), e]));
    const currentByKey = new Map(current.endpoints.map((e) => [keyOf(e), e]));
    for (const [key, baselineEndpoint] of baselineBykey) {
        const currentEndpoint = currentByKey.get(key);
        if (!currentEndpoint) {
            continue;
        }
        if (baselineEndpoint.domain !== currentEndpoint.domain) {
            diffs.push(`域归属变更: ${key}: ${baselineEndpoint.domain} -> ${currentEndpoint.domain}`);
        }
    }

    const domainsOf = (snapshot) => {
        const domainOrder = [];
        const seen = new Set();
        const sorted = [...snapshot.endpoints].sort((a, b) => a.order - b.order);
        for (const endpoint of sorted) {
            if (!seen.has(endpoint.domain)) {
                seen.add(endpoint.domain);
                domainOrder.push(endpoint.domain);
            }
        }
        return domainOrder;
    };
    const baselineDomainOrder = domainsOf(baseline);
    const currentDomainOrder = domainsOf(current);
    if (baselineDomainOrder.join('|') !== currentDomainOrder.join('|')) {
        diffs.push(`域间注册顺序变更: ${baselineDomainOrder.join(' -> ')} / 现状: ${currentDomainOrder.join(' -> ')}`);
    }

    const endpointsByDomain = (snapshot) => {
        const grouped = new Map();
        const sorted = [...snapshot.endpoints].sort((a, b) => a.order - b.order);
        for (const endpoint of sorted) {
            if (!grouped.has(endpoint.domain)) {
                grouped.set(endpoint.domain, []);
            }
            grouped.get(endpoint.domain).push(keyOf(endpoint));
        }
        return grouped;
    };
    const baselineGrouped = endpointsByDomain(baseline);
    const currentGrouped = endpointsByDomain(current);
    for (const [domain, baselineSequence] of baselineGrouped) {
        const currentSequence = currentGrouped.get(domain);
        if (!currentSequence) {
            diffs.push(`域整体缺失: ${domain}`);
            continue;
        }
        if (baselineSequence.length !== currentSequence.length) {
            diffs.push(`域 ${domain} 端点数量变更: ${baselineSequence.length} -> ${currentSequence.length}`);
            continue;
        }
        for (let i = 0; i < baselineSequence.length; i += 1) {
            if (baselineSequence[i] !== currentSequence[i]) {
                diffs.push(`域 ${domain} 内注册顺序变更: 位置 ${i + 1}: ${baselineSequence[i]} -> ${currentSequence[i]}`);
            }
        }
    }
    for (const domain of currentGrouped.keys()) {
        if (!baselineGrouped.has(domain)) {
            diffs.push(`域整体新增: ${domain}`);
        }
    }
    return diffs;
}

function main() {
    const args = process.argv.slice(2);
    let compareFile = null;
    let outFile = null;
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '--compare') {
            i += 1;
            if (i >= args.length || !args[i]) {
                fail('--compare 需要一个基准快照文件路径参数');
            }
            compareFile = args[i];
        } else if (args[i] === '--out') {
            i += 1;
            if (i >= args.length || !args[i]) {
                fail('--out 需要一个输出文件路径参数');
            }
            outFile = args[i];
        } else {
            fail(`未知参数: ${args[i]}`);
        }
    }

    let snapshot;
    try {
        snapshot = generateSnapshot();
    } catch (error) {
        fail(`扫描失败: ${error.message}`);
        return;
    }
    validateSnapshotShape(snapshot, '当前快照');

    if (compareFile) {
        const resolvedCompare = path.resolve(ROOT, compareFile);
        if (!fs.existsSync(resolvedCompare)) {
            fail(`基准快照文件不存在: ${compareFile}`);
        }
        let baseline;
        try {
            baseline = JSON.parse(fs.readFileSync(resolvedCompare, 'utf8'));
        } catch (error) {
            fail(`基准快照解析失败: ${error.message}`);
        }
        if (baseline && typeof baseline === 'object' && baseline.endpointSnapshot && typeof baseline.endpointSnapshot === 'object') {
            baseline = baseline.endpointSnapshot;
        }
        validateSnapshotShape(baseline, `基准快照(${compareFile})`);
        const diffs = compareSnapshots(baseline, snapshot);
        if (baseline.version !== snapshot.version) {
            diffs.push(`快照版本不一致: 基线 v${baseline.version} / 现状 v${snapshot.version}`);
        }
        if (diffs.length === 0) {
            console.log(`[snapshot-endpoints] 比对通过: ${snapshot.endpoints.length} 个端点与基线一致 (方法/路径/域归属/顺序)`);
            process.exit(0);
        }
        console.error(`[snapshot-endpoints] 比对失败, 共 ${diffs.length} 处差异:`);
        for (const diff of diffs) {
            console.error(`  - ${diff}`);
        }
        process.exit(1);
    }

    const json = JSON.stringify(snapshot, null, 2);
    if (outFile) {
        const resolvedOut = path.resolve(ROOT, outFile);
        fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
        fs.writeFileSync(resolvedOut, `${json}\n`, 'utf8');
        console.log(`[snapshot-endpoints] 已生成 ${snapshot.endpoints.length} 个端点的快照: ${outFile}`);
    } else {
        console.log(json);
    }
}

main();
