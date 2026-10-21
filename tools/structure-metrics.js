#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const COVERAGE_SUMMARY = path.join(ROOT, 'coverage', 'coverage-summary.json');
const METRICS_VERSION = 1;
const LINE_LIMIT = 1500;

const FACADE_PAIRS = [
    {
        name: 'message',
        facade: 'src/services/message.js',
        authoritative: 'src/services/message/MessageManager.js',
    },
];

function fail(message) {
    console.error(`[structure-metrics] 错误: ${message}`);
    process.exit(2);
}

function toPosix(filePath) {
    return filePath.split(path.sep).join('/');
}

function relFromSrc(filePath) {
    return toPosix(path.relative(ROOT, filePath));
}

function walkJsFiles(dir, files = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist') {
            continue;
        }
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkJsFiles(entryPath, files);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            files.push(entryPath);
        }
    }
    return files;
}

function collectLineMetrics() {
    const files = walkJsFiles(SRC_DIR);
    let maxFileLines = 0;
    let maxFile = null;
    const overLimitFiles = [];
    const lineCounts = [];
    for (const filePath of files) {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').length;
        if (lines > maxFileLines) {
            maxFileLines = lines;
            maxFile = relFromSrc(filePath);
        }
        if (lines > LINE_LIMIT) {
            overLimitFiles.push({ file: relFromSrc(filePath), lines });
        }
        lineCounts.push({ file: relFromSrc(filePath), lines });
    }
    overLimitFiles.sort((a, b) => b.lines - a.lines);
    return { maxFileLines, maxFile, overLimitFiles, lineCounts };
}

function resolveRequire(fromFile, request) {
    if (!request.startsWith('.') && !request.startsWith('/')) {
        return null;
    }
    const baseDir = path.dirname(fromFile);
    const resolved = path.resolve(baseDir, request);
    const candidates = [
        `${resolved}.js`,
        `${resolved}.json`,
        path.join(resolved, 'index.js'),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
    }
    return null;
}

function collectModuleLevelRequires(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const targets = [];
    const topLevelRequireRegex = /^(?:const|let|var)\s+[^=]+=\s*require\(\s*['"]([^'"]+)['"]\s*\)/;
    for (const line of lines) {
        const match = line.match(topLevelRequireRegex);
        if (match) {
            const resolved = resolveRequire(filePath, match[1]);
            if (resolved) {
                targets.push(resolved);
            }
        }
    }
    return targets;
}

function buildDependencyGraph() {
    const files = walkJsFiles(SRC_DIR);
    const graph = new Map();
    for (const filePath of files) {
        graph.set(filePath, collectModuleLevelRequires(filePath));
    }
    return graph;
}

function findStronglyConnectedComponents(graph) {
    const indices = new Map();
    const lowlinks = new Map();
    const onStack = new Set();
    const stack = [];
    const components = [];
    let indexCounter = 0;

    const strongconnect = (node) => {
        const work = [[node, 0]];
        while (work.length > 0) {
            const frame = work[work.length - 1];
            const current = frame[0];
            const edgeIndex = frame[1];
            if (edgeIndex === 0) {
                indices.set(current, indexCounter);
                lowlinks.set(current, indexCounter);
                indexCounter += 1;
                stack.push(current);
                onStack.add(current);
            }
            const edges = graph.get(current) || [];
            let advanced = false;
            for (let i = edgeIndex; i < edges.length; i += 1) {
                if (!graph.has(edges[i])) {
                    continue;
                }
                if (!indices.has(edges[i])) {
                    frame[1] = i + 1;
                    work.push([edges[i], 0]);
                    advanced = true;
                    break;
                }
                if (onStack.has(edges[i])) {
                    lowlinks.set(current, Math.min(lowlinks.get(current), indices.get(edges[i])));
                }
            }
            if (advanced) {
                continue;
            }
            frame[1] = edges.length;
            if (lowlinks.get(current) === indices.get(current)) {
                const component = [];
                let popped;
                do {
                    popped = stack.pop();
                    onStack.delete(popped);
                    component.push(popped);
                } while (popped !== current);
                components.push(component);
            }
            work.pop();
            if (work.length > 0) {
                const parent = work[work.length - 1][0];
                lowlinks.set(parent, Math.min(lowlinks.get(parent), lowlinks.get(current)));
            }
        }
    };

    for (const node of graph.keys()) {
        if (!indices.has(node)) {
            strongconnect(node);
        }
    }
    return components;
}

function collectCircularDependencies() {
    const graph = buildDependencyGraph();
    const components = findStronglyConnectedComponents(graph);
    const cycles = [];
    for (const component of components) {
        const hasSelfLoop = component.some((node) => (graph.get(node) || []).includes(node));
        if (component.length > 1 || hasSelfLoop) {
            cycles.push(component.map(relFromSrc).sort());
        }
    }
    cycles.sort((a, b) => a[0].localeCompare(b[0]));
    return { count: cycles.length, cycles };
}

