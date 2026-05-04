'use strict';

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const cron       = require('node-cron');
const { Pool }   = require('pg');
const Anthropic  = require('@anthropic-ai/sdk');
const axios      = require('axios');
const rateLimit  = require('express-rate-limit');

// ─── Configuration ─────────────────────────────────────────────────────────

const PORT          = process.env.PORT        || 3000;
const META_API_VER  = 'v18.0';
const META_BASE_URL = `https://graph.facebook.com/${META_API_VER}`;

// ─── Logging ────────────────────────────────────────────────────────────────

function log(level, message, data = null) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  if (data) {
    console.log(`${prefix} ${message}`, typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

// ─── Database ───────────────────────────────────────────────────────────────

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

db.on('error', (err) => log('error', 'Unexpected DB pool error', err.message));

async function checkDbConnection() {
  const client = await db.connect();
  await client.query('SELECT 1');
  client.release();
  log('info', 'PostgreSQL connected successfully');
}

// ─── Claude AI Client ────────────────────────────────────────────────────────

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();

app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? false : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Basic rate limiting: 100 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitizeToken(token) {
  if (!token || token.length < 10) return '[invalid]';
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function validateRequired(body, fields) {
  const missing = fields.filter(f => !body[f]);
  if (missing.length) {
    return { valid: false, error: `Missing required fields: ${missing.join(', ')}` };
  }
  return { valid: true };
}

// ─── Meta API Helpers ────────────────────────────────────────────────────────

async function fetchPagePosts(pageId, accessToken, limit = 3) {
  const url = `${META_BASE_URL}/${pageId}/posts`;
  const response = await axios.get(url, {
    params: { access_token: accessToken, fields: 'id,message,created_time', limit },
    timeout: 10000,
  });
  return response.data.data || [];
}

async function fetchPostComments(postId, accessToken) {
  const url = `${META_BASE_URL}/${postId}/comments`;
  const response = await axios.get(url, {
    params: { access_token: accessToken, fields: 'id,message,from,created_time', limit: 25 },
    timeout: 10000,
  });
  return response.data.data || [];
}

async function postCommentReply(commentId, message, accessToken) {
  const url = `${META_BASE_URL}/${commentId}/comments`;
  const response = await axios.post(url, null, {
    params: { access_token: accessToken, message },
    timeout: 10000,
  });
  return response.data;
}

async function publishFacebookPost(pageId, content, imageUrl, accessToken) {
  const params = { access_token: accessToken, message: content };
  if (imageUrl) {
    // Use photos endpoint when an image is provided
    const url = `${META_BASE_URL}/${pageId}/photos`;
    const response = await axios.post(url, null, {
      params: { ...params, url: imageUrl, published: true },
      timeout: 15000,
    });
    return response.data;
  }
  const url = `${META_BASE_URL}/${pageId}/feed`;
  const response = await axios.post(url, null, {
    params,
    timeout: 15000,
  });
  return response.data;
}

async function publishInstagramPost(pageId, content, imageUrl, accessToken) {
  // Step 1: Get IG Business Account ID linked to the Facebook page
  const pageRes = await axios.get(`${META_BASE_URL}/${pageId}`, {
    params: { access_token: accessToken, fields: 'instagram_business_account' },
    timeout: 10000,
  });
  const igAccountId = pageRes.data?.instagram_business_account?.id;
  if (!igAccountId) throw new Error('No Instagram Business Account linked to this page');

  // Step 2: Create media container (requires an image for Instagram)
  if (!imageUrl) throw new Error('Instagram posts require an image URL');
  const containerRes = await axios.post(`${META_BASE_URL}/${igAccountId}/media`, null, {
    params: { access_token: accessToken, image_url: imageUrl, caption: content },
    timeout: 15000,
  });
  const containerId = containerRes.data.id;

  // Step 3: Publish the container
  const publishRes = await axios.post(`${META_BASE_URL}/${igAccountId}/media_publish`, null, {
    params: { access_token: accessToken, creation_id: containerId },
    timeout: 15000,
  });
  return publishRes.data;
}

// ─── Claude AI Helper ─────────────────────────────────────────────────────────

async function generateCommentReply(commentText, postContext = '') {
  const systemPrompt = `Eres un asistente de redes sociales profesional. Responde comentarios de forma:
- Amable, profesional y empática
- Breve (máximo 2 oraciones)
- En español
- Relevante al tema del post
- Sin hashtags ni emojis excesivos

Si no puedes responder directamente, ofrece redirigir al cliente.`;

  const userMessage = postContext
    ? `Contexto del post: "${postContext}"\n\nComentario a responder: "${commentText}"`
    : `Comentario a responder: "${commentText}"`;

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 256,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  return response.content.find(b => b.type === 'text')?.text?.trim() || '';
}

// ─── Meta API Helper: posts de los últimos N días con métricas ───────────────

async function fetchPostsWithMetrics(pageId, accessToken, daysBack = 60) {
  const since = Math.floor((Date.now() - daysBack * 24 * 60 * 60 * 1000) / 1000);
  const url = `${META_BASE_URL}/${pageId}/posts`;

  const response = await axios.get(url, {
    params: {
      access_token: accessToken,
      fields: 'id,message,story,full_picture,attachments{media_type},created_time',
      since,
      limit: 100,
    },
    timeout: 15000,
  });

  const posts = response.data.data || [];

  // Fetch engagement metrics for each post in parallel (batched to avoid throttling)
  const enriched = [];
  const BATCH = 10;

  for (let i = 0; i < posts.length; i += BATCH) {
    const batch = posts.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (post) => {
        let metrics = { likes: 0, comments: 0, shares: 0, reach: 0, impressions: 0 };
        try {
          const r = await axios.get(`${META_BASE_URL}/${post.id}`, {
            params: {
              access_token: accessToken,
              fields: [
                'likes.summary(true)',
                'comments.summary(true)',
                'shares',
                'insights.metric(post_impressions,post_impressions_unique)',
              ].join(','),
            },
            timeout: 10000,
          });
          const d = r.data;
          metrics.likes       = d.likes?.summary?.total_count    || 0;
          metrics.comments    = d.comments?.summary?.total_count || 0;
          metrics.shares      = d.shares?.count                  || 0;
          const insightsData  = d.insights?.data || [];
          for (const ins of insightsData) {
            const val = ins.values?.[0]?.value || 0;
            if (ins.name === 'post_impressions')        metrics.impressions = val;
            if (ins.name === 'post_impressions_unique') metrics.reach       = val;
          }
        } catch { /* best-effort — keep zeros */ }

        // Detect content type from attachments
        const mediaType = post.attachments?.data?.[0]?.media_type || 'text';
        const contentType = mediaType.includes('video') ? 'video'
          : mediaType.includes('photo') ? 'photo'
          : post.full_picture ? 'photo'
          : 'text';

        const engagementRate = metrics.reach > 0
          ? ((metrics.likes + metrics.comments + metrics.shares) / metrics.reach * 100).toFixed(2)
          : '0.00';

        return {
          postId:         post.id,
          message:        post.message || post.story || '',
          contentType,
          createdTime:    post.created_time,
          hour:           new Date(post.created_time).getHours(),
          dayOfWeek:      new Date(post.created_time).toLocaleDateString('es-ES', { weekday: 'long' }),
          ...metrics,
          engagementRate: parseFloat(engagementRate),
        };
      })
    );

    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') enriched.push(r.value);
      else log('warn', `Could not enrich post ${batch[idx]?.id}: ${r.reason?.message}`);
    });
  }

  return enriched;
}

