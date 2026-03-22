/**
 * Lobsterr ローカルサーバー
 * npm不要 — Node.js組み込みモジュールのみ使用
 * 起動: node ~/Desktop/server.js
 * アクセス: http://localhost:3001/lobsterr.html
 */
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = process.env.PORT || 3001;
const DIR  = __dirname;

const CORS_HEADERS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.svg':  'image/svg+xml',
};

function proxyToAnthropic(reqBody, res) {
    let payload;
    try {
        payload = JSON.parse(reqBody);
    } catch {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
        return;
    }

    const apiKey = payload.apiKey;
    delete payload.apiKey;

    if (!apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ error: { message: 'APIキーが未設定です' } }));
        return;
    }

    const postData = JSON.stringify(payload);
    const options  = {
        hostname: 'api.anthropic.com',
        path:     '/v1/messages',
        method:   'POST',
        headers:  {
            'Content-Type':    'application/json',
            'Content-Length':  Buffer.byteLength(postData),
            'x-api-key':       apiKey,
            'anthropic-version': '2023-06-01',
        },
    };

    const apiReq = https.request(options, apiRes => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
            res.writeHead(apiRes.statusCode, {
                'Content-Type': 'application/json',
                ...CORS_HEADERS,
            });
            res.end(data);
        });
    });

    apiReq.on('error', err => {
        res.writeHead(502, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ error: { message: err.message } }));
    });

    apiReq.write(postData);
    apiReq.end();
}

// 記事本文をURLから取得（リダイレクト対応、最大3回）
function fetchArticleUrl(targetUrl, res, redirectCount = 0) {
    if (redirectCount > 3) {
        res.writeHead(502, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ error: 'Too many redirects' }));
        return;
    }

    let parsed;
    try { parsed = new URL(targetUrl); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ error: 'Invalid URL' }));
        return;
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        method:   'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept':     'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 10000,
    };

    const req2 = lib.request(options, r => {
        // Follow redirects
        if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) {
            const next = r.headers.location.startsWith('http')
                ? r.headers.location
                : `${parsed.protocol}//${parsed.hostname}${r.headers.location}`;
            r.resume();
            fetchArticleUrl(next, res, redirectCount + 1);
            return;
        }

        const chunks = [];
        r.on('data', chunk => chunks.push(chunk));
        r.on('end', () => {
            const html = Buffer.concat(chunks).toString('utf-8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS });
            res.end(html);
        });
    });

    req2.on('error', err => {
        res.writeHead(502, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ error: err.message }));
    });
    req2.on('timeout', () => {
        req2.destroy();
        res.writeHead(504, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ error: 'Timeout' }));
    });
    req2.end();
}

const server = http.createServer((req, res) => {
    // Preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }

    // Claude API proxy
    if (req.method === 'POST' && req.url === '/api/claude') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => proxyToAnthropic(body, res));
        return;
    }

    // RSS fetch proxy
    if (req.method === 'GET' && req.url.startsWith('/api/rss?')) {
        const params = new URL('http://localhost' + req.url).searchParams;
        const rssUrl = params.get('url');
        const count  = params.get('count') || '20';
        if (!rssUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
            res.end(JSON.stringify({ status: 'error', message: 'Missing url param' }));
            return;
        }
        const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}&count=${count}`;
        const parsed = new URL(apiUrl);
        const reqOpts = {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
            timeout: 10000,
        };
        const apiReq = https.request(reqOpts, apiRes => {
            let data = '';
            apiRes.on('data', chunk => data += chunk);
            apiRes.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
                res.end(data);
            });
        });
        apiReq.on('error', err => {
            res.writeHead(502, { 'Content-Type': 'application/json', ...CORS_HEADERS });
            res.end(JSON.stringify({ status: 'error', message: err.message }));
        });
        apiReq.on('timeout', () => { apiReq.destroy(); });
        apiReq.end();
        return;
    }

    // Article fetch proxy
    if (req.method === 'POST' && req.url === '/api/fetch') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { url } = JSON.parse(body);
                fetchArticleUrl(url, res);
            } catch {
                res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
                res.end(JSON.stringify({ error: 'Invalid request body' }));
            }
        });
        return;
    }

    // Static file serving
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/lobsterr.html';
    const filePath = path.join(DIR, urlPath);

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, CORS_HEADERS);
            res.end('Not found');
            return;
        }
        const ext  = path.extname(filePath);
        const mime = MIME[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, ...CORS_HEADERS });
        res.end(data);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('🦞 Lobsterr サーバー起動中');
    console.log(`   → http://localhost:${PORT}/lobsterr.html`);
    console.log('');
    console.log('   終了するには Ctrl+C');
    console.log('');
});
