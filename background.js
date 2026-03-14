/*
This file is part of run-a-script
Copyright (C) 2022-present Mihail Ivanchev

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program. If not, see <http://www.gnu.org/licenses/>.
*/

/*
 * BACKGROUND SCRIPT — runs as the extension's persistent background page.
 *
 * Responsibilities:
 *   1. Load user-defined rules from browser.storage.local on startup.
 *   2. Register each enabled rule as a sandboxed userScript via
 *      browser.userScripts.register(). Only the files the user opted into
 *      (jQuery, GRenderer) plus their own code are injected — nothing else.
 *   3. Listen for "get" / "set" messages from the settings page (settings.js)
 *      and respond with the current rules or persist + re-register updated ones.
 *   4. Migrate old single-script settings (v1.0.x) to the new multi-rule format.
 *
 * Data flow:
 *   settings.js  --"get"--> background.js --"get-ok"--> settings.js
 *   settings.js  --"set"--> background.js --"set-ok"--> settings.js
 *
 * Storage schema (browser.storage.local):
 *   { version: string, rules: Rule[] }
 *
 * No data is collected, transmitted, or shared. All scripts run sandboxed
 * via Firefox's userScripts API. The extension only stores the user's rules
 * locally and injects them into matching pages.
 */

/**
 * @typedef {Object} Rule
 * @property {string}  id              - Unique identifier for the rule.
 * @property {string}  urlPattern      - Glob pattern for URL matching ("*" = all URLs).
 * @property {string}  script          - User-provided JavaScript code to inject.
 * @property {boolean} enabled         - Whether this rule is active.
 * @property {boolean} injectJquery    - Whether to inject jQuery before the user script.
 * @property {boolean} injectGRenderer - Whether to inject GRenderer before the user script.
 */

/**
 * @typedef {Object} Settings
 * @property {string} [version] - Settings schema version (stripped before sending to UI).
 * @property {Rule[]} rules     - Array of user-defined injection rules.
 */

/**
 * @typedef {Object} Message
 * @property {string}      id        - Message type: "get", "set", "get-ok", "set-ok", etc.
 * @property {string}      initiator - UUID of the sender (used to route replies).
 * @property {*}           [data]    - Optional payload.
 */

/** @type {string} Current extension version from manifest.json. */
const VERSION = browser.runtime.getManifest().version;

/**
 * Active userScript registrations. Each entry is the return value of
 * browser.userScripts.register() and has an .unregister() method.
 * @type {Object[]}
 */
var registrations = [];

/**
 * Serialization queue — ensures startup finishes before any message is handled.
 * Every message handler chains onto this promise so operations never overlap.
 * @type {Promise|null}
 */
var queue = null;

/**
 * Send a message to all extension pages (settings popup / options page).
 * The message includes an initiator UUID so the recipient can filter
 * out messages that weren't meant for it.
 *
 * @param {string} id        - Message type identifier (e.g. "get-ok", "set-failed").
 * @param {string} initiator - UUID of the original requester to route the reply to.
 * @param {*}      [data]    - Optional payload (settings object, error key, etc.).
 * @returns {Promise}        - Resolves when the message has been dispatched.
 */
function send(id, initiator, data = null) {
    return browser.runtime.sendMessage({
        "id": id,
        "initiator": initiator,
        "data": data
    });
}

/**
 * Message listener — dispatches incoming messages from the settings page.
 * All operations are chained onto the serialization queue to prevent races.
 *
 * Handled message types:
 *   "get" — load rules from storage and send them back.
 *   "set" — persist new rules to storage and re-register userScripts.
 *
 * @param {Message} message - Incoming message from browser.runtime.sendMessage.
 */
function notify(message) {
    switch (message.id) {
        case "get":
            queue = queue.then(() => handleGet(message.initiator));
            break;
        case "set":
            queue = queue.then(() => handleSet(message.initiator, message.data));
            break;
    }
}

/**
 * Handle a "get" request: load rules from storage and reply.
 * Sends "get-ok" with the settings on success, or "get-failed" with an
 * error key that the UI maps to a human-readable message.
 *
 * @param {string} initiator - UUID of the requesting settings page instance.
 */
async function handleGet(initiator) {
    try {
        await send("get-ok", initiator, await query());
    } catch (err) {
        await send("get-failed", initiator, err.message);
    }
}