// ─── Claude AI Helper: análisis de performance completo ──────────────────────

async function generatePerformanceReport(clientName, postsData, period) {
  const systemPrompt = `Eres un experto consultor de marketing digital y social media analytics con 10 años de experiencia.
Tu misión es analizar datos de performance de redes sociales y generar reportes profesionales, estratégicos y altamente accionables.
Responde siempre en español. Sé específico, usa los datos reales proporcionados, y da recomendaciones concretas con ejemplos.`;

  const userPrompt = `Analiza el performance de redes sociales de "${clientName}" para los últimos ${period} días.

DATOS DE POSTS (${postsData.length} posts totales):
${JSON.stringify(postsData, null, 2)}

Genera un reporte COMPLETO y PROFESIONAL con las siguientes secciones:

1. **RESUMEN EJECUTIVO** - KPIs principales y conclusión en 3-4 oraciones
2. **ANÁLISIS POR TIPO DE CONTENIDO** - Comparativa entre video, foto y texto (engagement promedio, alcance, mejor tipo)
3. **HORARIOS ÓPTIMOS DE PUBLICACIÓN** - Basado en los datos, qué horas y días generan más engagement
4. **TASAS DE ENGAGEMENT** - Análisis detallado, benchmark y comparativas
5. **TOP 3 POSTS CON MEJOR RENDIMIENTO** - Con postId, razón del éxito y lecciones aprendidas
6. **BOTTOM 3 POSTS CON PEOR RENDIMIENTO** - Con postId, razón del bajo rendimiento y cómo mejorarlos
7. **RECOMENDACIONES ESPECÍFICAS PARA MEJORAR ALCANCE** - Mínimo 5 tácticas concretas y aplicables
8. **ESTRATEGIA DE CONTENIDO PARA PRÓXIMOS 30 DÍAS** - Plan semanal con tipos de contenido, temas y frecuencia
9. **ANÁLISIS DE TENDENCIAS** - Qué tipo de contenido está funcionando actualmente en la industria
10. **TIPS PARA CAMPAÑAS EXITOSAS** - 5 tips accionables específicos para este cliente

Responde en formato JSON con esta estructura exacta:
{
  "resumenEjecutivo": "...",
  "analisisPorTipoContenido": { "video": {...}, "foto": {...}, "texto": {...}, "conclusion": "..." },
  "horariosOptimos": { "mejoresHoras": [...], "mejoresDias": [...], "analisis": "..." },
  "tasasEngagement": { "promedioGeneral": "...", "porTipo": {...}, "benchmark": "...", "analisis": "..." },
  "topPosts": [{ "postId": "...", "mensaje": "...", "metricas": {...}, "razonExito": "...", "leccion": "..." }],
  "bottomPosts": [{ "postId": "...", "mensaje": "...", "metricas": {...}, "razonBajoRendimiento": "...", "mejora": "..." }],
  "recomendacionesAlcance": ["...", "...", "...", "...", "..."],
  "estrategiaContenido30Dias": { "semana1": "...", "semana2": "...", "semana3": "...", "semana4": "...", "frecuenciaRecomendada": "..." },
  "tendencias": "...",
  "tipsExito": ["...", "...", "...", "...", "..."],
  "keyInsights": ["...", "...", "..."]
}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content.find(b => b.type === 'text')?.text?.trim() || '{}';

  // Extract JSON from possible markdown fences
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
  const jsonStr = jsonMatch[1].trim();

  try {
    return JSON.parse(jsonStr);
  } catch {
    // Return as-is in a wrapper if JSON parsing fails
    return { rawReport: text, parseError: true };
  }
}

async function generateAnalyticsRecommendations(analyticsData) {
  const systemPrompt = `Eres un experto en marketing digital y redes sociales.
Analiza los datos de analytics proporcionados y genera recomendaciones estratégicas concretas,
accionables y específicas para mejorar el desempeño en redes sociales.
Responde en español, de forma clara y estructurada.`;

  const dataText = JSON.stringify(analyticsData, null, 2);

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 1024,
    thinking: { type: 'adaptive' },
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Analiza estos datos de analytics y dame 3-5 recomendaciones concretas:\n\n${dataText}`,
    }],
  });

  return response.content.find(b => b.type === 'text')?.text?.trim() || '';
}

