const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ─── Mobile User-Agent ───
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// ─── Platform Detection ───
function detectPlatform(url) {
    if (/douyin|抖音|iesdouyin|v\.douyin/i.test(url)) return 'douyin';
    if (/kuaishou|快手|v\.kuaishou|v\.kwai|kwai/i.test(url)) return 'kuaishou';
    if (/xiaohongshu|小红书|xhslink|xhs/i.test(url)) return 'xiaohongshu';
    if (/bilibili|b站|b23\.tv|bilibili\.com/i.test(url)) return 'bilibili';
    return null;
}

// ─── Extract clean URL from share text ───
function extractUrl(text) {
    const urlMatch = text.match(/https?:\/\/[^\s\u4e00-\u9fff]+/);
    if (urlMatch) {
        return urlMatch[0].replace(/[，。！？、；：""''）】》]+$/, '');
    }
    return text.trim();
}

// ─── Follow redirects and return final URL ───
async function resolveRedirects(url, maxRedirects = 5) {
    let currentUrl = url;
    for (let i = 0; i < maxRedirects; i++) {
        try {
            const resp = await fetch(currentUrl, {
                headers: { 'User-Agent': MOBILE_UA },
                redirect: 'manual'
            });
            if (resp.status >= 300 && resp.status < 400) {
                const location = resp.headers.get('location');
                if (location) {
                    currentUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;
                } else {
                    break;
                }
            } else {
                break;
            }
        } catch (e) {
            break;
        }
    }
    return currentUrl;
}

// ─── Extract video ID from Douyin short URL ───
async function resolveDouyinShortUrl(url) {
    try {
        // Follow all redirects to get the final URL
        const finalUrl = await resolveRedirects(url);
        console.log(`[Douyin] Resolved URL: ${finalUrl}`);
        const match = finalUrl.match(/video\/(\d+)/);
        if (match) return match[1];

        // Also try note type
        const noteMatch = finalUrl.match(/note\/(\d+)/);
        if (noteMatch) return noteMatch[1];
    } catch (e) {
        console.error('resolveDouyinShortUrl error:', e.message);
    }
    return null;
}

// ─── Parse Douyin ───
async function parseDouyin(url) {
    // Step 1: Resolve short URL to get video ID
    let videoId = null;
    const idMatch = url.match(/video\/(\d+)/);
    if (idMatch) {
        videoId = idMatch[1];
    } else {
        videoId = await resolveDouyinShortUrl(url);
    }

    if (!videoId) throw new Error('无法提取视频ID，请检查链接');

    // Step 2: Fetch video page
    const pageUrl = `https://www.iesdouyin.com/share/video/${videoId}`;
    const resp = await fetch(pageUrl, {
        headers: { 'User-Agent': MOBILE_UA }
    });
    const html = await resp.text();

    // Step 3: Extract _ROUTER_DATA
    const dataMatch = html.match(/window\._ROUTER_DATA\s*=\s*(.*?)<\/script>/s);
    if (!dataMatch) throw new Error('页面数据解析失败，抖音可能已更新接口');

    let jsonData;
    try {
        jsonData = JSON.parse(dataMatch[1].trim());
    } catch (e) {
        throw new Error('JSON 数据解析失败');
    }

    // Step 4: Navigate JSON to find video info
    try {
        const loaderData = jsonData.loaderData;
        const pageKey = Object.keys(loaderData).find(k => k.includes('/page'));
        if (!pageKey) throw new Error('找不到视频数据');

        const videoInfo = loaderData[pageKey].videoInfoRes;
        const item = videoInfo.item_list[0];

        const videoAddr = item.video?.play_addr;
        let videoUrl = videoAddr?.url_list?.[0] || '';

        // Key: replace playwm with play to remove watermark
        if (videoUrl) {
            videoUrl = videoUrl.replace('playwm', 'play');
        }

        // Extract music info
        const musicInfo = item.music || {};
        const musicTitle = musicInfo.title || '';
        const musicAuthor = musicInfo.author || '';

        return {
            title: item.desc || '未知标题',
            author: item.author?.nickname || '',
            cover: videoAddr?.cover?.url_list?.[0] || item.video?.cover?.url_list?.[0] || '',
            video_url: videoUrl,
            music_url: musicInfo.play_url?.url_list?.[0] || '',
            music_title: musicTitle ? `${musicTitle} - ${musicAuthor}` : '',
            platform: 'douyin'
        };
    } catch (e) {
        console.error('Parse douyin data error:', e.message);
        throw new Error('视频信息提取失败: ' + e.message);
    }
}

