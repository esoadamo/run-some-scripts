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

const VERSION = browser.runtime.getManifest().version;
const ALL_VERSIONS = ["1.0.0", "1.0.1", "1.1.0", VERSION];

var registrations = [];
var queue = null;

function send(id, initiator, data = null) {
    return browser.runtime.sendMessage({
        "id": id,
        "initiator": initiator,
        "data": data
    });
}

function notify(message) {
    switch (message.id) {
        case "get":
            queue.then(() => handleGet(message.initiator));
            break;
        case "set":
            queue.then(() => handleSet(message.initiator, message.data));
            break;
    }
}

async function handleGet(initiator) {
    try {
        await send("get-ok", initiator, await query());
    } catch (err) {
        await send("get-failed", initiator, err.message);
    }
}

async function handleSet(initiator, settings) {
    await unregisterAll();

    try {
        settings.version = VERSION;
        await browser.storage.local.set(settings);
    } catch (err) {
        console.log(`Error while writing data to storage: ${err}`);
        await send("set-failed", initiator, "persist.settings");
        return;
    }

    try {
        await registerAll(settings);
    } catch (err) {
        console.log(`Error while registering scripts: ${err}`);
        await send("set-failed", initiator, "activate.script");
        return;
    }

    await send("set-ok", initiator);
}

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

function migrateOldSettings(settings) {
    // Migrate from old single-script format (v1.0.0 / v1.0.1)
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

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function query() {
    var settings;

    try {
        settings = await browser.storage.local.get();
        if (Object.keys(settings).length === 0) {
            // Compatibility with 1.0.0, the settings might be in sync storage.
            settings = await browser.storage.sync.get();
            if (Object.keys(settings).length === 0) {
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

    settings = migrateOldSettings(settings);

    if (!settings.rules) {
        settings.rules = [];
    }

    validateRules(settings.rules);
    delete settings.version;

    return settings;
}

async function registerAll(settings) {
    if (!settings.rules) return;

    for (const rule of settings.rules) {
        if (!rule.enabled) continue;
        if (!rule.script.trim()) continue;

        var jsFiles = [];

        if (rule.injectJquery) {
            jsFiles.push({ file: "jquery-3.7.1.min.js" });
        }

        if (rule.injectGRenderer) {
            jsFiles.push({ file: "GRenderer.js" });
        }

        jsFiles.push({ code: rule.script });

        var options = {
            js: jsFiles,
            matches: ["http://*/*", "https://*/*"],
            runAt: "document_start"
        };

        // If urlPattern is not a catch-all, use includeGlobs to filter
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

browser.runtime.onMessage.addListener(notify);

queue = (async function () {
    try {
        await registerAll(await query());
    } catch (err) {
        /* Ignore error. */
    }
})();