// ─── CRON JOB #1: Responder Comentarios (cada 5 minutos) ─────────────────────

cron.schedule('*/5 * * * *', async () => {
  log('info', '[CRON #1] Iniciando ciclo de respuesta a comentarios...');
  let totalProcessed = 0;

  try {
    const { rows: clients } = await db.query(
      "SELECT id, name, page_id, access_token, platform FROM clients"
    );

    if (!clients.length) {
      log('info', '[CRON #1] No hay clientes registrados');
      return;
    }

    for (const client of clients) {
      log('info', `[CRON #1] Procesando cliente: ${client.name} (token: ${sanitizeToken(client.access_token)})`);

      let posts = [];
      try {
        posts = await fetchPagePosts(client.page_id, client.access_token, 3);
      } catch (err) {
        log('warn', `[CRON #1] Error obteniendo posts de ${client.name}: ${err.message}`);
        continue;
      }

      for (const post of posts) {
        let comments = [];
        try {
          comments = await fetchPostComments(post.id, client.access_token);
        } catch (err) {
          log('warn', `[CRON #1] Error obteniendo comentarios del post ${post.id}: ${err.message}`);
          continue;
        }

        for (const comment of comments) {
          // Skip if we already responded to this comment
          const { rows: existing } = await db.query(
            'SELECT id FROM comment_responses WHERE client_id = $1 AND comment_id = $2',
            [client.id, comment.id]
          );
          if (existing.length) continue;

          log('info', `[CRON #1] Respondiendo comentario ${comment.id} de ${comment.from?.name || 'usuario'}`);

          let aiReply = '';
          try {
            aiReply = await generateCommentReply(comment.message, post.message);
          } catch (err) {
            log('error', `[CRON #1] Error generando respuesta IA para comentario ${comment.id}: ${err.message}`);
            continue;
          }

          if (!aiReply) continue;

          // Publish reply on Meta
          try {
            await postCommentReply(comment.id, aiReply, client.access_token);
          } catch (err) {
            log('warn', `[CRON #1] No se pudo publicar respuesta en Meta (${err.message}). Guardando en BD de todas formas.`);
          }

          // Persist in DB (unique constraint prevents duplicates on retry)
          await db.query(
            `INSERT INTO comment_responses (client_id, comment_id, original_comment, ai_response, post_id)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (client_id, comment_id) DO NOTHING`,
            [client.id, comment.id, comment.message, aiReply, post.id]
          );

          totalProcessed++;
        }
      }
    }

    log('info', `✅ [CRON #1] Procesados ${totalProcessed} comentarios`);
  } catch (err) {
    log('error', `[CRON #1] Error crítico en ciclo de comentarios: ${err.message}`);
  }
});

