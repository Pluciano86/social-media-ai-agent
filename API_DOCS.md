# Social Media AI Agent — API Documentation

**Base URL:** `https://social-media-ai-agent.onrender.com`  
**Version:** 1.0.0  
**Total endpoints:** 28

---

## Table of Contents

1. [Authentication](#authentication)
2. [System](#system)
3. [Account Management](#account-management)
4. [Meta Client Management](#meta-client-management)
5. [Clients](#clients)
6. [Comments](#comments)
7. [Scheduled Posts](#scheduled-posts)
8. [Analytics & AI](#analytics--ai)
9. [Error Reference](#error-reference)

---

## Authentication

All protected endpoints require a `Bearer` token in the `Authorization` header:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Tokens expire after **24 hours**. Use `/api/auth/refresh` to renew.

| Symbol | Meaning |
|--------|---------|
| ❌ | Public — no token required |
| ✅ | Protected — valid JWT required |

---

## System

### `GET /api/health` ❌

Returns server status and database liveness.

**Response `200`:**
```json
{
  "status": "ok",
  "timestamp": "2026-05-04T12:00:00.000Z",
  "uptime": 3600,
  "environment": "production",
  "services": {
    "database": { "status": "ok", "latencyMs": 4 }
  }
}
```

**Response `503`** (database unreachable):
```json
{
  "status": "degraded",
  "services": {
    "database": { "status": "error", "latencyMs": null }
  }
}
```

---

## Account Management

### `POST /api/auth/register` ❌

Creates a new user account and returns a JWT token.

**Body:**
```json
{
  "username": "admin",
  "password": "myPassword123"
}
```

| Field | Required | Rules |
|-------|----------|-------|
| `username` | ✅ | Unique, stored lowercase |
| `password` | ✅ | Minimum 8 characters |

**Response `201`:**
```json
{
  "success": true,
  "message": "User registered successfully",
  "token": "eyJhbGci...",
  "expiresIn": "24h",
  "user": {
    "id": 1,
    "username": "admin",
    "createdAt": "2026-05-04T12:00:00.000Z"
  }
}
```

**Errors:** `400` missing fields · `400` password too short · `409` username taken

---

### `POST /api/auth/login` ❌

Authenticates a user and returns a JWT token.

**Body:**
```json
{
  "username": "admin",
  "password": "myPassword123"
}
```

**Response `200`:**
```json
{
  "success": true,
  "token": "eyJhbGci...",
  "expiresIn": "24h",
  "user": {
    "id": 1,
    "username": "admin"
  }
}
```

**Errors:** `400` missing fields · `401` invalid credentials

---

### `POST /api/auth/refresh` ✅

Issues a new token and revokes the current one (rotation).

**Response `200`:**
```json
{
  "success": true,
  "token": "eyJhbGci...",
  "expiresIn": "24h"
}
```

---

### `POST /api/auth/logout` ✅

Revokes the current token immediately.

**Response `200`:**
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

After logout, the same token returns `401 Token has been revoked`.

---

### `GET /api/auth/me` ✅

Returns the authenticated user's profile and token metadata.

**Response `200`:**
```json
{
  "success": true,
  "user": {
    "id": 1,
    "username": "admin",
    "createdAt": "2026-05-04T12:00:00.000Z"
  },
  "token": {
    "issuedAt": "2026-05-04T12:00:00.000Z",
    "expiresAt": "2026-05-05T12:00:00.000Z"
  }
}
```

**Errors:** `404` user not found

---

### `PUT /api/auth/change-password` ✅

Updates the user's password. Revokes the current token after the change.

**Body:**
```json
{
  "currentPassword": "myPassword123",
  "newPassword": "newPassword456"
}
```

| Field | Required | Rules |
|-------|----------|-------|
| `currentPassword` | ✅ | Must match stored password |
| `newPassword` | ✅ | Minimum 8 characters, must differ from current |

**Response `200`:**
```json
{
  "success": true,
  "message": "Password changed successfully. Please log in again."
}
```

**Errors:** `400` missing fields · `400` too short · `400` same as current · `401` wrong password

---

### `DELETE /api/auth/delete-account` ✅

Permanently deletes the account. Requires password confirmation.

**Body:**
```json
{
  "password": "myPassword123"
}
```

**Response `200`:**
```json
{
  "success": true,
  "message": "Account \"admin\" deleted successfully"
}
```

**Errors:** `400` missing password · `401` wrong password

---

## Meta Client Management

### `POST /api/auth/list-pages` ❌

Returns all Facebook Pages accessible with a User Access Token.  
Use this before `/connect-client` to let the user choose a page.

**Body:**
```json
{
  "userAccessToken": "EAABwzLixnjYBO..."
}
```

**Response `200`:**
```json
{
  "success": true,
  "total": 2,
  "pages": [
    { "pageId": "111222333", "pageName": "My Store", "category": "Retail", "followers": 1200 },
    { "pageId": "444555666", "pageName": "My Blog",  "category": "Media",  "followers": 850 }
  ]
}
```

**Errors:** `400` missing token · `401` invalid token · `404` no pages found

---

### `POST /api/auth/connect-client` ❌

Connects a Facebook/Instagram client. Automatically exchanges the User Token for a Page Access Token.  
If the user manages multiple pages, `pageId` is required.

**Body:**
```json
{
  "clientName": "My Store",
  "platformType": "facebook",
  "userAccessToken": "EAABwzLixnjYBO...",
  "pageId": "111222333"
}
```

| Field | Required | Values |
|-------|----------|--------|
| `clientName` | ✅ | Any string |
| `platformType` | ✅ | `facebook` · `instagram` · `both` |
| `userAccessToken` | ✅ | Meta User Access Token |
| `pageId` | Conditional | Required when user manages multiple pages |

**Response `201`:**
```json
{
  "success": true,
  "message": "Client connected successfully",
  "clientId": 1,
  "clientName": "My Store",
  "pageId": "111222333"
}
```

**Response `400`** (multiple pages, no `pageId`):
```json
{
  "success": false,
  "message": "This user manages multiple pages. Provide pageId to select one.",
  "pages": [
    { "pageId": "111222333", "pageName": "My Store" },
    { "pageId": "444555666", "pageName": "My Blog" }
  ]
}
```

**Errors:** `400` missing/invalid fields · `401` invalid token · `404` page not found

---

### `GET /api/auth/pages/:clientId` ✅

Returns the connected page details for a client.

**Response `200`:**
```json
{
  "success": true,
  "clientId": 1,
  "clientName": "My Store",
  "platform": "facebook",
  "pageId": "111222333",
  "connectedAt": "2026-05-04T12:00:00.000Z"
}
```

**Errors:** `400` invalid id · `404` client not found

---

### `DELETE /api/auth/disconnect/:clientId` ✅

Disconnects a client and deletes all associated data (posts, comments, analytics) via cascade.

**Response `200`:**
```json
{
  "success": true,
  "message": "Client \"My Store\" disconnected successfully",
  "clientId": 1,
  "pageId": "111222333"
}
```

**Errors:** `400` invalid id · `404` client not found

---

## Clients

### `GET /api/clients` ✅

Returns all connected clients ordered by most recently connected.

**Response `200`:**
```json
{
  "success": true,
  "total": 2,
  "clients": [
    {
      "clientId": 2,
      "clientName": "My Blog",
      "platform": "instagram",
      "pageId": "444555666",
      "connectedAt": "2026-05-04T13:00:00.000Z"
    },
    {
      "clientId": 1,
      "clientName": "My Store",
      "platform": "facebook",
      "pageId": "111222333",
      "connectedAt": "2026-05-04T12:00:00.000Z"
    }
  ]
}
```

---

### `GET /api/clients/:clientId` ✅

Returns a single client by ID.

**Response `200`:**
```json
{
  "success": true,
  "clientId": 1,
  "clientName": "My Store",
  "platform": "facebook",
  "pageId": "111222333",
  "connectedAt": "2026-05-04T12:00:00.000Z"
}
```

**Errors:** `400` invalid id · `404` not found

---

### `PUT /api/clients/:clientId` ✅

Updates `clientName` and/or `platformType`. Send only the fields to change.

**Body:**
```json
{
  "clientName": "My Store V2",
  "platformType": "both"
}
```

| Field | Required | Values |
|-------|----------|--------|
| `clientName` | Conditional | Any string |
| `platformType` | Conditional | `facebook` · `instagram` · `both` |

At least one field must be provided.

**Response `200`:**
```json
{
  "success": true,
  "message": "Client updated successfully",
  "clientId": 1,
  "clientName": "My Store V2",
  "platform": "both",
  "pageId": "111222333",
  "connectedAt": "2026-05-04T12:00:00.000Z"
}
```

**Errors:** `400` no fields provided · `400` invalid platform · `404` not found

---

## Comments

### `GET /api/comments/:clientId` ✅

Fetches all comments from the last 3 posts via Meta API. Each comment includes an `answered` flag.

**Response `200`:**
```json
{
  "success": true,
  "clientId": 1,
  "clientName": "My Store",
  "source": "meta",
  "total": 8,
  "totalUnanswered": 5,
  "totalAnswered": 3,
  "comments": [
    {
      "commentId": "123456789_987654321",
      "postId": "123456789_111222333",
      "message": "Do you have delivery?",
      "from": "John Doe",
      "answered": false,
      "createdAt": "2026-05-04T10:00:00+0000"
    }
  ]
}
```

`source` is `"meta"` for live data or `"unavailable"` if the Meta API call failed.

**Errors:** `400` invalid id · `404` client not found

---

### `POST /api/respond-comment` ✅

Generates an AI reply with Claude and publishes it to Meta.

**Body:**
```json
{
  "clientId": 1,
  "commentId": "123456789_987654321",
  "commentText": "Do you have delivery?",
  "postMessage": "Special offer today!"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `clientId` | ✅ | Connected client ID |
| `commentId` | ✅ | Meta comment ID |
| `commentText` | ✅ | Comment text (context for Claude) |
| `postMessage` | ❌ | Original post text — improves AI reply quality |

**Response `200`:**
```json
{
  "success": true,
  "clientId": 1,
  "commentId": "123456789_987654321",
  "aiResponse": "Hi John! Yes, we deliver. Estimated time is 2-3 business days. 😊",
  "publishedToMeta": true,
  "generatedAt": "2026-05-04T12:00:00.000Z"
}
```

`publishedToMeta: false` means the reply was saved to DB but could not be posted to Meta (expired token, network error, etc.).

**Errors:** `400` missing fields · `404` client not found · `500` AI generation failed

---

### `GET /api/response-history/:clientId` ✅

Returns paginated history of AI-generated comment replies.

**Query params:**

| Param | Default | Max |
|-------|---------|-----|
| `page` | `1` | — |
| `limit` | `20` | `100` |

**Example:** `GET /api/response-history/1?page=2&limit=10`

**Response `200`:**
```json
{
  "success": true,
  "clientId": 1,
  "clientName": "My Store",
  "total": 45,
  "page": 1,
  "limit": 20,
  "totalPages": 3,
  "responses": [
    {
      "responseId": 12,
      "commentId": "123456789_987654321",
      "originalComment": "Do you have delivery?",
      "aiResponse": "Hi John! Yes, we deliver...",
      "postId": "123456789_111222333",
      "platform": "facebook",
      "createdAt": "2026-05-04T12:00:00.000Z"
    }
  ]
}
```

**Errors:** `400` invalid id · `404` client not found

---

## Scheduled Posts

### `POST /api/schedule-post` ✅

Schedules a post for future publication. The cron job publishes it automatically every minute.

**Body:**
```json
{
  "clientId": 1,
  "content": "Special offer today! 20% off everything. 🛍️",
  "imageUrl": "https://example.com/image.jpg",
  "scheduledTime": "2026-05-06T15:00:00.000Z",
  "platforms": ["facebook", "instagram"]
}
```

| Field | Required | Rules |
|-------|----------|-------|
| `clientId` | ✅ | Connected client ID |
| `content` | ✅ | Post text |
| `scheduledTime` | ✅ | ISO 8601, must be in the future |
| `imageUrl` | ❌ | Image URL |
| `platforms` | ❌ | Default `["facebook"]`. Values: `facebook` · `instagram` |

**Response `201`:**
```json
{
  "success": true,
  "message": "Post scheduled successfully",
  "postId": 5,
  "clientId": 1,
  "clientName": "My Store",
  "content": "Special offer today! 20% off everything. 🛍️",
  "imageUrl": "https://example.com/image.jpg",
  "scheduledTime": "2026-05-06T15:00:00.000Z",
  "platforms": ["facebook", "instagram"],
  "status": "pending",
  "createdAt": "2026-05-04T12:00:00.000Z"
}
```

**Errors:** `400` missing/invalid fields · `400` past date · `404` client not found

---

### `GET /api/scheduled-posts/:clientId` ✅

Returns all scheduled posts for a client ordered by `scheduledTime ASC`.

**Query params:**

| Param | Values |
|-------|--------|
| `status` | `pending` · `published` · `failed` · `cancelled` |

**Example:** `GET /api/scheduled-posts/1?status=pending`

**Response `200`:**
```json
{
  "success": true,
  "clientId": 1,
  "total": 3,
  "posts": [
    {
      "postId": 5,
      "content": "Special offer today!",
      "imageUrl": null,
      "scheduledTime": "2026-05-06T15:00:00.000Z",
      "platforms": ["facebook"],
      "status": "pending",
      "publishedAt": null,
      "errorMessage": null,
      "createdAt": "2026-05-04T12:00:00.000Z"
    }
  ]
}
```

**Errors:** `400` invalid id/status · `404` client not found

---

### `GET /api/scheduled-posts/:postId` ✅

Returns a single scheduled post by ID.

**Response `200`:**
```json
{
  "success": true,
  "postId": 5,
  "clientId": 1,
  "content": "Special offer today!",
  "imageUrl": null,
  "scheduledTime": "2026-05-06T15:00:00.000Z",
  "platforms": ["facebook", "instagram"],
  "status": "pending",
  "publishedAt": null,
  "errorMessage": null,
  "createdAt": "2026-05-04T12:00:00.000Z"
}
```

**Errors:** `400` invalid id · `404` not found

---

### `PUT /api/scheduled-posts/:postId` ✅

Edits a pending post. Only `pending` posts can be edited.

**Body:**
```json
{
  "content": "Updated offer — 30% off!",
  "imageUrl": "https://example.com/new-image.jpg",
  "scheduledTime": "2026-05-07T10:00:00.000Z",
  "platforms": ["facebook"]
}
```

All fields are optional — send only what you want to change.

| Field | Rules |
|-------|-------|
| `scheduledTime` | Must be a future ISO 8601 date |
| `platforms` | Non-empty array of `facebook` / `instagram` |

**Response `200`:**
```json
{
  "success": true,
  "message": "Scheduled post updated successfully",
  "postId": 5,
  "content": "Updated offer — 30% off!",
  "imageUrl": "https://example.com/new-image.jpg",
  "scheduledTime": "2026-05-07T10:00:00.000Z",
  "platforms": ["facebook"],
  "status": "pending",
  "createdAt": "2026-05-04T12:00:00.000Z"
}
```

**Errors:** `400` no fields · `400` invalid date/platforms · `404` not found · `409` not pending

---

### `DELETE /api/scheduled-posts/:postId` ✅

Deletes a pending post. Only `pending` posts can be deleted.

**Response `200`:**
```json
{
  "success": true,
  "message": "Scheduled post deleted successfully",
  "postId": 5
}
```

**Errors:** `400` invalid id · `404` not found · `409` not pending

---

## Analytics & AI

### `GET /api/analytics/:clientId` ✅

Fetches real-time post metrics from Meta API and saves snapshots to the database.  
Falls back to stored data if Meta API is unavailable.

**Response `200`:**
```json
{
  "success": true,
  "clientId": 1,
  "clientName": "My Store",
  "platform": "facebook",
  "source": "meta",
  "total": 10,
  "aggregates": {
    "likes": 342,
    "comments": 87,
    "shares": 54,
    "reach": 4200,
    "totalEngagements": 483,
    "avgEngagementRate": 11.5
  },
  "posts": [
    {
      "postId": "111_222",
      "content": "Special offer!",
      "createdTime": "2026-05-03T14:00:00+0000",
      "likes": 45,
      "comments": 12,
      "shares": 8,
      "reach": 620
    }
  ],
  "lastUpdate": "2026-05-04T12:00:00.000Z"
}
```

`source` is `"meta"` for live data or `"database"` for fallback.

**Errors:** `400` invalid id · `404` client not found

---

### `GET /api/recommendations/:clientId` ✅

Generates AI-powered content recommendations based on recent analytics and engagement history.

**Response `200`:**
```json
{
  "success": true,
  "clientId": 1,
  "clientName": "My Store",
  "platform": "facebook",
  "insufficientData": false,
  "recommendations": "Based on your last 20 posts, video content performs 3x better...",
  "generatedAt": "2026-05-04T12:00:00.000Z"
}
```

If no data is available yet:
```json
{
  "success": true,
  "insufficientData": true,
  "recommendations": "No history found. Publish posts and respond to comments first."
}
```

**Errors:** `400` invalid id · `404` client not found

---

### `POST /api/analyze-performance` ✅

Generates a full 60-day performance report using Claude AI.  
Fetches metrics from Meta API (falls back to DB), computes aggregates, and persists the report.

> This request takes **15–30 seconds**. Set Postman timeout to 60,000 ms.

**Body:**
```json
{
  "clientId": 1
}
```

**Response `200`:**
```json
{
  "success": true,
  "clientId": 1,
  "clientName": "My Store",
  "analysisDate": "2026-05-04T12:00:00.000Z",
  "aggregateStats": {
    "totalPosts": 24,
    "totalLikes": 1840,
    "totalComments": 312,
    "totalShares": 98,
    "totalReach": 18500,
    "totalImpressions": 24000,
    "avgEngagementRate": 12.18,
    "period": "60 días"
  },
  "analysis": {
    "resumenEjecutivo": "...",
    "analisisPorTipoContenido": {},
    "horariosOptimos": ["Tuesday 6pm", "Thursday 12pm"],
    "tasasEngagement": {},
    "topPosts": [],
    "bottomPosts": [],
    "recomendacionesAlcance": [],
    "estrategiaContenido30Dias": "...",
    "tendencias": "...",
    "tipsExito": [],
    "keyInsights": []
  },
  "recommendations": [],
  "keyInsights": []
}
```

**Errors:** `400` missing clientId · `404` client not found · `422` no posts in last 60 days

---

### `GET /api/analyze-performance/:clientId` ✅

Returns the most recent stored performance analysis for a client. Does not call Claude AI.

**Response `200`:**
```json
{
  "success": true,
  "clientId": 1,
  "clientName": "My Store",
  "platform": "facebook",
  "analysisId": 7,
  "analysisDate": "2026-05-04T12:00:00.000Z",
  "aggregateStats": {},
  "analysis": {},
  "recommendations": [],
  "keyInsights": [],
  "createdAt": "2026-05-04T12:00:00.000Z"
}
```

**Errors:** `400` invalid id · `404` client not found or no analysis yet

---

## Error Reference

All error responses follow this shape:

```json
{
  "success": false,
  "message": "Human-readable description"
}
```

| Status | Meaning |
|--------|---------|
| `400` | Bad request — missing or invalid fields |
| `401` | Unauthorized — missing, expired, or revoked token |
| `404` | Not found — resource does not exist |
| `409` | Conflict — duplicate or invalid state (e.g. editing a published post) |
| `422` | Unprocessable — request valid but cannot be completed (e.g. no posts found) |
| `429` | Too many requests — rate limit exceeded (100 req / 15 min per IP) |
| `500` | Internal server error |
| `503` | Service unavailable — database unreachable |

---

## Automated Background Jobs

| Cron | Schedule | Description |
|------|----------|-------------|
| #1 | Every 5 min | Fetch unanswered comments → reply with Claude AI |
| #2 | Every 1 min | Publish pending scheduled posts to Facebook/Instagram |
| #3 | Daily at midnight | Purge expired JWT blacklist entries |
