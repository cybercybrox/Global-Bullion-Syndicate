'use strict';

const http = require('node:http');
const { Pool } = require('pg');

const {
    default: makeWASocket,
    DisconnectReason,
    initAuthCreds,
    BufferJSON,
    proto
} = require('@whiskeysockets/baileys');

const PHONE_NUMBER = (
    process.env.WHATSAPP_PHONE_NUMBER || ''
).replace(/\D/g, '');

const DATABASE_URL = process.env.DATABASE_URL || '';

const SESSION_ID =
    process.env.WHATSAPP_SESSION_ID ||
    'global-bullion-syndicate-main';

const PORT = Number(process.env.PORT || 10000);

const INITIAL_RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30000;

const TABLE_NAME = 'gbs_baileys_auth';

if (!/^\d{8,15}$/.test(PHONE_NUMBER)) {
    throw new Error(
        'WHATSAPP_PHONE_NUMBER is missing or invalid. ' +
        'Use the full international number with digits only.'
    );
}

if (!DATABASE_URL) {
    throw new Error(
        'DATABASE_URL is missing. Add a PostgreSQL connection ' +
        'string in Render Environment Variables to preserve ' +
        'WhatsApp authentication.'
    );
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error('PORT is invalid.');
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 20000,
    keepAlive: true
});

pool.on('error', (error) => {
    console.error(
        '[DATABASE POOL ERROR]',
        error.message || error
    );
});

let activeSocket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let connecting = false;
let shuttingDown = false;
let databaseReady = false;
let whatsappStatus = 'starting';
let lastConnectedAt = null;
let server = null;

function sendJson(res, statusCode, data) {
    const body = JSON.stringify(data);

    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });

    res.end(body);
}

function startHttpServer() {
    return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
            if (req.method !== 'GET') {
                res.setHeader('Allow', 'GET');

                return sendJson(res, 405, {
                    error: 'Method not allowed'
                });
            }

            let pathname;

            try {
                pathname = new URL(
                    req.url || '/',
                    'http://localhost'
                ).pathname;
            } catch {
                return sendJson(res, 400, {
                    error: 'Invalid request URL'
                });
            }

            if (
                pathname === '/' ||
                pathname === '/health' ||
                pathname === '/status'
            ) {
                return sendJson(res, 200, {
                    service: 'Global Bullion Syndicate',
                    status: shuttingDown
                        ? 'shutting_down'
                        : 'running',
                    database: databaseReady
                        ? 'connected'
                        : 'not_ready',
                    whatsapp: whatsappStatus,
                    last_connected_at: lastConnectedAt,
                    uptime_seconds: Math.floor(
                        process.uptime()
                    )
                });
            }

            return sendJson(res, 404, {
                error: 'Not found'
            });
        });

        server.once('error', reject);

        server.listen(PORT, '0.0.0.0', () => {
            server.removeListener('error', reject);

            console.log(
                `[HTTP] Listening on 0.0.0.0:${PORT}`
            );

            resolve();
        });
    });
}

function serialize(value) {
    return JSON.stringify(value, BufferJSON.replacer);
}

function deserialize(value) {
    if (
        value === null ||
        typeof value === 'undefined'
    ) {
        return null;
    }

    const json = typeof value === 'string'
        ? value
        : JSON.stringify(value);

    return JSON.parse(json, BufferJSON.reviver);
}

async function saveAuthItem(type, id, value) {
    if (
        value === null ||
        typeof value === 'undefined'
    ) {
        await pool.query(
            `DELETE FROM ${TABLE_NAME}
             WHERE session_id = $1
             AND item_type = $2
             AND item_id = $3`,
            [SESSION_ID, type, id]
        );

        return;
    }

    await pool.query(
        `INSERT INTO ${TABLE_NAME}
            (
                session_id,
                item_type,
                item_id,
                item_value,
                updated_at
            )
         VALUES ($1, $2, $3, $4::jsonb, NOW())
         ON CONFLICT (session_id, item_type, item_id)
         DO UPDATE SET
            item_value = EXCLUDED.item_value,
            updated_at = NOW()`,
        [
            SESSION_ID,
            type,
            id,
            serialize(value)
        ]
    );
}

async function loadAuthItem(type, id) {
    const result = await pool.query(
        `SELECT item_value
         FROM ${TABLE_NAME}
         WHERE session_id = $1
         AND item_type = $2
         AND item_id = $3
         LIMIT 1`,
        [SESSION_ID, type, id]
    );

    if (!result.rowCount) {
        return null;
    }

    return deserialize(result.rows[0].item_value);
}