// ─── CRON JOB #2: Publicar Posts Programados (cada 1 minuto) ─────────────────

cron.schedule('* * * * *', async () => {
  log('info', '[CRON #2] Verificando posts programados...');

  try {
    const { rows: pendingPosts } = await db.query(
      `SELECT sp.*, c.page_id, c.access_token, c.name AS client_name
       FROM scheduled_posts sp
       JOIN clients c ON c.id = sp.client_id
       WHERE sp.status = 'pending'
         AND sp.scheduled_time <= NOW()
       ORDER BY sp.scheduled_time ASC
       LIMIT 20`
    );

    if (!pendingPosts.length) {
      log('info', '[CRON #2] No hay posts pendientes para publicar');
      return;
    }

    log('info', `[CRON #2] Encontrados ${pendingPosts.length} posts para publicar`);

    for (const post of pendingPosts) {
      log('info', `[CRON #2] Publicando post #${post.id} para ${post.client_name}`);

      const platforms = post.platforms || ['facebook'];
      let anySuccess = false;
      const errors = [];

      for (const platform of platforms) {
        try {
          if (platform === 'facebook') {
            await publishFacebookPost(post.page_id, post.content, post.image_url, post.access_token);
            log('info', `[CRON #2] ✅ Post #${post.id} publicado en Facebook`);
            anySuccess = true;
          } else if (platform === 'instagram') {
            await publishInstagramPost(post.page_id, post.content, post.image_url, post.access_token);
            log('info', `[CRON #2] ✅ Post #${post.id} publicado en Instagram`);
            anySuccess = true;
          }
        } catch (err) {
          log('error', `[CRON #2] Error publicando post #${post.id} en ${platform}: ${err.message}`);
          errors.push(`${platform}: ${err.message}`);
        }
      }

      const newStatus = anySuccess ? 'published' : 'failed';
      await db.query(
        `UPDATE scheduled_posts
         SET status = $1, published_at = $2, error_message = $3
         WHERE id = $4`,
        [
          newStatus,
          anySuccess ? new Date() : null,
          errors.length ? errors.join(' | ') : null,
          post.id,
        ]
      );
    }

    log('info', `✅ [CRON #2] Ciclo de publicación completado`);
  } catch (err) {
    log('error', `[CRON #2] Error crítico en ciclo de publicación: ${err.message}`);
  }
});

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
  });
});

