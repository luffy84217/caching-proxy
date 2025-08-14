const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

class CachingProxy {
    constructor() {
        this.cache = new Map();
        this.cacheDir = path.join(os.homedir(), '.caching-proxy');
        this.cacheFile = path.join(this.cacheDir, 'cache.json');
        this.loadCache();
    }

    loadCache() {
        try {
            if (fs.existsSync(this.cacheFile)) {
                const cacheData = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
                this.cache = new Map(Object.entries(cacheData));
                if (this.cache.size > 0) {
                    console.log(`💾 Loaded ${this.cache.size} cached entries`);
                }
            }
        } catch (error) {
            console.warn('⚠️  Could not load cache from disk:', error.message);
        }
    }

    saveCache() {
        try {
            if (!fs.existsSync(this.cacheDir)) {
                fs.mkdirSync(this.cacheDir, { recursive: true });
            }
            const cacheData = Object.fromEntries(this.cache);
            fs.writeFileSync(this.cacheFile, JSON.stringify(cacheData, null, 2));
        } catch (error) {
            console.warn('⚠️  Could not save cache to disk:', error.message);
        }
    }

    generateCacheKey(method, url, headers) {
        // Only include relevant headers for caching
        const relevantHeaders = {};
        if (headers.authorization) relevantHeaders.authorization = headers.authorization;
        if (headers['user-agent']) relevantHeaders['user-agent'] = headers['user-agent'];
        
        const key = `${method}:${url}:${JSON.stringify(relevantHeaders)}`;
        return crypto.createHash('sha256').update(key).digest('hex');
    }

    clearCache() {
        this.cache.clear();
        try {
            if (fs.existsSync(this.cacheFile)) {
                fs.unlinkSync(this.cacheFile);
            }
            console.log('✅ Cache cleared successfully');
        } catch (error) {
            console.warn('⚠️  Could not clear cache files:', error.message);
        }
    }

    getCacheInfo() {
        return {
            location: this.cacheFile,
            entries: this.cache.size,
            cacheData: Array.from(this.cache.entries()).slice(0, 10).map(([key, value]) => ({
                key: key.substring(0, 16) + '...',
                statusCode: value.statusCode,
                age: Math.round((Date.now() - value.timestamp) / 1000),
                dataLength: value.data.length
            }))
        };
    }

    makeRequest(options, postData = null, redirectCount = 0) {
        return new Promise((resolve, reject) => {
            if (redirectCount > 5) {
                reject(new Error('Too many redirects'));
                return;
            }

            const client = options.protocol === 'https:' ? https : http;
            
            console.log(`🔗 Making request to: ${options.protocol}//${options.hostname}:${options.port}${options.path}`);
            
            const req = client.request(options, (res) => {
                console.log(`📥 Response received: ${res.statusCode}`);
                
                // Handle redirects
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    console.log(`🔄 Redirect to: ${res.headers.location}`);
                    
                    // Parse the redirect URL
                    const redirectUrl = url.parse(res.headers.location);
                    const newOptions = {
                        hostname: redirectUrl.hostname,
                        port: redirectUrl.port || (redirectUrl.protocol === 'https:' ? 443 : 80),
                        path: redirectUrl.path,
                        method: options.method,
                        headers: options.headers,
                        protocol: redirectUrl.protocol
                    };
                    
                    // Follow the redirect
                    this.makeRequest(newOptions, postData, redirectCount + 1)
                        .then(resolve)
                        .catch(reject);
                    return;
                }
                
                let data = [];
                
                res.on('data', (chunk) => {
                    data.push(chunk);
                });
                
                res.on('end', () => {
                    const body = Buffer.concat(data).toString();
                    console.log(`✅ Response complete, body length: ${body.length}`);
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        data: body
                    });
                });
            });

            req.on('error', (error) => {
                console.error(`❌ Request error: ${error.message}`);
                reject(error);
            });

            // Set timeout
            req.setTimeout(5000, () => {
                console.error(`⏰ Request timeout`);
                req.destroy();
                reject(new Error('Request timeout'));
            });

            if (postData && postData.length > 0) {
                console.log(`📤 Writing body data: ${postData.length} chars`);
                req.write(postData);
            }