/**
 * Handle a "set" request: unregister old scripts, persist new rules, re-register.
 *
 * Steps:
 *   1. Unregister all currently active userScripts.
 *   2. Stamp the settings with the current version and write to storage.
 *   3. Register new userScripts for all enabled rules.
 *   4. Reply "set-ok" on success, or "set-failed" with an error key on failure.
 *
 * @param {string}   initiator - UUID of the requesting settings page instance.
 * @param {Settings} settings  - New settings object containing the rules array.
 */
async function handleSet(initiator, settings) {
    // Validate incoming data before persisting — reject malformed rules early.
    try {
        validateRules(settings.rules || []);
    } catch (err) {
        console.log(`Validation failed for incoming settings: ${err}`);
        await send("set-failed", initiator, "validate.settings");
        return;
    }

    // Step 1: tear down all existing script injections
    await unregisterAll();

    // Step 2: persist only known keys to browser.storage.local
    // (prevents storage pollution from unexpected extra fields)
    try {
        await browser.storage.local.set({
            version: VERSION,
            rules: settings.rules
        });
    } catch (err) {
        console.log(`Error while writing data to storage: ${err}`);
        await send("set-failed", initiator, "persist.settings");
        return;
    }

    // Step 3: register userScripts for each enabled rule
    try {
        await registerAll({ rules: settings.rules });
    } catch (err) {
        console.log(`Error while registering scripts: ${err}`);
        await send("set-failed", initiator, "activate.script");
        return;
    }

    await send("set-ok", initiator);
}

/**
 * Unregister all currently active userScript registrations.
 * Errors during individual unregistrations are logged but do not abort
 * the loop — we always want to clean up as many as possible.
 * After this call, the registrations array is empty.
 *
 * @returns {Promise<void>}
 */
async function unregisterAll() {
    for (const reg of registrations) {
        try {
            await reg.unregister();
        } catch (err) {
            console.log(`Error while unregistering script: ${err}`);
        }
    }
    registrations = [];
}

/**
 * Validate that the rules array has the correct shape.
 * This is a defense against corrupted or tampered storage data.
 * Each rule must have exactly the expected fields with the expected types.
 * Throws an Error with key "validate.settings" if validation fails.
 *
 * @param {*} rules - Value to validate (should be Rule[]).
 * @throws {Error} If rules is not an array or any rule has wrong field types.
 */
function validateRules(rules) {
    if (!Array.isArray(rules)) {
        throw new Error("validate.settings");
    }
    for (const rule of rules) {
        if (typeof rule.id !== "string" ||
            typeof rule.urlPattern !== "string" ||
            typeof rule.script !== "string" ||
            typeof rule.enabled !== "boolean" ||
            typeof rule.injectJquery !== "boolean" ||
            typeof rule.injectGRenderer !== "boolean") {
            throw new Error("validate.settings");
        }
    }
}

/**
 * Migrate settings from the old v1.0.x single-script format to the new
 * multi-rule format. If the settings already have a "rules" key, they are
 * returned unchanged.
 *
 * Old format: { version, script: string, enabled: boolean }
 * New format: { version, rules: Rule[] }
 *
 * The migrated rule matches all URLs ("*"), injects jQuery (as the old
 * version always did), and preserves the user's script and enabled state.
 *
 * @param {Object} settings - Settings object loaded from storage.
 * @returns {Settings} Settings in the current multi-rule format.
 */
function migrateOldSettings(settings) {
    if ("script" in settings && !("rules" in settings)) {
        return {
            version: VERSION,
            rules: [{
                id: generateId(),
                urlPattern: "*",
                script: settings.script || "",
                enabled: !!settings.enabled,
                injectJquery: true,
                injectGRenderer: false
            }]
        };
    }
    return settings;
}