// ── POST /api/auth/connect-client ──────────────────────────────────────────
app.post('/api/auth/connect-client', async (req, res) => {
  const { clientName, platformType, accessToken, pageId } = req.body;

  const check = validateRequired(req.body, ['clientName', 'platformType', 'accessToken', 'pageId']);
  if (!check.valid) return res.status(400).json({ success: false, message: check.error });

  const validPlatforms = ['facebook', 'instagram', 'both'];
  if (!validPlatforms.includes(platformType)) {
    return res.status(400).json({ success: false, message: `platformType must be one of: ${validPlatforms.join(', ')}` });
  }

  log('info', `Connecting client: ${clientName} | platform: ${platformType} | token: ${sanitizeToken(accessToken)}`);

  try {
    // Verify the token works by fetching the page
    try {
      await axios.get(`${META_BASE_URL}/${pageId}`, {
        params: { access_token: accessToken, fields: 'id,name' },
        timeout: 10000,
      });
    } catch (err) {
      log('warn', `Token validation failed for ${clientName}: ${err.message}`);
      return res.status(401).json({ success: false, message: 'Invalid access token or page ID' });
    }

    const { rows } = await db.query(
      `INSERT INTO clients (name, platform, page_id, access_token)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING id, name, platform, page_id, created_at`,
      [clientName, platformType, pageId, accessToken]
    );

    const client = rows[0];
    if (!client) {
      return res.status(409).json({ success: false, message: 'Client already exists or conflict occurred' });
    }

    log('info', `Client connected successfully: ${clientName} (id: ${client.id})`);
    res.status(201).json({
      success: true,
      message: 'Client connected successfully',
      client: { id: client.id, name: client.name, platform: client.platform, pageId: client.page_id, createdAt: client.created_at },
    });
  } catch (err) {
    log('error', `Error connecting client: ${err.message}`);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── GET /api/clients ────────────────────────────────────────────────────────
app.get('/api/clients', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, name, platform, page_id, created_at FROM clients ORDER BY created_at DESC'
    );
    res.json({ clients: rows, total: rows.length });
  } catch (err) {
    log('error', `Error fetching clients: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/comments/:clientId ─────────────────────────────────────────────
app.get('/api/comments/:clientId', async (req, res) => {
  const clientId = parseInt(req.params.clientId, 10);
  if (isNaN(clientId)) return res.status(400).json({ error: 'Invalid clientId' });

  try {
    const { rows: clientRows } = await db.query(
      'SELECT id, name, page_id, access_token FROM clients WHERE id = $1',
      [clientId]
    );
    if (!clientRows.length) return res.status(404).json({ error: 'Client not found' });

    const client = clientRows[0];

    // Fetch responded comment IDs from DB
    const { rows: responded } = await db.query(
      'SELECT comment_id FROM comment_responses WHERE client_id = $1',
      [clientId]
    );
    const respondedIds = new Set(responded.map(r => r.comment_id));

    let unansweredComments = [];

    try {
      const posts = await fetchPagePosts(client.page_id, client.access_token, 3);
      for (const post of posts) {
        const comments = await fetchPostComments(post.id, client.access_token);
        const unanswered = comments.filter(c => !respondedIds.has(c.id));
        unansweredComments.push(...unanswered.map(c => ({
          commentId: c.id,
          postId: post.id,
          message: c.message,
          from: c.from?.name || 'Unknown',
          createdAt: c.created_time,
        })));
      }
    } catch (err) {
      log('warn', `Error fetching comments from Meta for client ${clientId}: ${err.message}`);
    }

    res.json({
      clientId,
      clientName: client.name,
      totalUnanswered: unansweredComments.length,
      comments: unansweredComments,
    });
  } catch (err) {
    log('error', `Error fetching comments for client ${clientId}: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/respond-comment ───────────────────────────────────────────────
app.post('/api/respond-comment', async (req, res) => {
  const { clientId, commentId, commentText, postMessage } = req.body;

  const check = validateRequired(req.body, ['clientId', 'commentId', 'commentText']);
  if (!check.valid) return res.status(400).json({ success: false, message: check.error });

  try {
    const { rows: clientRows } = await db.query(
      'SELECT id, name, page_id, access_token FROM clients WHERE id = $1',
      [clientId]
    );
    if (!clientRows.length) return res.status(404).json({ success: false, message: 'Client not found' });

    const client = clientRows[0];

    const aiReply = await generateCommentReply(commentText, postMessage || '');
    if (!aiReply) {
      return res.status(500).json({ success: false, message: 'AI failed to generate a response' });
    }

    // Publish on Meta
    try {
      await postCommentReply(commentId, aiReply, client.access_token);
    } catch (err) {
      log('warn', `Could not publish reply to Meta (${err.message}). Saving to DB only.`);
    }

    // Save to DB (ignore duplicate)
    await db.query(
      `INSERT INTO comment_responses (client_id, comment_id, original_comment, ai_response)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (client_id, comment_id) DO UPDATE SET ai_response = EXCLUDED.ai_response`,
      [clientId, commentId, commentText, aiReply]
    );

    res.json({
      success: true,
      response: aiReply,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    log('error', `Error responding to comment: ${err.message}`);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── POST /api/schedule-post ─────────────────────────────────────────────────
app.post('/api/schedule-post', async (req, res) => {
  const { clientId, content, imageUrl, scheduledTime, platforms } = req.body;

  const check = validateRequired(req.body, ['clientId', 'content', 'scheduledTime']);
  if (!check.valid) return res.status(400).json({ success: false, message: check.error });

  const scheduledDate = new Date(scheduledTime);
  if (isNaN(scheduledDate.getTime())) {
    return res.status(400).json({ success: false, message: 'Invalid scheduledTime format. Use ISO 8601.' });
  }

  if (scheduledDate <= new Date()) {
    return res.status(400).json({ success: false, message: 'scheduledTime must be in the future' });
  }

  const platformList = Array.isArray(platforms) && platforms.length ? platforms : ['facebook'];
  const validPlatforms = ['facebook', 'instagram'];
  const invalidPlatforms = platformList.filter(p => !validPlatforms.includes(p));
  if (invalidPlatforms.length) {
    return res.status(400).json({ success: false, message: `Invalid platforms: ${invalidPlatforms.join(', ')}` });
  }

  try {
    const { rows: clientRows } = await db.query('SELECT id FROM clients WHERE id = $1', [clientId]);
    if (!clientRows.length) return res.status(404).json({ success: false, message: 'Client not found' });

    const { rows } = await db.query(
      `INSERT INTO scheduled_posts (client_id, content, image_url, scheduled_time, platforms)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [clientId, content, imageUrl || null, scheduledDate, platformList]
    );

    log('info', `Post scheduled: id=${rows[0].id} for client=${clientId} at ${scheduledDate.toISOString()}`);

    res.status(201).json({
      success: true,
      postId: rows[0].id,
      message: `Post scheduled for ${scheduledDate.toISOString()} on [${platformList.join(', ')}]`,
    });
  } catch (err) {
    log('error', `Error scheduling post: ${err.message}`);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── GET /api/analytics/:clientId ────────────────────────────────────────────
app.get('/api/analytics/:clientId', async (req, res) => {
  const clientId = parseInt(req.params.clientId, 10);
  if (isNaN(clientId)) return res.status(400).json({ error: 'Invalid clientId' });

  try {
    const { rows: clientRows } = await db.query(
      'SELECT id, name, platform, page_id, access_token FROM clients WHERE id = $1',
      [clientId]
    );
    if (!clientRows.length) return res.status(404).json({ error: 'Client not found' });

    const client = clientRows[0];
    let metaData = [];

    try {
      const posts = await fetchPagePosts(client.page_id, client.access_token, 10);

      for (const post of posts) {
        let insights = { likes: 0, comments: 0, shares: 0, reach: 0 };
        try {
          const insightsRes = await axios.get(`${META_BASE_URL}/${post.id}`, {
            params: {
              access_token: client.access_token,
              fields: 'likes.summary(true),comments.summary(true),shares,insights.metric(post_impressions_unique)',
            },
            timeout: 10000,
          });
          const d = insightsRes.data;
          insights = {
            likes:    d.likes?.summary?.total_count    || 0,
            comments: d.comments?.summary?.total_count || 0,
            shares:   d.shares?.count                  || 0,
            reach:    d.insights?.data?.[0]?.values?.[0]?.value || 0,
          };
        } catch {
          // Insights may not be available for all posts; continue with zeros
        }

        // Upsert analytics snapshot
        await db.query(
          `INSERT INTO posts_analytics (client_id, post_id, content, likes, comments, shares, reach)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT DO NOTHING`,
          [clientId, post.id, post.message || '', insights.likes, insights.comments, insights.shares, insights.reach]
        );

        metaData.push({ postId: post.id, content: post.message || '', createdTime: post.created_time, ...insights });
      }
    } catch (err) {
      log('warn', `Error fetching Meta analytics for client ${clientId}: ${err.message}`);
    }

    // Fallback to DB data if Meta API returned nothing
    if (!metaData.length) {
      const { rows: dbData } = await db.query(
        `SELECT post_id, content, likes, comments, shares, reach, created_at
         FROM posts_analytics WHERE client_id = $1
         ORDER BY created_at DESC LIMIT 20`,
        [clientId]
      );
      metaData = dbData.map(r => ({
        postId: r.post_id, content: r.content,
        likes: r.likes, comments: r.comments, shares: r.shares, reach: r.reach,
        createdAt: r.created_at,
      }));
    }

    res.json({
      clientId,
      clientName: client.name,
      platform: client.platform,
      data: metaData,
      lastUpdate: new Date().toISOString(),
    });
  } catch (err) {
    log('error', `Error fetching analytics for client ${clientId}: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/recommendations/:clientId ──────────────────────────────────────
app.get('/api/recommendations/:clientId', async (req, res) => {
  const clientId = parseInt(req.params.clientId, 10);
  if (isNaN(clientId)) return res.status(400).json({ error: 'Invalid clientId' });

  try {
    const { rows: clientRows } = await db.query(
      'SELECT id, name, platform FROM clients WHERE id = $1', [clientId]
    );
    if (!clientRows.length) return res.status(404).json({ error: 'Client not found' });

    const client = clientRows[0];

    // Pull recent analytics from DB
    const { rows: analyticsRows } = await db.query(
      `SELECT post_id, likes, comments, shares, reach, created_at
       FROM posts_analytics WHERE client_id = $1
       ORDER BY created_at DESC LIMIT 20`,
      [clientId]
    );

    // Pull response history stats
    const { rows: responseRows } = await db.query(
      'SELECT COUNT(*) AS total FROM comment_responses WHERE client_id = $1', [clientId]
    );

    // Pull scheduled posts stats
    const { rows: postRows } = await db.query(
      `SELECT status, COUNT(*) AS count FROM scheduled_posts WHERE client_id = $1 GROUP BY status`,
      [clientId]
    );

    const historyData = {
      client: { name: client.name, platform: client.platform },
      analytics: analyticsRows,
      totalCommentReplies: parseInt(responseRows[0]?.total || 0),
      postStatusSummary: postRows,
    };

    if (!analyticsRows.length && !parseInt(responseRows[0]?.total)) {
      return res.json({
        clientId,
        recommendations: 'No hay suficiente historial para generar recomendaciones. Conecta posts y responde comentarios primero.',
      });
    }

    log('info', `Generating AI recommendations for client ${clientId}`);
    const recommendations = await generateAnalyticsRecommendations(historyData);

    res.json({ clientId, recommendations });
  } catch (err) {
    log('error', `Error generating recommendations for client ${clientId}: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/response-history/:clientId ─────────────────────────────────────
app.get('/api/response-history/:clientId', async (req, res) => {
  const clientId = parseInt(req.params.clientId, 10);
  if (isNaN(clientId)) return res.status(400).json({ error: 'Invalid clientId' });

  const page  = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
  const offset = (page - 1) * limit;

  try {
    const { rows: clientRows } = await db.query('SELECT name FROM clients WHERE id = $1', [clientId]);
    if (!clientRows.length) return res.status(404).json({ error: 'Client not found' });

    const { rows: countRows } = await db.query(
      'SELECT COUNT(*) AS total FROM comment_responses WHERE client_id = $1', [clientId]
    );
    const total = parseInt(countRows[0].total, 10);

    const { rows: responses } = await db.query(
      `SELECT id, comment_id, original_comment, ai_response, post_id, created_at
       FROM comment_responses WHERE client_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [clientId, limit, offset]
    );

    res.json({
      clientId,
      clientName: clientRows[0].name,
      total,
      page,
      limit,
      responses,
    });
  } catch (err) {
    log('error', `Error fetching response history for client ${clientId}: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/analyze-performance ───────────────────────────────────────────
app.post('/api/analyze-performance', async (req, res) => {
  const { clientId } = req.body;

  if (!clientId) return res.status(400).json({ success: false, message: 'clientId is required' });

  const parsedClientId = parseInt(clientId, 10);
  if (isNaN(parsedClientId)) return res.status(400).json({ success: false, message: 'clientId must be a number' });

  log('info', `[ANALYZE] Starting performance analysis for client ${parsedClientId}`);

  try {
    // Fetch client
    const { rows: clientRows } = await db.query(
      'SELECT id, name, platform, page_id, access_token FROM clients WHERE id = $1',
      [parsedClientId]
    );
    if (!clientRows.length) return res.status(404).json({ success: false, message: 'Client not found' });

    const client = clientRows[0];
    const DAYS_BACK = 60;

    // Fetch posts + metrics from Meta API
    log('info', `[ANALYZE] Fetching posts from last ${DAYS_BACK} days for ${client.name}...`);
    let postsData = [];

    try {
      postsData = await fetchPostsWithMetrics(client.page_id, client.access_token, DAYS_BACK);
      log('info', `[ANALYZE] Retrieved ${postsData.length} posts with metrics`);
    } catch (err) {
      log('warn', `[ANALYZE] Meta API error: ${err.message}. Falling back to DB data.`);

      // Fallback: use stored analytics from DB
      const { rows: dbPosts } = await db.query(
        `SELECT post_id AS "postId", content AS message, likes, comments, shares, reach,
                0 AS impressions, 'unknown' AS "contentType", created_at AS "createdTime",
                EXTRACT(HOUR FROM created_at)::int AS hour,
                TO_CHAR(created_at, 'Day') AS "dayOfWeek",
                CASE WHEN reach > 0 THEN
                  ROUND(((likes + comments + shares)::numeric / reach * 100), 2)
                ELSE 0 END AS "engagementRate"
         FROM posts_analytics WHERE client_id = $1
         ORDER BY created_at DESC LIMIT 100`,
        [parsedClientId]
      );
      postsData = dbPosts;
    }

    if (!postsData.length) {
      return res.status(422).json({
        success: false,
        message: 'No posts found for this client in the last 60 days. Publish some content first.',
      });
    }

    // Compute aggregate statistics to include in the response
    const totalPosts     = postsData.length;
    const totalLikes     = postsData.reduce((s, p) => s + (p.likes     || 0), 0);
    const totalComments  = postsData.reduce((s, p) => s + (p.comments  || 0), 0);
    const totalShares    = postsData.reduce((s, p) => s + (p.shares    || 0), 0);
    const totalReach     = postsData.reduce((s, p) => s + (p.reach     || 0), 0);
    const totalImpressions = postsData.reduce((s, p) => s + (p.impressions || 0), 0);
    const avgEngagement  = postsData.length
      ? (postsData.reduce((s, p) => s + (p.engagementRate || 0), 0) / postsData.length).toFixed(2)
      : '0.00';

    const aggregateStats = {
      totalPosts, totalLikes, totalComments, totalShares,
      totalReach, totalImpressions, avgEngagementRate: parseFloat(avgEngagement),
      period: `${DAYS_BACK} días`,
      analysisDate: new Date().toISOString(),
    };

    // Generate AI report
    log('info', `[ANALYZE] Generating Claude AI report for ${client.name}...`);
    const reportJson = await generatePerformanceReport(client.name, postsData, DAYS_BACK);

    // Extract key insights and recommendations for easy access
    const keyInsights    = reportJson.keyInsights    || [];
    const recommendations = reportJson.recomendacionesAlcance || [];

    // Persist analysis in DB
    await db.query(
      `INSERT INTO performance_analyses
         (client_id, analysis_date, report_json, key_insights, recommendations)
       VALUES ($1, NOW(), $2, $3, $4)`,
      [
        parsedClientId,
        JSON.stringify({ aggregateStats, ...reportJson }),
        JSON.stringify(keyInsights),
        JSON.stringify(recommendations),
      ]
    );

    log('info', `[ANALYZE] ✅ Analysis complete for ${client.name}`);

    res.json({
      success:         true,
      clientId:        parsedClientId,
      clientName:      client.name,
      analysisDate:    new Date().toISOString(),
      aggregateStats,
      analysis:        reportJson,
      recommendations,
      keyInsights,
    });
  } catch (err) {
    log('error', `[ANALYZE] Error for client ${parsedClientId}: ${err.message}`);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 404 catch-all
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// Global error handler
app.use((err, req, res, _next) => {
  log('error', `Unhandled error: ${err.message}`, err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Server Boot ─────────────────────────────────────────────────────────────

async function start() {
  try {
    await checkDbConnection();
    app.listen(PORT, () => {
      log('info', `🚀 Social Media AI Agent running on port ${PORT}`);
      log('info', `   Environment : ${process.env.NODE_ENV || 'development'}`);
      log('info', `   Health check: http://localhost:${PORT}/health`);
      log('info', `   Cron #1 (comments)  : every 5 minutes`);
      log('info', `   Cron #2 (publishing): every 1 minute`);
    });
  } catch (err) {
    log('error', `Failed to start server: ${err.message}`);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  log('info', 'SIGTERM received. Shutting down gracefully...');
  await db.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  log('info', 'SIGINT received. Shutting down gracefully...');
  await db.end();
  process.exit(0);
});

start();
