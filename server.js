import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { getAuthorData, getAuthorFilters } from 'stihirus-reader';

// Эмуляция __dirname для ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 30010;

app.use(cors());

// --- ИСПРАВЛЕНИЕ 1: Папка кэша ---
// Vercel разрешает запись ТОЛЬКО в папку /tmp
// Если мы на Vercel (есть ENV), используем /tmp, иначе текущую папку
const IS_VERCEL = process.env.VERCEL || process.env.AWS_REGION;
const CACHE_DIR = IS_VERCEL ? '/tmp' : __dirname;
const CACHE_DURATION_MS = 60 * 60 * 1000; 

console.log(`Environment: ${IS_VERCEL ? 'Vercel/Serverless' : 'Local'}, Cache Dir: ${CACHE_DIR}`);

// --- ИСПРАВЛЕНИЕ 2: Загрузка OpenAPI ---
let swaggerDocument;
try {
    // process.cwd() надежнее на Vercel для файлов, указанных в includeFiles
    const yamlPath = path.join(process.cwd(), 'openapi.yaml');
    swaggerDocument = YAML.load(yamlPath);
} catch (e) {
    console.error("Primary load failed, trying fallback...", e);
    try {
        swaggerDocument = YAML.load(path.join(__dirname, 'openapi.yaml'));
    } catch (e2) {
        console.error("CRITICAL: openapi.yaml not found!", e2);
    }
}

// --- ИСПРАВЛЕНИЕ 3: CSS для Swagger ---
// Исправляет "белый экран", загружая стили с CDN
if (swaggerDocument) {
    const swaggerOptions = {
        customCssUrl: 'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui.min.css',
        customSiteTitle: "StihiRus API Docs"
    };
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, swaggerOptions));
}

// --- Функции кэширования ---

function generateCacheKey(prefix, identifier, queryParams = {}) {
    const identifierPart = String(identifier).replace(/[^a-zA-Z0-9_-]/g, '_');
    let queryPart = '';
    const sortedKeys = Object.keys(queryParams).sort();
    sortedKeys.forEach(key => {
        if (queryParams[key] !== undefined && queryParams[key] !== null) {
            queryPart += `_${key}_${String(queryParams[key])}`;
        } else if (queryParams[key] === null) {
             queryPart += `_${key}_null`;
        }
    });
    return `_cache_${prefix}_${identifierPart}${queryPart}.json`;
}

async function readCache(key) {
    const filePath = path.join(CACHE_DIR, key);
    try {
        const stats = await fs.stat(filePath);
        const now = Date.now();
        const mtime = stats.mtime.getTime();
        const isStale = (now - mtime) > CACHE_DURATION_MS;
        const content = await fs.readFile(filePath, 'utf-8');
        const data = JSON.parse(content);
        return { data, isStale, exists: true, mtime };
    } catch (err) {
        if (err.code === 'ENOENT') {
            return { exists: false };
        }
        return { exists: false, error: true };
    }
}

async function writeCache(key, data) {
    const filePath = path.join(CACHE_DIR, key);
    try {
        const content = JSON.stringify(data);
        await fs.writeFile(filePath, content, 'utf-8');
    } catch (err) {
        console.error(`Error writing cache to ${filePath}:`, err);
    }
}

// --- Роуты API ---

app.get('/author/:identifier', async (req, res) => {
    const identifier = req.params.identifier;
    let page = req.query.page;
    let delay = req.query.delay;
    let pageNum = null;
    
    if (page !== undefined) {
        const parsedPage = parseInt(page, 10);
        if (!isNaN(parsedPage) && parsedPage >= 0) {
            pageNum = parsedPage;
        } else if (page === 'null' || page === '') {
             pageNum = null;
        } else {
            return res.status(400).json({ status: 'error', error: { code: 400, message: 'Invalid page parameter.' } });
        }
    }

    let delayMs = undefined;
     if (delay !== undefined) {
        const parsedDelay = parseInt(delay, 10);
        if (!isNaN(parsedDelay) && parsedDelay >= 0) {
            delayMs = parsedDelay;
        } else {
             return res.status(400).json({ status: 'error', error: { code: 400, message: 'Invalid delay parameter.' } });
        }
    }

    const cacheKey = generateCacheKey('author', identifier, { page: pageNum });
    let cacheEntry = null;

    try {
        cacheEntry = await readCache(cacheKey);
        if (cacheEntry.exists && !cacheEntry.isStale) {
            return res.json(cacheEntry.data);
        }

        const freshResult = await getAuthorData(identifier, pageNum, delayMs);
        
        if (freshResult.status === 'success') {
            await writeCache(cacheKey, freshResult);
            return res.json(freshResult);
        } else {
            if (cacheEntry.exists) {
                return res.json(cacheEntry.data);
            } else {
                return res.status(freshResult.error.code >= 400 && freshResult.error.code < 600 ? freshResult.error.code : 500).json(freshResult);
            }
        }
    } catch (err) {
         if (cacheEntry && cacheEntry.exists) {
             return res.json(cacheEntry.data);
         } else {
            console.error(`Error processing /author/${identifier}:`, err);
            return res.status(500).json({ status: 'error', error: { code: 500, message: 'Internal Server Error' } });
         }
    }
});

app.get('/author/:identifier/filters', async (req, res) => {
    const identifier = req.params.identifier;
    const cacheKey = generateCacheKey('filters', identifier);
    let cacheEntry = null;

     try {
        cacheEntry = await readCache(cacheKey);
        if (cacheEntry.exists && !cacheEntry.isStale) {
            return res.json(cacheEntry.data);
        }

        const freshResult = await getAuthorFilters(identifier);
        
         if (freshResult.status === 'success') {
            await writeCache(cacheKey, freshResult);
            return res.json(freshResult);
        } else {
             if (cacheEntry.exists) {
                return res.json(cacheEntry.data);
             } else {
                return res.status(freshResult.error.code >= 400 && freshResult.error.code < 600 ? freshResult.error.code : 500).json(freshResult);
             }
        }
    } catch (err) {
         if (cacheEntry && cacheEntry.exists) {
             return res.json(cacheEntry.data);
         } else {
            console.error(`Error processing /author/${identifier}/filters:`, err);
            return res.status(500).json({ status: 'error', error: { code: 500, message: 'Internal Server Error' } });
         }
    }
});

app.get('/', (req, res) => {
    res.redirect('/docs');
});

// --- Debug Endpoint (опционально, для проверки файлов) ---
app.get('/debug-info', (req, res) => {
    res.json({
        cwd: process.cwd(),
        dirname: __dirname,
        cacheDir: CACHE_DIR,
        isVercel: !!IS_VERCEL
    });
});

// --- ИСПРАВЛЕНИЕ 4: Экспорт для Vercel ---
// Если мы НЕ в production и НЕ на Vercel, слушаем порт (локальная разработка)
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    app.listen(port, () => {
        console.log(`StihiRus API Server listening on port: ${port}`);
        console.log(`Docs: http://localhost:${port}/docs`);
    });
}

// Для Vercel обязательно нужен export default
export default app;
