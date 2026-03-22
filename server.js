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

// RSS XML を直接取得（リダイレクト対応）
function fetchRawUrl(targetUrl, callback, redirectCount = 0) {
    if (redirectCount > 5) { callback(new Error('Too many redirects')); return; }
    let parsed;
    try { parsed = new URL(targetUrl); } catch(e) { callback(e); return; }

    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        method:   'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Lobsterr/1.0; +https://lobsterr.onrender.com)',
            'Accept':     'application/rss+xml, application/xml, text/xml, application/atom+xml, */*',
        },
        timeout: 12000,
    };
    const r = lib.request(options, res => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
            const next = res.headers.location.startsWith('http')
                ? res.headers.location
                : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
            res.resume();
            fetchRawUrl(next, callback, redirectCount + 1);
            return;
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => callback(null, Buffer.concat(chunks).toString('utf-8')));
    });
    r.on('error', callback);
    r.on('timeout', () => { r.destroy(); callback(new Error('Timeout')); });
    r.end();
}

// RSS / Atom XML をパースして rss2json 互換 JSON を返す
function parseRSSXML(xml, maxCount) {
    const get = (str, tags) => {
        for (const tag of [].concat(tags)) {
            // CDATA
            let m = str.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, 'i'));
            if (m) return m[1].trim();
            // 通常テキスト
            m = str.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
            if (m) return m[1].replace(/<[^>]*>/g, '').trim();
        }
        return '';
    };
    const getAttr = (str, tag, attr) => {
        const m = str.match(new RegExp(`<${tag}[^>]+${attr}=["']([^"']+)["']`, 'i'));
        return m ? m[1] : '';
    };
    const getLinkHref = (str) => {
        // Atom <link href="..."> or RSS <link>...</link>
        const m = str.match(/<link[^>]+href=["']([^"']+)["'][^>]*\/?>/i)
               || str.match(/<link[^>]*rel=["']alternate["'][^>]+href=["']([^"']+)["']/i);
        if (m) return m[1];
        return get(str, 'link');
    };

    // RSS items or Atom entries
    const isAtom  = /<feed[^>]*xmlns/i.test(xml);
    const tag     = isAtom ? 'entry' : 'item';
    const matches = [...xml.matchAll(new RegExp(`<${tag}[\\s>]([\\s\\S]*?)<\\/${tag}>`, 'g'))];

    const items = matches.slice(0, maxCount).map(m => {
        const s         = m[1];
        const link      = getLinkHref(s) || get(s, ['guid','id']);
        const thumbnail = getAttr(s, 'media:thumbnail', 'url')
                       || getAttr(s, 'media:content', 'url')
                       || getAttr(s, 'enclosure', 'url') || '';
        return {
            title:       get(s, 'title')                                    || '',
            link:        link                                               || '',
            description: get(s, ['description','summary'])                  || '',
            content:     get(s, ['content:encoded','content','description']) || '',
            pubDate:     get(s, ['pubDate','published','updated','dc:date']) || '',
            guid:        get(s, ['guid','id']) || link                      || '',
            thumbnail,
            enclosure:   thumbnail ? { link: thumbnail } : null,
        };
    });

    return { status: 'ok', items };
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

    // RSS fetch proxy（直接取得・XMLパース）
    if (req.method === 'GET' && req.url.startsWith('/api/rss?')) {
        const params = new URL('http://localhost' + req.url).searchParams;
        const rssUrl = params.get('url');
        const count  = parseInt(params.get('count') || '20');
        if (!rssUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
            res.end(JSON.stringify({ status: 'error', items: [] }));
            return;
        }
        fetchRawUrl(rssUrl, (err, xml) => {
            if (err) {
                res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
                res.end(JSON.stringify({ status: 'error', items: [] }));
                return;
            }
            const result = parseRSSXML(xml, count);
            res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
            res.end(JSON.stringify(result));
        });
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