function collectEndpointsPerRouteFile() {
    const routesDir = path.join(SRC_DIR, 'routes');
    const files = walkJsFiles(routesDir);
    const perFile = [];
    const methodCallRegex = /\bapp\.(get|post|put|delete|patch)\s*\(/g;
    for (const filePath of files) {
        const content = fs.readFileSync(filePath, 'utf8');
        let registrations = 0;
        let match;
        while ((match = methodCallRegex.exec(content)) !== null) {
            registrations += 1;
        }
        perFile.push({ file: relFromSrc(filePath), endpointRegistrations: registrations });
    }
    perFile.sort((a, b) => b.endpointRegistrations - a.endpointRegistrations);
    return perFile;
}

function collectFacadeReferenceConvergence() {
    const results = [];
    const srcFiles = walkJsFiles(SRC_DIR);
    for (const pair of FACADE_PAIRS) {
        const facadePath = path.join(ROOT, pair.facade);
        const authoritativePath = path.join(ROOT, pair.authoritative);
        const facadeReferencers = [];
        const authoritativeReferencers = [];
        for (const filePath of srcFiles) {
            if (filePath === facadePath || filePath === authoritativePath) {
                continue;
            }
            const requires = collectModuleLevelRequires(filePath);
            if (requires.includes(facadePath)) {
                facadeReferencers.push(relFromSrc(filePath));
            }
            if (requires.includes(authoritativePath)) {
                authoritativeReferencers.push(relFromSrc(filePath));
            }
        }
        const total = facadeReferencers.length + authoritativeReferencers.length;
        const convergence = total > 0 ? authoritativeReferencers.length / total : null;
        results.push({
            name: pair.name,
            facade: pair.facade,
            authoritative: pair.authoritative,
            facadeReferencers: facadeReferencers.sort(),
            authoritativeReferencers: authoritativeReferencers.sort(),
            facadeReferenceCount: facadeReferencers.length,
            authoritativeReferenceCount: authoritativeReferencers.length,
            convergence: convergence === null ? null : Number(convergence.toFixed(4)),
        });
    }
    return results;
}

function collectCoverage(skipCoverage) {
    if (!fs.existsSync(COVERAGE_SUMMARY)) {
        if (skipCoverage) {
            return null;
        }
        fail(`覆盖率产物不存在: coverage/coverage-summary.json (先运行 npm run test:coverage, 或使用 --skip-coverage)`);
    }
    let summary;
    try {
        summary = JSON.parse(fs.readFileSync(COVERAGE_SUMMARY, 'utf8'));
    } catch (error) {
        fail(`覆盖率产物解析失败: ${error.message}`);
    }
    if (!summary || !summary.total || typeof summary.total !== 'object') {
        fail('覆盖率产物缺少 total 字段');
    }
    const pickPct = (section) => {
        const value = summary.total[section];
        if (!value || typeof value.pct !== 'number') {
            fail(`覆盖率产物缺少 ${section}.pct 字段`);
        }
        return value.pct;
    };
    return {
        statements: pickPct('statements'),
        branches: pickPct('branches'),
        functions: pickPct('functions'),
        lines: pickPct('lines'),
    };
}

function main() {
    const args = process.argv.slice(2);
    let outFile = null;
    let skipCoverage = false;
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '--out') {
            i += 1;
            if (i >= args.length || !args[i]) {
                fail('--out 需要一个输出文件路径参数');
            }
            outFile = args[i];
        } else if (args[i] === '--skip-coverage') {
            skipCoverage = true;
        } else {
            fail(`未知参数: ${args[i]}`);
        }
    }

    const lineMetrics = collectLineMetrics();
    const circular = collectCircularDependencies();
    const endpointsPerRouteFile = collectEndpointsPerRouteFile();
    const facadeConvergence = collectFacadeReferenceConvergence();
    const coverage = collectCoverage(skipCoverage);

    const report = {
        version: METRICS_VERSION,
        generatedAt: new Date().toISOString(),
        metrics: {
            lineLimit: LINE_LIMIT,
            maxFileLines: lineMetrics.maxFileLines,
            maxFile: lineMetrics.maxFile,
            overLimitFiles: lineMetrics.overLimitFiles,
            endpointsPerRouteFile,
            circularDependencyCount: circular.count,
            circularDependencies: circular.cycles,
            facadeReferenceConvergence: facadeConvergence,
            coverage,
        },
    };

    const json = JSON.stringify(report, null, 2);
    if (outFile) {
        const resolvedOut = path.resolve(ROOT, outFile);
        fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
        fs.writeFileSync(resolvedOut, `${json}\n`, 'utf8');
        console.log(`[structure-metrics] 度量已生成: ${outFile}`);
    } else {
        console.log(json);
    }
}

main();