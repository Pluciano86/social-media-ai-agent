-- Social Media AI Agent - Database Schema
-- Run this file to initialize the PostgreSQL database

-- Drop tables if they exist (for clean reinstall)
DROP TABLE IF EXISTS posts_analytics CASCADE;
DROP TABLE IF EXISTS comment_responses CASCADE;
DROP TABLE IF EXISTS scheduled_posts CASCADE;
DROP TABLE IF EXISTS clients CASCADE;

-- ============================================================
-- TABLE: clients
-- Stores connected social media client accounts
-- ============================================================
CREATE TABLE clients (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(255)        NOT NULL,
    platform    VARCHAR(50)         NOT NULL CHECK (platform IN ('facebook', 'instagram', 'both')),
    page_id     VARCHAR(255)        NOT NULL,
    access_token TEXT               NOT NULL,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_clients_platform ON clients(platform);
CREATE INDEX idx_clients_page_id  ON clients(page_id);

-- ============================================================
-- TABLE: scheduled_posts
-- Posts queued for future publication
-- ============================================================
CREATE TABLE scheduled_posts (
    id              SERIAL PRIMARY KEY,
    client_id       INTEGER         NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    content         TEXT            NOT NULL,
    image_url       VARCHAR(2048),
    scheduled_time  TIMESTAMP WITH TIME ZONE NOT NULL,
    platforms       TEXT[]          NOT NULL DEFAULT ARRAY['facebook'],
    status          VARCHAR(20)     NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'published', 'failed', 'cancelled')),
    published_at    TIMESTAMP WITH TIME ZONE,
    error_message   TEXT,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_scheduled_posts_client_id     ON scheduled_posts(client_id);
CREATE INDEX idx_scheduled_posts_status        ON scheduled_posts(status);
CREATE INDEX idx_scheduled_posts_scheduled_time ON scheduled_posts(scheduled_time);

-- ============================================================
-- TABLE: comment_responses
-- Audit log of AI-generated comment replies
-- ============================================================
CREATE TABLE comment_responses (
    id              SERIAL PRIMARY KEY,
    client_id       INTEGER         NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    comment_id      VARCHAR(255)    NOT NULL,
    original_comment TEXT           NOT NULL,
    ai_response     TEXT            NOT NULL,
    post_id         VARCHAR(255),
    platform        VARCHAR(50)     DEFAULT 'facebook',
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_comment_responses_client_id  ON comment_responses(client_id);
CREATE INDEX idx_comment_responses_comment_id ON comment_responses(comment_id);

-- Unique constraint prevents double-responding to the same comment
CREATE UNIQUE INDEX idx_comment_responses_unique ON comment_responses(client_id, comment_id);

-- ============================================================
-- TABLE: posts_analytics
-- Snapshot of post performance metrics from Meta API
-- ============================================================
CREATE TABLE posts_analytics (
    id          SERIAL PRIMARY KEY,
    client_id   INTEGER         NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    post_id     VARCHAR(255)    NOT NULL,
    content     TEXT,
    likes       INTEGER         DEFAULT 0,
    comments    INTEGER         DEFAULT 0,
    shares      INTEGER         DEFAULT 0,
    reach       INTEGER         DEFAULT 0,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_posts_analytics_client_id ON posts_analytics(client_id);
CREATE INDEX idx_posts_analytics_post_id   ON posts_analytics(post_id);
CREATE INDEX idx_posts_analytics_created_at ON posts_analytics(created_at DESC);

-- ============================================================
-- TABLE: performance_analyses
-- AI-generated performance reports for client accounts
-- ============================================================
CREATE TABLE performance_analyses (
    id               SERIAL PRIMARY KEY,
    client_id        INTEGER         NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    analysis_date    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    report_json      JSONB           NOT NULL,
    key_insights     JSONB,
    recommendations  JSONB,
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_performance_analyses_client_id    ON performance_analyses(client_id);
CREATE INDEX idx_performance_analyses_created_at   ON performance_analyses(created_at DESC);
