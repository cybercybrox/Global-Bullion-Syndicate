'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const path = require('path');
const fs = require('fs');

// ============================================
// GLOBAL BULLION SYNDICATE — CONFIGURATION
// ============================================

// Set this in Render's Environment Variables.
// Use the international number with digits only.
const PHONE_NUMBER = (
    process.env.WHATSAPP_PHONE_NUMBER || ''
).replace(/\D/g, '');

const SESSION_ID = 'global-bullion-syndicate';

const SESSION_PATH = path.resolve(
    process.env.WWEBJS_AUTH_PATH || '.wwebjs_auth'
);

const PAIRING_INTERVAL_MS = 180000;

// ============================================
// VALIDATE CONFIGURATION
// ============================================

if (!PHONE_NUMBER) {
    throw new Error(
        'Missing WHATSAPP_PHONE_NUMBER. ' +
        'Add your international phone number in Render Environment Variables.'
    );
}

if (!/^\d{8,15}$/.test(PHONE_NUMBER)) {
    throw new Error(
        'Invalid WhatsApp number. Use international format with digits only.'
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
        phoneNumber: PHONE_NUMBER,
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
// PHONE-NUMBER PAIRING
// ============================================

client.on('code', (code) => {
    console.log('\n========================================');
    console.log(' GLOBAL BULLION SYNDICATE');
    console.log(' WHATSAPP PAIRING CODE');
    console.log('========================================');
    console.log(`Pairing code: ${code}`);
    console.log('\nOn your phone:');
    console.log('1. Open WhatsApp.');
    console.log('2. Open Linked Devices.');
    console.log('3. Tap Link a Device.');
    console.log('4. Choose Link with phone number instead.');
    console.log('5. Enter the pairing code shown above.');
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
    console.log('Session directory:', SESSION_PATH);
    console.log('WhatsApp client is ready.');
    console.log('========================================\n');
});

client.on('auth_failure', (message) => {
    console.error('[AUTH ERROR]', message);
});

client.on('disconnected', (reason) => {
    console.warn('[DISCONNECTED]', reason);
    console.warn(
        '[INFO] Check the logs and WhatsApp linked-device status.'
    );
});

client.on('loading_screen', (percent, message) => {
    console.log(`[LOADING] ${percent}% - ${message}`);
});

client.on('change_state', (state) => {
    console.log('[STATE]', state);
});

// We expect phone-number pairing, not QR pairing.
client.on('qr', () => {
    console.error(
        '[PAIRING WARNING] A QR event was received. ' +
        'Check the installed whatsapp-web.js version and pairing configuration.'
    );
});

// ============================================
// CHECK BROWSER INSTALLATION
// ============================================

try {
    const puppeteer = require('puppeteer');
    const browserPath = puppeteer.executablePath();

    console.log('[BROWSER] Expected Chrome location:', browserPath);

    if (!fs.existsSync(browserPath)) {
        console.error(
            '[BROWSER ERROR] Chrome is missing from the expected location.'
        );
        console.error(
            '[BROWSER FIX] Check the Puppeteer browser installation in Render.'
        );
    } else {
        console.log('[BROWSER] Chrome executable found.');
    }
} catch (error) {
    console.error(
        '[BROWSER CHECK ERROR]',
        error.message
    );
}

// ============================================
// START APPLICATION
// ============================================

async function startApplication() {
    console.log('\n========================================');
    console.log('Starting Global Bullion Syndicate...');
    console.log('Authentication: Phone-number pairing');
    console.log('QR display: Not used for pairing');
    console.log('Session identifier:', SESSION_ID);
    console.log('========================================\n');

    try {
        await client.initialize();
    } catch (error) {
        console.error(
            '[STARTUP ERROR]',
            error.stack || error.message || error
        );

        process.exitCode = 1;

        try {
            await client.destroy();
        } catch {
            // The client might not have finished initializing.
        }
    }
}

// ============================================
// SAFE SHUTDOWN
// ============================================

let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;

    console.log(`\n[SHUTDOWN] Received ${signal}.`);

    try {
        await client.destroy();
        console.log('[SHUTDOWN] WhatsApp client closed.');
    } catch (error) {
        console.error(
            '[SHUTDOWN ERROR]',
            error.message
        );
    }

    process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// ============================================
// RUN
// ============================================

startApplication();