async function createDatabaseAuthState() {
    const savedCreds = await loadAuthItem(
        'creds',
        'creds'
    );

    const creds = savedCreds || initAuthCreds();

    if (!savedCreds) {
        await saveAuthItem(
            'creds',
            'creds',
            creds
        );

        console.log(
            '[AUTH] New authentication state created in PostgreSQL.'
        );
    } else {
        console.log(
            '[AUTH] Existing authentication state restored from PostgreSQL.'
        );
    }

    return {
        state: {
            creds,

            keys: {
                get: async (type, ids) => {
                    if (!ids.length) {
                        return {};
                    }

                    const result = await pool.query(
                        `SELECT item_id, item_value
                         FROM ${TABLE_NAME}
                         WHERE session_id = $1
                         AND item_type = $2
                         AND item_id = ANY($3::text[])`,
                        [
                            SESSION_ID,
                            type,
                            ids
                        ]
                    );

                    const data = {};

                    for (const row of result.rows) {
                        let value = deserialize(
                            row.item_value
                        );

                        if (
                            type === 'app-state-sync-key' &&
                            value
                        ) {
                            value =
                                proto.Message.AppStateSyncKeyData
                                    .fromObject(value);
                        }

                        data[row.item_id] = value;
                    }

                    return data;
                },

                set: async (data) => {
                    const tasks = [];

                    for (
                        const [type, entries]
                        of Object.entries(data)
                    ) {
                        for (
                            const [id, value]
                            of Object.entries(entries || {})
                        ) {
                            tasks.push(
                                saveAuthItem(
                                    type,
                                    id,
                                    value
                                )
                            );
                        }
                    }

                    await Promise.all(tasks);
                },

                clear: async () => {
                    await pool.query(
                        `DELETE FROM ${TABLE_NAME}
                         WHERE session_id = $1`,
                        [SESSION_ID]
                    );
                }
            }
        },

        saveCreds: async () => {
            await saveAuthItem(
                'creds',
                'creds',
                creds
            );
        }
    };
}

function getDisconnectStatusCode(error) {
    return (
        error?.output?.statusCode ??
        error?.statusCode ??
        null
    );
}

function scheduleReconnect(reason) {
    if (shuttingDown || reconnectTimer) {
        return;
    }

    reconnectAttempts += 1;

    const exponent = Math.min(
        reconnectAttempts - 1,
        4
    );

    const delay = Math.min(
        INITIAL_RECONNECT_DELAY_MS * (2 ** exponent),
        MAX_RECONNECT_DELAY_MS
    );

    whatsappStatus = 'reconnecting';

    console.warn(
        `[RECONNECT] ${
            reason || 'Connection closed'
        }. Retry in ${
            Math.ceil(delay / 1000)
        }s (attempt ${reconnectAttempts}).`
    );

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connectToWhatsApp();
    }, delay);

    reconnectTimer.unref?.();
}