            req.end();
            console.log(`📤 Request sent`);
        });
    }

    start(port, originUrl) {
        const parsedOrigin = new URL(originUrl);
        
        if (!parsedOrigin.protocol || !parsedOrigin.hostname) {
            throw new Error('Invalid origin URL format');
        }
        
        const server = http.createServer((req, res) => {
            console.log(`\n🔄 ${new Date().toISOString()} - ${req.method} ${req.url}`);
            
            const fullUrl = `${originUrl.replace(/\/$/, '')}${req.url}`;
            const cacheKey = this.generateCacheKey(req.method, fullUrl, req.headers);
            
            // Check cache first for GET requests
            if (req.method === 'GET' && this.cache.has(cacheKey)) {
                const cachedResponse = this.cache.get(cacheKey);
                console.log(`✅ Cache HIT for ${req.url}`);
                
                // Set headers
                Object.entries(cachedResponse.headers).forEach(([key, value]) => {
                    if (!['transfer-encoding', 'connection', 'content-encoding'].includes(key.toLowerCase())) {
                        res.setHeader(key, value);
                    }
                });
                
                res.setHeader('X-Cache', 'HIT');
                res.statusCode = cachedResponse.statusCode;
                res.end(cachedResponse.data);
                return;
            }

            // Prepare request options
            const options = {
                hostname: parsedOrigin.hostname,
                port: parsedOrigin.port || (parsedOrigin.protocol === 'https:' ? 443 : 80),
                path: req.url,
                method: req.method,
                headers: {},
                protocol: parsedOrigin.protocol
            };

            // Copy safe headers
            Object.entries(req.headers).forEach(([key, value]) => {
                if (!['host', 'connection', 'content-length'].includes(key.toLowerCase())) {
                    options.headers[key] = value;
                }
            });

            console.log(`📡 Forwarding: ${options.method} ${options.protocol}//${options.hostname}:${options.port}${options.path}`);

            // Collect request body
            let body = '';
            req.on('data', chunk => {
                body += chunk;
            });

            req.on('end', async () => {
                try {
                    console.log(`📦 Request body length: ${body.length}`);
                    
                    const response = await this.makeRequest(options, body);
                    
                    // Cache GET responses with good status codes
                    if (req.method === 'GET' && response.statusCode >= 200 && response.statusCode < 400) {
                        this.cache.set(cacheKey, {
                            statusCode: response.statusCode,
                            headers: response.headers,
                            data: response.data,
                            timestamp: Date.now()
                        });
                        this.saveCache();
                        console.log(`💾 Cached response for ${req.url}`);
                    }

                    // Send response
                    Object.entries(response.headers).forEach(([key, value]) => {
                        if (!['transfer-encoding', 'connection', 'content-encoding'].includes(key.toLowerCase())) {
                            res.setHeader(key, value);
                        }
                    });
                    
                    res.setHeader('X-Cache', 'MISS');
                    res.statusCode = response.statusCode;
                    res.end(response.data);
                    
                    console.log(`✅ Response sent: ${response.statusCode}`);
                    
                } catch (error) {
                    console.error(`❌ Proxy error: ${error.message}`);
                    
                    if (!res.headersSent) {
                        res.statusCode = 502;
                        res.setHeader('Content-Type', 'application/json');
                        res.setHeader('X-Cache', 'MISS');
                        res.end(JSON.stringify({
                            error: 'Bad Gateway',
                            message: error.message
                        }));
                    }
                }
            });

            req.on('error', (error) => {
                console.error(`❌ Request error: ${error.message}`);
                if (!res.headersSent) {
                    res.statusCode = 400;
                    res.end('Bad Request');
                }
            });
        });

        server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                console.error(`❌ Error: Port ${port} is already in use`);
                process.exit(1);
            } else {
                console.error(`❌ Server error: ${error.message}`);
                process.exit(1);
            }
        });

        return new Promise((resolve, reject) => {
            server.listen(port, (error) => {
                if (error) {
                    reject(error);
                } else {
                    console.log(`🚀 Caching proxy server started on port ${port}`);
                    console.log(`📡 Forwarding requests to: ${originUrl}`);
                    console.log(`💾 Cache entries: ${this.cache.size}`);
                    console.log(`\nTest with: curl http://localhost:${port}/products`);
                    
                    // Handle graceful shutdown
                    const gracefulShutdown = () => {
                        console.log('\n📝 Saving cache before shutdown...');
                        this.saveCache();
                        console.log('✅ Cache saved. Goodbye!');
                        process.exit(0);
                    };

                    process.on('SIGINT', gracefulShutdown);
                    process.on('SIGTERM', gracefulShutdown);
                    
                    resolve(server);
                }
            });
        });
    }
}

module.exports = CachingProxy;