/**
 * Generate a short, unique-enough identifier for a rule.
 * Combines a base-36 timestamp with random characters.
 * Not cryptographically secure — just needs to be unique within the rules list.
 *
 * @returns {string} A short alphanumeric ID (e.g. "lx1a2b3cde").
 */
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Load, migrate, and validate settings from persistent storage.
 *
 * Lookup order:
 *   1. browser.storage.local (current)
 *   2. browser.storage.sync  (v1.0.0 compatibility fallback)
 *   3. Empty default: { version, rules: [] }
 *
 * After loading, old single-script settings are migrated to multi-rule format,
 * the rules array is validated, and the version field is stripped before
 * returning (the UI doesn't need it).
 *
 * @returns {Promise<Settings>} Validated settings without the version field.
 * @throws {Error} With key "query.settings" if storage read fails,
 *                 or "validate.settings" if data is malformed.
 */
async function query() {
    var settings;

    try {
        settings = await browser.storage.local.get();
        if (Object.keys(settings).length === 0) {
            // Compatibility with v1.0.0 which used sync storage.
            settings = await browser.storage.sync.get();
            if (Object.keys(settings).length === 0) {
                // First run — no saved data, start with empty rules.
                settings = {
                    version: VERSION,
                    rules: []
                };
            } else if (!("version" in settings)) {
                settings.version = "1.0.0";
            }
        }
    } catch (err) {
        console.log("Failed to retrieve data from persistent storage: " +
            `${err}`);
        throw new Error("query.settings");
    }

    // Convert v1.0.x single-script format to multi-rule if needed.
    settings = migrateOldSettings(settings);

    if (!settings.rules) {
        settings.rules = [];
    }

    // Ensure storage hasn't been tampered with.
    validateRules(settings.rules);

    // The version field is internal — strip it before sending to the UI.
    delete settings.version;

    return settings;
}

/**
 * Register userScripts for all enabled rules that have non-empty scripts.
 *
 * For each qualifying rule, this builds a js[] array containing only the
 * files the user opted into:
 *   - jquery-3.7.1.min.js  (if rule.injectJquery is true)
 *   - GRenderer.js          (if rule.injectGRenderer is true)
 *   - The user's own code   (always last, so dependencies are available)
 *
 * URL filtering:
 *   - "matches" is always ["http://*\/*", "https://*\/*"] to cover all HTTP(S) pages.
 *   - If the user specified a non-catch-all glob (anything other than "*"),
 *     it's passed as "includeGlobs" so Firefox further filters which pages
 *     actually get the injection. Glob syntax: * = any chars, ? = one char.
 *
 * All scripts run sandboxed via Firefox's userScripts API — they cannot
 * access extension APIs or privileged browser features.
 *
 * @param {Settings} settings - Settings object containing the rules array.
 * @returns {Promise<void>}
 * @throws {Error} If any browser.userScripts.register() call fails.
 */
async function registerAll(settings) {
    if (!settings.rules) return;

    for (const rule of settings.rules) {
        // Skip disabled rules and rules with empty scripts.
        if (!rule.enabled) continue;
        if (!rule.script.trim()) continue;

        // Build the list of scripts to inject, in order.
        // Dependencies come first so they're available when the user's code runs.
        var jsFiles = [];

        if (rule.injectJquery) {
            jsFiles.push({ file: "jquery-3.7.1.min.js" });
        }

        if (rule.injectGRenderer) {
            jsFiles.push({ file: "GRenderer.js" });
        }

        // The user's own code is always injected last.
        jsFiles.push({ code: rule.script });

        var options = {
            js: jsFiles,
            // Broad match — actual filtering is done by includeGlobs below.
            matches: ["http://*/*", "https://*/*"],
            runAt: "document_start"
        };

        // Apply the user's URL glob filter. "*" means all URLs, so we skip
        // includeGlobs in that case (it's the default behavior).
        if (rule.urlPattern && rule.urlPattern !== "*") {
            options.includeGlobs = [rule.urlPattern];
        }

        try {
            var reg = await browser.userScripts.register(options);
            registrations.push(reg);
        } catch (err) {
            console.log(`Error while registering script for rule "${rule.id}": ${err}`);
            throw err;
        }
    }
}

// --- INITIALIZATION ---
// Listen for messages from the settings page (settings.js).
browser.runtime.onMessage.addListener(notify);

// On extension startup (browser launch, extension install/update, enable):
// Load saved rules and register userScripts for any that are enabled.
// The queue promise serializes this with subsequent message handling.
queue = (async function () {
    try {
        await registerAll(await query());
    } catch (err) {
        /* Startup errors are non-fatal — the user can fix via settings. */
    }
})();