async function connectToWhatsApp() {
    if (
        shuttingDown ||
        connecting ||
        activeSocket
    ) {
        return;
    }

    connecting = true;
    whatsappStatus = 'connecting';

    let socketCreated = null;

    try {
        const auth = await createDatabaseAuthState();

        let pairingCodeRequested = false;

        const sock = makeWASocket({
            auth: auth.state,
            markOnlineOnConnect: false,
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000
        });

        socketCreated = sock;
        activeSocket = sock;

        sock.ev.on('creds.update', () => {
            auth.saveCreds().catch((error) => {
                console.error(
                    '[AUTH SAVE ERROR]',
                    error.message || error
                );
            });
        });

        sock.ev.on(
            'connection.update',
            async (update) => {
                const {
                    connection,
                    lastDisconnect,
                    qr
                } = update;

                if (
                    qr &&
                    !auth.state.creds.registered &&
                    !pairingCodeRequested
                ) {
                    pairingCodeRequested = true;

                    try {
                        const code =
                            await sock.requestPairingCode(
                                PHONE_NUMBER
                            );

                        console.log(
                            '========================================'
                        );

                        console.log(
                            'GLOBAL BULLION SYNDICATE — PAIRING CODE'
                        );

                        console.log(
                            `Pairing code: ${code}`
                        );

                        console.log(
                            'Enter it in WhatsApp > Linked Devices > ' +
                            'Link a Device > Link with phone number instead.'
                        );

                        console.log(
                            'Keep this code private.'
                        );

                        console.log(
                            '========================================'
                        );
                    } catch (error) {
                        console.error(
                            '[PAIRING CODE ERROR]',
                            error.message || error
                        );
                    }
                }

                if (connection === 'connecting') {
                    whatsappStatus = 'connecting';

                    console.log(
                        '[WHATSAPP] Connecting.'
                    );
                }

                if (connection === 'open') {
                    reconnectAttempts = 0;
                    whatsappStatus = 'connected';

                    lastConnectedAt =
                        new Date().toISOString();

                    console.log(
                        '[WHATSAPP] Connected. ' +
                        'Authentication state is stored in PostgreSQL.'
                    );
                }

                if (connection === 'close') {
                    if (sock !== activeSocket) {
                        return;
                    }

                    activeSocket = null;

                    const error = lastDisconnect?.error;

                    const statusCode =
                        getDisconnectStatusCode(error);

                    console.warn(
                        '[WHATSAPP] Disconnected:',
                        error?.message || 'Connection closed'
                    );

                    if (statusCode !== null) {
                        console.warn(
                            '[WHATSAPP] Disconnect status:',
                            statusCode
                        );
                    }

                    if (
                        statusCode ===
                        DisconnectReason.loggedOut
                    ) {
                        whatsappStatus = 'logged_out';

                        console.error(
                            '[AUTH] WhatsApp logged out this linked device. ' +
                            'Review the session before deliberately pairing again.'
                        );

                        return;
                    }

                    scheduleReconnect(
                        error?.message ||
                        'WhatsApp connection closed'
                    );
                }
            }
        );

        sock.ev.on(
            'messages.upsert',
            async ({ messages, type }) => {
                if (type !== 'notify') {
                    return;
                }

                for (const message of messages || []) {
                    if (
                        !message?.message ||
                        message.key?.fromMe
                    ) {
                        continue;
                    }

                    const remoteJid =
                        message.key?.remoteJid;

                    if (
                        !remoteJid ||
                        remoteJid === 'status@broadcast' ||
                        remoteJid.endsWith('@g.us')
                    ) {
                        continue;
                    }

                    const text = (
                        message.message.conversation ||
                        message.message
                            .extendedTextMessage?.text ||
                        ''
                    ).trim().toLowerCase();

                    if (
                        text !== '!ping' &&
                        text !== '/ping'
                    ) {
                        continue;
                    }

                    try {
                        await sock.sendMessage(
                            remoteJid,
                            {
                                text:
                                    '🐂 Global Bullion Syndicate is online.'
                            }
                        );

                        console.log(
                            '[MESSAGE] Replied to a private ping test.'
                        );
                    } catch (error) {
                        console.error(
                            '[MESSAGE ERROR]',
                            error.message || error
                        );
                    }
                }
            }
        );
    } catch (error) {
        if (
            socketCreated &&
            socketCreated === activeSocket
        ) {
            activeSocket = null;

            try {
                socketCreated.end(error);
            } catch {}
        }

        whatsappStatus = 'error';

        console.error(
            '[WHATSAPP START ERROR]',
            error.stack || error.message || error
        );

        scheduleReconnect(
            error?.message || 'WhatsApp startup failed'
        );
    } finally {
        connecting = false;
    }
}

async function shutdown(signal) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;
    whatsappStatus = 'shutting_down';

    console.log(`[SHUTDOWN] ${signal}`);

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (activeSocket) {
        try {
            activeSocket.end(
                new Error(`Process shutdown: ${signal}`)
            );
        } catch (error) {
            console.error(
                '[SHUTDOWN SOCKET ERROR]',
                error.message || error
            );
        }

        activeSocket = null;
    }

    if (server?.listening) {
        await new Promise((resolve) => {
            server.close(resolve);
        });
    }

    try {
        await pool.end();
    } catch (error) {
        console.error(
            '[DATABASE SHUTDOWN ERROR]',
            error.message || error
        );
    }

    process.exit(0);
}

process.once('SIGINT', () => {
    void shutdown('SIGINT');
});

process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
});

async function main() {
    await pool.query('SELECT 1');

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
            session_id TEXT NOT NULL,
            item_type TEXT NOT NULL,
            item_id TEXT NOT NULL,
            item_value JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (
                session_id,
                item_type,
                item_id
            )
        )
    `);

    databaseReady = true;

    console.log(
        '[DATABASE] PostgreSQL is ready.'
    );

    await startHttpServer();

    console.log(
        '[APP] Global Bullion Syndicate is ready.'
    );

    console.log(
        '[APP] Health endpoint: /health'
    );

    console.log(
        '[APP] Status endpoint: /status'
    );

    void connectToWhatsApp();
}

main().catch(async (error) => {
    console.error(
        '[FATAL STARTUP ERROR]',
        error.stack || error.message || error
    );

    try {
        await pool.end();
    } catch {}

    process.exit(1);
});
