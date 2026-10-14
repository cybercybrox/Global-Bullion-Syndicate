'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');

// ============================================
// GLOBAL BULLION SYNDICATE — CONFIGURATION
// ============================================

// International phone number: digits only, including country code.
const PHONE_NUMBER = '263789379749';

// Keep the session ID stable between restarts.
const SESSION_ID = 'global-bullion-syndicate';

// Authentication data directory.
const SESSION_PATH = './.wwebjs_auth';

// Pairing code refresh interval: 3 minutes.
const PAIRING_INTERVAL_MS = 180000;

// ============================================
// VALIDATE CONFIGURATION
// ============================================

const normalizedNumber = PHONE_NUMBER.replace(/\D/g, '');

if (!/^\d{8,15}$/.test(normalizedNumber)) {
    throw new Error(
        'Invalid PHONE_NUMBER. Use international format with country code.'
    );
}

// ============================================
// CREATE WHATSAPP CLIENT
// ============================================

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: SESSION_ID,
        dataPath: SESSION_PATH
    }),

    pairWithPhoneNumber: {
        phoneNumber: normalizedNumber,
        showNotification: true,
        intervalMs: PAIRING_INTERVAL_MS
    },

    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ]
    }
});

// ============================================
// PAIRING CODE EVENT
// ============================================

client.on('code', (code) => {
    console.log('\n========================================');
    console.log(' GLOBAL BULLION SYNDICATE');
    console.log(' WHATSAPP PAIRING CODE');
    console.log('========================================');
    console.log(`\nPairing code: ${code}\n`);
    console.log('On your phone:');
    console.log('WhatsApp → Linked Devices');
    console.log('→ Link a Device');
    console.log('→ Link with phone number instead');
    console.log('========================================\n');
});

// ============================================
// CONNECTION EVENTS
// ============================================

client.on('authenticated', () => {
    console.log('[AUTH] WhatsApp authentication successful.');
});

client.on('ready', () => {
    console.log('\n========================================');
    console.log(' GLOBAL BULLION SYNDICATE');
    console.log(' WHATSAPP CONNECTED');
    console.log('========================================');
    console.log('Session ID:', SESSION_ID);
    console.log('WhatsApp client is ready.');
    console.log('========================================\n');
});

client.on('auth_failure', (message) => {
    console.error('[AUTH ERROR]', message);
});

client.on('disconnected', (reason) => {
    console.warn('[DISCONNECTED]', reason);
});

client.on('loading_screen', (percent, message) => {
    console.log(`[LOADING] ${percent}% - ${message}`);
});

client.on('change_state', (state) => {
    console.log('[STATE]', state);
});

// ============================================
// START APPLICATION
// ============================================

async function startApplication() {
    console.log('Starting Global Bullion Syndicate...');
    console.log('Authentication: Phone-number pairing');
    console.log('QR display: Disabled');
    console.log('Session identifier:', SESSION_ID);

    try {
        await client.initialize();
    } catch (error) {
        console.error('[STARTUP ERROR]', error.message);
        process.exitCode = 1;
    }
}

// ============================================
// SAFE SHUTDOWN
// ============================================

let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;

    shuttingDown = true;
    console.log(`\n[SHUTDOWN] Received ${signal}.`);

    try {
        await client.destroy();
        console.log('[SHUTDOWN] WhatsApp client closed.');
    } catch (error) {
        console.error('[SHUTDOWN ERROR]', error.message);
    }

    process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// ============================================
// RUN
// ============================================

startApplication();