// ─── Parse Kuaishou ───
async function parseKuaishou(url) {
    // Resolve short URL
    let finalUrl = url;
    try {
        const resp = await fetch(url, {
            headers: { 'User-Agent': MOBILE_UA },
            redirect: 'manual'
        });
        const location = resp.headers.get('location');
        if (location) finalUrl = location;
    } catch (e) { /* use original URL */ }

    // Fetch page
    const resp = await fetch(finalUrl, {
        headers: { 'User-Agent': MOBILE_UA }
    });
    const html = await resp.text();

    // Try to extract from page data
    const $ = cheerio.load(html);

    // Method 1: Look for __APOLLO_STATE__ or window.__data
    let videoUrl = '';
    let title = '';
    let author = '';
    let cover = '';

    // Try extracting from script tags
    $('script').each((i, el) => {
        const content = $(el).html() || '';
        if (content.includes('videoData') || content.includes('pageData')) {
            // Try to find video URL
            const urlMatch = content.match(/"src"\s*:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/);
            if (urlMatch) videoUrl = urlMatch[1];

            const titleMatch = content.match(/"caption"\s*:\s*"([^"]+)"/);
            if (titleMatch) title = titleMatch[1];

            const authorMatch = content.match(/"userName"\s*:\s*"([^"]+)"/);
            if (authorMatch) author = authorMatch[1];

            const coverMatch = content.match(/"poster"\s*:\s*"(https?:\/\/[^"]+)"/);
            if (coverMatch) cover = coverMatch[1];
        }
    });

    if (!videoUrl) {
        // Method 2: Try to find video URL in meta tags or og tags
        const ogVideo = $('meta[property="og:video"]').attr('content');
        if (ogVideo) videoUrl = ogVideo;

        const ogTitle = $('meta[property="og:title"]').attr('content');
        if (ogTitle) title = ogTitle;

        const ogImage = $('meta[property="og:image"]').attr('content');
        if (ogImage) cover = ogImage;
    }

    if (!videoUrl) throw new Error('快手视频解析失败，接口可能已更新');

    return {
        title: title || '快手视频',
        author: author || '',
        cover: cover || '',
        video_url: videoUrl,
        platform: 'kuaishou'
    };
}

// ─── Parse Xiaohongshu ───
async function parseXiaohongshu(url) {
    // Resolve short URL
    let finalUrl = url;
    try {
        const resp = await fetch(url, {
            headers: { 'User-Agent': MOBILE_UA },
            redirect: 'manual'
        });
        const location = resp.headers.get('location');
        if (location) finalUrl = location;
    } catch (e) { /* use original URL */ }

    const resp = await fetch(finalUrl, {
        headers: { 'User-Agent': MOBILE_UA }
    });
    const html = await resp.text();

    const $ = cheerio.load(html);
    let videoUrl = '';
    let title = '';
    let author = '';
    let cover = '';

    // Extract from SSR data
    $('script').each((i, el) => {
        const content = $(el).html() || '';
        if (content.includes('noteDetailMap') || content.includes('video') && content.includes('url')) {
            const urlMatch = content.match(/"url"\s*:\s*"(https?:\/\/sns-video[^"]+|https?:\/\/[^\s"]+video[^\s"]+)"/);
            if (urlMatch) videoUrl = urlMatch[1];

            const titleMatch = content.match(/"title"\s*:\s*"([^"]+)"/);
            if (titleMatch) title = titleMatch[1];

            const authorMatch = content.match(/"nickname"\s*:\s*"([^"]+)"/);
            if (authorMatch) author = authorMatch[1];

            const coverMatch = content.match(/"urlDefault"\s*:\s*"(https?:\/\/[^"]+)"/);
            if (coverMatch) cover = coverMatch[1];
        }
    });

    // Fallback: meta tags
    if (!videoUrl) {
        const ogVideo = $('meta[property="og:video"]').attr('content');
        if (ogVideo) videoUrl = ogVideo;
    }
    if (!title) {
        const ogTitle = $('meta[property="og:title"]').attr('content');
        if (ogTitle) title = ogTitle;
    }
    if (!cover) {
        const ogImage = $('meta[property="og:image"]').attr('content');
        if (ogImage) cover = ogImage;
    }

    if (!videoUrl) throw new Error('小红书视频解析失败，可能不是视频笔记或接口已更新');

    return {
        title: title || '小红书视频',
        author: author || '',
        cover: cover || '',
        video_url: videoUrl,
        platform: 'xiaohongshu'
    };
}

// ─── Parse Bilibili ───
async function parseBilibili(url) {
    // Extract BV ID
    let bvid = '';
    const bvMatch = url.match(/(BV[a-zA-Z0-9]+)/);
    if (bvMatch) {
        bvid = bvMatch[1];
    } else {
        // Try resolving short URL (b23.tv)
        try {
            const resp = await fetch(url, {
                headers: { 'User-Agent': MOBILE_UA },
                redirect: 'manual'
            });
            const location = resp.headers.get('location');
            if (location) {
                const bvMatch2 = location.match(/(BV[a-zA-Z0-9]+)/);
                if (bvMatch2) bvid = bvMatch2[1];
            }
        } catch (e) { /* ignore */ }
    }

    if (!bvid) throw new Error('无法提取B站视频ID');

    // Use Bilibili API to get video info
    const apiResp = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
        headers: {
            'User-Agent': MOBILE_UA,
            'Referer': 'https://www.bilibili.com/'
        }
    });
    const apiData = await apiResp.json();

    if (apiData.code !== 0) throw new Error(apiData.message || 'B站API请求失败');

    const data = apiData.data;
    const cid = data.cid;
    const avid = data.aid;

    // Get video stream URL (highest quality MP4)
    const streamResp = await fetch(
        `https://api.bilibili.com/x/player/playurl?avid=${avid}&cid=${cid}&qn=80&fnval=16&fourk=1`,
        {
            headers: {
                'User-Agent': MOBILE_UA,
                'Referer': 'https://www.bilibili.com/'
            }
        }
    );
    const streamData = await streamResp.json();

    let videoUrl = '';
    if (streamData.code === 0 && streamData.data) {
        // Try DASH first, fallback to FLV/MP4
        if (streamData.data.dash && streamData.data.dash.video) {
            const videos = streamData.data.dash.video;
            // Pick highest quality
            const best = videos.sort((a, b) => b.bandwidth - a.bandwidth)[0];
            videoUrl = best?.baseUrl || best?.base_url || '';
        } else if (streamData.data.durl) {
            videoUrl = streamData.data.durl[0]?.url || '';
        }
    }

    return {
        title: data.title || 'B站视频',
        author: data.owner?.name || '',
        cover: data.pic || '',
        video_url: videoUrl,
        platform: 'bilibili'
    };
}

// ─── Main Parse API ───
app.post('/api/parse', async (req, res) => {
    let { url, platform } = req.body;

    if (!url) {
        return res.json({ code: -1, msg: '请提供视频链接' });
    }

    // Extract clean URL from share text
    url = extractUrl(url);

    const detectedPlatform = platform || detectPlatform(url);
    if (!detectedPlatform) {
        return res.json({ code: -1, msg: '无法识别平台，请手动选择或检查链接' });
    }

    console.log(`[Parse] Platform: ${detectedPlatform}, URL: ${url}`);

    try {
        let result;
        switch (detectedPlatform) {
            case 'douyin':
                result = await parseDouyin(url);
                break;
            case 'kuaishou':
                result = await parseKuaishou(url);
                break;
            case 'xiaohongshu':
                result = await parseXiaohongshu(url);
                break;
            case 'bilibili':
                result = await parseBilibili(url);
                break;
            default:
                return res.json({ code: -1, msg: '不支持的平台' });
        }

        console.log(`[Parse] Success: ${result.title}`);
        res.json({ code: 0, data: result });
    } catch (err) {
        console.error(`[Parse] Error: ${err.message}`);
        res.json({ code: -1, msg: err.message });
    }
});

// ─── Download proxy ───
app.get('/api/download', async (req, res) => {
    const { url, filename, type } = req.query;
    if (!url) return res.status(400).json({ code: -1, msg: '缺少 url 参数' });

    try {
        const decodedUrl = decodeURIComponent(url);
        const safeName = (filename || 'video').replace(/[^\w\u4e00-\u9fff\-_.]/g, '').substring(0, 100);
        const isAudio = type === 'audio';
        const ext = isAudio ? 'mp3' : 'mp4';

        console.log(`[Download] Proxying: ${decodedUrl.substring(0, 80)}...`);

        // Follow redirects and collect the final response
        let currentUrl = decodedUrl;
        let resp;
        for (let redirectCount = 0; redirectCount < 5; redirectCount++) {
            resp = await fetch(currentUrl, {
                headers: {
                    'User-Agent': MOBILE_UA,
                    'Referer': 'https://www.douyin.com/',
                }
            });

            if (resp.status >= 300 && resp.status < 400) {
                const location = resp.headers.get('location');
                if (location) {
                    // Resolve relative URLs
                    currentUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;
                    continue;
                }
            }
            break;
        }

        if (!resp || (!resp.ok && resp.status !== 206)) {
            return res.status(502).json({ code: -1, msg: `下载失败: HTTP ${resp?.status}` });
        }

        const contentType = resp.headers.get('content-type') || (isAudio ? 'audio/mpeg' : 'video/mp4');
        const contentLength = resp.headers.get('content-length') || '';
        res.set({
            'Content-Type': contentType,
            'Content-Length': contentLength,
            'Content-Disposition': `attachment; filename="${safeName}.${ext}"; filename*=UTF-8''${safeName}.${ext}`,
            'Accept-Ranges': 'bytes',
            'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length'
        });

        // Collect all chunks then send (avoids streaming issues with redirects)
        const chunks = [];
        for await (const chunk of resp.body) {
            chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        res.send(buffer);
        console.log(`[Download] Sent ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);
    } catch (err) {
        console.error('[Download] Error:', err.message);
        res.status(500).json({ code: -1, msg: '下载失败: ' + err.message });
    }
});

// ─── Batch download (ZIP) ───
app.post('/api/batch-download', async (req, res) => {
    const { urls } = req.body;
    if (!Array.isArray(urls) || urls.length === 0) {
        return res.json({ code: -1, msg: '请提供链接列表' });
    }
    if (urls.length > 20) {
        return res.json({ code: -1, msg: '最多支持 20 个链接批量下载' });
    }

    console.log(`[Batch] Processing ${urls.length} URLs...`);

    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 5 } });
    const hasError = false;

    res.set({
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="videolens_batch_${Date.now()}.zip"`,
        'Transfer-Encoding': 'chunked'
    });

    archive.pipe(res);

    const downloadPromises = urls.map(async (item, index) => {
        const { url, title, platform } = item;
        if (!url) return;

        const safeName = (title || `video_${index + 1}`)
            .replace(/[^\w\u4e00-\u9fff\-_. ]/g, '')
            .substring(0, 80)
            .trim() || `video_${index + 1}`;

        try {
            const decodedUrl = decodeURIComponent(url);
            console.log(`[Batch] Downloading: ${safeName}`);

            const resp = await fetch(decodedUrl, {
                headers: {
                    'User-Agent': MOBILE_UA,
                    'Referer': 'https://www.douyin.com/'
                }
            });

            if (resp.ok) {
                const chunks = [];
                for await (const chunk of resp.body) {
                    chunks.push(chunk);
                }
                const buffer = Buffer.concat(chunks);
                archive.append(buffer, { name: `${safeName}.mp4` });
                console.log(`[Batch] Added: ${safeName} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
            }
        } catch (err) {
            console.error(`[Batch] Failed to download ${safeName}:`, err.message);
        }
    });

    try {
        await Promise.all(downloadPromises);
        await archive.finalize();
    } catch (err) {
        console.error('[Batch] Archive error:', err.message);
        if (!res.headersSent) {
            res.status(500).json({ code: -1, msg: '打包失败: ' + err.message });
        }
    }
});

// ─── Health check ───
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

// ─── Serve static files (frontend) ───
// Copy index.html to public/ for serving
const fs = require('fs');
const path = require('path');
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
}
const publicIndex = path.join(publicDir, 'index.html');
const sourceIndex = path.join(__dirname, '..', '..', '..', '..', '..', 'AppData', 'Roaming', 'TRAE SOLO CN', 'ModularData', 'ai-agent', 'work-mode-projects', '69fc4b85d882ebeb4c40e1aa', 'index.html');
if (fs.existsSync(sourceIndex) && !fs.existsSync(publicIndex)) {
    fs.copyFileSync(sourceIndex, publicIndex);
    console.log('[Init] Copied index.html to public/');
}

app.listen(PORT, () => {
    console.log(`
  ╔══════════════════════════════════════╗
  ║   VideoLens Server Running          ║
  ║   http://localhost:${PORT}            ║
  ║   API: http://localhost:${PORT}/api/parse ║
  ╚══════════════════════════════════════╝
    `);
});
